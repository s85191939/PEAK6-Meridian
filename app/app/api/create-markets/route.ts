/**
 * POST /api/create-markets — Automated morning market creation
 *
 * Called by Vercel Cron at ~8:30 AM ET every trading day.
 * Fetches REAL previous closing prices from Yahoo Finance,
 * calculates strikes at ATM, +/-3%, +/-6%, +/-9% (rounded to $10, deduplicated),
 * and creates all markets + orderbooks on Solana devnet.
 *
 * Each market requires 5 transactions:
 *   1. create_market (market PDA + Yes/No mints)
 *   2. init_orderbook (vault + orderbook)
 *   3. init_escrow_yes (Yes token escrow for asks)
 *   4. init_bid_escrow (USDC escrow for bids)
 *   5. register_market (add to on-chain registry for frontend discovery)
 *
 * Protected by CRON_SECRET env var.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM } from "@solana/spl-token";
import type { Meridian } from "@/lib/idl/meridian";
import idl from "@/lib/idl/meridian.json";
import { PROGRAM_ID, RPC_URL } from "@/lib/constants";

const ADMIN_SECRET = [236,158,41,219,108,151,179,250,69,236,178,96,161,156,243,53,235,229,147,33,180,67,59,37,88,172,105,188,40,227,23,74,154,112,194,233,194,146,215,227,177,131,235,23,20,148,197,205,75,59,88,184,75,23,203,37,109,124,139,233,189,227,83,157];

const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
const STRIKE_OFFSETS = [-0.09, -0.06, -0.03, 0, 0.03, 0.06, 0.09];

/**
 * Pyth Network Price Feed IDs for MAG7 US Equities
 * Same feeds used by settle-markets — real, production-grade prices.
 */
const PYTH_FEED_IDS: Record<string, string> = {
  AAPL: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  MSFT: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  GOOGL: "0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
  AMZN: "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  NVDA: "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  META: "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  TSLA: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
};

const HERMES_URL = "https://hermes.pyth.network";

function getDateInt(): number {
  const now = new Date();
  const etStr = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return parseInt(etStr.replace(/-/g, ""));
}

/**
 * Check if today is a US stock market trading day (Mon-Fri, non-holiday).
 * Returns false on weekends. Major market holidays are also excluded.
 */
function isTradingDay(): boolean {
  const now = new Date();
  // Get current day of week in ET
  const etDay = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);

  // Weekends
  if (etDay === "Sat" || etDay === "Sun") return false;

  // Major US market holidays (approximate — NYSE/NASDAQ closures)
  const etDate = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const HOLIDAYS_2026 = [
    "2026-01-01", // New Year's Day
    "2026-01-19", // MLK Day
    "2026-02-16", // Presidents' Day
    "2026-04-03", // Good Friday
    "2026-05-25", // Memorial Day
    "2026-06-19", // Juneteenth
    "2026-07-03", // Independence Day (observed)
    "2026-09-07", // Labor Day
    "2026-11-26", // Thanksgiving
    "2026-12-25", // Christmas
  ];
  if (HOLIDAYS_2026.includes(etDate)) return false;

  return true;
}

function computeStrikes(prevClose: number): number[] {
  const strikes = new Set<number>();
  for (const offset of STRIKE_OFFSETS) {
    const raw = prevClose * (1 + offset);
    const rounded = Math.round(raw / 1000) * 1000;
    if (rounded > 0) strikes.add(rounded);
  }
  return Array.from(strikes).sort((a, b) => a - b);
}

/**
 * PRIMARY: Fetch current/latest prices from Pyth Network Hermes API.
 * Used to calculate strike prices for new markets.
 * Returns prices in USD cents.
 */
