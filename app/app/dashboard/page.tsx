"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import Link from "next/link";
import {
  findMarketRegistryPda,
  findOrderbookPda,
  findConfigPda,
  findVaultPda,
  findBidEscrowPda,
  findEscrowYesPda,
  formatStrikePrice,
  formatMarketDate,
  formatPrice,
  isExpired,
  shortenAddress,
} from "@/lib/utils";
import { MAG7_TICKERS, PRICE_DECIMALS } from "@/lib/constants";
import type { Meridian } from "@/lib/idl/meridian";
import idl from "@/lib/idl/meridian.json";

// ─── Types ──────────────────────────────────────────────────────────────────

interface MarketInfo {
  publicKey: PublicKey;
  marketId: number;
  ticker: string;
  strikePrice: BN;
  date: number;
  settled: boolean;
  outcomeYesWins: boolean;
  settlementPrice: BN;
  totalPairsMinted: BN;
  vaultBalance: number; // USDC in vault (lamports)
}

interface OrderInfo {
  marketPubkey: PublicKey;
  ticker: string;
  orderId: number;
  maker: PublicKey;
  isBid: boolean;
  price: BN;
  quantity: BN;
  filled: BN;
  timestamp: number;
  cancelled: boolean;
}

interface ProtocolStats {
  totalMarkets: number;
  activeMarkets: number;
  settledMarkets: number;
  awaitingSettlement: number;
  totalPairsMinted: number;
  totalVaultUSDC: number;
  totalOrders: number;
  totalActiveOrders: number;
  paused: boolean;
}

type TimelineEvent = {
  id: string;
  timestamp: number;
  type: "market_created" | "order_placed" | "order_filled" | "market_settled" | "market_expired";
  ticker: string;
  description: string;
  detail: string;
  color: string;
  icon: string;
  marketPubkey?: PublicKey;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getNextETTime(hour: number, minute: number): Date {
  const now = new Date();
  // Compute current ET time
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etNow = new Date(etStr);

  const target = new Date(etNow);
  target.setHours(hour, minute, 0, 0);

  // If target is in the past, move to next weekday
  if (target <= etNow) {
    target.setDate(target.getDate() + 1);
  }
  // Skip weekends
  while (target.getDay() === 0 || target.getDay() === 6) {
    target.setDate(target.getDate() + 1);
  }

  // Convert back to UTC by finding the offset
  const diff = now.getTime() - etNow.getTime();
  return new Date(target.getTime() + diff);
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  });
}

