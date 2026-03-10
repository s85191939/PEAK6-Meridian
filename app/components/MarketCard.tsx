"use client";

import React from "react";
import Link from "next/link";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { MAG7_TICKERS } from "@/lib/constants";
import CountdownTimer from "./CountdownTimer";
import {
  formatStrikePrice,
  formatMarketDate,
  priceToPercent,
  isExpired,
} from "@/lib/utils";

export interface MarketData {
  publicKey: PublicKey;
  marketId: BN;
  ticker: string;
  strikePrice: BN;
  date: number;
  yesMint: PublicKey;
  noMint: PublicKey;
  settled: boolean;
  outcomeYesWins: boolean;
  settlementPrice: BN;
  totalPairsMinted: BN;
  bestBid: BN | null;
  bestAsk: BN | null;
}

function getYesPrice(market: MarketData): number {
  if (market.settled) {
    return market.outcomeYesWins ? 100 : 0;
  }
  if (market.bestBid && market.bestAsk) {
    const mid = market.bestBid.add(market.bestAsk).div(new BN(2));
    return priceToPercent(mid);
  }
  if (market.bestBid) return priceToPercent(market.bestBid);
  if (market.bestAsk) return priceToPercent(market.bestAsk);
  return 50;
}

export default function MarketCard({ market }: { market: MarketData }) {
  const tickerInfo = MAG7_TICKERS[market.ticker];
  const yesPrice = getYesPrice(market);
  const noPrice = 100 - yesPrice;
  const expired = isExpired(market.date);

  let statusBadge: React.ReactNode = null;
  if (market.settled) {
    statusBadge = (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-700/50 px-2.5 py-1 text-[11px] font-semibold text-gray-300">
        <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
        Settled &middot; {market.outcomeYesWins ? "Yes" : "No"} Won
      </span>
    );
  } else if (expired) {
    statusBadge = (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-2.5 py-1 text-[11px] font-semibold text-yellow-400 ring-1 ring-inset ring-yellow-500/20">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
        Pending
      </span>
    );
  } else {
    statusBadge = (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-2.5 py-1 text-[11px] font-semibold text-yellow-400 ring-1 ring-inset ring-yellow-500/20">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
        Live
      </span>
    );
  }

  return (
    <Link
      href={`/trade/${market.publicKey.toBase58()}`}
      className="group block rounded-2xl border border-gray-800/60 bg-gray-900/50 p-5 transition-all duration-300 hover:border-yellow-500/20 hover:bg-gray-900/80 hover:shadow-xl hover:shadow-yellow-500/5"
    >
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex h-11 w-11 items-center justify-center rounded-xl text-sm font-bold text-white shadow-lg"
            style={{ backgroundColor: tickerInfo?.color ?? "#6B7280" }}
          >
            {market.ticker.slice(0, 2)}
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">
              {market.ticker}
            </h3>
            <p className="text-xs text-gray-500">
              {tickerInfo?.name ?? market.ticker}
            </p>
          </div>
        </div>
        {statusBadge}
      </div>

      {/* Question */}
      <p className="mb-4 text-sm leading-relaxed text-gray-300">
        Will <span className="font-semibold text-white">{market.ticker}</span>{" "}
        close above{" "}
        <span className="font-semibold text-white">
          {formatStrikePrice(market.strikePrice)}
        </span>{" "}
        {formatMarketDate(market.date).toLowerCase()}?
      </p>

      {/* Price bars */}
      <div className="space-y-2">
        {/* Yes */}
        <div className="flex items-center gap-3">
          <span className="w-8 text-xs font-bold text-emerald-400">Yes</span>
          <div className="relative h-9 flex-1 overflow-hidden rounded-xl bg-gray-800/60">
            <div
              className="absolute inset-y-0 left-0 rounded-xl bg-gradient-to-r from-emerald-500/25 to-emerald-500/10 transition-all duration-700"
              style={{ width: `${Math.max(yesPrice, 2)}%` }}
            />
            <div className="relative flex h-full items-center px-3">
              <span className="text-sm font-bold text-emerald-400">
                {yesPrice}&cent;
              </span>
            </div>
          </div>
        </div>

        {/* No */}
        <div className="flex items-center gap-3">
          <span className="w-8 text-xs font-bold text-red-400">No</span>
          <div className="relative h-9 flex-1 overflow-hidden rounded-xl bg-gray-800/60">
            <div
              className="absolute inset-y-0 left-0 rounded-xl bg-gradient-to-r from-red-500/25 to-red-500/10 transition-all duration-700"
              style={{ width: `${Math.max(noPrice, 2)}%` }}
            />
            <div className="relative flex h-full items-center px-3">
              <span className="text-sm font-bold text-red-400">
                {noPrice}&cent;
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span className="font-medium text-gray-400">
            {formatMarketDate(market.date)}
          </span>
          <span className="text-gray-700">&middot;</span>
          <span className="font-mono">
            {(market.totalPairsMinted.toNumber() / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 0 })} contracts
          </span>
          {!market.settled && !expired && (
            <>
              <span className="text-gray-700">&middot;</span>
              <CountdownTimer date={market.date} />
            </>
          )}
        </div>
        <span className="text-xs font-medium text-gray-600 transition-colors group-hover:text-yellow-400">
          Trade &rarr;
        </span>
      </div>
    </Link>
  );
}
