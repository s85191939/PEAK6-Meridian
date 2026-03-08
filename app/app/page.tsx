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
import type { Meridian } from "../../target/types/meridian";
import idl from "../../target/idl/meridian.json";

export default function MarketsPage() {
  const { connection } = useConnection();
  const [markets, setMarkets] = useState<MarketData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "active" | "settled">("all");

  const fetchMarkets = useCallback(async () => {
    try {
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

      // Fetch market registry to get all market pubkeys
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
      const marketsList: MarketData[] = [];

      for (const marketPda of marketPubkeys) {
        try {
          const market = await program.account.market.fetch(marketPda);

          let bestBid: BN | null = null;
          let bestAsk: BN | null = null;

          try {
            const [orderbookPda] = findOrderbookPda(marketPda);
            const orderbook = await program.account.orderBook.fetch(
              orderbookPda
            );

            interface OrderData {
              isBid: boolean;
              cancelled: boolean;
              quantity: BN;
              filled: BN;
              price: BN;
            }

            const activeOrders = (orderbook.orders as OrderData[]).filter(
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
          } catch {
            // Orderbook may not be initialized
          }

          marketsList.push({
            publicKey: marketPda,
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
        } catch {
          // Market may not exist
        }
      }

      setMarkets(marketsList);
    } catch (err) {
      console.error("Failed to fetch markets:", err);
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
        <h1 className="text-2xl font-bold text-white">Markets</h1>
        <p className="mt-1 text-sm text-gray-500">
          Trade binary outcomes on MAG7 stocks. Predict whether a stock closes
          above or below a strike price.
        </p>
      </div>

      {/* Filters */}
      <div className="mb-6 flex items-center gap-2">
        {(["all", "active", "settled"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-lg px-4 py-2 text-sm font-medium capitalize transition-colors ${
              filter === f
                ? "bg-gray-800 text-white"
                : "text-gray-500 hover:bg-gray-800/50 hover:text-gray-300"
            }`}
          >
            {f}
          </button>
        ))}
        <div className="ml-auto text-sm text-gray-600">
          {filteredMarkets.length} market{filteredMarkets.length !== 1 && "s"}
        </div>
      </div>

      {/* Market Grid */}
      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            <span className="text-sm text-gray-400">Loading markets...</span>
          </div>
        </div>
      ) : filteredMarkets.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-gray-800 bg-gray-900">
          <svg
            className="mb-3 h-10 w-10 text-gray-600"
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
          <p className="text-sm text-gray-500">
            {markets.length === 0
              ? "No markets found. Markets will appear here once created on-chain."
              : "No markets match the current filter."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredMarkets.map((market) => (
            <MarketCard key={market.publicKey.toBase58()} market={market} />
          ))}
        </div>
      )}
    </div>
  );
}
