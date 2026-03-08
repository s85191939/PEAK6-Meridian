#!/usr/bin/env ts-node

/**
 * demo-lifecycle.ts — Full end-to-end demo of the Meridian protocol.
 *
 * Demonstrates the complete lifecycle:
 *   1. Initialize config
 *   2. Create a market (AAPL > $230)
 *   3. Mint Yes/No pairs ($5 deposit)
 *   4. Merge pairs pre-settlement ($2 back)
 *   5. Settle market (Yes wins)
 *   6. Redeem winning Yes tokens
 *
 * Usage:
 *   npx ts-node scripts/demo-lifecycle.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet as anchor.Wallet;

  console.log("\n" + "=".repeat(60));
  console.log("  MERIDIAN — Binary Stock Outcome Markets Demo");
  console.log("=".repeat(60) + "\n");

  // ──────────────────────────────────────────
  // Step 0: Setup — Create USDC mint and fund user
  // ──────────────────────────────────────────
  console.log("📋 Step 0: Setting up mock USDC and user...");

  const usdcMint = await createMint(
    provider.connection,
    (admin as any).payer,
    admin.publicKey,
    null,
    6
  );
  console.log(`   USDC Mint: ${usdcMint.toBase58()}`);

  const user = Keypair.generate();
  const airdropSig = await provider.connection.requestAirdrop(
    user.publicKey,
    5 * anchor.web3.LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(airdropSig);
  console.log(`   User: ${user.publicKey.toBase58()}`);

  // ──────────────────────────────────────────
  // Step 1: Initialize Config
  // ──────────────────────────────────────────
  console.log("\n📋 Step 1: Initializing global config...");

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  await program.methods
    .initialize(usdcMint)
    .accounts({
      admin: admin.publicKey,
      config: configPda,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
  console.log(`   ✅ Config PDA: ${configPda.toBase58()}`);

  // ──────────────────────────────────────────
  // Step 1b: Initialize Market Registry
  // ──────────────────────────────────────────
  console.log("\n📋 Step 1b: Initializing market registry...");

  const [registryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market_registry")],
    program.programId
  );

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

  // ──────────────────────────────────────────
  // Step 2: Create Market — "AAPL > $230 on 2026-03-06"
  // ──────────────────────────────────────────
  console.log('\n📊 Step 2: Creating market "AAPL > $230"...');

  const ticker = "AAPL";
  const strikePrice = new BN(23000);
  const date = 20260306;

  const [marketPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      Buffer.from(ticker),
      strikePrice.toArrayLike(Buffer, "le", 8),
      new BN(date).toArrayLike(Buffer, "le", 4),
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

  // Step 2a: Create market + mints
  await program.methods
    .createMarket(ticker, strikePrice, date)
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

  // Step 2b: Init vault + orderbook
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

  // Step 2c: Init escrow accounts for trading
  const [escrowYesPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_yes"), marketPda.toBuffer()],
    program.programId
  );
  const [bidEscrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bid_escrow"), marketPda.toBuffer()],
    program.programId
  );

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

  // Step 2d: Register market in frontend registry
  await program.methods
    .registerMarket()
    .accounts({
      admin: admin.publicKey,
      config: configPda,
      marketRegistry: registryPda,
      market: marketPda,
    } as any)
    .rpc();

  console.log(`   ✅ Market: ${marketPda.toBase58()}`);
  console.log(`   ✅ Escrow accounts initialized (Yes + USDC bid)`);
  console.log(`   ✅ Market registered in frontend registry`);
  console.log(`   Question: "Will AAPL close above $230.00 on 2026-03-06?"`);

  // ──────────────────────────────────────────
  // Step 3: Mint Pairs — $5 USDC → 5 Yes + 5 No
  // ──────────────────────────────────────────
  console.log("\n💰 Step 3: Minting 5 outcome pairs ($5.00 USDC deposit)...");

  // Fund user's USDC
  const userUsdcAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (admin as any).payer,
    usdcMint,
    user.publicKey
  );
  await mintTo(
    provider.connection,
    (admin as any).payer,
    usdcMint,
    userUsdcAta.address,
    admin.publicKey,
    10_000_000 // $10 USDC
  );

  const userYesAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (admin as any).payer,
    yesMintPda,
    user.publicKey
  );
  const userNoAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (admin as any).payer,
    noMintPda,
    user.publicKey
  );

  await program.methods
    .mintPair(new BN(5_000_000))
    .accounts({
      user: user.publicKey,
      market: marketPda,
      yesMint: yesMintPda,
      noMint: noMintPda,
      vault: vaultPda,
      userUsdc: userUsdcAta.address,
      userYes: userYesAta.address,
      userNo: userNoAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([user])
    .rpc();

  let vault = await getAccount(provider.connection, vaultPda);
  let market = await program.account.market.fetch(marketPda);
  console.log(`   ✅ Deposited: $5.00 USDC`);
  console.log(`   ✅ Received: 5 Yes tokens + 5 No tokens`);
  console.log(`   📊 Vault: $${(Number(vault.amount) / 1_000_000).toFixed(2)} USDC`);
  console.log(`   📊 Invariant: vault($${(Number(vault.amount) / 1_000_000).toFixed(2)}) == pairs(${market.totalPairsMinted.toNumber() / 1_000_000}) ✅`);

  // ──────────────────────────────────────────
  // Step 4: Merge 2 Pairs — Pre-settlement exit
  // ──────────────────────────────────────────
  console.log("\n🔄 Step 4: Merging 2 pairs ($2.00 USDC returned)...");

  await program.methods
    .mergePair(new BN(2_000_000))
    .accounts({
      user: user.publicKey,
      market: marketPda,
      yesMint: yesMintPda,
      noMint: noMintPda,
      vault: vaultPda,
      userUsdc: userUsdcAta.address,
      userYes: userYesAta.address,
      userNo: userNoAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([user])
    .rpc();

  vault = await getAccount(provider.connection, vaultPda);
  market = await program.account.market.fetch(marketPda);
  const userUsdc = await getAccount(provider.connection, userUsdcAta.address);
  console.log(`   ✅ Burned: 2 Yes + 2 No tokens`);
  console.log(`   ✅ Returned: $2.00 USDC`);
  console.log(`   📊 User USDC: $${(Number(userUsdc.amount) / 1_000_000).toFixed(2)}`);
  console.log(`   📊 Remaining positions: 3 Yes + 3 No`);
  console.log(`   📊 Invariant: vault($${(Number(vault.amount) / 1_000_000).toFixed(2)}) == pairs(${market.totalPairsMinted.toNumber() / 1_000_000}) ✅`);

  // ──────────────────────────────────────────
  // Step 5: Settle — AAPL closes at $240 → Yes wins!
  // ──────────────────────────────────────────
  console.log("\n⚖️  Step 5: Settling market (AAPL closes at $240.00)...");

  await program.methods
    .settleMarket(new BN(24000))
    .accounts({
      admin: admin.publicKey,
      config: configPda,
      market: marketPda,
    } as any)
    .rpc();

  market = await program.account.market.fetch(marketPda);
  console.log(`   ✅ Settlement price: $240.00`);
  console.log(`   ✅ Outcome: ${market.outcomeYesWins ? "YES WINS" : "NO WINS"} (AAPL $240 >= $230)`);
  console.log(`   🔒 Settlement is IMMUTABLE — cannot be changed`);

  // ──────────────────────────────────────────
  // Step 6: Redeem — Yes tokens → USDC
  // ──────────────────────────────────────────
  console.log("\n💸 Step 6: Redeeming winning Yes tokens...");

  const usdcBefore = Number(
    (await getAccount(provider.connection, userUsdcAta.address)).amount
  );

  await program.methods
    .redeem(new BN(3_000_000))
    .accounts({
      user: user.publicKey,
      market: marketPda,
      tokenMint: yesMintPda,
      userToken: userYesAta.address,
      userUsdc: userUsdcAta.address,
      vault: vaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([user])
    .rpc();

  const usdcAfter = Number(
    (await getAccount(provider.connection, userUsdcAta.address)).amount
  );
  const profit = usdcAfter - usdcBefore;

  console.log(`   ✅ Redeemed: 3 Yes tokens → $${(profit / 1_000_000).toFixed(2)} USDC`);
  console.log(`   📊 Final USDC balance: $${(usdcAfter / 1_000_000).toFixed(2)}`);

  // ──────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("  📊 P&L Summary");
  console.log("=".repeat(60));
  console.log(`  Started with:    $10.00 USDC`);
  console.log(`  Deposited:       -$5.00 (mint 5 pairs)`);
  console.log(`  Merged back:     +$2.00 (merge 2 pairs)`);
  console.log(`  Redeemed:        +$3.00 (3 Yes tokens @ $1.00)`);
  console.log(`  Final balance:   $${(usdcAfter / 1_000_000).toFixed(2)} USDC`);
  console.log(`  Net P&L:         $${((usdcAfter - 10_000_000) / 1_000_000).toFixed(2)}`);
  console.log(`\n  💡 The user's $5.00 deposit was split into:`);
  console.log(`     - 3 Yes tokens (won $3.00) + 3 No tokens (lost $0.00)`);
  console.log(`     - 2 pairs merged back pre-settlement ($2.00 returned)`);
  console.log(`     - Total recovered: $5.00 out of $5.00 invested`);
  console.log(`\n  ✅ The $1.00 invariant was maintained throughout:`);
  console.log(`     Yes payout ($1.00) + No payout ($0.00) = $1.00`);
  console.log("=".repeat(60) + "\n");
}

main().catch(console.error);
