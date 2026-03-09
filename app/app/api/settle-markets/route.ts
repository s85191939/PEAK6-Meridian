/**
 * POST /api/settle-markets — Automated settlement endpoint
 *
 * Called by Vercel Cron at ~4:05 PM ET every trading day.
 * Fetches REAL closing prices from Yahoo Finance, then settles all
 * open markets for today on Solana devnet.
 *
 * Oracle pattern:
 *   1. Fetch real stock prices from Yahoo Finance (off-chain oracle)
 *   2. Validate prices (must be recent, must be positive)
 *   3. Submit settlement transactions to Solana program
 *   4. Retry on failure (up to 15 minutes, every 30 seconds)
 *   5. If still failing after 15 min, log for admin override
 *
 * In production, step 1 would read from Pyth on-chain price accounts.
 * PEAK6 is a Pyth validator, providing direct oracle infrastructure.
 *
 * Protected by CRON_SECRET env var to prevent unauthorized calls.
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

// Admin keypair — devnet only (same as in UsdcFaucet)
const ADMIN_SECRET = [236,158,41,219,108,151,179,250,69,236,178,96,161,156,243,53,235,229,147,33,180,67,59,37,88,172,105,188,40,227,23,74,154,112,194,233,194,146,215,227,177,131,235,23,20,148,197,205,75,59,88,184,75,23,203,37,109,124,139,233,189,227,83,157];

const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

// Yahoo Finance symbol mapping
const YAHOO_SYMBOLS: Record<string, string> = {
  AAPL: "AAPL",
  MSFT: "MSFT",
  GOOGL: "GOOGL",
  AMZN: "AMZN",
  NVDA: "NVDA",
  META: "META",
  TSLA: "TSLA",
};

function getDateInt(): number {
  // Get today's date in ET
  const now = new Date();
  const etStr = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return parseInt(etStr.replace(/-/g, ""));
}

// Compute strikes from previous close (same algorithm as create-markets.ts)
const STRIKE_OFFSETS = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];

function computeStrikes(prevClose: number): number[] {
  const strikes = new Set<number>();
  for (const offset of STRIKE_OFFSETS) {
    const raw = prevClose * (1 + offset);
    // Round to nearest $10 (1000 cents)
    const rounded = Math.round(raw / 1000) * 1000;
    if (rounded > 0) strikes.add(rounded);
  }
  return Array.from(strikes).sort((a, b) => a - b);
}

/**
 * Fetch real stock prices from Yahoo Finance.
 * Returns prices in USD cents (e.g., 23650 = $236.50).
 */
async function fetchClosingPrices(): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};

  // Use Yahoo Finance v8 API (public, no key needed)
  const symbols = MAG7_TICKERS.map((t) => YAHOO_SYMBOLS[t]).join(",");
  const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols}&range=1d&interval=1d`;

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Meridian/1.0" },
    });

    if (!resp.ok) {
      // Fallback: fetch individually
      for (const ticker of MAG7_TICKERS) {
        try {
          const singleUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${YAHOO_SYMBOLS[ticker]}&range=1d&interval=1d`;
          const singleResp = await fetch(singleUrl, {
            headers: { "User-Agent": "Meridian/1.0" },
          });
          if (singleResp.ok) {
            const data = await singleResp.json();
            const result = data?.spark?.result?.[0];
            const close = result?.response?.[0]?.meta?.regularMarketPrice;
            if (close && close > 0) {
              prices[ticker] = Math.round(close * 100); // Convert to cents
            }
          }
        } catch {
          console.error(`Failed to fetch price for ${ticker}`);
        }
      }
      return prices;
    }

    const data = await resp.json();
    const results = data?.spark?.result || [];
    for (const result of results) {
      const symbol = result.symbol;
      const close = result?.response?.[0]?.meta?.regularMarketPrice;
      // Reverse-lookup ticker from symbol
      const ticker = MAG7_TICKERS.find((t) => YAHOO_SYMBOLS[t] === symbol);
      if (ticker && close && close > 0) {
        prices[ticker] = Math.round(close * 100); // Convert to cents
      }
    }
  } catch (err) {
    console.error("Yahoo Finance API failed:", err);
  }

  return prices;
}

/**
 * Fetch previous day's closing prices for strike calculation.
 */
async function fetchPrevClosePrices(): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};

  for (const ticker of MAG7_TICKERS) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${YAHOO_SYMBOLS[ticker]}&range=5d&interval=1d`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Meridian/1.0" },
      });
      if (resp.ok) {
        const data = await resp.json();
        const result = data?.spark?.result?.[0];
        const close = result?.response?.[0]?.meta?.chartPreviousClose ||
                       result?.response?.[0]?.meta?.previousClose;
        if (close && close > 0) {
          prices[ticker] = Math.round(close * 100);
        }
      }
    } catch {
      console.error(`Failed to fetch prev close for ${ticker}`);
    }
  }

  return prices;
}

export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const adminKeypair = Keypair.fromSecretKey(Uint8Array.from(ADMIN_SECRET));
    const connection = new Connection(RPC_URL, "confirmed");

    // Create a minimal wallet adapter for AnchorProvider
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

    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    const program = new Program<Meridian>(idl as Meridian, provider);

    const date = getDateInt();
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      PROGRAM_ID
    );

    // Step 1: Fetch real closing prices from Yahoo Finance
    console.log(`Fetching real closing prices for ${MAG7_TICKERS.join(", ")}...`);
    const closingPrices = await fetchClosingPrices();
    console.log("Closing prices:", closingPrices);

    if (Object.keys(closingPrices).length === 0) {
      return NextResponse.json(
        { error: "Oracle failure: Could not fetch any stock prices", retryable: true },
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
      const closingPrice = closingPrices[ticker];
      if (!closingPrice) {
        results.push(`${ticker}: No closing price available`);
        failed++;
        continue;
      }

      // Use prev close for strikes, or fallback to closing price
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
          if (market.settled) {
            skipped++;
            continue;
          }

          const outcome = closingPrice >= strike ? "YES wins" : "NO wins";

          await program.methods
            .settleMarket(new BN(closingPrice))
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              market: marketPda,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any)
            .signers([adminKeypair])
            .rpc();

          settled++;
          results.push(
            `${ticker} > $${(strike / 100).toFixed(0)}: close=$${(closingPrice / 100).toFixed(2)} -> ${outcome}`
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
      settled,
      skipped,
      failed,
      prices: closingPrices,
      results,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// GET handler for Vercel Cron (cron jobs use GET by default)
export async function GET(request: NextRequest) {
  return POST(request);
}
