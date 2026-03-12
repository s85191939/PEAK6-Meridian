#!/usr/bin/env ts-node

/**
 * setup-devnet.ts — One-time devnet setup: init config, create USDC, create markets, fund user.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json npx ts-node scripts/setup-devnet.ts [USER_WALLET_ADDRESS]
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";

// MAG7 stocks with mock previous close prices (in USD cents)
const MAG7_STOCKS: Record<string, number> = {
  AAPL: 23500,
  MSFT: 42000,
  GOOGL: 17800,
  AMZN: 19500,
  NVDA: 88000,
  META: 58000,
  TSLA: 27500,
};

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
  const userAddress = process.argv[2]; // Optional: user wallet to fund with USDC

  console.log("\n" + "=".repeat(60));
  console.log("  MERIDIAN — Devnet Setup");
  console.log("=".repeat(60));
  console.log(`\n  Admin:   ${admin.publicKey.toBase58()}`);
  console.log(`  Program: ${program.programId.toBase58()}`);
  console.log(`  Date:    ${date}\n`);

  // ── Step 1: Create mock USDC mint ──
  console.log("📋 Step 1: Creating mock USDC mint...");
  const usdcMint = await createMint(
    provider.connection,
    (admin as any).payer,
    admin.publicKey,
    null,
    6
  );
  console.log(`   ✅ USDC Mint: ${usdcMint.toBase58()}`);

  // ── Step 2: Initialize config ──
  console.log("\n📋 Step 2: Initializing global config...");
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  try {
    await program.methods
      .initialize(usdcMint)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    console.log(`   ✅ Config PDA: ${configPda.toBase58()}`);
  } catch (err: any) {
    if (err.message?.includes("already in use")) {
      console.log(`   ⏭️  Config already initialized`);
    } else {
      throw err;
    }
  }

  // ── Step 3: Initialize market registry ──
  console.log("\n📋 Step 3: Initializing market registry...");
  const [registryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market_registry")],
    program.programId
  );

  try {
    await program.methods
      .initRegistry()
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        marketRegistry: registryPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    console.log(`   ✅ Registry PDA: ${registryPda.toBase58()}`);
  } catch (err: any) {
    if (err.message?.includes("already in use")) {
      console.log(`   ⏭️  Registry already initialized`);
    } else {
      throw err;
    }
  }

  // ── Step 4: Create markets ──
  console.log("\n📊 Step 4: Creating markets...\n");
  let marketsCreated = 0;

  for (const [ticker, prevClose] of Object.entries(MAG7_STOCKS)) {
    const strikes = computeStrikes(prevClose);
    console.log(
      `  ${ticker} (prev close: $${(prevClose / 100).toFixed(2)}) → ${strikes.length} strikes`
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
            usdcMint: usdcMint,
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
            usdcMint: usdcMint,
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

        marketsCreated++;
        console.log(
          `   ✅ ${ticker} > $${(strike / 100).toFixed(0)} — ${marketPda.toBase58().slice(0, 8)}...`
        );
      } catch (err: any) {
        if (err.message?.includes("already in use")) {
          console.log(
            `   ⏭️  ${ticker} > $${(strike / 100).toFixed(0)} — already exists`
          );
        } else {
          console.error(
            `   ❌ ${ticker} > $${(strike / 100).toFixed(0)} — ${err.message?.slice(0, 80)}`
          );
        }
      }
    }
  }

  console.log(`\n   Created ${marketsCreated} markets`);

  // ── Step 5: Fund user with USDC (if address provided) ──
  if (userAddress) {
    console.log(`\n💰 Step 5: Funding user ${userAddress} with USDC...`);
    try {
      const userPubkey = new PublicKey(userAddress);
      const userUsdcAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (admin as any).payer,
        usdcMint,
        userPubkey
      );
      await mintTo(
        provider.connection,
        (admin as any).payer,
        usdcMint,
        userUsdcAta.address,
        admin.publicKey,
        1000_000_000 // $1,000 USDC
      );
      console.log(`   ✅ Minted $1,000 USDC to ${userUsdcAta.address.toBase58()}`);
    } catch (err: any) {
      console.error(`   ❌ Failed to fund user: ${err.message}`);
    }
  } else {
    console.log(
      "\n💡 Tip: Pass user wallet address as argument to fund with USDC:"
    );
    console.log(
      "   npx ts-node scripts/setup-devnet.ts <USER_WALLET_ADDRESS>\n"
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("  ✅ Devnet setup complete!");
  console.log("=".repeat(60) + "\n");
}

main().catch(console.error);
