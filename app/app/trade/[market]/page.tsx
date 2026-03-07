"use client";

import React, { useEffect, useState, useCallback, use } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import Link from "next/link";
import OrderBook from "@/components/OrderBook";
import TradePanel from "@/components/TradePanel";
import { MarketData } from "@/components/MarketCard";
import {
  formatStrikePrice,
  formatMarketDate,
  isExpired,
  priceToPercent,
} from "@/lib/utils";
import { MAG7_TICKERS } from "@/lib/constants";
import type { Meridian } from "../../../../target/types/meridian";
import idl from "../../../../target/idl/meridian.json";

export default function TradePage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const resolvedParams = use(params);
  const { connection } = useConnection();
  const [market, setMarket] = useState<MarketData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const marketAddress = resolvedParams.market;

  const fetchMarket = useCallback(async () => {
    try {
      const marketPubkey = new PublicKey(marketAddress);

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

      const marketAccount = await program.account.market.fetch(marketPubkey);

      setMarket({
        publicKey: marketPubkey,
        marketId: marketAccount.marketId as BN,
        ticker: marketAccount.ticker as string,
        strikePrice: marketAccount.strikePrice as BN,
        date: marketAccount.date as number,
        yesMint: marketAccount.yesMint as PublicKey,
        noMint: marketAccount.noMint as PublicKey,
        settled: marketAccount.settled as boolean,
        outcomeYesWins: marketAccount.outcomeYesWins as boolean,
        settlementPrice: marketAccount.settlementPrice as BN,
        totalPairsMinted: marketAccount.totalPairsMinted as BN,
        bestBid: null,
        bestAsk: null,
      });
    } catch (err) {
      console.error("Failed to fetch market:", err);
      setError("Market not found or failed to load.");
    } finally {
      setLoading(false);
    }
  }, [connection, marketAddress]);

  useEffect(() => {
    fetchMarket();
  }, [fetchMarket]);

  const handlePriceUpdate = useCallback(
    (bestBid: BN | null, bestAsk: BN | null) => {
      setMarket((prev) => (prev ? { ...prev, bestBid, bestAsk } : null));
    },
    []
  );

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          <span className="text-sm text-gray-400">Loading market...</span>
        </div>
      </div>
    );
  }

  if (error || !market) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <div className="flex min-h-[400px] flex-col items-center justify-center rounded-xl border border-gray-800 bg-gray-900 p-8">
          <svg
            className="mb-4 h-12 w-12 text-red-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
            />
          </svg>
          <h3 className="mb-2 text-lg font-semibold text-white">
            Market Not Found
          </h3>
          <p className="mb-4 text-sm text-gray-500">
            {error ?? "This market could not be loaded."}
          </p>
          <Link
            href="/"
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700"
          >
            Back to Markets
          </Link>
        </div>
      </div>
    );
  }

  const tickerInfo = MAG7_TICKERS[market.ticker];
  const expired = isExpired(market.date);

  let yesPrice = 50;
  if (market.bestBid && market.bestAsk) {
    yesPrice = priceToPercent(
      market.bestBid.add(market.bestAsk).div(new BN(2))
    );
  } else if (market.bestBid) {
    yesPrice = priceToPercent(market.bestBid);
  } else if (market.bestAsk) {
    yesPrice = priceToPercent(market.bestAsk);
  }

  if (market.settled) {
    yesPrice = market.outcomeYesWins ? 100 : 0;
  }

  const noPrice = 100 - yesPrice;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* Breadcrumb */}
      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500">
        <Link href="/" className="hover:text-gray-300">
          Markets
        </Link>
        <span>/</span>
        <span className="text-gray-300">{market.ticker}</span>
      </div>

      {/* Market Header */}
      <div className="mb-8 rounded-xl border border-gray-800 bg-gray-900 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div
              className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white"
              style={{ backgroundColor: tickerInfo?.color ?? "#6B7280" }}
            >
              {market.ticker.slice(0, 2)}
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">
                Will {market.ticker} close above{" "}
                {formatStrikePrice(market.strikePrice)}?
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                {tickerInfo?.name ?? market.ticker} &middot; Expiry:{" "}
                {formatMarketDate(market.date)} &middot; Vol:{" "}
                {market.totalPairsMinted.toNumber().toLocaleString()} pairs
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {market.settled ? (
              <span className="inline-flex items-center rounded-full bg-gray-700 px-3 py-1 text-sm font-medium text-gray-300">
                Settled &middot;{" "}
                {market.outcomeYesWins ? "Yes Won" : "No Won"}
              </span>
            ) : expired ? (
              <span className="inline-flex items-center rounded-full bg-yellow-900/50 px-3 py-1 text-sm font-medium text-yellow-400">
                Awaiting Settlement
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-emerald-900/50 px-3 py-1 text-sm font-medium text-emerald-400">
                Active
              </span>
            )}
          </div>
        </div>

        {/* Price display */}
        <div className="mt-6 grid grid-cols-2 gap-4">
          <div className="rounded-xl bg-emerald-500/10 p-4">
            <span className="text-sm text-gray-400">Yes Price</span>
            <p className="mt-1 text-3xl font-bold text-emerald-400">
              {yesPrice}\u00A2
            </p>
          </div>
          <div className="rounded-xl bg-red-500/10 p-4">
            <span className="text-sm text-gray-400">No Price</span>
            <p className="mt-1 text-3xl font-bold text-red-400">
              {noPrice}\u00A2
            </p>
          </div>
        </div>
      </div>

      {/* Trading area */}
      <div className="grid gap-6 lg:grid-cols-5">
        {/* Order Book - takes 2 cols */}
        <div className="lg:col-span-2">
          <OrderBook
            marketPubkey={market.publicKey}
            onPriceUpdate={handlePriceUpdate}
          />
        </div>

        {/* Trade Panel - takes 3 cols */}
        <div className="lg:col-span-3">
          <TradePanel market={market} onTradeComplete={fetchMarket} />
        </div>
      </div>
    </div>
  );
}