function timeAgo(ts: number): string {
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { connection } = useConnection();
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [orders, setOrders] = useState<OrderInfo[]>([]);
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const divisor = Math.pow(10, PRICE_DECIMALS);
  const qtyDivisor = Math.pow(10, 6);

  const fetchDashboard = useCallback(async () => {
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

      // Fetch config
      const [configPda] = findConfigPda();
      let paused = false;
      try {
        const config = await program.account.config.fetch(configPda);
        paused = (config as Record<string, unknown>).paused as boolean ?? false;
      } catch {
        // Config may not exist yet
      }

      // Fetch market registry
      const [registryPda] = findMarketRegistryPda();
      let marketKeys: PublicKey[] = [];
      try {
        const registry = await program.account.marketRegistry.fetch(registryPda);
        marketKeys = (registry.markets as PublicKey[]).filter(
          (k: PublicKey) => !k.equals(new PublicKey("11111111111111111111111111111111"))
        );
      } catch {
        // Registry may not exist yet
      }

      if (marketKeys.length === 0) {
        setMarkets([]);
        setOrders([]);
        setStats({
          totalMarkets: 0,
          activeMarkets: 0,
          settledMarkets: 0,
          awaitingSettlement: 0,
          totalPairsMinted: 0,
          totalVaultUSDC: 0,
          totalOrders: 0,
          totalActiveOrders: 0,
          paused,
        });
        setLoading(false);
        setLastRefresh(new Date());
        return;
      }

      // Fetch all markets and orderbooks in parallel
      const allMarkets: MarketInfo[] = [];
      const allOrders: OrderInfo[] = [];
      let totalVaultUSDC = 0;

      const results = await Promise.allSettled(
        marketKeys.map(async (marketKey: PublicKey) => {
          const [orderbookPda] = findOrderbookPda(marketKey);
          const [vaultPda] = findVaultPda(marketKey);

          const [marketAccount, orderbookAccount] = await Promise.all([
            program.account.market.fetch(marketKey),
            program.account.orderBook.fetch(orderbookPda),
          ]);

          // Try to get vault balance
          let vaultBalance = 0;
          try {
            const vaultInfo = await connection.getTokenAccountBalance(vaultPda);
            vaultBalance = Number(vaultInfo.value.amount);
          } catch {
            // Vault may not exist
          }

          const mInfo: MarketInfo = {
            publicKey: marketKey,
            marketId: (marketAccount.marketId as BN).toNumber(),
            ticker: marketAccount.ticker as string,
            strikePrice: marketAccount.strikePrice as BN,
            date: marketAccount.date as number,
            settled: marketAccount.settled as boolean,
            outcomeYesWins: marketAccount.outcomeYesWins as boolean,
            settlementPrice: marketAccount.settlementPrice as BN,
            totalPairsMinted: marketAccount.totalPairsMinted as BN,
            vaultBalance,
          };
          allMarkets.push(mInfo);
          totalVaultUSDC += vaultBalance;

          // Gather all orders
          const orderbookOrders = orderbookAccount.orders as Array<{
            orderId: BN;
            maker: PublicKey;
            isBid: boolean;
            price: BN;
            quantity: BN;
            filled: BN;
            timestamp: BN;
            cancelled: boolean;
          }>;

          for (const order of orderbookOrders) {
            allOrders.push({
              marketPubkey: marketKey,
              ticker: marketAccount.ticker as string,
              orderId: (order.orderId as BN).toNumber(),
              maker: order.maker,
              isBid: order.isBid,
              price: order.price,
              quantity: order.quantity,
              filled: order.filled,
              timestamp: (order.timestamp as BN).toNumber(),
              cancelled: order.cancelled,
            });
          }
        })
      );

      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.warn(`Failed to fetch market ${marketKeys[i]?.toBase58()}:`, r.reason);
        }
      });

      // Sort markets by date desc then ticker
      allMarkets.sort((a, b) => b.date - a.date || a.ticker.localeCompare(b.ticker));

      // Sort orders by timestamp desc
      allOrders.sort((a, b) => b.timestamp - a.timestamp);

      const active = allMarkets.filter((m) => !m.settled && !isExpired(m.date));
      const settled = allMarkets.filter((m) => m.settled);
      const awaiting = allMarkets.filter((m) => !m.settled && isExpired(m.date));
      const totalPairs = allMarkets.reduce(
        (sum, m) => sum + m.totalPairsMinted.toNumber(),
        0
      );
      const activeOrders = allOrders.filter(
        (o) => !o.cancelled && o.quantity.sub(o.filled).gt(new BN(0))
      );

      setMarkets(allMarkets);
      setOrders(allOrders);
      setStats({
        totalMarkets: allMarkets.length,
        activeMarkets: active.length,
        settledMarkets: settled.length,
        awaitingSettlement: awaiting.length,
        totalPairsMinted: totalPairs,
        totalVaultUSDC: totalVaultUSDC,
        totalOrders: allOrders.length,
        totalActiveOrders: activeOrders.length,
        paused,
      });
      setLastRefresh(new Date());
    } catch (err) {
      console.error("Dashboard fetch failed:", err);
      setError("Failed to load dashboard. Check your connection to Solana Devnet.");
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(fetchDashboard, 15000); // Refresh every 15s
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  // ─── Build timeline events ────────────────────────────────────────────────

  const timeline = useMemo((): TimelineEvent[] => {
    const events: TimelineEvent[] = [];

    // Market creation events (approximate — use the date field as creation indicator)
    for (const m of markets) {
      // Market was created for this date
      const year = Math.floor(m.date / 10000);
      const month = Math.floor((m.date % 10000) / 100);
      const day = m.date % 100;
      // Approximate creation at 8:30 AM ET the same day
      const isDST = month >= 3 && month <= 11;
      const etOffset = isDST ? 4 : 5;
      const createdTs = Math.floor(
        new Date(Date.UTC(year, month - 1, day, 8 + etOffset, 30, 0)).getTime() / 1000
      );

      events.push({
        id: `created-${m.publicKey.toBase58()}`,
        timestamp: createdTs,
        type: "market_created",
        ticker: m.ticker,
        description: `${m.ticker} market created`,
        detail: `Strike ${formatStrikePrice(m.strikePrice)} for ${formatMarketDate(m.date)}`,
        color: "text-blue-400",
        icon: "M12 6v6m0 0v6m0-6h6m-6 0H6",
        marketPubkey: m.publicKey,
      });

      if (m.settled) {
        // Settlement event (approximate at 4:05 PM ET)
        const settleTs = Math.floor(
          new Date(Date.UTC(year, month - 1, day, 16 + etOffset, 5, 0)).getTime() / 1000
        );
        events.push({
          id: `settled-${m.publicKey.toBase58()}`,
          timestamp: settleTs,
          type: "market_settled",
          ticker: m.ticker,
          description: `${m.ticker} settled — ${m.outcomeYesWins ? "Yes wins" : "No wins"}`,
          detail: `Settlement price: $${(m.settlementPrice.toNumber() / 100).toFixed(2)} vs strike ${formatStrikePrice(m.strikePrice)}`,
          color: m.outcomeYesWins ? "text-emerald-400" : "text-red-400",
          icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
          marketPubkey: m.publicKey,
        });
      } else if (isExpired(m.date)) {
        const expireTs = Math.floor(
          new Date(Date.UTC(year, month - 1, day, 16 + etOffset, 0, 0)).getTime() / 1000
        );
        events.push({
          id: `expired-${m.publicKey.toBase58()}`,
          timestamp: expireTs,
          type: "market_expired",
          ticker: m.ticker,
          description: `${m.ticker} closed — awaiting settlement`,
          detail: `Market close at 4:00 PM ET`,
          color: "text-yellow-400",
          icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
          marketPubkey: m.publicKey,
        });
      }
    }

    // Order events
    for (const o of orders) {
      const priceStr = `$${(o.price.toNumber() / divisor).toFixed(2)}`;
      const qtyStr = `${(o.quantity.toNumber() / qtyDivisor).toFixed(0)}`;
      const filledQty = o.filled.toNumber();
      const totalQty = o.quantity.toNumber();
      const isFullyFilled = filledQty >= totalQty;
      const isPartial = filledQty > 0 && filledQty < totalQty;

      events.push({
        id: `order-${o.marketPubkey.toBase58()}-${o.orderId}`,
        timestamp: o.timestamp,
        type: isFullyFilled ? "order_filled" : "order_placed",
        ticker: o.ticker,
        description: `${o.isBid ? "BID" : "ASK"} ${qtyStr} ${o.ticker} @ ${priceStr}${
          isFullyFilled ? " — FILLED" : isPartial ? ` — ${Math.round((filledQty / totalQty) * 100)}% filled` : ""
        }`,
        detail: `by ${shortenAddress(o.maker.toBase58())}${o.cancelled ? " (cancelled)" : ""}`,
        color: o.cancelled
          ? "text-gray-500"
          : isFullyFilled
          ? "text-emerald-400"
          : o.isBid
          ? "text-emerald-400"
          : "text-red-400",
        icon: isFullyFilled
          ? "M9 12l2 2 4-4"
          : o.isBid
          ? "M3 17l6-6 4 4 8-8"
          : "M3 7l6 6 4-4 8 8",
        marketPubkey: o.marketPubkey,
      });
    }

    // Sort all events by timestamp desc
    events.sort((a, b) => b.timestamp - a.timestamp);

    return events;
  }, [markets, orders, divisor, qtyDivisor]);

  // ─── Next automation times ────────────────────────────────────────────────

  const nextCreate = useMemo(() => getNextETTime(8, 30), []);
  const nextSettle = useMemo(() => getNextETTime(16, 5), []);

  // ─── Market status helper ─────────────────────────────────────────────────

  const getMarketStatus = (m: MarketInfo) => {
    if (m.settled) {
      return {
        label: m.outcomeYesWins ? "Yes Won" : "No Won",
        color: m.outcomeYesWins ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20" : "bg-red-500/10 text-red-400 ring-red-500/20",
        dotColor: m.outcomeYesWins ? "bg-emerald-400" : "bg-red-400",
      };
    }
    if (isExpired(m.date)) {
      return {
        label: "Awaiting Settlement",
        color: "bg-yellow-500/10 text-yellow-400 ring-yellow-500/20",
        dotColor: "bg-yellow-400 animate-pulse",
      };
    }
    return {
      label: "Live",
      color: "bg-yellow-500/10 text-yellow-400 ring-yellow-500/20",
      dotColor: "bg-yellow-400 animate-pulse",
    };
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <h1 className="mb-6 text-2xl font-bold text-white">Dashboard</h1>
        <div className="flex min-h-[400px] items-center justify-center rounded-2xl border border-gray-800/60 bg-gray-900/50">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-yellow-500 border-t-transparent" />
            <span className="text-sm text-gray-400">Loading protocol data...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <h1 className="mb-6 text-2xl font-bold text-white">Dashboard</h1>
        <div className="flex min-h-[400px] flex-col items-center justify-center gap-4 rounded-2xl border border-gray-800/60 bg-gray-900/50 p-8">
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={() => { setLoading(true); fetchDashboard(); }}
            className="rounded-lg bg-gray-800 px-4 py-2 text-xs font-medium text-gray-300 hover:bg-gray-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Protocol Dashboard</h1>
          <p className="mt-1 text-xs text-gray-500">
            Real-time on-chain visibility &middot; Last updated {lastRefresh.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); fetchDashboard(); }}
          className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-700 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* ─── Protocol Health Stats ─────────────────────────────────────────── */}
      {stats && (
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-5">
          <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-4">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Markets</span>
            <p className="mt-1 font-mono text-2xl font-bold text-white">{stats.totalMarkets}</p>
            <div className="mt-1 flex items-center gap-2 text-[11px]">
              <span className="text-emerald-400">{stats.activeMarkets} live</span>
              <span className="text-gray-600">&middot;</span>
              <span className="text-gray-400">{stats.settledMarkets} settled</span>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-4">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">TVL (Vault)</span>
            <p className="mt-1 font-mono text-2xl font-bold text-white">
              ${(stats.totalVaultUSDC / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="mt-1 text-[11px] text-gray-500">USDC locked in vaults</p>
          </div>

          <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-4">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Contracts</span>
            <p className="mt-1 font-mono text-2xl font-bold text-white">
              {(stats.totalPairsMinted / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </p>
            <p className="mt-1 text-[11px] text-gray-500">Yes+No pairs minted</p>
          </div>

          <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-4">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Orders</span>
            <p className="mt-1 font-mono text-2xl font-bold text-white">{stats.totalOrders}</p>
            <div className="mt-1 flex items-center gap-2 text-[11px]">
              <span className="text-blue-400">{stats.totalActiveOrders} active</span>
              <span className="text-gray-600">&middot;</span>
              <span className="text-gray-400">{stats.totalOrders - stats.totalActiveOrders} filled/cancelled</span>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-4">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Protocol</span>
            <p className="mt-2">
              {stats.paused ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-400 ring-1 ring-inset ring-red-500/20">
                  <span className="h-2 w-2 rounded-full bg-red-400" />
                  Paused
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                  Active
                </span>
              )}
            </p>
            {stats.awaitingSettlement > 0 && (
              <p className="mt-1 text-[11px] text-yellow-400">
                {stats.awaitingSettlement} awaiting settle
              </p>
            )}
          </div>
        </div>
      )}

      {/* ─── Two-column layout: Markets + Timeline ─────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-5">
        {/* Left: Market Lifecycle Cards (2 cols) */}
        <div className="lg:col-span-2">
          <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50">
            <div className="border-b border-gray-800/60 px-5 py-4">
              <h2 className="text-sm font-bold text-white">Market Lifecycle</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">All markets by date</p>
            </div>
            <div className="max-h-[600px] overflow-y-auto">
              {markets.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-600">
                  No markets created yet. The cron job creates markets at 8:30 AM ET on weekdays.
                </div>
              ) : (
                <div className="divide-y divide-gray-800/40">
                  {markets.map((m) => {
                    const status = getMarketStatus(m);
                    const tickerInfo = MAG7_TICKERS[m.ticker];
                    const pairsMinted = m.totalPairsMinted.toNumber() / 1_000_000;
                    const vaultUsd = m.vaultBalance / 1_000_000;

                    return (
                      <Link
                        key={m.publicKey.toBase58()}
                        href={`/trade/${m.publicKey.toBase58()}`}
                        className="block px-5 py-4 transition-colors hover:bg-gray-800/30"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <div
                              className="flex h-9 w-9 items-center justify-center rounded-xl text-xs font-bold text-white"
                              style={{ backgroundColor: tickerInfo?.color ?? "#6B7280" }}
                            >
                              {m.ticker.slice(0, 2)}
                            </div>
                            <div>
                              <span className="text-sm font-bold text-white">{m.ticker}</span>
                              <span className="ml-2 text-xs text-gray-500">
                                &gt; {formatStrikePrice(m.strikePrice)}
                              </span>
                              <p className="text-[11px] text-gray-500">{formatMarketDate(m.date)}</p>
                            </div>
                          </div>
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${status.color}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${status.dotColor}`} />
                            {status.label}
                          </span>
                        </div>

                        {/* Market stats row */}
                        <div className="mt-2.5 flex items-center gap-4 text-[11px] text-gray-500">
                          <span>
                            <span className="text-gray-400">{pairsMinted.toFixed(0)}</span> pairs
                          </span>
                          <span>
                            <span className="text-gray-400">${vaultUsd.toFixed(2)}</span> vault
                          </span>
                          {m.settled && (
                            <span>
                              settled @ <span className="text-gray-400">${(m.settlementPrice.toNumber() / 100).toFixed(2)}</span>
                            </span>
                          )}
                        </div>

                        {/* Lifecycle bar */}
                        <div className="mt-2 flex items-center gap-1">
                          <div className="h-1 flex-1 rounded-full bg-blue-500" title="Created" />
                          <div className={`h-1 flex-1 rounded-full ${!m.settled && !isExpired(m.date) ? "bg-yellow-500 animate-pulse" : "bg-yellow-500"}`} title="Trading" />
                          <div className={`h-1 flex-1 rounded-full ${isExpired(m.date) || m.settled ? "bg-orange-500" : "bg-gray-800"}`} title="Closed" />
                          <div className={`h-1 flex-1 rounded-full ${m.settled ? (m.outcomeYesWins ? "bg-emerald-500" : "bg-red-500") : "bg-gray-800"}`} title="Settled" />
                        </div>
                        <div className="mt-1 flex items-center gap-1 text-[9px] text-gray-600">
                          <span className="flex-1 text-center">Created</span>
                          <span className="flex-1 text-center">Trading</span>
                          <span className="flex-1 text-center">Closed</span>
                          <span className="flex-1 text-center">Settled</span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Automation Schedule */}
          <div className="mt-6 rounded-2xl border border-gray-800/60 bg-gray-900/50 p-5">
            <h2 className="text-sm font-bold text-white">Automation Schedule</h2>
            <p className="mt-0.5 text-[11px] text-gray-500">Vercel cron jobs (weekdays only)</p>

            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
                  <svg className="h-4 w-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-semibold text-white">Market Creation</p>
                  <p className="text-[11px] text-gray-500">
                    8:30 AM ET &middot; Creates 0DTE markets for all MAG7 tickers
                  </p>
                  <p className="text-[10px] text-gray-600 font-mono">
                    Next: {nextCreate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10">
                  <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-semibold text-white">Market Settlement</p>
                  <p className="text-[11px] text-gray-500">
                    4:05 PM ET &middot; Settles all expired markets via Pyth oracle
                  </p>
                  <p className="text-[10px] text-gray-600 font-mono">
                    Next: {nextSettle.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Event Timeline (3 cols) */}
        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50">
            <div className="border-b border-gray-800/60 px-5 py-4">
              <h2 className="text-sm font-bold text-white">Activity Timeline</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">
                All on-chain events across all markets &middot; {timeline.length} events
              </p>
            </div>

            <div className="max-h-[720px] overflow-y-auto">
              {timeline.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-600">
                  No activity yet. Events will appear as markets are created and orders are placed.
                </div>
              ) : (
                <div className="relative">
                  {/* Vertical line */}
                  <div className="absolute left-8 top-0 bottom-0 w-px bg-gray-800/60" />

                  {timeline.slice(0, 50).map((event, i) => {
                    const tickerInfo = MAG7_TICKERS[event.ticker];

                    return (
                      <div key={event.id} className="relative flex gap-4 px-5 py-3 transition-colors hover:bg-gray-800/20">
                        {/* Timeline dot */}
                        <div className="relative z-10 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gray-900 ring-2 ring-gray-800">
                          <svg className={`h-3.5 w-3.5 ${event.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d={event.icon} />
                          </svg>
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex-1 pt-0.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-gray-200 truncate">
                                {event.description}
                              </p>
                              <p className="text-[11px] text-gray-500 truncate">{event.detail}</p>
                            </div>
                            <div className="flex-shrink-0 text-right">
                              <p className="text-[10px] font-mono text-gray-600">
                                {timeAgo(event.timestamp)}
                              </p>
                              <p className="text-[9px] font-mono text-gray-700">
                                {formatTimestamp(event.timestamp)}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {timeline.length > 50 && (
                    <div className="px-5 py-4 text-center text-[11px] text-gray-600">
                      Showing 50 of {timeline.length} events
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ─── On-Chain Addresses (collapsible reference) ────────────────────── */}
      <details className="mt-8 rounded-2xl border border-gray-800/60 bg-gray-900/50">
        <summary className="cursor-pointer px-5 py-4 text-sm font-bold text-white hover:text-yellow-400 transition-colors">
          On-Chain Addresses &amp; Explorer Links
        </summary>
        <div className="border-t border-gray-800/60 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Program ID</p>
              <a
                href="https://explorer.solana.com/address/2zchyfx482vagebbGJ2ePq8AuuafwS1Hc6YoSkgAfTe1?cluster=devnet"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 block truncate font-mono text-xs text-yellow-400 hover:underline"
              >
                2zchyfx4...fTe1
              </a>
            </div>
            {markets.map((m) => (
              <div key={m.publicKey.toBase58()}>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  {m.ticker} Market #{m.marketId}
                </p>
                <a
                  href={`https://explorer.solana.com/address/${m.publicKey.toBase58()}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 block truncate font-mono text-xs text-yellow-400 hover:underline"
                >
                  {shortenAddress(m.publicKey.toBase58(), 6)}
                </a>
              </div>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}
