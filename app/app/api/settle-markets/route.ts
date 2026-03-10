/**
 * POST /api/settle-markets — Automated settlement via Pyth Oracle
 *
 * Called at ~4:05 PM ET every trading day.
 *
 * Oracle hierarchy:
 *   1. PRIMARY: Pyth Network (on-chain oracle, PEAK6 is a Pyth validator)
 *      - Fetches real stock prices from Pyth Hermes API
 *      - Validates staleness (< 5 min) and confidence (< 1% of price)
 *      - Real prices from 120+ institutional data publishers
 *   2. FALLBACK: Yahoo Finance (if Pyth unavailable after 15-min retry)
 *
 * Retry logic per PRD:
 *   - If oracle fails, retry every 30 seconds for up to 15 minutes
 *   - If still failing after 15 min, log for admin manual override
 *
 * Contracts settle at 4:00 PM ET. 0DTE — all contracts expire same day.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import type { Meridian } from "@/lib/idl/meridian";
import idl from "@/lib/idl/meridian.json";
import { PROGRAM_ID, RPC_URL } from "@/lib/constants";

// Admin keypair — devnet only
const ADMIN_SECRET = [236,158,41,219,108,151,179,250,69,236,178,96,161,156,243,53,235,229,147,33,180,67,59,37,88,172,105,188,40,227,23,74,154,112,194,233,194,146,215,227,177,131,235,23,20,148,197,205,75,59,88,184,75,23,203,37,109,124,139,233,189,227,83,157];

const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

/**
 * Pyth Network Price Feed IDs for MAG7 US Equities
 * These are real, production-grade price feeds from Pyth's 120+ institutional publishers.
 * PEAK6 is a Pyth validator, providing direct infrastructure relationship.
 *
 * Standard market hours feeds (9:30 AM - 4:00 PM ET, Mon-Fri)
 * Source: https://pyth.network/developers/price-feed-ids
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
const MAX_STALENESS_SECONDS = 300; // 5 minutes
const MAX_CONFIDENCE_RATIO = 0.01; // 1% of price

function getDateInt(): number {
  const now = new Date();
  const etStr = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return parseInt(etStr.replace(/-/g, ""));
}

/**
 * Check if today is a US stock market trading day (Mon-Fri, non-holiday).
 */
function isTradingDay(): boolean {
  const now = new Date();
  const etDay = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);

  if (etDay === "Sat" || etDay === "Sun") return false;

  const etDate = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const HOLIDAYS_2026 = [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03",
    "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
    "2026-11-26", "2026-12-25",
  ];
  return !HOLIDAYS_2026.includes(etDate);
}

const STRIKE_OFFSETS = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];

function computeStrikes(prevClose: number): number[] {
  const strikes = new Set<number>();
  for (const offset of STRIKE_OFFSETS) {
    const raw = prevClose * (1 + offset);
    const rounded = Math.round(raw / 1000) * 1000;
    if (rounded > 0) strikes.add(rounded);
  }
  return Array.from(strikes).sort((a, b) => a - b);
}

interface PythPrice {
  price: number; // USD cents
  confidence: number; // USD cents
  publishTime: number; // Unix timestamp
  source: "pyth";
}

interface YahooPrice {
  price: number; // USD cents
  confidence: number;
  publishTime: number;
  source: "yahoo_fallback";
}

type OraclePrice = PythPrice | YahooPrice;

/**
 * PRIMARY ORACLE: Fetch real stock prices from Pyth Network Hermes API.
 *
 * Pyth Hermes is the off-chain component of Pyth's pull-based oracle.
 * It returns the latest price data from Pyth's on-chain price accounts,
 * including price, confidence interval, exponent, and publish timestamp.
 *
 * These are REAL prices from institutional publishers (PEAK6, Jane Street, etc.)
 */
