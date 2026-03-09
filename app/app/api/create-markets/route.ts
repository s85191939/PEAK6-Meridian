/**
 * POST /api/create-markets — Automated morning market creation
 *
 * Called by Vercel Cron at ~8:30 AM ET every trading day.
 * Fetches REAL previous closing prices from Yahoo Finance,
 * calculates strikes at +/-3%, +/-6%, +/-9% (rounded to $10, deduplicated),
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
const STRIKE_OFFSETS = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];

function getDateInt(): number {
  const now = new Date();
  const etStr = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return parseInt(etStr.replace(/-/g, ""));
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

async function fetchPrevClosePrices(): Promise<Record<string, number>> {
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

          // 5. Register market
          await program.methods
            .registerMarket()
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              market: marketPda,
              registry: registryPda,
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
