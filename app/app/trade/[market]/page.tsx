"use client";

import React, { useEffect, useState, useCallback, use } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import Link from "next/link";
import OrderBook from "@/components/OrderBook";
import TradePanel from "@/components/TradePanel";
import CountdownTimer from "@/components/CountdownTimer";
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
      setError(null);
      const marketPubkey = new PublicKey(marketAddress);

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
      setError("Market not found or failed to load. Check your connection to Solana Devnet.");
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
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent" />
          <span className="text-sm text-gray-400">Loading market...</span>
        </div>
      </div>
    );
  }

  if (error || !market) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <div className="flex min-h-[400px] flex-col items-center justify-center rounded-2xl border border-gray-800/60 bg-gray-900/50 p-8">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10">
            <svg
              className="h-8 w-8 text-red-400"
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
          </div>
          <h3 className="mb-2 text-lg font-bold text-white">
            Market Not Found
          </h3>
          <p className="mb-4 text-center text-sm text-gray-500">
            {error ?? "This market could not be loaded."}
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => {
                setLoading(true);
                fetchMarket();
              }}
              className="rounded-xl bg-gray-800/80 px-4 py-2 text-sm font-bold text-gray-300 hover:bg-gray-700 transition-colors"
            >
              Retry
            </button>
            <Link
              href="/markets"
              className="rounded-xl bg-yellow-500 px-4 py-2 text-sm font-bold text-black hover:bg-yellow-400 transition-colors"
            >
              Back to Markets
            </Link>
          </div>
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
        <Link href="/markets" className="hover:text-gray-300 transition-colors">
          Markets
        </Link>
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="font-medium text-gray-300">{market.ticker}</span>
      </div>

      {/* Market Header */}
      <div className="mb-8 rounded-2xl border border-gray-800/60 bg-gray-900/50 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div
              className="flex h-14 w-14 items-center justify-center rounded-2xl text-lg font-bold text-white shadow-lg"
              style={{ backgroundColor: tickerInfo?.color ?? "#6B7280" }}
            >
              {market.ticker.slice(0, 2)}
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">
                Will {market.ticker} close above{" "}
                {formatStrikePrice(market.strikePrice)}?
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-500">
                <span>{tickerInfo?.name ?? market.ticker}</span>
                <span className="text-gray-700">&middot;</span>
                <span>{formatMarketDate(market.date)}</span>
                <span className="text-gray-700">&middot;</span>
                <span className="font-mono">{(market.totalPairsMinted.toNumber() / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 0 })} contracts</span>
                {!market.settled && !expired && (
                  <>
                    <span className="text-gray-700">&middot;</span>
                    <CountdownTimer date={market.date} />
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {market.settled ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-700/50 px-3 py-1.5 text-sm font-semibold text-gray-300">
                <span className="h-2 w-2 rounded-full bg-gray-400" />
                Settled &middot;{" "}
                {market.outcomeYesWins ? "Yes Won" : "No Won"}
              </span>
            ) : expired ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-3 py-1.5 text-sm font-semibold text-yellow-400 ring-1 ring-inset ring-yellow-500/20">
                <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-400" />
                Awaiting Settlement
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-3 py-1.5 text-sm font-semibold text-yellow-400 ring-1 ring-inset ring-yellow-500/20">
                <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-400" />
                Live
              </span>
            )}
          </div>
        </div>

        {/* Price display */}
        <div className="mt-6 grid grid-cols-2 gap-4">
          <div className="rounded-2xl bg-emerald-500/8 p-5 ring-1 ring-inset ring-emerald-500/15">
            <span className="text-sm font-medium text-gray-400">Yes Price</span>
            <p className="mt-1 font-mono text-4xl font-bold text-emerald-400">
              {yesPrice}&cent;
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Pays $1.00 if {market.ticker} closes above {formatStrikePrice(market.strikePrice)}
            </p>
          </div>
          <div className="rounded-2xl bg-red-500/8 p-5 ring-1 ring-inset ring-red-500/15">
            <span className="text-sm font-medium text-gray-400">No Price</span>
            <p className="mt-1 font-mono text-4xl font-bold text-red-400">
              {noPrice}&cent;
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Pays $1.00 if {market.ticker} closes below {formatStrikePrice(market.strikePrice)}
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
