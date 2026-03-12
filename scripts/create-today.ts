#!/usr/bin/env ts-node

/**
 * create-today.ts — Create markets for today with 3 tickers to save SOL.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";

// 3 tickers to save SOL
const TICKERS: Record<string, number> = {
  AAPL: 23500,
  NVDA: 88000,
  TSLA: 27500,
};

const STRIKE_OFFSETS = [-0.06, -0.03, 0, 0.03, 0.06];

const USDC_MINT = new PublicKey("9L1fhmF2PbANM3XJE2527aZXh596EunDDdMYgZXYxntW");

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

  console.log(`\nCreating markets for ${date}`);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  const startBalance = await provider.connection.getBalance(admin.publicKey);
  console.log(`Starting balance: ${(startBalance / 1e9).toFixed(4)} SOL\n`);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [registryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market_registry")],
    program.programId
  );

  let created = 0;

  for (const [ticker, prevClose] of Object.entries(TICKERS)) {
    const strikes = computeStrikes(prevClose);
    console.log(
      `${ticker} → ${strikes.length} strikes: ${strikes.map((s) => "$" + (s / 100).toFixed(0)).join(", ")}`
    );

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
      const [escrowYesPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_yes"), marketPda.toBuffer()],
        program.programId
      );
      const [bidEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bid_escrow"), marketPda.toBuffer()],
        program.programId
      );

      try {
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

        await program.methods
          .initOrderbook()
          .accounts({
            admin: admin.publicKey,
            config: configPda,
            market: marketPda,
            vault: vaultPda,
            orderbook: orderbookPda,
            usdcMint: USDC_MINT,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();

        await program.methods
          .initEscrowYes()
          .accounts({
            admin: admin.publicKey,
            config: configPda,
            market: marketPda,
            escrowYes: escrowYesPda,
            yesMint: yesMintPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();

        await program.methods
          .initBidEscrow()
          .accounts({
            admin: admin.publicKey,
            config: configPda,
            market: marketPda,
            bidEscrow: bidEscrowPda,
            usdcMint: USDC_MINT,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();

        await program.methods
          .registerMarket()
          .accounts({
            admin: admin.publicKey,
            config: configPda,
            marketRegistry: registryPda,
            market: marketPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();

        created++;
        console.log(`  ✅ ${ticker} > $${(strike / 100).toFixed(0)}`);
      } catch (err: any) {
        if (err.message?.includes("already in use")) {
          console.log(
            `  ⏭️  ${ticker} > $${(strike / 100).toFixed(0)} — exists`
          );
        } else {
          console.error(
            `  ❌ ${ticker} > $${(strike / 100).toFixed(0)} — ${err.message?.slice(0, 100)}`
          );
        }
      }
    }
  }

  const endBalance = await provider.connection.getBalance(admin.publicKey);
  const cost = (startBalance - endBalance) / 1e9;
  console.log(`\n✅ Created ${created} markets`);
  console.log(`💰 Cost: ${cost.toFixed(4)} SOL`);
  console.log(`💰 Remaining: ${(endBalance / 1e9).toFixed(4)} SOL\n`);
}

main().catch(console.error);
