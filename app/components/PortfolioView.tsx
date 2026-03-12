"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import Link from "next/link";
import {
  findConfigPda,
  findMarketRegistryPda,
  findVaultPda,
  findOrderbookPda,
  formatStrikePrice,
  formatMarketDate,
  formatUsdc,
  parseSolanaError,
  explorerUrl,
} from "@/lib/utils";
import { MAG7_TICKERS } from "@/lib/constants";
import type { Meridian } from "@/lib/idl/meridian";
import idl from "@/lib/idl/meridian.json";

interface Position {
  marketPubkey: PublicKey;
  ticker: string;
  strikePrice: BN;
  date: number;
  settled: boolean;
  outcomeYesWins: boolean;
  yesBalance: BN;
  noBalance: BN;
  yesMint: PublicKey;
  noMint: PublicKey;
  entryPrice: number | null; // avg entry price from on-chain orders
  costBasis: number | null;  // total cost = avgPrice * quantity
}

export default function PortfolioView() {
  const { publicKey, signTransaction, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [redeeming, setRedeeming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<BN | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  const fetchPositions = useCallback(async () => {
    if (!publicKey) {
      setPositions([]);
      setLoading(false);
      return;
    }

    try {
      setError(null);
      const provider = new AnchorProvider(
        connection,
        {
          publicKey,
          signTransaction: signTransaction ?? (async (tx) => tx),
          signAllTransactions: async (txs) => txs,
        },
        { commitment: "confirmed" }
      );
      const program = new Program<Meridian>(idl as Meridian, provider);

      // Fetch USDC balance
      try {
        const [configPda] = findConfigPda();
        const configAccount = await program.account.config.fetch(configPda);
        const usdcMint = configAccount.usdcMint as PublicKey;
        const userUsdcAta = await getAssociatedTokenAddress(usdcMint, publicKey);
        const usdcAcct = await connection.getTokenAccountBalance(userUsdcAta);
        setUsdcBalance(new BN(usdcAcct.value.amount));
      } catch {
        setUsdcBalance(null);
      }

      // Fetch market registry
      const [registryPda] = findMarketRegistryPda();
      let registryAccount;
      try {
        registryAccount = await program.account.marketRegistry.fetch(registryPda);
      } catch {
        setPositions([]);
        setLoading(false);
        return;
      }

      const marketPubkeys = registryAccount.markets as PublicKey[];

      // Batch fetch markets in chunks of 100 (Solana RPC limit)
      const BATCH_SIZE = 100;
      const marketAccounts: (any | null)[] = [];
      for (let i = 0; i < marketPubkeys.length; i += BATCH_SIZE) {
        const chunk = marketPubkeys.slice(i, i + BATCH_SIZE);
        const results = await program.account.market.fetchMultiple(chunk);
        marketAccounts.push(...results);
      }

      // Derive all token ATAs for the user (Yes + No for each market)
      const atas: PublicKey[] = [];
      const ataMap: { index: number; type: "yes" | "no" }[] = [];

      for (let i = 0; i < marketPubkeys.length; i++) {
        const market = marketAccounts[i];
        if (!market) continue;

        const yesAta = await getAssociatedTokenAddress(market.yesMint as PublicKey, publicKey);
        const noAta = await getAssociatedTokenAddress(market.noMint as PublicKey, publicKey);
        atas.push(yesAta, noAta);
        ataMap.push({ index: i, type: "yes" }, { index: i, type: "no" });
      }

      // Batch fetch token balances in chunks of 100 (Solana RPC limit)
      const ataInfos: (import("@solana/web3.js").AccountInfo<Buffer> | null)[] = [];
      for (let i = 0; i < atas.length; i += BATCH_SIZE) {
        const chunk = atas.slice(i, i + BATCH_SIZE);
        const results = await connection.getMultipleAccountsInfo(chunk);
        ataInfos.push(...results);
      }

      // Parse balances and build positions
      const balances = new Map<number, { yesBalance: BN; noBalance: BN }>();
      for (let j = 0; j < ataInfos.length; j++) {
        const info = ataInfos[j];
        const { index, type } = ataMap[j];
        if (!balances.has(index)) {
          balances.set(index, { yesBalance: new BN(0), noBalance: new BN(0) });
        }
        if (info && info.data.length >= 72) {
          // SPL Token account: amount is at offset 64, 8 bytes LE
          const amount = new BN(info.data.subarray(64, 72), "le");
          if (type === "yes") balances.get(index)!.yesBalance = amount;
          else balances.get(index)!.noBalance = amount;
        }
      }

      // Collect markets with positions, then batch-fetch orderbooks for entry prices
      const positionIndices: number[] = [];
      for (const [i, bal] of balances.entries()) {
        if (bal.yesBalance.gt(new BN(0)) || bal.noBalance.gt(new BN(0))) {
          positionIndices.push(i);
        }
      }

      // Batch fetch orderbooks for all markets with positions (chunked)
      const orderbookPdas = positionIndices.map((i) => findOrderbookPda(marketPubkeys[i])[0]);
      const orderbookAccounts: (any | null)[] = [];
      for (let i = 0; i < orderbookPdas.length; i += BATCH_SIZE) {
        const chunk = orderbookPdas.slice(i, i + BATCH_SIZE);
        const results = await program.account.orderBook.fetchMultiple(chunk);
        orderbookAccounts.push(...results);
      }

      const userPositions: Position[] = [];
      for (let j = 0; j < positionIndices.length; j++) {
        const i = positionIndices[j];
        const bal = balances.get(i)!;
        const market = marketAccounts[i]!;

        // Compute entry price from on-chain order history
        let entryPrice: number | null = null;
        let costBasis: number | null = null;
        const orderbook = orderbookAccounts[j];
        if (orderbook) {
          const userOrders = (orderbook.orders as any[]).filter(
            (o: any) => o.maker.equals(publicKey) && new BN(o.filled).gt(new BN(0))
          );

          if (userOrders.length > 0) {
            // For bids (buying Yes): entry price = avg fill price
            // For asks (selling Yes to get No): entry price = 1 - avg fill price
            const holdingYes = bal.yesBalance.gt(new BN(0));
            let totalFilled = 0;
            let totalCost = 0;

            for (const order of userOrders) {
              const filledQty = Number(order.filled) / 1_000_000;
              const orderPrice = Number(order.price) / 1_000_000;

              if (order.isBid && holdingYes) {
                // User bought Yes via bid
                totalFilled += filledQty;
                totalCost += filledQty * orderPrice;
              } else if (!order.isBid && !holdingYes) {
                // User sold Yes (from mint_pair) to keep No → entry = 1 - askPrice
                totalFilled += filledQty;
                totalCost += filledQty * (1 - orderPrice);
              }
            }

            if (totalFilled > 0) {
              entryPrice = Math.round((totalCost / totalFilled) * 100) / 100;
              const contracts = Math.max(
                bal.yesBalance.toNumber() / 1_000_000,
                bal.noBalance.toNumber() / 1_000_000
              );
              costBasis = entryPrice * contracts;
            }
          }
        }

        userPositions.push({
          marketPubkey: marketPubkeys[i],
          ticker: market.ticker as string,
          strikePrice: market.strikePrice as BN,
          date: market.date as number,
          settled: market.settled as boolean,
          outcomeYesWins: market.outcomeYesWins as boolean,
          yesBalance: bal.yesBalance,
          noBalance: bal.noBalance,
          yesMint: market.yesMint as PublicKey,
          noMint: market.noMint as PublicKey,
          entryPrice,
          costBasis,
        });
      }

      setPositions(userPositions);
    } catch (err) {
      console.error("Failed to fetch positions:", err);
      setError("Failed to load positions. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [publicKey, signTransaction, connection]);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  const handleRedeem = useCallback(
    async (position: Position, tokenType: "yes" | "no") => {
      if (!publicKey || !signTransaction) return;
      const key = `${position.marketPubkey.toBase58()}-${tokenType}`;
      setRedeeming(key);
      setError(null);
      setTxSignature(null);

      try {
        const provider = new AnchorProvider(
          connection,
          { publicKey, signTransaction, signAllTransactions: async (txs) => txs },
          { commitment: "confirmed" }
        );
        const program = new Program<Meridian>(idl as Meridian, provider);

        const tokenMint =
          tokenType === "yes" ? position.yesMint : position.noMint;
        const amount =
          tokenType === "yes" ? position.yesBalance : position.noBalance;

        const userToken = await getAssociatedTokenAddress(tokenMint, publicKey);

        const [configPda] = findConfigPda();
        const configAccount = await program.account.config.fetch(configPda);
        const usdcMint = configAccount.usdcMint as PublicKey;

        const userUsdc = await getAssociatedTokenAddress(usdcMint, publicKey);
        const [vaultPda] = findVaultPda(position.marketPubkey);

        const tx = await program.methods
          .redeem(amount)
          .accounts({
            user: publicKey,
            market: position.marketPubkey,
            tokenMint,
            userToken,
            userUsdc,
            vault: vaultPda,
          })
          .transaction();

        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, "confirmed");
        setTxSignature(sig);

        await fetchPositions();
      } catch (err: unknown) {
        setError(parseSolanaError(err));
      } finally {
        setRedeeming(null);
      }
    },
    [publicKey, signTransaction, connection, sendTransaction, fetchPositions]
  );

  // Helper: determine if user won this position
  const didWin = (pos: Position): boolean | null => {
    if (!pos.settled) return null; // still active
    const holdingYes = pos.yesBalance.gt(new BN(0));
    const holdingNo = pos.noBalance.gt(new BN(0));
    if (holdingYes && pos.outcomeYesWins) return true;
    if (holdingNo && !pos.outcomeYesWins) return true;
    return false;
  };

  // Helper: get payout amount
  const getPayout = (pos: Position): number => {
    if (!pos.settled) return 0;
    const yesQty = pos.yesBalance.toNumber() / 1_000_000;
    const noQty = pos.noBalance.toNumber() / 1_000_000;
    if (pos.outcomeYesWins) return yesQty; // Yes tokens pay $1 each
    return noQty; // No tokens pay $1 each
  };

  // Helper: contracts count
  const getContracts = (pos: Position): number => {
    const yesQty = pos.yesBalance.toNumber() / 1_000_000;
    const noQty = pos.noBalance.toNumber() / 1_000_000;
    return Math.max(yesQty, noQty);
  };

  // Summary stats
  const totalWinnings = positions.reduce((sum, pos) => sum + getPayout(pos), 0);
  const winnersCount = positions.filter((p) => didWin(p) === true).length;
  const losersCount = positions.filter((p) => didWin(p) === false).length;
  const activeCount = positions.filter((p) => didWin(p) === null).length;

  // Sort: winners first (redeemable), then active, then losers
  const sortedPositions = [...positions].sort((a, b) => {
    const aWin = didWin(a);
    const bWin = didWin(b);
    if (aWin === true && bWin !== true) return -1;
    if (bWin === true && aWin !== true) return 1;
    if (aWin === null && bWin !== null) return -1;
    if (bWin === null && aWin !== null) return 1;
    return 0;
  });

  if (!publicKey) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center rounded-2xl border border-gray-800/60 bg-gray-900/50 p-8">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-800/50">
          <svg
            className="h-8 w-8 text-gray-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"
            />
          </svg>
        </div>
        <h3 className="mb-2 text-lg font-bold text-white">
          Connect Your Wallet
        </h3>
        <p className="text-sm text-gray-500">
          Connect a Solana wallet to view your positions and portfolio.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center rounded-2xl border border-gray-800/60 bg-gray-900/50">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent" />
          <span className="text-sm text-gray-400">Loading portfolio...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Portfolio Summary — simple 3 cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-5">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
            USDC Balance
          </span>
          <p className="mt-1 font-mono text-2xl font-bold text-white">
            ${usdcBalance ? formatUsdc(usdcBalance) : "0.00"}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-600">
            available to trade
          </p>
        </div>
        <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-5">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
            Winnings to Collect
          </span>
          <p className="mt-1 font-mono text-2xl font-bold text-emerald-400">
            ${totalWinnings.toFixed(2)}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-600">
            {winnersCount > 0 ? `${winnersCount} winning position${winnersCount > 1 ? "s" : ""}` : "no wins yet"}
          </p>
        </div>
        <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-5">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
            Positions
          </span>
          <p className="mt-1 font-mono text-2xl font-bold text-white">
            {positions.length}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-600">
            {activeCount > 0 && `${activeCount} active`}
            {activeCount > 0 && (winnersCount > 0 || losersCount > 0) && " · "}
            {winnersCount > 0 && `${winnersCount} won`}
            {winnersCount > 0 && losersCount > 0 && " · "}
            {losersCount > 0 && `${losersCount} lost`}
            {activeCount === 0 && winnersCount === 0 && losersCount === 0 && "no positions"}
          </p>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 rounded-xl bg-red-500/8 px-4 py-3 ring-1 ring-inset ring-red-500/20">
          <svg className="mt-0.5 h-4 w-4 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      {/* Success */}
      {txSignature && (
        <div className="flex items-start gap-2 rounded-xl bg-emerald-500/8 px-4 py-3 ring-1 ring-inset ring-emerald-500/20">
          <svg className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="text-sm text-emerald-400">
            Redeemed successfully!{" "}
            <a
              href={explorerUrl(txSignature)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-emerald-300"
            >
              View on Explorer &rarr;
            </a>
          </div>
        </div>
      )}

      {/* Positions list */}
      {positions.length === 0 ? (
        <div className="flex min-h-[300px] flex-col items-center justify-center rounded-2xl border border-gray-800/60 bg-gray-900/50 p-8">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-800/50">
            <svg
              className="h-8 w-8 text-gray-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-bold text-white">
            No Positions Yet
          </h3>
          <p className="mb-4 text-sm text-gray-500">
            Start trading to see your positions here.
          </p>
          <Link
            href="/markets"
            className="rounded-xl bg-yellow-500 px-5 py-2.5 text-sm font-bold text-black shadow-lg shadow-yellow-500/20 hover:bg-yellow-400"
          >
            Explore Markets
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedPositions.map((pos) => {
            const tickerInfo = MAG7_TICKERS[pos.ticker];
            const won = didWin(pos);
            const payout = getPayout(pos);
            const contracts = getContracts(pos);
            const holdingYes = pos.yesBalance.gt(new BN(0));
            const holdingNo = pos.noBalance.gt(new BN(0));
            const winningToken = pos.outcomeYesWins ? "yes" : "no";
            const strikeStr = formatStrikePrice(pos.strikePrice);

            // Plain English prediction
            const prediction = holdingYes
              ? `${pos.ticker} closes above ${strikeStr}`
              : `${pos.ticker} closes below ${strikeStr}`;

            // Card styling based on outcome
            const cardBorder = won === true
              ? "border-emerald-500/30"
              : won === false
                ? "border-gray-800/40"
                : "border-yellow-500/20";
            const cardBg = won === false ? "bg-gray-900/30" : "bg-gray-900/50";
            const cardOpacity = won === false ? "opacity-60" : "";

            return (
              <div
                key={pos.marketPubkey.toBase58()}
                className={`animate-fade-in rounded-2xl border ${cardBorder} ${cardBg} ${cardOpacity} p-5 transition-all`}
              >
                {/* Top row: ticker + outcome badge */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-xl text-xs font-bold text-white shadow-lg"
                      style={{ backgroundColor: tickerInfo?.color ?? "#6B7280" }}
                    >
                      {pos.ticker.slice(0, 2)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/trade/${pos.marketPubkey.toBase58()}`}
                          className="text-sm font-bold text-white hover:text-yellow-400 transition-colors"
                        >
                          {pos.ticker} &gt; {strikeStr}
                        </Link>
                      </div>
                      <p className="text-xs text-gray-500">
                        {formatMarketDate(pos.date)} · {contracts} contract{contracts !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>

                  {/* Big outcome badge */}
                  {won === true && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-400 ring-1 ring-inset ring-emerald-500/25">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      Won ${payout.toFixed(2)}
                    </span>
                  )}
                  {won === false && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-700/40 px-3 py-1.5 text-xs font-semibold text-gray-500">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      Lost
                    </span>
                  )}
                  {won === null && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-3 py-1.5 text-xs font-bold text-yellow-400 ring-1 ring-inset ring-yellow-500/20">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
                      Waiting for result
                    </span>
                  )}
                </div>

                {/* Prediction line — plain English */}
                <div className="mt-3 flex items-center gap-2 rounded-xl bg-gray-800/30 px-4 py-2.5 ring-1 ring-inset ring-gray-700/20">
                  <span className={`text-xs font-bold uppercase tracking-wide ${holdingYes ? "text-emerald-400" : "text-red-400"}`}>
                    {holdingYes ? "YES" : "NO"}
                  </span>
                  <span className="text-sm text-gray-300">
                    You predicted: <span className="font-medium text-white">{prediction}</span>
                  </span>
                </div>

                {/* Action button — only for winners and active */}
                {won === true && (
                  <div className="mt-3 flex gap-2">
                    {holdingYes && (
                      <button
                        onClick={() => handleRedeem(pos, "yes")}
                        disabled={redeeming === `${pos.marketPubkey.toBase58()}-yes`}
                        className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-bold text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-500 disabled:opacity-40 transition-all"
                      >
                        {redeeming === `${pos.marketPubkey.toBase58()}-yes`
                          ? "Collecting..."
                          : `Collect $${payout.toFixed(2)}`}
                      </button>
                    )}
                    {holdingNo && (
                      <button
                        onClick={() => handleRedeem(pos, "no")}
                        disabled={redeeming === `${pos.marketPubkey.toBase58()}-no`}
                        className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-bold text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-500 disabled:opacity-40 transition-all"
                      >
                        {redeeming === `${pos.marketPubkey.toBase58()}-no`
                          ? "Collecting..."
                          : `Collect $${payout.toFixed(2)}`}
                      </button>
                    )}
                  </div>
                )}

                {won === null && (
                  <div className="mt-3">
                    <Link
                      href={`/trade/${pos.marketPubkey.toBase58()}`}
                      className="block rounded-xl bg-gray-800/50 py-2.5 text-center text-sm font-bold text-gray-300 ring-1 ring-inset ring-gray-700/30 hover:bg-gray-700/50 transition-all"
                    >
                      View Market
                    </Link>
                  </div>
                )}

                {/* Lost positions: subtle note, no action */}
                {won === false && (
                  <p className="mt-2 text-center text-[11px] text-gray-600">
                    Market settled — {pos.outcomeYesWins ? `${pos.ticker} closed above ${strikeStr}` : `${pos.ticker} closed below ${strikeStr}`}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
