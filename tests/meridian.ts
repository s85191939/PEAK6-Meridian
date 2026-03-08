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
  let registryPda: PublicKey;
  let marketPda: PublicKey;
  let yesMintPda: PublicKey;
  let noMintPda: PublicKey;
  let vaultPda: PublicKey;
  let orderbookPda: PublicKey;
  let escrowYesPda: PublicKey;
  let bidEscrowPda: PublicKey;

  // Market params
  const ticker = "AAPL";
  const strikePrice = new BN(23000); // $230.00 in cents
  const date = 20260306;

  // Two users for trading
  const user = Keypair.generate();
  const maker = Keypair.generate();

  // Token account addresses
  let userUsdcAddr: PublicKey;
  let userYesAddr: PublicKey;
  let userNoAddr: PublicKey;
  let makerUsdcAddr: PublicKey;
  let makerYesAddr: PublicKey;
  let makerNoAddr: PublicKey;

  before(async () => {
    // Airdrop SOL to both users
    const sig1 = await provider.connection.requestAirdrop(
      user.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    const sig2 = await provider.connection.requestAirdrop(
      maker.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    // Create mock USDC mint (6 decimals)
    usdcMint = await createMint(
      provider.connection,
      (admin as any).payer,
      admin.publicKey,
      null,
      6
    );

    // Derive all PDAs
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [registryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_registry")],
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

    [escrowYesPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_yes"), marketPda.toBuffer()],
      program.programId
    );

    [bidEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bid_escrow"), marketPda.toBuffer()],
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
  // 2. Initialize Market Registry
  // ========================================================

  it("Initializes the market registry", async () => {
    await program.methods
      .initRegistry()
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        marketRegistry: registryPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const registry = await program.account.marketRegistry.fetch(registryPda);
    assert.ok(registry.admin.equals(admin.publicKey));
    assert.equal(registry.markets.length, 0);
  });

  // ========================================================
  // 3. Create Market (Market + Yes/No mints)
  // ========================================================

  it("Creates a market with Yes/No mints", async () => {
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
    assert.ok(market.yesMint.equals(yesMintPda));
    assert.ok(market.noMint.equals(noMintPda));
  });

  // ========================================================
  // 4. Register Market in Registry
  // ========================================================

  it("Registers market in on-chain registry", async () => {
    await program.methods
      .registerMarket()
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        marketRegistry: registryPda,
        market: marketPda,
      } as any)
      .rpc();

    const registry = await program.account.marketRegistry.fetch(registryPda);
    assert.equal(registry.markets.length, 1);
    assert.ok(registry.markets[0].equals(marketPda));
  });

  // ========================================================
  // 5. Init Orderbook (vault + orderbook)
  // ========================================================

  it("Initializes vault + orderbook", async () => {
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
  // 6. Init Escrow Yes (Yes token escrow for ask orders)
  // ========================================================

  it("Initializes escrow_yes for ask order collateral", async () => {
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

    // Verify escrow account exists and is empty
    const escrow = await getAccount(provider.connection, escrowYesPda);
    assert.equal(Number(escrow.amount), 0);
  });

  // ========================================================
  // 7. Init Bid Escrow (USDC escrow for bid orders)
  // ========================================================

  it("Initializes bid_escrow for bid order collateral", async () => {
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

    // Verify escrow account exists and is empty
    const escrow = await getAccount(provider.connection, bidEscrowPda);
    assert.equal(Number(escrow.amount), 0);
  });

  // ========================================================
  // 8. Mint Pairs — $1.00 Invariant
  // ========================================================

  it("Mints Yes/No token pairs by depositing USDC", async () => {
    // Create token accounts for user
    const userUsdcAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection, (admin as any).payer, usdcMint, user.publicKey
    );
    userUsdcAddr = userUsdcAccount.address;

    // Create token accounts for maker
    const makerUsdcAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection, (admin as any).payer, usdcMint, maker.publicKey
    );
    makerUsdcAddr = makerUsdcAccount.address;

    // Fund both users with $10 USDC each
    await mintTo(provider.connection, (admin as any).payer, usdcMint, userUsdcAddr, admin.publicKey, 10_000_000);
    await mintTo(provider.connection, (admin as any).payer, usdcMint, makerUsdcAddr, admin.publicKey, 10_000_000);

    // Create Yes/No token accounts for both
    userYesAddr = (await getOrCreateAssociatedTokenAccount(
      provider.connection, (admin as any).payer, yesMintPda, user.publicKey
    )).address;
    userNoAddr = (await getOrCreateAssociatedTokenAccount(
      provider.connection, (admin as any).payer, noMintPda, user.publicKey
    )).address;
    makerYesAddr = (await getOrCreateAssociatedTokenAccount(
      provider.connection, (admin as any).payer, yesMintPda, maker.publicKey
    )).address;
    makerNoAddr = (await getOrCreateAssociatedTokenAccount(
      provider.connection, (admin as any).payer, noMintPda, maker.publicKey
    )).address;

    // User mints 5 pairs ($5 USDC -> 5 Yes + 5 No)
    await program.methods
      .mintPair(new BN(5_000_000))
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

    // Maker mints 5 pairs ($5 USDC -> 5 Yes + 5 No)
    await program.methods
      .mintPair(new BN(5_000_000))
      .accounts({
        user: maker.publicKey,
        market: marketPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        vault: vaultPda,
        userUsdc: makerUsdcAddr,
        userYes: makerYesAddr,
        userNo: makerNoAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([maker])
      .rpc();

    // Verify balances
    const userUsdc = await getAccount(provider.connection, userUsdcAddr);
    const userYes = await getAccount(provider.connection, userYesAddr);
    const userNo = await getAccount(provider.connection, userNoAddr);
    const vault = await getAccount(provider.connection, vaultPda);

    assert.equal(Number(userUsdc.amount), 5_000_000, "User: $10 - $5 = $5 USDC remaining");
    assert.equal(Number(userYes.amount), 5_000_000, "User should have 5 Yes tokens");
    assert.equal(Number(userNo.amount), 5_000_000, "User should have 5 No tokens");
    assert.equal(Number(vault.amount), 10_000_000, "Vault should hold $10 (5+5 pairs)");

    // $1.00 INVARIANT CHECK: vault == total_pairs_minted
    const market = await program.account.market.fetch(marketPda);
    assert.equal(market.totalPairsMinted.toNumber(), 10_000_000);
    assert.equal(Number(vault.amount), market.totalPairsMinted.toNumber(),
      "$1.00 invariant violated: vault balance != total pairs minted");
  });

  // ========================================================
  // 9. Place Bid — Resting Order (no crossing asks)
  // ========================================================

  it("Places a resting bid order (no crossing asks)", async () => {
    const makerUsdcBefore = Number(
      (await getAccount(provider.connection, makerUsdcAddr)).amount
    );

    // Maker places bid: Buy 2 Yes tokens at $0.60 each
    // USDC locked = 0.60 * 2 = $1.20
    await program.methods
      .placeOrder(true, new BN(600_000), new BN(2_000_000))
      .accounts({
        user: maker.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        bidEscrow: bidEscrowPda,
        escrowYes: escrowYesPda,
        userUsdc: makerUsdcAddr,
        userYes: makerYesAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([maker])
      .rpc();

    // Verify USDC locked in bid_escrow
    const makerUsdcAfter = Number(
      (await getAccount(provider.connection, makerUsdcAddr)).amount
    );
    assert.equal(makerUsdcBefore - makerUsdcAfter, 1_200_000,
      "Maker should lock $1.20 USDC for bid");

    const bidEscrow = await getAccount(provider.connection, bidEscrowPda);
    assert.equal(Number(bidEscrow.amount), 1_200_000,
      "bid_escrow should hold $1.20");

    // Verify resting order on book
    const orderbook = await program.account.orderBook.fetch(orderbookPda);
    assert.equal(orderbook.orders.length, 1);
    assert.equal(orderbook.orders[0].isBid, true);
    assert.equal(orderbook.orders[0].price.toNumber(), 600_000);
    assert.equal(orderbook.orders[0].quantity.toNumber(), 2_000_000);
    assert.equal(orderbook.orders[0].filled.toNumber(), 0);
    assert.equal(orderbook.orders[0].cancelled, false);
    assert.ok(orderbook.orders[0].maker.equals(maker.publicKey));

    // $1.00 INVARIANT: order collateral is separate from vault
    const vault = await getAccount(provider.connection, vaultPda);
    const market = await program.account.market.fetch(marketPda);
    assert.equal(Number(vault.amount), market.totalPairsMinted.toNumber(),
      "$1.00 invariant violated after placing bid");
  });

  // ========================================================
  // 10. Place Ask that Crosses Bid — Match Fill
  // ========================================================

  it("Places an ask that crosses bid -> fills immediately", async () => {
    const userUsdcBefore = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );
    const userYesBefore = Number(
      (await getAccount(provider.connection, userYesAddr)).amount
    );
    const makerYesBefore = Number(
      (await getAccount(provider.connection, makerYesAddr)).amount
    );

    // User places ask: Sell 1 Yes token at $0.50
    // Crosses maker's bid at $0.60 (bid $0.60 >= ask $0.50)
    // Fill at bid price $0.60 (maker's price)
    // remaining_accounts = [maker_yes_account] for bid maker to receive Yes
    await program.methods
      .placeOrder(false, new BN(500_000), new BN(1_000_000))
      .accounts({
        user: user.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        bidEscrow: bidEscrowPda,
        escrowYes: escrowYesPda,
        userUsdc: userUsdcAddr,
        userYes: userYesAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .remainingAccounts([
        { pubkey: makerYesAddr, isWritable: true, isSigner: false },
      ])
      .signers([user])
      .rpc();

    // Verify fill results
    const userUsdcAfter = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );
    const userYesAfter = Number(
      (await getAccount(provider.connection, userYesAddr)).amount
    );
    const makerYesAfter = Number(
      (await getAccount(provider.connection, makerYesAddr)).amount
    );

    // User sold 1 Yes token
    assert.equal(userYesBefore - userYesAfter, 1_000_000,
      "User should have 1 fewer Yes token");

    // User received USDC at the bid price ($0.60)
    assert.equal(userUsdcAfter - userUsdcBefore, 600_000,
      "User should receive $0.60 USDC (filled at bid price)");

    // Maker received 1 Yes token via remaining_accounts
    assert.equal(makerYesAfter - makerYesBefore, 1_000_000,
      "Maker should receive 1 Yes token");

    // Bid partially filled: 1 of 2 tokens
    const orderbook = await program.account.orderBook.fetch(orderbookPda);
    assert.equal(orderbook.orders[0].filled.toNumber(), 1_000_000,
      "Bid should be partially filled (1 of 2)");
    // Fully filled ask should NOT rest on book
    assert.equal(orderbook.orders.length, 1,
      "Fully filled ask should not rest on book");

    // bid_escrow: $1.20 - $0.60 = $0.60 remaining
    const bidEscrow = await getAccount(provider.connection, bidEscrowPda);
    assert.equal(Number(bidEscrow.amount), 600_000,
      "bid_escrow should have $0.60 remaining");

    // escrow_yes: all matched, should be empty
    const escrowYes = await getAccount(provider.connection, escrowYesPda);
    assert.equal(Number(escrowYes.amount), 0,
      "escrow_yes should be empty after fully matched ask");

    // $1.00 INVARIANT
    const vault = await getAccount(provider.connection, vaultPda);
    const market = await program.account.market.fetch(marketPda);
    assert.equal(Number(vault.amount), market.totalPairsMinted.toNumber(),
      "$1.00 invariant violated after order matching");
  });

  // ========================================================
  // 11. Cancel Order — Return Collateral
  // ========================================================

  it("Cancels an open bid order and returns USDC collateral", async () => {
    const makerUsdcBefore = Number(
      (await getAccount(provider.connection, makerUsdcAddr)).amount
    );

    // Cancel order_id=0 (partially filled bid, 1 of 2 remaining)
    // USDC to return = 600_000 * 1_000_000 / 1_000_000 = 600_000
    await program.methods
      .cancelOrder(new BN(0))
      .accounts({
        user: maker.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        bidEscrow: bidEscrowPda,
        escrowYes: escrowYesPda,
        userUsdc: makerUsdcAddr,
        userYes: makerYesAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([maker])
      .rpc();

    // Maker gets back $0.60 USDC
    const makerUsdcAfter = Number(
      (await getAccount(provider.connection, makerUsdcAddr)).amount
    );
    assert.equal(makerUsdcAfter - makerUsdcBefore, 600_000,
      "Maker should receive $0.60 USDC back from cancelled bid");

    // bid_escrow should be empty
    const bidEscrow = await getAccount(provider.connection, bidEscrowPda);
    assert.equal(Number(bidEscrow.amount), 0,
      "bid_escrow should be empty after cancel");

    // Order marked as cancelled
    const orderbook = await program.account.orderBook.fetch(orderbookPda);
    assert.equal(orderbook.orders[0].cancelled, true,
      "Order should be marked cancelled");

    // $1.00 INVARIANT
    const vault = await getAccount(provider.connection, vaultPda);
    const market = await program.account.market.fetch(marketPda);
    assert.equal(Number(vault.amount), market.totalPairsMinted.toNumber(),
      "$1.00 invariant violated after cancel");
  });

  it("Prevents cancelling another user's order", async () => {
    // Place a new bid from maker
    await program.methods
      .placeOrder(true, new BN(500_000), new BN(1_000_000))
      .accounts({
        user: maker.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        bidEscrow: bidEscrowPda,
        escrowYes: escrowYesPda,
        userUsdc: makerUsdcAddr,
        userYes: makerYesAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([maker])
      .rpc();

    // User tries to cancel maker's order
    try {
      await program.methods
        .cancelOrder(new BN(1))
        .accounts({
          user: user.publicKey,
          market: marketPda,
          orderbook: orderbookPda,
          bidEscrow: bidEscrowPda,
          escrowYes: escrowYesPda,
          userUsdc: userUsdcAddr,
          userYes: userYesAddr,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([user])
        .rpc();
      assert.fail("Should have thrown NotOrderOwner");
    } catch (err: any) {
      assert.ok(err, "Should fail with NotOrderOwner error");
    }

    // Clean up: cancel the order properly
    await program.methods
      .cancelOrder(new BN(1))
      .accounts({
        user: maker.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        bidEscrow: bidEscrowPda,
        escrowYes: escrowYesPda,
        userUsdc: makerUsdcAddr,
        userYes: makerYesAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([maker])
      .rpc();
  });

  // ========================================================
  // 12. Merge Pairs — Inverse of Mint, Pre-Settlement Exit
  // ========================================================

  it("Merges Yes/No pairs back to USDC pre-settlement", async () => {
    const usdcBefore = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );
    const yesBefore = Number(
      (await getAccount(provider.connection, userYesAddr)).amount
    );
    const noBefore = Number(
      (await getAccount(provider.connection, userNoAddr)).amount
    );

    // User merges 2 pairs: burn 2 Yes + 2 No -> get $2 USDC back
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

    const usdcAfter = Number((await getAccount(provider.connection, userUsdcAddr)).amount);
    const yesAfter = Number((await getAccount(provider.connection, userYesAddr)).amount);
    const noAfter = Number((await getAccount(provider.connection, userNoAddr)).amount);

    assert.equal(usdcAfter - usdcBefore, 2_000_000, "Should receive $2.00 USDC back");
    assert.equal(yesBefore - yesAfter, 2_000_000, "Should burn 2 Yes tokens");
    assert.equal(noBefore - noAfter, 2_000_000, "Should burn 2 No tokens");

    // $1.00 INVARIANT CHECK
    const vault = await getAccount(provider.connection, vaultPda);
    const market = await program.account.market.fetch(marketPda);
    assert.equal(Number(vault.amount), market.totalPairsMinted.toNumber(),
      "$1.00 invariant violated after merge");
  });

  // ========================================================
  // 13. Settlement
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
      assert.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      assert.ok(err, "Non-admin settlement should fail");
    }
  });

  it("Settles market — Yes wins (close >= strike)", async () => {
    // AAPL closes at $240 >= $230 strike -> Yes wins
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
      assert.ok(err, "Double settlement should fail");
    }
  });

  // ========================================================
  // 14. Redemption
  // ========================================================

  it("Redeems winning Yes tokens for USDC", async () => {
    const yesBal = Number(
      (await getAccount(provider.connection, userYesAddr)).amount
    );
    if (yesBal === 0) return;

    const usdcBefore = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );

    await program.methods
      .redeem(new BN(yesBal))
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

    assert.equal(usdcAfter - usdcBefore, yesBal,
      "Should receive $1.00 USDC per winning Yes token");
    assert.equal(yesAfter, 0, "All Yes tokens should be burned");
  });

  it("Burns losing No tokens with $0 payout", async () => {
    const noBal = Number(
      (await getAccount(provider.connection, userNoAddr)).amount
    );
    if (noBal === 0) return;

    const usdcBefore = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );

    await program.methods
      .redeem(new BN(noBal))
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
    assert.equal(usdcAfter, usdcBefore,
      "Losing No tokens should receive $0 USDC");
  });

  it("Maker redeems winning Yes tokens", async () => {
    const makerYesBal = Number(
      (await getAccount(provider.connection, makerYesAddr)).amount
    );
    if (makerYesBal === 0) return;

    const makerUsdcBefore = Number(
      (await getAccount(provider.connection, makerUsdcAddr)).amount
    );

    await program.methods
      .redeem(new BN(makerYesBal))
      .accounts({
        user: maker.publicKey,
        market: marketPda,
        tokenMint: yesMintPda,
        userToken: makerYesAddr,
        userUsdc: makerUsdcAddr,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([maker])
      .rpc();

    const makerUsdcAfter = Number(
      (await getAccount(provider.connection, makerUsdcAddr)).amount
    );
    assert.equal(makerUsdcAfter - makerUsdcBefore, makerYesBal,
      "Maker should receive USDC for winning Yes tokens");
  });

  // ========================================================
  // 15. Edge Cases
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

  it("Prevents merge on settled market", async () => {
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

  it("Prevents placing orders on settled market", async () => {
    try {
      await program.methods
        .placeOrder(true, new BN(500_000), new BN(1_000_000))
        .accounts({
          user: user.publicKey,
          market: marketPda,
          orderbook: orderbookPda,
          bidEscrow: bidEscrowPda,
          escrowYes: escrowYesPda,
          userUsdc: userUsdcAddr,
          userYes: userYesAddr,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([user])
        .rpc();
      assert.fail("Should have thrown MarketAlreadySettled");
    } catch (err: any) {
      assert.ok(err, "Placing orders on settled market should fail");
    }
  });

  // ========================================================
  // 16. No-Wins Scenario (second market)
  // ========================================================

  it("Handles No-wins correctly (close < strike)", async () => {
    const ticker2 = "NVDA";
    const strikePrice2 = new BN(15000);
    const date2 = 20260307;

    // Derive all PDAs for second market
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
      [Buffer.from("yes_mint"), market2Pda.toBuffer()], program.programId
    );
    const [noMint2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("no_mint"), market2Pda.toBuffer()], program.programId
    );
    const [vault2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), market2Pda.toBuffer()], program.programId
    );
    const [orderbook2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), market2Pda.toBuffer()], program.programId
    );
    const [escrowYes2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_yes"), market2Pda.toBuffer()], program.programId
    );
    const [bidEscrow2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bid_escrow"), market2Pda.toBuffer()], program.programId
    );

    // Full market setup: create -> register -> init_orderbook -> init_escrow_yes -> init_bid_escrow
    await program.methods
      .createMarket(ticker2, strikePrice2, date2)
      .accounts({
        admin: admin.publicKey, config: configPda, market: market2Pda,
        yesMint: yesMint2Pda, noMint: noMint2Pda,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    await program.methods
      .registerMarket()
      .accounts({
        admin: admin.publicKey, config: configPda,
        marketRegistry: registryPda, market: market2Pda,
      } as any)
      .rpc();

    await program.methods
      .initOrderbook()
      .accounts({
        admin: admin.publicKey, config: configPda, market: market2Pda,
        vault: vault2Pda, orderbook: orderbook2Pda, usdcMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    await program.methods
      .initEscrowYes()
      .accounts({
        admin: admin.publicKey, config: configPda, market: market2Pda,
        escrowYes: escrowYes2Pda, yesMint: yesMint2Pda,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    await program.methods
      .initBidEscrow()
      .accounts({
        admin: admin.publicKey, config: configPda, market: market2Pda,
        bidEscrow: bidEscrow2Pda, usdcMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Verify registry has 2 markets
    const registry = await program.account.marketRegistry.fetch(registryPda);
    assert.equal(registry.markets.length, 2, "Registry should have 2 markets");
    assert.ok(registry.markets[1].equals(market2Pda));

    // Fund user and mint pairs for market 2
    await mintTo(
      provider.connection, (admin as any).payer, usdcMint,
      userUsdcAddr, admin.publicKey, 2_000_000
    );

    const userYes2 = await getOrCreateAssociatedTokenAccount(
      provider.connection, (admin as any).payer, yesMint2Pda, user.publicKey
    );
    const userNo2 = await getOrCreateAssociatedTokenAccount(
      provider.connection, (admin as any).payer, noMint2Pda, user.publicKey
    );

    await program.methods
      .mintPair(new BN(2_000_000))
      .accounts({
        user: user.publicKey, market: market2Pda,
        yesMint: yesMint2Pda, noMint: noMint2Pda, vault: vault2Pda,
        userUsdc: userUsdcAddr, userYes: userYes2.address, userNo: userNo2.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([user])
      .rpc();

    // Settle: NVDA = $140 < $150 strike -> No wins
    await program.methods
      .settleMarket(new BN(14000))
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        market: market2Pda,
      } as any)
      .rpc();

    const market2 = await program.account.market.fetch(market2Pda);
    assert.equal(market2.outcomeYesWins, false, "NVDA $140 < $150 -> No should win");

    // Redeem No tokens (winners)
    const usdcBefore = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );

    await program.methods
      .redeem(new BN(2_000_000))
      .accounts({
        user: user.publicKey, market: market2Pda,
        tokenMint: noMint2Pda, userToken: userNo2.address,
        userUsdc: userUsdcAddr, vault: vault2Pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([user])
      .rpc();

    const usdcAfter = Number(
      (await getAccount(provider.connection, userUsdcAddr)).amount
    );
    assert.equal(usdcAfter - usdcBefore, 2_000_000,
      "No-wins: should receive $2.00 USDC for winning No tokens");

    // Vault should be empty after all winners redeemed
    const vault2 = await getAccount(provider.connection, vault2Pda);
    assert.equal(Number(vault2.amount), 0,
      "Vault should be empty after all winners redeemed");
  });
});
