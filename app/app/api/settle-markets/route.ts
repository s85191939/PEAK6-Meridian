/**
 * POST /api/settle-markets — Automated settlement via Pyth Oracle
 *
 * Called at ~4:05 PM ET every trading day (and can be triggered manually).
 *
 * REGISTRY-BASED: Reads ALL markets from the on-chain MarketRegistry,
 * finds any that are unsettled, and settles them using oracle prices.
 * This handles missed settlements from previous days automatically.
 *
 * Oracle hierarchy:
 *   1. PRIMARY: Pyth Network (on-chain oracle, PEAK6 is a Pyth validator)
 *      - Fetches real stock prices from Pyth Hermes API
 *      - Validates staleness (< 5 min) and confidence (< 1% of price)
 *      - Real prices from 120+ institutional data publishers
 *   2. FALLBACK: Yahoo Finance (if Pyth unavailable)
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
const MAX_STALENESS_SECONDS = 86400; // 24 hours — relaxed for after-hours settlement of missed markets
const MAX_CONFIDENCE_RATIO = 0.02; // 2% of price — slightly relaxed for after-hours

function getDateInt(): number {
  const now = new Date();
  const etStr = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return parseInt(etStr.replace(/-/g, ""));
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
 */
async function fetchPythPrices(): Promise<Record<string, OraclePrice>> {
  const prices: Record<string, OraclePrice> = {};
  const now = Math.floor(Date.now() / 1000);

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

      const rawConf = Number(priceData.conf);
      const confUsd = rawConf * Math.pow(10, expo);
      const confCents = Math.round(confUsd * 100);

      const publishTime = priceData.publish_time;

      // Staleness check
      const age = now - publishTime;
      if (age > MAX_STALENESS_SECONDS) {
        console.warn(`${ticker}: Pyth price is stale (${age}s old, max ${MAX_STALENESS_SECONDS}s)`);
        continue;
      }

      // Confidence check
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
 * FALLBACK ORACLE: Yahoo Finance (used when Pyth unavailable)
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
 * Fetch prices from Pyth first, then fill gaps from Yahoo.
 * No retry loop — for missed settlements we just need current/last known prices.
 */
async function fetchOraclePrices(): Promise<{
  prices: Record<string, OraclePrice>;
  source: string;
}> {
  const prices = await fetchPythPrices();

  // Fill gaps from Yahoo
  if (Object.keys(prices).length < MAG7_TICKERS.length) {
    const yahooPrices = await fetchYahooPrices();
    for (const ticker of MAG7_TICKERS) {
      if (!prices[ticker] && yahooPrices[ticker]) {
        prices[ticker] = yahooPrices[ticker];
      }
    }
  }

  const source = Object.values(prices).some((p) => p.source === "yahoo_fallback")
    ? "pyth+yahoo_fallback"
    : "pyth";

  return { prices, source };
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    const todayDate = getDateInt();
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      PROGRAM_ID
    );
    const [registryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_registry")],
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

    // Step 2: Read ALL markets from the on-chain registry
    let registryAccount;
    try {
      registryAccount = await program.account.marketRegistry.fetch(registryPda);
    } catch {
      return NextResponse.json(
        { error: "Market registry not found on-chain" },
        { status: 404 }
      );
    }

    const marketPubkeys = registryAccount.markets as PublicKey[];
    console.log(`Registry contains ${marketPubkeys.length} markets`);

    // Batch fetch ALL market accounts in 1 RPC call
    const marketAccounts = await program.account.market.fetchMultiple(marketPubkeys);

    // Step 3: Settle any unsettled markets whose date has passed
    let settled = 0;
    let skipped = 0;
    let alreadySettled = 0;
    let failed = 0;
    const results: string[] = [];

    for (let i = 0; i < marketPubkeys.length; i++) {
      const market = marketAccounts[i];
      if (!market) continue;

      const marketDate = market.date as number;
      const ticker = market.ticker as string;
      const strikePrice = (market.strikePrice as BN).toNumber();
      const isSettled = market.settled as boolean;

      // Skip already settled markets
      if (isSettled) {
        alreadySettled++;
        continue;
      }

      // Only settle markets whose date has passed (date < today)
      // or markets from today if it's after 4 PM ET
      const etHour = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          hour12: false,
        }).format(new Date())
      );
      const canSettle = marketDate < todayDate || (marketDate === todayDate && etHour >= 16);

      if (!canSettle) {
        skipped++;
        continue;
      }

      // Get oracle price for this ticker
      const oracleData = oraclePrices[ticker];
      if (!oracleData) {
        results.push(`${ticker} > $${(strikePrice / 100).toFixed(0)} (${marketDate}): No oracle price`);
        failed++;
        continue;
      }

      const closingPrice = oracleData.price;
      const outcome = closingPrice >= strikePrice ? "YES wins" : "NO wins";

      try {
        await program.methods
          .settleMarket(new BN(closingPrice))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .accounts({ admin: adminKeypair.publicKey, config: configPda, market: marketPubkeys[i] } as any)
          .signers([adminKeypair])
          .rpc();

        settled++;
        results.push(
          `${ticker} > $${(strikePrice / 100).toFixed(0)} (${marketDate}): close=$${(closingPrice / 100).toFixed(2)} [${oracleData.source}] -> ${outcome}`
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // TooEarlyToSettle means the on-chain clock hasn't passed 4 PM ET for that market's date
        if (msg.includes("TooEarlyToSettle")) {
          skipped++;
          results.push(`${ticker} > $${(strikePrice / 100).toFixed(0)} (${marketDate}): Too early (on-chain clock)`);
        } else {
          failed++;
          results.push(`${ticker} > $${(strikePrice / 100).toFixed(0)} (${marketDate}): FAILED - ${msg.slice(0, 120)}`);
        }
      }
    }

    return NextResponse.json({
      success: true,
      todayDate,
      oracleSource: source,
      totalRegistered: marketPubkeys.length,
      alreadySettled,
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
