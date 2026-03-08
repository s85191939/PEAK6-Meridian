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

  const fetchPositions = useCallback(async () => {
    if (!publicKey) {
      setPositions([]);
      setLoading(false);
      return;
    }

    try {
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

      // Fetch market registry to get all market pubkeys
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
      const userPositions: Position[] = [];

      for (const marketPda of marketPubkeys) {
        try {
          const market = await program.account.market.fetch(marketPda);

          const yesMint = market.yesMint as PublicKey;
          const noMint = market.noMint as PublicKey;

          const userYesAta = await getAssociatedTokenAddress(
            yesMint,
            publicKey
          );
          const userNoAta = await getAssociatedTokenAddress(
            noMint,
            publicKey
          );

          let yesBalance = new BN(0);
          let noBalance = new BN(0);

          try {
            const yesAccount = await connection.getTokenAccountBalance(
              userYesAta
            );
            yesBalance = new BN(yesAccount.value.amount);
          } catch {
            // ATA does not exist
          }

          try {
            const noAccount = await connection.getTokenAccountBalance(
              userNoAta
            );
            noBalance = new BN(noAccount.value.amount);
          } catch {
            // ATA does not exist
          }

          if (yesBalance.gt(new BN(0)) || noBalance.gt(new BN(0))) {
            userPositions.push({
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
            });
          }
        } catch {
          // Market may not exist at this index
        }
      }

      setPositions(userPositions);
    } catch (err) {
      console.error("Failed to fetch positions:", err);
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

        // Fetch config to get USDC mint
        const [configPda] = findConfigPda();
        const configAccount = await program.account.config.fetch(configPda);
        const usdcMint = configAccount.usdcMint as PublicKey;

        const userUsdc = await getAssociatedTokenAddress(
          usdcMint,
          publicKey
        );

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

        await fetchPositions();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Redemption failed";
        setError(message);
      } finally {
        setRedeeming(null);
      }
    },
    [publicKey, signTransaction, connection, sendTransaction, fetchPositions]
  );

  if (!publicKey) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center rounded-xl border border-gray-800 bg-gray-900 p-8">
        <svg
          className="mb-4 h-12 w-12 text-gray-600"
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
        <h3 className="mb-2 text-lg font-semibold text-white">
          Connect Your Wallet
        </h3>
        <p className="text-sm text-gray-500">
          Connect a Solana wallet to view your positions.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center rounded-xl border border-gray-800 bg-gray-900">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          <span className="text-sm text-gray-400">Loading positions...</span>
        </div>
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center rounded-xl border border-gray-800 bg-gray-900 p-8">
        <svg
          className="mb-4 h-12 w-12 text-gray-600"
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
        <h3 className="mb-2 text-lg font-semibold text-white">
          No Positions
        </h3>
        <p className="mb-4 text-sm text-gray-500">
          You don&apos;t have any open positions yet.
        </p>
        <Link
          href="/"
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          Explore Markets
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {positions.map((pos) => {
        const tickerInfo = MAG7_TICKERS[pos.ticker];
        const canRedeem = pos.settled;
        const winningToken = pos.outcomeYesWins ? "yes" : "no";

        return (
          <div
            key={pos.marketPubkey.toBase58()}
            className="rounded-xl border border-gray-800 bg-gray-900 p-5"
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white"
                  style={{
                    backgroundColor: tickerInfo?.color ?? "#6B7280",
                  }}
                >
                  {pos.ticker.slice(0, 2)}
                </div>
                <div>
                  <Link
                    href={`/trade/${pos.marketPubkey.toBase58()}`}
                    className="text-sm font-semibold text-white hover:text-emerald-400"
                  >
                    {pos.ticker} &gt; {formatStrikePrice(pos.strikePrice)}
                  </Link>
                  <p className="text-xs text-gray-500">
                    Exp: {formatMarketDate(pos.date)}
                  </p>
                </div>
              </div>

              {pos.settled ? (
                <span className="inline-flex items-center rounded-full bg-gray-700 px-2.5 py-0.5 text-xs font-medium text-gray-300">
                  {pos.outcomeYesWins ? "Yes Won" : "No Won"}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-emerald-900/50 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
                  Active
                </span>
              )}
            </div>

            {/* Balances */}
            <div className="mb-4 grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-gray-800/50 p-3">
                <span className="text-xs text-gray-500">Yes Tokens</span>
                <p className="text-sm font-semibold text-emerald-400">
                  {formatTokenAmount(pos.yesBalance)}
                </p>
              </div>
              <div className="rounded-lg bg-gray-800/50 p-3">
                <span className="text-xs text-gray-500">No Tokens</span>
                <p className="text-sm font-semibold text-red-400">
                  {formatTokenAmount(pos.noBalance)}
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
                      className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
                        winningToken === "yes"
                          ? "bg-emerald-600 text-white hover:bg-emerald-500"
                          : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                      } disabled:opacity-50`}
                    >
                      {redeeming ===
                      `${pos.marketPubkey.toBase58()}-yes`
                        ? "Redeeming..."
                        : `Redeem Yes (${formatTokenAmount(
                            pos.yesBalance
                          )})`}
                    </button>
                  )}
                  {pos.noBalance.gt(new BN(0)) && (
                    <button
                      onClick={() => handleRedeem(pos, "no")}
                      disabled={
                        redeeming ===
                        `${pos.marketPubkey.toBase58()}-no`
                      }
                      className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
                        winningToken === "no"
                          ? "bg-emerald-600 text-white hover:bg-emerald-500"
                          : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                      } disabled:opacity-50`}
                    >
                      {redeeming ===
                      `${pos.marketPubkey.toBase58()}-no`
                        ? "Redeeming..."
                        : `Redeem No (${formatTokenAmount(
                            pos.noBalance
                          )})`}
                    </button>
                  )}
                </>
              ) : (
                <Link
                  href={`/trade/${pos.marketPubkey.toBase58()}`}
                  className="flex-1 rounded-lg bg-gray-800 py-2.5 text-center text-sm font-semibold text-gray-300 hover:bg-gray-700"
                >
                  Trade
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
