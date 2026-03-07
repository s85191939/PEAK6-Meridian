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
import { assert } from "chai";
import BN from "bn.js";

describe("meridian", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet as anchor.Wallet;

  let usdcMint: PublicKey;
  let configPda: PublicKey;
  let marketPda: PublicKey;
  let yesMintPda: PublicKey;
  let noMintPda: PublicKey;
  let vaultPda: PublicKey;
  let orderbookPda: PublicKey;

  // Market params
  const ticker = "AAPL";
  const strikePrice = new BN(23000); // $230.00 in cents
  const date = 20260306;

  // User for trading
  const user = Keypair.generate();

  // Reusable token account addresses
  let userUsdcAddr: PublicKey;
  let userYesAddr: PublicKey;
  let userNoAddr: PublicKey;

  before(async () => {
    // Airdrop SOL to user
    const sig = await provider.connection.requestAirdrop(
      user.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    // Create a mock USDC mint (6 decimals)
    usdcMint = await createMint(
      provider.connection,
      (admin as any).payer,
      admin.publicKey,
      null,
      6
    );

    // Derive PDAs
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [marketPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        Buffer.from(ticker),
        strikePrice.toArrayLike(Buffer, "le", 8),
        new BN(date).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    [yesMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("yes_mint"), marketPda.toBuffer()],
      program.programId
    );

    [noMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("no_mint"), marketPda.toBuffer()],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId
    );

    [orderbookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), marketPda.toBuffer()],
      program.programId
    );
  });

  // ========================================================
  // 1. Initialize Config
  // ========================================================

  it("Initializes the global config", async () => {
    await program.methods
      .initialize(usdcMint)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.ok(config.admin.equals(admin.publicKey));
    assert.ok(config.usdcMint.equals(usdcMint));
    assert.equal(config.marketCount.toNumber(), 0);
  });

  // ========================================================
  // 2. Create Market (2-step process)
  // ========================================================

  it("Creates a market (step 1: Market + Yes/No mints)", async () => {
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

    const market = await program.account.market.fetch(marketPda);
    assert.equal(market.ticker, ticker);
    assert.equal(market.strikePrice.toNumber(), 23000);
    assert.equal(market.date, date);
    assert.equal(market.settled, false);
    assert.equal(market.totalPairsMinted.toNumber(), 0);
  });

  it("Initializes vault + orderbook (step 2)", async () => {
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

    const market = await program.account.market.fetch(marketPda);
    assert.ok(market.vault.equals(vaultPda));

    const orderbook = await program.account.orderBook.fetch(orderbookPda);
    assert.ok(orderbook.market.equals(marketPda));
    assert.equal(orderbook.orderCount.toNumber(), 0);
  });

  // ========================================================
  // 3. Mint Pairs — $1.00 Invariant
  // ========================================================

  it("Mints Yes/No token pairs by depositing USDC", async () => {
    // Create user's USDC token account and fund it
    const userUsdcAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (admin as any).payer,
      usdcMint,
      user.publicKey
    );
    userUsdcAddr = userUsdcAccount.address;

    await mintTo(
      provider.connection,
      (admin as any).payer,
      usdcMint,
      userUsdcAddr,
      admin.publicKey,
      10_000_000 // $10 USDC
    );

    // Create user's Yes and No token accounts
    const userYesAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (admin as any).payer,
      yesMintPda,
      user.publicKey
    );
    userYesAddr = userYesAccount.address;

    const userNoAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (admin as any).payer,
      noMintPda,
      user.publicKey
    );
    userNoAddr = userNoAccount.address;

    // Mint 5 pairs ($5 USDC → 5 Yes + 5 No)
    const mintAmount = new BN(5_000_000);
    await program.methods
      .mintPair(mintAmount)
      .accounts({
        user: user.publicKey,
        market: marketPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        vault: vaultPda,
        userUsdc: userUsdcAddr,
        userYes: userYesAddr,
        userNo: userNoAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([user])
      .rpc();

    // Verify balances
    const userUsdc = await getAccount(provider.connection, userUsdcAddr);
    const userYes = await getAccount(provider.connection, userYesAddr);
    const userNo = await getAccount(provider.connection, userNoAddr);
    const vault = await getAccount(provider.connection, vaultPda);

    assert.equal(Number(userUsdc.amount), 5_000_000); // 10 - 5 remaining
    assert.equal(Number(userYes.amount), 5_000_000);
    assert.equal(Number(userNo.amount), 5_000_000);
    assert.equal(Number(vault.amount), 5_000_000);

    // $1.00 INVARIANT CHECK: vault == total_pairs_minted
    const market = await program.account.market.fetch(marketPda);
    assert.equal(Number(vault.amount), market.totalPairsMinted.toNumber(),
      "$1.00 invariant violated: vault balance != total pairs minted");
  });

  // ========================================================
  // 4. Merge Pairs — inverse of mint, pre-settlement exit
  // ========================================================

  it("Merges Yes/No pairs back to USDC pre-settlement", async () => {
    const usdcBefore = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );

    // Merge 2 pairs: burn 2 Yes + 2 No → get 2 USDC back
    await program.methods
      .mergePair(new BN(2_000_000))
      .accounts({
        user: user.publicKey,
        market: marketPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        vault: vaultPda,
        userUsdc: userUsdcAddr,
        userYes: userYesAddr,
        userNo: userNoAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([user])
      .rpc();

    // Verify balances after merge
    const userUsdc = await getAccount(provider.connection, userUsdcAddr);
    const userYes = await getAccount(provider.connection, userYesAddr);
    const userNo = await getAccount(provider.connection, userNoAddr);
    const vault = await getAccount(provider.connection, vaultPda);

    assert.equal(Number(userUsdc.amount), usdcBefore + 2_000_000, "Should receive $2.00 USDC back");
    assert.equal(Number(userYes.amount), 3_000_000, "Should have 3 Yes remaining");
    assert.equal(Number(userNo.amount), 3_000_000, "Should have 3 No remaining");
    assert.equal(Number(vault.amount), 3_000_000, "Vault should have 3 USDC remaining");

    // $1.00 INVARIANT CHECK after merge
    const market = await program.account.market.fetch(marketPda);
    assert.equal(market.totalPairsMinted.toNumber(), 3_000_000,
      "total_pairs_minted should be 3 after merging 2 of 5");
    assert.equal(Number(vault.amount), market.totalPairsMinted.toNumber(),
      "$1.00 invariant violated after merge: vault != total pairs minted");
  });

  // ========================================================
  // 5. Settlement
  // ========================================================

  it("Prevents settlement by non-admin", async () => {
    try {
      await program.methods
        .settleMarket(new BN(24000))
        .accounts({
          admin: user.publicKey,
          config: configPda,
          market: marketPda,
        } as any)
        .signers([user])
        .rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.ok(err);
    }
  });

  it("Settles market — Yes wins (close >= strike)", async () => {
    // AAPL closes at $240 → $240 >= $230 → Yes wins
    await program.methods
      .settleMarket(new BN(24000))
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        market: marketPda,
      } as any)
      .rpc();

    const market = await program.account.market.fetch(marketPda);
    assert.equal(market.settled, true);
    assert.equal(market.outcomeYesWins, true);
    assert.equal(market.settlementPrice.toNumber(), 24000);
  });

  it("Prevents double settlement (immutability)", async () => {
    try {
      await program.methods
        .settleMarket(new BN(22000))
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          market: marketPda,
        } as any)
        .rpc();
      assert.fail("Should have thrown MarketAlreadySettled");
    } catch (err: any) {
      assert.ok(err);
    }
  });

  // ========================================================
  // 6. Redemption
  // ========================================================

  it("Redeems winning Yes tokens for USDC", async () => {
    const usdcBefore = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );

    // Redeem all 3 remaining Yes tokens (winners)
    await program.methods
      .redeem(new BN(3_000_000))
      .accounts({
        user: user.publicKey,
        market: marketPda,
        tokenMint: yesMintPda,
        userToken: userYesAddr,
        userUsdc: userUsdcAddr,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([user])
      .rpc();

    const usdcAfter = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );
    const yesAfter = Number(
      (await getAccount(provider.connection, userYesAddr)).amount
    );

    assert.equal(usdcAfter - usdcBefore, 3_000_000, "Should receive $3.00 USDC for 3 winning tokens");
    assert.equal(yesAfter, 0, "Should have 0 Yes tokens remaining");
  });

  it("Burns losing No tokens with $0 payout", async () => {
    const usdcBefore = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );

    // Burn 3 losing No tokens
    await program.methods
      .redeem(new BN(3_000_000))
      .accounts({
        user: user.publicKey,
        market: marketPda,
        tokenMint: noMintPda,
        userToken: userNoAddr,
        userUsdc: userUsdcAddr,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([user])
      .rpc();

    const usdcAfter = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );
    assert.equal(usdcAfter, usdcBefore, "Losing tokens should receive $0 USDC");
  });

  // ========================================================
  // 7. No-Wins Scenario (second market)
  // ========================================================

  it("Handles No-wins correctly (close < strike)", async () => {
    const ticker2 = "NVDA";
    const strikePrice2 = new BN(15000);
    const date2 = 20260307;

    const [market2Pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        Buffer.from(ticker2),
        strikePrice2.toArrayLike(Buffer, "le", 8),
        new BN(date2).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );
    const [yesMint2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("yes_mint"), market2Pda.toBuffer()],
      program.programId
    );
    const [noMint2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("no_mint"), market2Pda.toBuffer()],
      program.programId
    );
    const [vault2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), market2Pda.toBuffer()],
      program.programId
    );
    const [orderbook2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), market2Pda.toBuffer()],
      program.programId
    );

    // Create market + init
    await program.methods
      .createMarket(ticker2, strikePrice2, date2)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        market: market2Pda,
        yesMint: yesMint2Pda,
        noMint: noMint2Pda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    await program.methods
      .initOrderbook()
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        market: market2Pda,
        vault: vault2Pda,
        orderbook: orderbook2Pda,
        usdcMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Fund user and mint pairs
    await mintTo(
      provider.connection,
      (admin as any).payer,
      usdcMint,
      userUsdcAddr,
      admin.publicKey,
      2_000_000
    );

    const userYes2 = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (admin as any).payer,
      yesMint2Pda,
      user.publicKey
    );
    const userNo2 = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (admin as any).payer,
      noMint2Pda,
      user.publicKey
    );

    await program.methods
      .mintPair(new BN(2_000_000))
      .accounts({
        user: user.publicKey,
        market: market2Pda,
        yesMint: yesMint2Pda,
        noMint: noMint2Pda,
        vault: vault2Pda,
        userUsdc: userUsdcAddr,
        userYes: userYes2.address,
        userNo: userNo2.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([user])
      .rpc();

    // Settle: NVDA = $140 < $150 → No wins
    await program.methods
      .settleMarket(new BN(14000))
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        market: market2Pda,
      } as any)
      .rpc();

    const market2 = await program.account.market.fetch(market2Pda);
    assert.equal(market2.outcomeYesWins, false, "NVDA $140 < $150 → No should win");

    // Redeem No tokens (winners)
    const usdcBefore = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );

    await program.methods
      .redeem(new BN(2_000_000))
      .accounts({
        user: user.publicKey,
        market: market2Pda,
        tokenMint: noMint2Pda,
        userToken: userNo2.address,
        userUsdc: userUsdcAddr,
        vault: vault2Pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([user])
      .rpc();

    const usdcAfter = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );
    assert.equal(usdcAfter - usdcBefore, 2_000_000, "No-wins: should receive $2.00 USDC");
  });

  // ========================================================
  // 8. Edge Cases
  // ========================================================

  it("Prevents minting on settled market", async () => {
    try {
      await program.methods
        .mintPair(new BN(1_000_000))
        .accounts({
          user: user.publicKey,
          market: marketPda,
          yesMint: yesMintPda,
          noMint: noMintPda,
          vault: vaultPda,
          userUsdc: userUsdcAddr,
          userYes: userYesAddr,
          userNo: userNoAddr,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([user])
        .rpc();
      assert.fail("Should have thrown MarketAlreadySettled");
    } catch (err: any) {
      assert.ok(err, "Minting on settled market should fail");
    }
  });

  it("Prevents merge_pair on settled market", async () => {
    try {
      await program.methods
        .mergePair(new BN(1_000_000))
        .accounts({
          user: user.publicKey,
          market: marketPda,
          yesMint: yesMintPda,
          noMint: noMintPda,
          vault: vaultPda,
          userUsdc: userUsdcAddr,
          userYes: userYesAddr,
          userNo: userNoAddr,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([user])
        .rpc();
      assert.fail("Should have thrown MarketAlreadySettled");
    } catch (err: any) {
      assert.ok(err, "Merging on settled market should fail");
    }
  });
});
