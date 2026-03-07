#!/usr/bin/env ts-node

/**
 * create-markets.ts — Morning script to create daily strike markets.
 *
 * For each MAG7 stock, creates strike markets at:
 *   ±3%, ±6%, ±9% from previous close, rounded to $10, deduplicated.
 *
 * Usage:
 *   npx ts-node scripts/create-markets.ts
 *
 * Requires:
 *   - Solana CLI configured with admin keypair
 *   - Program deployed to the configured cluster
 *   - Config PDA already initialized
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";

// MAG7 stocks with mock previous close prices (in USD cents)
// In production, these would come from a Pyth oracle or market data API
const MAG7_STOCKS: Record<string, number> = {
  AAPL: 23500, // $235.00
  MSFT: 42000, // $420.00
  GOOGL: 17800, // $178.00
  AMZN: 19500, // $195.00
  NVDA: 88000, // $880.00
  META: 58000, // $580.00
  TSLA: 27500, // $275.00
};

// Strike offsets from previous close
const STRIKE_OFFSETS = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];

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
    // Round to nearest $10 (1000 cents)
    const rounded = Math.round(raw / 1000) * 1000;
    if (rounded > 0) {
      strikes.add(rounded);
    }
  }
  return Array.from(strikes).sort((a, b) => a - b);
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet as anchor.Wallet;
  const date = getDateInt();

  console.log(`\n🏗️  Creating markets for ${date}`);
  console.log(`   Admin: ${admin.publicKey.toBase58()}`);
  console.log(`   Program: ${program.programId.toBase58()}\n`);

  // Derive config PDA
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const config = await program.account.config.fetch(configPda);
  const usdcMint = config.usdcMint;

  let marketsCreated = 0;

  for (const [ticker, prevClose] of Object.entries(MAG7_STOCKS)) {
    const strikes = computeStrikes(prevClose);
    console.log(
      `📊 ${ticker} (prev close: $${(prevClose / 100).toFixed(2)}) → ${strikes.length} strikes`
    );

    for (const strike of strikes) {
      const strikeBn = new BN(strike);
      const dateBn = new BN(date);

      // Derive PDAs
      const [marketPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("market"),
          Buffer.from(ticker),
          strikeBn.toArrayLike(Buffer, "le", 8),
          dateBn.toArrayLike(Buffer, "le", 4),
        ],
        program.programId
      );
      const [yesMintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("yes_mint"), marketPda.toBuffer()],
        program.programId
      );
      const [noMintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("no_mint"), marketPda.toBuffer()],
        program.programId
      );
      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), marketPda.toBuffer()],
        program.programId
      );
      const [orderbookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), marketPda.toBuffer()],
        program.programId
      );

      try {
        // Step 1: Create market + mints
        await program.methods
          .createMarket(ticker, strikeBn, date)
          .accounts({
            admin: admin.publicKey,
            config: configPda,
            market: marketPda,
            yesMint: yesMintPda,
            noMint: noMintPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();

        // Step 2: Init orderbook + vault
        await program.methods
          .initOrderbook()
          .accounts({
            admin: admin.publicKey,
            config: configPda,
            market: marketPda,
            vault: vaultPda,
            orderbook: orderbookPda,
            usdcMint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();

        marketsCreated++;
        console.log(
          `   ✅ ${ticker} > $${(strike / 100).toFixed(0)} — market: ${marketPda.toBase58().slice(0, 8)}...`
        );
      } catch (err: any) {
        // Skip if market already exists (idempotent)
        if (err.message?.includes("already in use")) {
          console.log(
            `   ⏭️  ${ticker} > $${(strike / 100).toFixed(0)} — already exists`
          );
        } else {
          console.error(
            `   ❌ ${ticker} > $${(strike / 100).toFixed(0)} — ${err.message}`
          );
        }
      }
    }
  }

  console.log(`\n✅ Created ${marketsCreated} new markets for ${date}\n`);
}

main().catch(console.error);
