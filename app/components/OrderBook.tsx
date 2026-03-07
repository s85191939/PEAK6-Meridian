"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { findOrderbookPda, formatPrice, priceToPercent } from "@/lib/utils";
import { PRICE_DECIMALS } from "@/lib/constants";
import type { Meridian } from "../../target/types/meridian";
import idl from "../../target/idl/meridian.json";

interface Order {
  orderId: BN;
  maker: PublicKey;
  isBid: boolean;
  price: BN;
  quantity: BN;
  filled: BN;
  timestamp: BN;
  cancelled: boolean;
}

interface PriceLevel {
  price: number;
  priceBn: BN;
  totalQuantity: number;
  orderCount: number;
}

interface OrderBookProps {
  marketPubkey: PublicKey;
  onPriceUpdate?: (bestBid: BN | null, bestAsk: BN | null) => void;
}

export default function OrderBook({ marketPubkey, onPriceUpdate }: OrderBookProps) {
  const { connection } = useConnection();
  const [bids, setBids] = useState<PriceLevel[]>([]);
  const [asks, setAsks] = useState<PriceLevel[]>([]);
  const [spread, setSpread] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchOrderbook = useCallback(async () => {
    try {
      // Create a read-only provider
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

      const [orderbookPda] = findOrderbookPda(marketPubkey);
      const orderbookAccount = await program.account.orderBook.fetch(
        orderbookPda
      );

      const activeOrders = (orderbookAccount.orders as Order[]).filter(
        (o: Order) => !o.cancelled && o.quantity.sub(o.filled).gt(new BN(0))
      );

      // Aggregate into price levels
      const bidMap = new Map<number, PriceLevel>();
      const askMap = new Map<number, PriceLevel>();

      for (const order of activeOrders) {
        const price = order.price.toNumber();
        const remaining = order.quantity.sub(order.filled).toNumber();
        const map = order.isBid ? bidMap : askMap;

        const existing = map.get(price);
        if (existing) {
          existing.totalQuantity += remaining;
          existing.orderCount += 1;
        } else {
          map.set(price, {
            price,
            priceBn: order.price,
            totalQuantity: remaining,
            orderCount: 1,
          });
        }
      }

      // Sort bids descending, asks ascending
      const sortedBids = Array.from(bidMap.values()).sort(
        (a, b) => b.price - a.price
      );
      const sortedAsks = Array.from(askMap.values()).sort(
        (a, b) => a.price - b.price
      );

      setBids(sortedBids.slice(0, 10));
      setAsks(sortedAsks.slice(0, 10));

      // Calculate spread
      const bestBid = sortedBids.length > 0 ? sortedBids[0] : null;
      const bestAsk = sortedAsks.length > 0 ? sortedAsks[0] : null;

      if (bestBid && bestAsk) {
        const s = bestAsk.price - bestBid.price;
        setSpread(s);
      } else {
        setSpread(null);
      }

      onPriceUpdate?.(
        bestBid?.priceBn ?? null,
        bestAsk?.priceBn ?? null
      );
    } catch (err) {
      console.error("Failed to fetch orderbook:", err);
    } finally {
      setLoading(false);
    }
  }, [connection, marketPubkey, onPriceUpdate]);

  useEffect(() => {
    fetchOrderbook();
    const interval = setInterval(fetchOrderbook, 5000);
    return () => clearInterval(interval);
  }, [fetchOrderbook]);

  const maxQuantity = Math.max(
    ...bids.map((b) => b.totalQuantity),
    ...asks.map((a) => a.totalQuantity),
    1
  );

  const divisor = Math.pow(10, PRICE_DECIMALS);
  const qtyDivisor = Math.pow(10, 6);

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h3 className="mb-4 text-sm font-semibold text-white">Order Book</h3>
        <div className="flex h-64 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Order Book</h3>
        <span className="text-xs text-gray-500">Yes / USDC</span>
      </div>

      {/* Header */}
      <div className="mb-2 grid grid-cols-3 text-xs font-medium text-gray-500">
        <span>Price</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Total</span>
      </div>

      {/* Asks (reversed so lowest ask is at bottom) */}
      <div className="space-y-0.5">
        {asks.length === 0 ? (
          <div className="py-3 text-center text-xs text-gray-600">
            No asks
          </div>
        ) : (
          [...asks].reverse().map((level) => (
            <div key={`ask-${level.price}`} className="relative">
              <div
                className="absolute inset-y-0 right-0 bg-red-500/10"
                style={{
                  width: `${(level.totalQuantity / maxQuantity) * 100}%`,
                }}
              />
              <div className="relative grid grid-cols-3 py-1 text-xs">
                <span className="font-mono text-red-400">
                  {(level.price / divisor).toFixed(2)}
                </span>
                <span className="text-right font-mono text-gray-400">
                  {(level.totalQuantity / qtyDivisor).toFixed(0)}
                </span>
                <span className="text-right font-mono text-gray-500">
                  {level.orderCount}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Spread */}
      <div className="my-2 flex items-center justify-center border-y border-gray-800 py-2">
        <span className="text-xs text-gray-500">
          Spread:{" "}
          <span className="font-mono text-gray-400">
            {spread !== null
              ? `${(spread / divisor).toFixed(2)} (${priceToPercent(
                  new BN(spread)
                )}%)`
              : "--"}
          </span>
        </span>
      </div>

      {/* Bids */}
      <div className="space-y-0.5">
        {bids.length === 0 ? (
          <div className="py-3 text-center text-xs text-gray-600">
            No bids
          </div>
        ) : (
          bids.map((level) => (
            <div key={`bid-${level.price}`} className="relative">
              <div
                className="absolute inset-y-0 right-0 bg-emerald-500/10"
                style={{
                  width: `${(level.totalQuantity / maxQuantity) * 100}%`,
                }}
              />
              <div className="relative grid grid-cols-3 py-1 text-xs">
                <span className="font-mono text-emerald-400">
                  {(level.price / divisor).toFixed(2)}
                </span>
                <span className="text-right font-mono text-gray-400">
                  {(level.totalQuantity / qtyDivisor).toFixed(0)}
                </span>
                <span className="text-right font-mono text-gray-500">
                  {level.orderCount}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