async function fetchPythPrices(): Promise<Record<string, OraclePrice>> {
  const prices: Record<string, OraclePrice> = {};
  const now = Math.floor(Date.now() / 1000);

  // Batch fetch all 7 feed IDs in one request
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

      // Pyth price = priceData.price * 10^priceData.expo
      // For equities, expo is typically -5 (5 decimal places)
      const rawPrice = Number(priceData.price);
      const expo = priceData.expo;
      const priceUsd = rawPrice * Math.pow(10, expo); // USD dollars
      const priceCents = Math.round(priceUsd * 100); // USD cents

      const rawConf = Number(priceData.conf);
      const confUsd = rawConf * Math.pow(10, expo);
      const confCents = Math.round(confUsd * 100);

      const publishTime = priceData.publish_time;

      // Staleness check: reject prices older than 5 minutes
      const age = now - publishTime;
      if (age > MAX_STALENESS_SECONDS) {
        console.warn(`${ticker}: Pyth price is stale (${age}s old, max ${MAX_STALENESS_SECONDS}s)`);
        continue;
      }

      // Confidence check: reject if confidence > 1% of price
      if (priceCents > 0 && confCents / priceCents > MAX_CONFIDENCE_RATIO) {
        console.warn(`${ticker}: Pyth confidence too wide (${confCents}c / ${priceCents}c = ${(confCents/priceCents*100).toFixed(2)}%)`);
        continue;
      }

      if (priceCents > 0) {
        prices[ticker] = {
          price: priceCents,
          confidence: confCents,
          publishTime,
          source: "pyth",
        };
      }
    }
  } catch (err) {
    console.error("Pyth Hermes API failed:", err);
  }

  return prices;
}

/**
 * FALLBACK ORACLE: Yahoo Finance (used only when Pyth fails after 15-min retry)
 */
