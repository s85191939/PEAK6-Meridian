"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import Link from "next/link";
import {
  findMarketRegistryPda,
  findOrderbookPda,
  formatStrikePrice,
  formatMarketDate,
  formatPrice,
  shortenAddress,
  explorerUrl,
} from "@/lib/utils";
import { MAG7_TICKERS, PRICE_DECIMALS } from "@/lib/constants";
import type { Meridian } from "../../../target/types/meridian";
import idl from "../../../target/idl/meridian.json";

interface HistoryEntry {
  marketPubkey: PublicKey;
  ticker: string;
  strikePrice: BN;
  date: number;
  orderId: number;
  isBid: boolean;
  price: BN;
  quantity: BN;
  filled: BN;
  timestamp: number;
  cancelled: boolean;
  settled: boolean;
  outcomeYesWins: boolean;
}

export default function HistoryPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!publicKey) {
      setEntries([]);
      setLoading(false);
      return;
    }

    try {
      setError(null);
      setLoading(true);

      const provider = new AnchorProvider(
        connection,
        {
          publicKey: PublicKey.default,
          signTransaction: async (tx) => tx,
          signAllTransactions: async (txs) => txs,
        },
        { commitment: "confirmed" }
      );
      const program = new Program<Meridian>(idl as Meridian, provider);

      // Fetch market registry
      const [registryPda] = findMarketRegistryPda();
      let registry;
      try {
        registry = await program.account.marketRegistry.fetch(registryPda);
      } catch {
        setEntries([]);
        setLoading(false);
        return;
      }

      const allEntries: HistoryEntry[] = [];
      const marketKeys = (registry.markets as PublicKey[]).filter(
        (k: PublicKey) => !k.equals(PublicKey.default)
      );

      // Fetch all markets and orderbooks in parallel
      const results = await Promise.allSettled(
        marketKeys.map(async (marketKey: PublicKey) => {
          const [orderbookPda] = findOrderbookPda(marketKey);
          const [marketAccount, orderbookAccount] = await Promise.all([
            program.account.market.fetch(marketKey),
            program.account.orderBook.fetch(orderbookPda),
          ]);

          const orders = orderbookAccount.orders as Array<{
            orderId: BN;
            maker: PublicKey;
            isBid: boolean;
            price: BN;
            quantity: BN;
            filled: BN;
            timestamp: BN;
            cancelled: boolean;
          }>;

          for (const order of orders) {
            if (order.maker.equals(publicKey)) {
              allEntries.push({
                marketPubkey: marketKey,
                ticker: marketAccount.ticker as string,
                strikePrice: marketAccount.strikePrice as BN,
                date: marketAccount.date as number,
                orderId: (order.orderId as BN).toNumber(),
                isBid: order.isBid,
                price: order.price,
                quantity: order.quantity,
                filled: order.filled,
                timestamp: (order.timestamp as BN).toNumber(),
                cancelled: order.cancelled,
                settled: marketAccount.settled as boolean,
                outcomeYesWins: marketAccount.outcomeYesWins as boolean,
              });
            }
          }
        })
      );

      // Log any errors but continue
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.warn(`Failed to fetch market ${marketKeys[i]?.toBase58()}:`, r.reason);
        }
      });

      // Sort by timestamp descending (most recent first)
      allEntries.sort((a, b) => b.timestamp - a.timestamp);
      setEntries(allEntries);
    } catch (err) {
      console.error("Failed to fetch history:", err);
      setError("Failed to load trade history. Check your connection to Solana Devnet.");
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const divisor = Math.pow(10, PRICE_DECIMALS);
  const qtyDivisor = Math.pow(10, 6);

  const getStatusBadge = (entry: HistoryEntry) => {
    if (entry.cancelled) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-gray-700/50 px-2 py-0.5 text-[11px] font-semibold text-gray-400">
          Cancelled
        </span>
      );
    }
    const remaining = entry.quantity.sub(entry.filled);
    if (remaining.isZero()) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
          Filled
        </span>
      );
    }
    if (entry.filled.gt(new BN(0))) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/10 px-2 py-0.5 text-[11px] font-semibold text-yellow-400">
          Partial
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-semibold text-blue-400">
        Open
      </span>
    );
  };

  if (!publicKey) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <h1 className="mb-6 text-2xl font-bold text-white">Trade History</h1>
        <div className="flex min-h-[400px] flex-col items-center justify-center rounded-2xl border border-gray-800/60 bg-gray-900/50 p-8">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-yellow-500/10">
            <svg className="h-8 w-8 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-bold text-white">Connect Your Wallet</h3>
          <p className="text-center text-sm text-gray-500">
            Connect your wallet to view your trade history across all Meridian markets.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <h1 className="mb-6 text-2xl font-bold text-white">Trade History</h1>
        <div className="flex min-h-[400px] items-center justify-center rounded-2xl border border-gray-800/60 bg-gray-900/50">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent" />
            <span className="text-sm text-gray-400">Loading trade history...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <h1 className="mb-6 text-2xl font-bold text-white">Trade History</h1>
        <div className="flex min-h-[400px] flex-col items-center justify-center gap-4 rounded-2xl border border-gray-800/60 bg-gray-900/50 p-8">
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={() => fetchHistory()}
            className="rounded-lg bg-gray-800 px-4 py-2 text-xs font-medium text-gray-300 hover:bg-gray-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Trade History</h1>
        <button
          onClick={() => fetchHistory()}
          className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-700 transition-colors"
        >
          Refresh
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="flex min-h-[400px] flex-col items-center justify-center rounded-2xl border border-gray-800/60 bg-gray-900/50 p-8">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-800/50">
            <svg className="h-8 w-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-bold text-white">No Trade History</h3>
          <p className="mb-4 text-center text-sm text-gray-500">
            You haven&apos;t placed any orders yet. Start trading to see your history here.
          </p>
          <Link
            href="/markets"
            className="rounded-xl bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-2.5 text-sm font-bold text-black shadow-lg shadow-yellow-500/20 transition-all hover:shadow-yellow-500/40"
          >
            Browse Markets
          </Link>
        </div>
      ) : (
        <>
          {/* Summary stats */}
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-4">
              <span className="text-xs text-gray-500">Total Orders</span>
              <p className="mt-1 font-mono text-lg font-bold text-white">{entries.length}</p>
            </div>
            <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-4">
              <span className="text-xs text-gray-500">Filled</span>
              <p className="mt-1 font-mono text-lg font-bold text-emerald-400">
                {entries.filter((e) => e.quantity.sub(e.filled).isZero() && !e.cancelled).length}
              </p>
            </div>
            <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-4">
              <span className="text-xs text-gray-500">Open</span>
              <p className="mt-1 font-mono text-lg font-bold text-blue-400">
                {entries.filter((e) => !e.cancelled && e.filled.lt(e.quantity)).length}
              </p>
            </div>
            <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-4">
              <span className="text-xs text-gray-500">Cancelled</span>
              <p className="mt-1 font-mono text-lg font-bold text-gray-400">
                {entries.filter((e) => e.cancelled).length}
              </p>
            </div>
          </div>

          {/* Order table */}
          <div className="overflow-hidden rounded-2xl border border-gray-800/60 bg-gray-900/50">
            {/* Table header */}
            <div className="hidden border-b border-gray-800/60 sm:grid sm:grid-cols-7 sm:gap-2 sm:px-5 sm:py-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Market</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Side</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Price</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Quantity</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Filled</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Status</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Time</span>
            </div>

            {/* Rows */}
            <div className="divide-y divide-gray-800/40">
              {entries.map((entry, i) => {
                const tickerInfo = MAG7_TICKERS[entry.ticker];
                const fillPct = entry.quantity.gt(new BN(0))
                  ? (entry.filled.toNumber() / entry.quantity.toNumber()) * 100
                  : 0;
                const time = new Date(entry.timestamp * 1000);

                return (
                  <Link
                    key={`${entry.marketPubkey.toBase58()}-${entry.orderId}-${i}`}
                    href={`/trade/${entry.marketPubkey.toBase58()}`}
                    className="block px-5 py-4 transition-colors hover:bg-gray-800/30"
                  >
                    {/* Mobile layout */}
                    <div className="sm:hidden">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white"
                            style={{ backgroundColor: tickerInfo?.color ?? "#6B7280" }}
                          >
                            {entry.ticker.slice(0, 2)}
                          </div>
                          <div>
                            <span className="text-sm font-bold text-white">{entry.ticker}</span>
                            <span className="ml-2 text-xs text-gray-500">
                              {formatStrikePrice(entry.strikePrice)}
                            </span>
                          </div>
                        </div>
                        {getStatusBadge(entry)}
                      </div>
                      <div className="flex items-center gap-4 text-xs text-gray-400">
                        <span className={entry.isBid ? "font-semibold text-emerald-400" : "font-semibold text-red-400"}>
                          {entry.isBid ? "BID" : "ASK"}
                        </span>
                        <span>@ ${(entry.price.toNumber() / divisor).toFixed(2)}</span>
                        <span>Qty: {(entry.quantity.toNumber() / qtyDivisor).toFixed(0)}</span>
                        <span>Fill: {fillPct.toFixed(0)}%</span>
                      </div>
                    </div>

                    {/* Desktop layout */}
                    <div className="hidden sm:grid sm:grid-cols-7 sm:items-center sm:gap-2">
                      <div className="flex items-center gap-2">
                        <div
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[10px] font-bold text-white"
                          style={{ backgroundColor: tickerInfo?.color ?? "#6B7280" }}
                        >
                          {entry.ticker.slice(0, 2)}
                        </div>
                        <div>
                          <span className="text-sm font-bold text-white">{entry.ticker}</span>
                          <p className="text-[11px] text-gray-500">{formatStrikePrice(entry.strikePrice)}</p>
                        </div>
                      </div>
                      <span className={`text-xs font-bold ${entry.isBid ? "text-emerald-400" : "text-red-400"}`}>
                        {entry.isBid ? "BID" : "ASK"}
                      </span>
                      <span className="font-mono text-xs text-gray-300">
                        ${(entry.price.toNumber() / divisor).toFixed(2)}
                      </span>
                      <span className="font-mono text-xs text-gray-300">
                        {(entry.quantity.toNumber() / qtyDivisor).toFixed(0)}
                      </span>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-gray-800">
                          <div
                            className="h-full rounded-full bg-emerald-500"
                            style={{ width: `${fillPct}%` }}
                          />
                        </div>
                        <span className="font-mono text-xs text-gray-400">
                          {(entry.filled.toNumber() / qtyDivisor).toFixed(0)}/{(entry.quantity.toNumber() / qtyDivisor).toFixed(0)}
                        </span>
                      </div>
                      {getStatusBadge(entry)}
                      <span className="text-[11px] text-gray-500">
                        {time.toLocaleDateString("en-US", { month: "short", day: "numeric" })}{" "}
                        {time.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
