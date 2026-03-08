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
  formatStrikePrice,
  formatMarketDate,
  formatTokenAmount,
  formatUsdc,
  parseSolanaError,
  explorerUrl,
} from "@/lib/utils";
import { MAG7_TICKERS } from "@/lib/constants";
import type { Meridian } from "../../target/types/meridian";
import idl from "../../target/idl/meridian.json";

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

      // Fetch all markets in parallel
      const marketResults = await Promise.allSettled(
        marketPubkeys.map((pda) => program.account.market.fetch(pda))
      );

      const userPositions: Position[] = [];

      // For each market, check token balances in parallel
      const balanceChecks = marketPubkeys.map(async (marketPda, index) => {
        const result = marketResults[index];
        if (result.status !== "fulfilled") return null;

        const market = result.value;
        const yesMint = market.yesMint as PublicKey;
        const noMint = market.noMint as PublicKey;

        const [userYesAta, userNoAta] = await Promise.all([
          getAssociatedTokenAddress(yesMint, publicKey),
          getAssociatedTokenAddress(noMint, publicKey),
        ]);

        const [yesResult, noResult] = await Promise.allSettled([
          connection.getTokenAccountBalance(userYesAta),
          connection.getTokenAccountBalance(userNoAta),
        ]);

        const yesBalance =
          yesResult.status === "fulfilled"
            ? new BN(yesResult.value.value.amount)
            : new BN(0);
        const noBalance =
          noResult.status === "fulfilled"
            ? new BN(noResult.value.value.amount)
            : new BN(0);

        if (yesBalance.gt(new BN(0)) || noBalance.gt(new BN(0))) {
          return {
            marketPubkey: marketPda,
            ticker: market.ticker as string,
            strikePrice: market.strikePrice as BN,
            date: market.date as number,
            settled: market.settled as boolean,
            outcomeYesWins: market.outcomeYesWins as boolean,
            yesBalance,
            noBalance,
            yesMint,
            noMint,
          };
        }
        return null;
      });

      const results = await Promise.allSettled(balanceChecks);
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          userPositions.push(r.value);
        }
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

  // Calculate portfolio P&L for each position
  const getPositionValue = (pos: Position): { value: number; pnl: number } => {
    const yesQty = pos.yesBalance.toNumber() / 1_000_000;
    const noQty = pos.noBalance.toNumber() / 1_000_000;

    if (pos.settled) {
      // Settled: winning tokens worth $1, losing worth $0
      const yesValue = pos.outcomeYesWins ? yesQty : 0;
      const noValue = pos.outcomeYesWins ? 0 : noQty;
      const value = yesValue + noValue;
      // Assume average cost basis of $0.50 (we don't track entry price on-chain)
      const costBasis = (yesQty + noQty) * 0.5;
      return { value, pnl: value - costBasis };
    }

    // Active: estimate at 50c each (midpoint) since we don't have live price here
    const value = (yesQty + noQty) * 0.5;
    return { value, pnl: 0 };
  };

  const totalPortfolioValue = positions.reduce(
    (sum, pos) => sum + getPositionValue(pos).value,
    0
  );

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
      {/* Portfolio Summary Header */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-5">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
            Portfolio Value
          </span>
          <p className="mt-1 font-mono text-2xl font-bold text-white">
            ${totalPortfolioValue.toFixed(2)}
          </p>
        </div>
        <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-5">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
            USDC Balance
          </span>
          <p className="mt-1 font-mono text-2xl font-bold text-white">
            ${usdcBalance ? formatUsdc(usdcBalance) : "0.00"}
          </p>
        </div>
        <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-5">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
            Positions
          </span>
          <p className="mt-1 font-mono text-2xl font-bold text-white">
            {positions.length}
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
            href="/"
            className="rounded-xl bg-yellow-500 px-5 py-2.5 text-sm font-bold text-black shadow-lg shadow-yellow-500/20 hover:bg-yellow-400"
          >
            Explore Markets
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {positions.map((pos) => {
            const tickerInfo = MAG7_TICKERS[pos.ticker];
            const canRedeem = pos.settled;
            const winningToken = pos.outcomeYesWins ? "yes" : "no";
            const posValue = getPositionValue(pos);

            return (
              <div
                key={pos.marketPubkey.toBase58()}
                className="animate-fade-in rounded-2xl border border-gray-800/60 bg-gray-900/50 p-5"
              >
                <div className="mb-4 flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-xl text-xs font-bold text-white shadow-lg"
                      style={{
                        backgroundColor: tickerInfo?.color ?? "#6B7280",
                      }}
                    >
                      {pos.ticker.slice(0, 2)}
                    </div>
                    <div>
                      <Link
                        href={`/trade/${pos.marketPubkey.toBase58()}`}
                        className="text-sm font-bold text-white hover:text-yellow-400 transition-colors"
                      >
                        {pos.ticker} &gt; {formatStrikePrice(pos.strikePrice)}
                      </Link>
                      <p className="text-xs text-gray-500">
                        Exp: {formatMarketDate(pos.date)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {pos.settled ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-700/50 px-2.5 py-1 text-[11px] font-semibold text-gray-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
                        {pos.outcomeYesWins ? "Yes Won" : "No Won"}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-2.5 py-1 text-[11px] font-semibold text-yellow-400 ring-1 ring-inset ring-yellow-500/20">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
                        Active
                      </span>
                    )}
                  </div>
                </div>

                {/* Balances + P&L */}
                <div className="mb-4 grid grid-cols-3 gap-3">
                  <div className="rounded-xl bg-gray-800/30 p-3 ring-1 ring-inset ring-gray-700/30">
                    <span className="text-[11px] font-medium text-gray-500">Yes Tokens</span>
                    <p className="font-mono text-sm font-bold text-emerald-400">
                      {formatTokenAmount(pos.yesBalance)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-gray-800/30 p-3 ring-1 ring-inset ring-gray-700/30">
                    <span className="text-[11px] font-medium text-gray-500">No Tokens</span>
                    <p className="font-mono text-sm font-bold text-red-400">
                      {formatTokenAmount(pos.noBalance)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-gray-800/30 p-3 ring-1 ring-inset ring-gray-700/30">
                    <span className="text-[11px] font-medium text-gray-500">Est. Value</span>
                    <p className={`font-mono text-sm font-bold ${
                      posValue.pnl >= 0 ? "text-emerald-400" : "text-red-400"
                    }`}>
                      ${posValue.value.toFixed(2)}
                      {pos.settled && posValue.pnl !== 0 && (
                        <span className="ml-1 text-[11px]">
                          ({posValue.pnl >= 0 ? "+" : ""}{posValue.pnl.toFixed(2)})
                        </span>
                      )}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  {canRedeem ? (
                    <>
                      {pos.yesBalance.gt(new BN(0)) && (
                        <button
                          onClick={() => handleRedeem(pos, "yes")}
                          disabled={
                            redeeming ===
                            `${pos.marketPubkey.toBase58()}-yes`
                          }
                          className={`flex-1 rounded-xl py-2.5 text-sm font-bold transition-all ${
                            winningToken === "yes"
                              ? "bg-emerald-600 text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-500"
                              : "bg-gray-700/50 text-gray-400 hover:bg-gray-600/50"
                          } disabled:opacity-40`}
                        >
                          {redeeming ===
                          `${pos.marketPubkey.toBase58()}-yes`
                            ? "Redeeming..."
                            : `Redeem Yes (${formatTokenAmount(pos.yesBalance)})`}
                        </button>
                      )}
                      {pos.noBalance.gt(new BN(0)) && (
                        <button
                          onClick={() => handleRedeem(pos, "no")}
                          disabled={
                            redeeming ===
                            `${pos.marketPubkey.toBase58()}-no`
                          }
                          className={`flex-1 rounded-xl py-2.5 text-sm font-bold transition-all ${
                            winningToken === "no"
                              ? "bg-emerald-600 text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-500"
                              : "bg-gray-700/50 text-gray-400 hover:bg-gray-600/50"
                          } disabled:opacity-40`}
                        >
                          {redeeming ===
                          `${pos.marketPubkey.toBase58()}-no`
                            ? "Redeeming..."
                            : `Redeem No (${formatTokenAmount(pos.noBalance)})`}
                        </button>
                      )}
                    </>
                  ) : (
                    <Link
                      href={`/trade/${pos.marketPubkey.toBase58()}`}
                      className="flex-1 rounded-xl bg-gray-800/50 py-2.5 text-center text-sm font-bold text-gray-300 ring-1 ring-inset ring-gray-700/30 hover:bg-gray-700/50 transition-all"
                    >
                      Trade
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