async function fetchYahooPrices(): Promise<Record<string, OraclePrice>> {
  const prices: Record<string, OraclePrice> = {};

  for (const ticker of MAG7_TICKERS) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${ticker}&range=1d&interval=1d`;
      const resp = await fetch(url, { headers: { "User-Agent": "Meridian/1.0" } });
      if (resp.ok) {
        const data = await resp.json();
        const close = data?.spark?.result?.[0]?.response?.[0]?.meta?.regularMarketPrice;
        if (close && close > 0) {
          prices[ticker] = {
            price: Math.round(close * 100),
            confidence: 0,
            publishTime: Math.floor(Date.now() / 1000),
            source: "yahoo_fallback",
          };
        }
      }
    } catch {
      console.error(`Yahoo fallback failed for ${ticker}`);
    }
  }

  return prices;
}

/**
 * Fetch closing prices with Pyth-first, Yahoo-fallback strategy.
 * Implements 15-minute retry window per PRD:
 *   - If oracle confidence is too wide, retry every 30 seconds
 *   - Up to 15 minutes (30 retries)
 *   - If still failing, return partial results for admin manual override
 */
const RETRY_INTERVAL_MS = 30_000; // 30 seconds
const MAX_RETRY_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const MAX_RETRIES = Math.floor(MAX_RETRY_DURATION_MS / RETRY_INTERVAL_MS); // 30

async function fetchOraclePrices(): Promise<{
  prices: Record<string, OraclePrice>;
  source: string;
  retries: number;
}> {
  let retries = 0;
  let prices: Record<string, OraclePrice> = {};

  // Retry loop: try Pyth every 30s for up to 15 min
  while (retries <= MAX_RETRIES) {
    prices = await fetchPythPrices();

    if (Object.keys(prices).length >= MAG7_TICKERS.length) {
      return { prices, source: "pyth", retries };
    }

    // If first attempt or still missing tickers, log and retry
    const missing = MAG7_TICKERS.filter((t) => !prices[t]);
    if (retries < MAX_RETRIES) {
      console.log(
        `Pyth returned ${Object.keys(prices).length}/${MAG7_TICKERS.length} prices ` +
        `(missing: ${missing.join(", ")}). Retry ${retries + 1}/${MAX_RETRIES} in 30s...`
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
      retries++;
    } else {
      break;
    }
  }

  // After retry window exhausted, try Yahoo for missing tickers
  console.log(`Pyth retry window exhausted after ${retries} retries. Trying Yahoo fallback...`);
  const yahooPrices = await fetchYahooPrices();

  for (const ticker of MAG7_TICKERS) {
    if (!prices[ticker] && yahooPrices[ticker]) {
      prices[ticker] = yahooPrices[ticker];
    }
  }

  // If still missing tickers, log alert for admin manual override
  const stillMissing = MAG7_TICKERS.filter((t) => !prices[t]);
  if (stillMissing.length > 0) {
    console.error(
      `ALERT: Oracle failure after 15-min retry. Missing tickers: ${stillMissing.join(", ")}. ` +
      `Admin should use admin_settle_override with manual price and enforced time delay.`
    );
  }

  const source = Object.values(prices).some((p) => p.source === "yahoo_fallback")
    ? "pyth+yahoo_fallback"
    : "pyth";

  return { prices, source, retries };
}

/**
 * Also fetch prev close from Pyth for strike computation
 */
async function fetchPrevClosePrices(): Promise<Record<string, number>> {
  // Pyth doesn't have a "previous close" concept directly,
  // so we use the current price as a proxy for prev close
  // (at 8 AM ET, the Pyth price reflects the last session's close)
  const pythPrices = await fetchPythPrices();
  const prices: Record<string, number> = {};
  for (const [ticker, data] of Object.entries(pythPrices)) {
    prices[ticker] = data.price;
  }

  // Fill gaps from Yahoo
  if (Object.keys(prices).length < MAG7_TICKERS.length) {
    for (const ticker of MAG7_TICKERS) {
      if (!prices[ticker]) {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${ticker}&range=5d&interval=1d`;
          const resp = await fetch(url, { headers: { "User-Agent": "Meridian/1.0" } });
          if (resp.ok) {
            const data = await resp.json();
            const close = data?.spark?.result?.[0]?.response?.[0]?.meta?.chartPreviousClose;
            if (close && close > 0) prices[ticker] = Math.round(close * 100);
          }
        } catch { /* skip */ }
      }
    }
  }

  return prices;
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Don't settle on weekends/holidays — no markets should exist for non-trading days
  if (!isTradingDay()) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "Not a trading day (weekend or market holiday). Nothing to settle.",
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

    // Step 1: Fetch oracle prices (Pyth primary, Yahoo fallback)
    console.log("Fetching oracle prices (Pyth primary)...");
    const { prices: oraclePrices, source } = await fetchOraclePrices();
    console.log(`Oracle source: ${source}`, oraclePrices);

    if (Object.keys(oraclePrices).length === 0) {
      return NextResponse.json(
        { error: "Oracle failure: No prices from Pyth or Yahoo. Admin override required.", retryable: true },
        { status: 503 }
      );
    }

    // Step 2: Get prev close for strike calculation
    const prevCloses = await fetchPrevClosePrices();

    // Step 3: Settle each market
    let settled = 0;
    let skipped = 0;
    let failed = 0;
    const results: string[] = [];

    for (const ticker of MAG7_TICKERS) {
      const oracleData = oraclePrices[ticker];
      if (!oracleData) {
        results.push(`${ticker}: No oracle price available`);
        failed++;
        continue;
      }

      const closingPrice = oracleData.price;
      const prevClose = prevCloses[ticker] || closingPrice;
      const strikes = computeStrikes(prevClose);

      for (const strike of strikes) {
        const strikeBn = new BN(strike);
        const dateBn = new BN(date);

        const [marketPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("market"),
            Buffer.from(ticker),
            strikeBn.toArrayLike(Buffer, "le", 8),
            dateBn.toArrayLike(Buffer, "le", 4),
          ],
          PROGRAM_ID
        );

        try {
          const market = await program.account.market.fetch(marketPda);
          if (market.settled) { skipped++; continue; }

          const outcome = closingPrice >= strike ? "YES wins" : "NO wins";

          await program.methods
            .settleMarket(new BN(closingPrice))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .accounts({ admin: adminKeypair.publicKey, config: configPda, market: marketPda } as any)
            .signers([adminKeypair])
            .rpc();

          settled++;
          results.push(
            `${ticker} > $${(strike / 100).toFixed(0)}: close=$${(closingPrice / 100).toFixed(2)} [${oracleData.source}] -> ${outcome}`
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("Account does not exist")) continue;
          failed++;
          results.push(`${ticker} > $${(strike / 100).toFixed(0)}: FAILED - ${msg.slice(0, 100)}`);
        }
      }
    }

    return NextResponse.json({
      success: true,
      date,
      oracleSource: source,
      settled,
      skipped,
      failed,
      prices: Object.fromEntries(
        Object.entries(oraclePrices).map(([k, v]) => [k, { price: v.price, source: v.source }])
      ),
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