async function fetchPythPrices(): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};

  const feedIds = MAG7_TICKERS.map((t) => PYTH_FEED_IDS[t]);
  const params = feedIds.map((id) => `ids[]=${id}`).join("&");
  const url = `${HERMES_URL}/v2/updates/price/latest?${params}`;

  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!resp.ok) {
      console.error(`Pyth Hermes API returned ${resp.status}`);
      return prices;
    }

    const data = await resp.json();
    const parsedPrices = data?.parsed || [];

    for (const parsed of parsedPrices) {
      const feedId = "0x" + parsed.id;
      const ticker = MAG7_TICKERS.find((t) => PYTH_FEED_IDS[t] === feedId);
      if (!ticker) continue;

      const priceData = parsed.price;
      if (!priceData) continue;

      const rawPrice = Number(priceData.price);
      const expo = priceData.expo;
      const priceUsd = rawPrice * Math.pow(10, expo);
      const priceCents = Math.round(priceUsd * 100);

      if (priceCents > 0) {
        prices[ticker] = priceCents;
      }
    }
  } catch (err) {
    console.error("Pyth Hermes API failed:", err);
  }

  return prices;
}

/**
 * FALLBACK: Yahoo Finance for previous closing prices.
 * Used when Pyth is unavailable.
 */
async function fetchYahooPrices(): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};

  for (const ticker of MAG7_TICKERS) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${ticker}&range=5d&interval=1d`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Meridian/1.0" },
      });
      if (resp.ok) {
        const data = await resp.json();
        const result = data?.spark?.result?.[0];
        const close = result?.response?.[0]?.meta?.chartPreviousClose ||
                       result?.response?.[0]?.meta?.previousClose ||
                       result?.response?.[0]?.meta?.regularMarketPrice;
        if (close && close > 0) {
          prices[ticker] = Math.round(close * 100);
        }
      }
    } catch {
      console.error(`Yahoo fallback failed for ${ticker}`);
    }
  }

  return prices;
}

/**
 * Fetch prices: Pyth primary, Yahoo fallback.
 * Returns prices in USD cents for strike calculation.
 */
async function fetchPrevClosePrices(): Promise<Record<string, number>> {
  console.log("Fetching prices from Pyth (primary)...");
  const pythPrices = await fetchPythPrices();

  if (Object.keys(pythPrices).length >= MAG7_TICKERS.length) {
    console.log("All prices from Pyth:", pythPrices);
    return pythPrices;
  }

  // Fill gaps from Yahoo
  console.log(`Pyth returned ${Object.keys(pythPrices).length}/${MAG7_TICKERS.length}, trying Yahoo fallback...`);
  const yahooPrices = await fetchYahooPrices();

  const merged = { ...pythPrices };
  for (const ticker of MAG7_TICKERS) {
    if (!merged[ticker] && yahooPrices[ticker]) {
      merged[ticker] = yahooPrices[ticker];
      console.log(`${ticker}: using Yahoo fallback price`);
    }
  }

  console.log("Merged prices:", merged);
  return merged;
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Don't create markets on weekends or holidays — US stock markets are closed
  if (!isTradingDay()) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "Not a trading day (weekend or market holiday). US markets trade Mon-Fri only.",
      date: getDateInt(),
    });
  }

  // Time guard: only create markets after 8:00 AM ET
  // Cron fires at both 12:30 and 13:30 UTC to cover EDT/EST.
  // If it's before 8 AM ET, skip — the next cron run will handle it.
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
  if (etHour < 8) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: `Too early to create markets (${etHour}:xx ET). Markets created at 8:30 AM ET.`,
      date: getDateInt(),
    });
  }

  try {
    const adminKeypair = Keypair.fromSecretKey(Uint8Array.from(ADMIN_SECRET));
    const connection = new Connection(RPC_URL, "confirmed");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wallet = {
      publicKey: adminKeypair.publicKey,
      signTransaction: async <T extends Transaction>(tx: T): Promise<T> => {
        if (tx instanceof Transaction) tx.partialSign(adminKeypair);
        return tx;
      },
      signAllTransactions: async <T extends Transaction>(txs: T[]): Promise<T[]> => {
        txs.forEach((tx) => { if (tx instanceof Transaction) tx.partialSign(adminKeypair); });
        return txs;
      },
    } as AnchorProvider["wallet"];

    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    const program = new Program<Meridian>(idl as Meridian, provider);

    const date = getDateInt();
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      PROGRAM_ID
    );
    const [registryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_registry")],
      PROGRAM_ID
    );

    // Fetch config to get USDC mint
    const config = await program.account.config.fetch(configPda);
    const usdcMint = config.usdcMint as PublicKey;

    // Fetch real previous closing prices
    console.log("Fetching previous closing prices...");
    const prevCloses = await fetchPrevClosePrices();
    console.log("Previous closes:", prevCloses);

    if (Object.keys(prevCloses).length === 0) {
      return NextResponse.json(
        { error: "Could not fetch any previous closing prices" },
        { status: 503 }
      );
    }

    let created = 0;
    let skipped = 0;
    let failed = 0;
    const results: string[] = [];

    for (const ticker of MAG7_TICKERS) {
      const prevClose = prevCloses[ticker];
      if (!prevClose) {
        results.push(`${ticker}: No previous close available`);
        failed++;
        continue;
      }

      const strikes = computeStrikes(prevClose);
      results.push(`${ticker} (prev close: $${(prevClose / 100).toFixed(2)}): ${strikes.length} strikes`);

      for (const strike of strikes) {
        const strikeBn = new BN(strike);
        const dateBn = new BN(date);

        // Derive market PDA
        const [marketPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("market"),
            Buffer.from(ticker),
            strikeBn.toArrayLike(Buffer, "le", 8),
            dateBn.toArrayLike(Buffer, "le", 4),
          ],
          PROGRAM_ID
        );

        // Check if market already exists
        try {
          await program.account.market.fetch(marketPda);
          skipped++;
          continue;
        } catch {
          // Market doesn't exist — create it
        }

        try {
          // Derive PDAs
          const [yesMint] = PublicKey.findProgramAddressSync(
            [Buffer.from("yes_mint"), marketPda.toBuffer()],
            PROGRAM_ID
          );
          const [noMint] = PublicKey.findProgramAddressSync(
            [Buffer.from("no_mint"), marketPda.toBuffer()],
            PROGRAM_ID
          );
          const [vault] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), marketPda.toBuffer()],
            PROGRAM_ID
          );
          const [orderbookPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("orderbook"), marketPda.toBuffer()],
            PROGRAM_ID
          );
          const [escrowYes] = PublicKey.findProgramAddressSync(
            [Buffer.from("escrow_yes"), marketPda.toBuffer()],
            PROGRAM_ID
          );
          const [bidEscrow] = PublicKey.findProgramAddressSync(
            [Buffer.from("bid_escrow"), marketPda.toBuffer()],
            PROGRAM_ID
          );

          // 1. Create market
          await program.methods
            .createMarket(ticker, strikeBn, date)
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              market: marketPda,
              yesMint,
              noMint,
              tokenProgram: SPL_TOKEN_PROGRAM,
              systemProgram: PublicKey.default,
              rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any)
            .signers([adminKeypair])
            .rpc();

          // 2. Init orderbook
          await program.methods
            .initOrderbook()
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              market: marketPda,
              vault,
              orderbook: orderbookPda,
              usdcMint,
              tokenProgram: SPL_TOKEN_PROGRAM,
              systemProgram: PublicKey.default,
              rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any)
            .signers([adminKeypair])
            .rpc();

          // 3. Init escrow_yes
          await program.methods
            .initEscrowYes()
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              market: marketPda,
              escrowYes,
              yesMint,
              tokenProgram: SPL_TOKEN_PROGRAM,
              systemProgram: PublicKey.default,
              rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any)
            .signers([adminKeypair])
            .rpc();

          // 4. Init bid_escrow
          await program.methods
            .initBidEscrow()
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              market: marketPda,
              bidEscrow,
              usdcMint,
              tokenProgram: SPL_TOKEN_PROGRAM,
              systemProgram: PublicKey.default,
              rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any)
            .signers([adminKeypair])
            .rpc();

          // 5. Register market (realloc grows registry as needed)
          await program.methods
            .registerMarket()
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              market: marketPda,
              marketRegistry: registryPda,
              systemProgram: PublicKey.default,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any)
            .signers([adminKeypair])
            .rpc();

          created++;
          results.push(`  ${ticker} > $${(strike / 100).toFixed(0)}: CREATED`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          failed++;
          results.push(`  ${ticker} > $${(strike / 100).toFixed(0)}: FAILED - ${msg.slice(0, 100)}`);
        }
      }
    }

    return NextResponse.json({
      success: true,
      date,
      created,
      skipped,
      failed,
      prevCloses,
      results,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
