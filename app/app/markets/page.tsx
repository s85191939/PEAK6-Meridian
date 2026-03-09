"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import MarketCard, { MarketData } from "@/components/MarketCard";
import {
  findMarketRegistryPda,
  findOrderbookPda,
} from "@/lib/utils";
import type { Meridian } from "../../../target/types/meridian";
import idl from "../../../target/idl/meridian.json";

export default function MarketsPage() {
  const { connection } = useConnection();
  const [markets, setMarkets] = useState<MarketData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "settled">("all");

  const fetchMarkets = useCallback(async () => {
    try {
      setError(null);
      const provider = new AnchorProvider(
        connection,
        {
          publicKey: new PublicKey("11111111111111111111111111111111"),
          signTransaction: async (tx) => tx,
          signAllTransactions: async (txs) => txs,
        },
        { commitment: "confirmed" }
      );
      const program = new Program<Meridian>(idl as Meridian, provider);

      // Fetch market registry
      const [registryPda] = findMarketRegistryPda();
      let registryAccount;
      try {
        registryAccount = await program.account.marketRegistry.fetch(registryPda);
      } catch {
        setMarkets([]);
        setLoading(false);
        return;
      }

      const marketPubkeys = registryAccount.markets as PublicKey[];

      // Fetch all markets in parallel
      const marketResults = await Promise.allSettled(
        marketPubkeys.map((pda) => program.account.market.fetch(pda))
      );

      // Fetch all orderbooks in parallel
      const orderbookResults = await Promise.allSettled(
        marketPubkeys.map((pda) => {
          const [orderbookPda] = findOrderbookPda(pda);
          return program.account.orderBook.fetch(orderbookPda);
        })
      );

      const marketsList: MarketData[] = [];

      for (let i = 0; i < marketPubkeys.length; i++) {
        const marketResult = marketResults[i];
        if (marketResult.status !== "fulfilled") continue;

        const market = marketResult.value;
        let bestBid: BN | null = null;
        let bestAsk: BN | null = null;

        const orderbookResult = orderbookResults[i];
        if (orderbookResult.status === "fulfilled") {
          interface OrderData {
            isBid: boolean;
            cancelled: boolean;
            quantity: BN;
            filled: BN;
            price: BN;
          }

          const activeOrders = (orderbookResult.value.orders as OrderData[]).filter(
            (o: OrderData) =>
              !o.cancelled && (o.quantity as BN).sub(o.filled as BN).gt(new BN(0))
          );

          const bidOrders = activeOrders.filter((o: OrderData) => o.isBid);
          const askOrders = activeOrders.filter((o: OrderData) => !o.isBid);

          if (bidOrders.length > 0) {
            bestBid = bidOrders.reduce(
              (max: BN, o: OrderData) =>
                (o.price as BN).gt(max) ? (o.price as BN) : max,
              new BN(0)
            );
          }
          if (askOrders.length > 0) {
            bestAsk = askOrders.reduce(
              (min: BN, o: OrderData) =>
                (o.price as BN).lt(min) ? (o.price as BN) : min,
              new BN(10).pow(new BN(12))
            );
          }
        }

        marketsList.push({
          publicKey: marketPubkeys[i],
          marketId: market.marketId as BN,
          ticker: market.ticker as string,
          strikePrice: market.strikePrice as BN,
          date: market.date as number,
          yesMint: market.yesMint as PublicKey,
          noMint: market.noMint as PublicKey,
          settled: market.settled as boolean,
          outcomeYesWins: market.outcomeYesWins as boolean,
          settlementPrice: market.settlementPrice as BN,
          totalPairsMinted: market.totalPairsMinted as BN,
          bestBid,
          bestAsk,
        });
      }

      setMarkets(marketsList);
    } catch (err) {
      console.error("Failed to fetch markets:", err);
      setError(
        "Failed to load markets. Connect your wallet and ensure you're on Solana Devnet."
      );
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    fetchMarkets();
    const interval = setInterval(fetchMarkets, 15000);
    return () => clearInterval(interval);
  }, [fetchMarkets]);

  const filteredMarkets = markets.filter((m) => {
    if (filter === "active") return !m.settled;
    if (filter === "settled") return m.settled;
    return true;
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">Markets</h1>
        <p className="mt-2 text-sm text-gray-500">
          Trade binary outcomes on MAG7 stocks. Predict whether a stock closes
          above or below a strike price. 0DTE contracts settle at 4:00 PM ET.
        </p>
      </div>

      {/* Filters */}
      <div className="mb-6 flex items-center gap-2">
        {(["all", "active", "settled"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-xl px-4 py-2 text-sm font-medium capitalize transition-all duration-200 ${
              filter === f
                ? "bg-gray-800/80 text-white shadow-sm"
                : "text-gray-500 hover:bg-gray-800/40 hover:text-gray-300"
            }`}
          >
            {f}
          </button>
        ))}
        <div className="ml-auto font-mono text-sm text-gray-600">
          {filteredMarkets.length} market{filteredMarkets.length !== 1 && "s"}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-6 flex items-center justify-between rounded-2xl border border-red-500/20 bg-red-500/8 px-5 py-4">
          <div className="flex items-start gap-3">
            <svg className="mt-0.5 h-5 w-5 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-red-400">Connection Error</p>
              <p className="mt-0.5 text-xs text-red-400/80">{error}</p>
            </div>
          </div>
          <button
            onClick={() => {
              setLoading(true);
              setError(null);
              fetchMarkets();
            }}
            className="shrink-0 rounded-xl bg-red-500/20 px-4 py-2 text-sm font-bold text-red-400 hover:bg-red-500/30 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Market Grid */}
      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent" />
            <span className="text-sm text-gray-400">Loading markets...</span>
          </div>
        </div>
      ) : !error && filteredMarkets.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-2xl border border-gray-800/60 bg-gray-900/50">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-800/50">
            <svg
              className="h-7 w-7 text-gray-500"
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
          <p className="text-sm font-medium text-gray-400">
            {markets.length === 0
              ? "No markets found. Markets will appear here once created on-chain."
              : "No markets match the current filter."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredMarkets.map((market, i) => (
            <div key={market.publicKey.toBase58()} className={`animate-fade-in stagger-${Math.min(i + 1, 7)}`}>
              <MarketCard market={market} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
