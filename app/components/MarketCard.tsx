"use client";

import React from "react";
import Link from "next/link";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { MAG7_TICKERS } from "@/lib/constants";
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
      <span className="inline-flex items-center rounded-full bg-gray-700 px-2.5 py-0.5 text-xs font-medium text-gray-300">
        Settled
      </span>
    );
  } else if (expired) {
    statusBadge = (
      <span className="inline-flex items-center rounded-full bg-yellow-900/50 px-2.5 py-0.5 text-xs font-medium text-yellow-400">
        Awaiting Settlement
      </span>
    );
  } else {
    statusBadge = (
      <span className="inline-flex items-center rounded-full bg-emerald-900/50 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
        Active
      </span>
    );
  }

  return (
    <Link
      href={`/trade/${market.publicKey.toBase58()}`}
      className="group block rounded-xl border border-gray-800 bg-gray-900 p-5 transition-all hover:border-gray-700 hover:bg-gray-900/80"
    >
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white"
            style={{ backgroundColor: tickerInfo?.color ?? "#6B7280" }}
          >
            {market.ticker.slice(0, 2)}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">
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
      <p className="mb-4 text-sm text-gray-300">
        Will <span className="font-semibold text-white">{market.ticker}</span>{" "}
        close above{" "}
        <span className="font-semibold text-white">
          {formatStrikePrice(market.strikePrice)}
        </span>{" "}
        on {formatMarketDate(market.date)}?
      </p>

      {/* Price bars */}
      <div className="space-y-2">
        {/* Yes */}
        <div className="flex items-center gap-3">
          <span className="w-8 text-xs font-medium text-emerald-400">Yes</span>
          <div className="relative h-8 flex-1 overflow-hidden rounded-lg bg-gray-800">
            <div
              className="absolute inset-y-0 left-0 rounded-lg bg-emerald-500/20 transition-all duration-500"
              style={{ width: `${yesPrice}%` }}
            />
            <div className="relative flex h-full items-center px-3">
              <span className="text-sm font-bold text-emerald-400">
                {yesPrice}\u00A2
              </span>
            </div>
          </div>
        </div>

        {/* No */}
        <div className="flex items-center gap-3">
          <span className="w-8 text-xs font-medium text-red-400">No</span>
          <div className="relative h-8 flex-1 overflow-hidden rounded-lg bg-gray-800">
            <div
              className="absolute inset-y-0 left-0 rounded-lg bg-red-500/20 transition-all duration-500"
              style={{ width: `${noPrice}%` }}
            />
            <div className="relative flex h-full items-center px-3">
              <span className="text-sm font-bold text-red-400">
                {noPrice}\u00A2
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center justify-between text-xs text-gray-500">
        <span>
          Vol: {market.totalPairsMinted.toNumber().toLocaleString()} pairs
        </span>
        <span className="text-gray-600 transition-colors group-hover:text-gray-400">
          Trade &rarr;
        </span>
      </div>
    </Link>
  );
}
