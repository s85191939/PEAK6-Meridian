#!/usr/bin/env ts-node

/**
 * settle-markets.ts — 4 PM ET settlement script.
 *
 * Reads the closing price for each stock (mock data in MVP, Pyth oracle in prod)
 * and settles all open markets for today's date.
 *
 * Usage:
 *   npx ts-node scripts/settle-markets.ts
 *
 * In production, this would:
 *   1. Read Pyth price feeds on-chain for each ticker
 *   2. Verify staleness < 60 seconds and confidence < 1%
 *   3. Submit settlement transactions
 *   4. Be triggered by a cron job at 4:01 PM ET
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// Mock closing prices (in USD cents) — in production, read from Pyth
const CLOSING_PRICES: Record<string, number> = {
  AAPL: 23650, // $236.50
  MSFT: 42300, // $423.00
  GOOGL: 17650, // $176.50
  AMZN: 19800, // $198.00
  NVDA: 87200, // $872.00
  META: 59100, // $591.00
  TSLA: 26800, // $268.00
};

// Same strike computation as create-markets
const STRIKE_OFFSETS = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];
const MAG7_PREV_CLOSE: Record<string, number> = {
  AAPL: 23500,
  MSFT: 42000,
  GOOGL: 17800,
  AMZN: 19500,
  NVDA: 88000,
  META: 58000,
  TSLA: 27500,
};

function getDateInt(): number {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return parseInt(`${year}${month}${day}`);
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

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet as anchor.Wallet;
  const date = getDateInt();

  console.log(`\n⏰ Settling markets for ${date}`);
  console.log(`   Admin: ${admin.publicKey.toBase58()}\n`);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  let settled = 0;
  let skipped = 0;

  for (const [ticker, prevClose] of Object.entries(MAG7_PREV_CLOSE)) {
    const closingPrice = CLOSING_PRICES[ticker];
    if (!closingPrice) {
      console.log(`   ⚠️  No closing price for ${ticker}, skipping`);
      continue;
    }

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
        program.programId
      );

      try {
        // Check if already settled
        const market = await program.account.market.fetch(marketPda);
        if (market.settled) {
          skipped++;
          continue;
        }

        const outcome = closingPrice >= strike ? "YES wins" : "NO wins";

        await program.methods
          .settleMarket(new BN(closingPrice))
          .accounts({
            admin: admin.publicKey,
            config: configPda,
            market: marketPda,
          } as any)
          .rpc();

        settled++;
        console.log(
          `   ✅ ${ticker} > $${(strike / 100).toFixed(0)} — close=$${(closingPrice / 100).toFixed(2)} → ${outcome}`
        );
      } catch (err: any) {
        if (err.message?.includes("Account does not exist")) {
          // Market doesn't exist for this strike today
          continue;
        }
        console.error(
          `   ❌ ${ticker} > $${(strike / 100).toFixed(0)} — ${err.message}`
        );
      }
    }
  }

  console.log(
    `\n✅ Settled ${settled} markets, ${skipped} already settled\n`
  );
}

main().catch(console.error);
