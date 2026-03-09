import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import BN from "bn.js";

const USDC_MINT = new PublicKey("9L1fhmF2PbANM3XJE2527aZXh596EunDDdMYgZXYxntW");

// Market-making spread config: for each strike, set a Yes price that reflects
// how likely the outcome is. Lower strikes → higher Yes price (more likely).
// We'll place asks (from mint_pair) and bids at various levels.
const TICKER_CONFIG: Record<string, { prevClose: number }> = {
  AAPL: { prevClose: 235 },
  NVDA: { prevClose: 880 },
  TSLA: { prevClose: 275 },
};

function getDateInt(): number {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return parseInt(`${year}${month}${day}`);
}

/** Estimate a fair Yes price based on how far strike is from prevClose */
function estimateYesPrice(strike: number, prevClose: number): number {
  // strike is in cents, prevClose in dollars
  const strikeUsd = strike / 100;
  const diff = (strikeUsd - prevClose) / prevClose; // positive = OTM, negative = ITM
  // Map diff to probability: far ITM → 0.85, at money → 0.50, far OTM → 0.15
  const prob = Math.max(0.10, Math.min(0.90, 0.50 - diff * 5));
  // Round to nearest 5 cents
  return Math.round(prob * 20) / 20;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet as anchor.Wallet;
  const date = getDateInt();

  console.log(`\nSeeding orders for markets on ${date}`);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  const startBalance = await provider.connection.getBalance(admin.publicKey);
  console.log(`SOL: ${(startBalance / 1e9).toFixed(4)}`);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [registryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market_registry")],
    program.programId
  );

  // Fetch registry to find all markets
  const registry = await program.account.marketRegistry.fetch(registryPda);
  const marketPubkeys = registry.markets as PublicKey[];

  let seeded = 0;

  for (const marketPk of marketPubkeys) {
    let market;
    try {
      market = await program.account.market.fetch(marketPk);
    } catch {
      continue;
    }

    // Only seed active (unsettled) markets for today
    if (market.settled) continue;
    if (market.date !== date) continue;

    const ticker = market.ticker as string;
    const config = TICKER_CONFIG[ticker];
    if (!config) continue;

    const strike = (market.strikePrice as BN).toNumber();
    const yesPrice = estimateYesPrice(strike, config.prevClose);
    const askPrice = Math.round((yesPrice + 0.02) * 1_000_000); // ask slightly above fair
    const bidPrice = Math.round((yesPrice - 0.02) * 1_000_000); // bid slightly below fair

    // Clamp prices to valid range
    const clampedAsk = Math.max(10_000, Math.min(990_000, askPrice));
    const clampedBid = Math.max(10_000, Math.min(990_000, bidPrice));

    console.log(
      `\n${ticker} > $${(strike / 100).toFixed(0)} — fair: ${(yesPrice * 100).toFixed(0)}¢, bid: ${(clampedBid / 10_000).toFixed(0)}¢, ask: ${(clampedAsk / 10_000).toFixed(0)}¢`
    );

    try {
      // Get/create token accounts for admin
      const adminUsdc = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin.payer,
        USDC_MINT,
        admin.publicKey
      );

      const adminYes = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin.payer,
        market.yesMint as PublicKey,
        admin.publicKey
      );

      const adminNo = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin.payer,
        market.noMint as PublicKey,
        admin.publicKey
      );

      // Derive PDAs
      const [orderbookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), marketPk.toBuffer()],
        program.programId
      );
      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), marketPk.toBuffer()],
        program.programId
      );
      const [escrowYesPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_yes"), marketPk.toBuffer()],
        program.programId
      );
      const [bidEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bid_escrow"), marketPk.toBuffer()],
        program.programId
      );

      const qty = new BN(5_000_000); // 5 contracts

      // Step 1: Mint 5 pairs ($5 USDC → 5 Yes + 5 No)
      await program.methods
        .mintPair(qty)
        .accounts({
          user: admin.publicKey,
          config: configPda,
          market: marketPk,
          yesMint: market.yesMint,
          noMint: market.noMint,
          vault: vaultPda,
          userUsdc: adminUsdc.address,
          userYes: adminYes.address,
          userNo: adminNo.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();

      console.log(`  ✅ Minted 5 pairs`);

      // Step 2: Place ask (sell 3 Yes tokens at ask price)
      const askQty = new BN(3_000_000); // 3 contracts
      await program.methods
        .placeOrder(false, new BN(clampedAsk), askQty)
        .accounts({
          user: admin.publicKey,
          config: configPda,
          market: marketPk,
          orderbook: orderbookPda,
          bidEscrow: bidEscrowPda,
          escrowYes: escrowYesPda,
          userUsdc: adminUsdc.address,
          userYes: adminYes.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();

      console.log(`  ✅ Ask placed: 3 Yes @ $${(clampedAsk / 1_000_000).toFixed(2)}`);

      // Step 3: Place bid (buy 3 Yes tokens at bid price)
      const bidQty = new BN(3_000_000); // 3 contracts
      await program.methods
        .placeOrder(true, new BN(clampedBid), bidQty)
        .accounts({
          user: admin.publicKey,
          config: configPda,
          market: marketPk,
          orderbook: orderbookPda,
          bidEscrow: bidEscrowPda,
          escrowYes: escrowYesPda,
          userUsdc: adminUsdc.address,
          userYes: adminYes.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();

      console.log(`  ✅ Bid placed: 3 Yes @ $${(clampedBid / 1_000_000).toFixed(2)}`);

      seeded++;
    } catch (err: any) {
      console.error(`  ❌ ${err.message?.slice(0, 120)}`);
    }
  }

  const endBalance = await provider.connection.getBalance(admin.publicKey);
  const cost = (startBalance - endBalance) / 1e9;
  console.log(`\n✅ Seeded ${seeded} markets`);
  console.log(`💰 SOL cost: ${cost.toFixed(4)}`);
  console.log(`💰 SOL remaining: ${(endBalance / 1e9).toFixed(4)}\n`);
}

main().catch(console.error);
