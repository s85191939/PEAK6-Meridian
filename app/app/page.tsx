"use client";

import React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

const MAG7 = [
  { ticker: "AAPL", name: "Apple", color: "text-gray-300" },
  { ticker: "MSFT", name: "Microsoft", color: "text-blue-400" },
  { ticker: "GOOGL", name: "Alphabet", color: "text-red-400" },
  { ticker: "AMZN", name: "Amazon", color: "text-orange-400" },
  { ticker: "NVDA", name: "NVIDIA", color: "text-green-400" },
  { ticker: "META", name: "Meta", color: "text-blue-300" },
  { ticker: "TSLA", name: "Tesla", color: "text-red-300" },
];

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      {/* Hero */}
      <div className="text-center">
        <h1 className="text-5xl font-extrabold tracking-tight text-white sm:text-6xl">
          Trade Binary Outcomes
          <br />
          <span className="bg-gradient-to-r from-yellow-400 to-amber-500 bg-clip-text text-transparent">
            on MAG7 Stocks
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-gray-400">
          Predict whether a stock closes above or below a strike price today.
          Yes tokens pay $1 if you&apos;re right, $0 if you&apos;re wrong.
          Zero-day contracts settle at 4:00 PM ET using on-chain price data.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <Link
            href="/markets"
            className="rounded-xl bg-gradient-to-r from-yellow-500 to-amber-500 px-8 py-3 text-sm font-bold text-black shadow-lg shadow-yellow-500/20 transition-all hover:shadow-yellow-500/40"
          >
            Browse Markets
          </Link>
          <div className="wallet-adapter-button-wrapper">
            <WalletMultiButton />
          </div>
        </div>
      </div>

      {/* How It Works */}
      <div className="mt-20">
        <h2 className="text-center text-2xl font-bold text-white">
          How It Works
        </h2>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {[
            {
              step: "1",
              title: "Pick a Market",
              desc: 'Choose from 7 MAG7 stocks with multiple strike prices. Example: "Will AAPL close above $230?"',
            },
            {
              step: "2",
              title: "Buy Yes or No",
              desc: "Yes tokens pay $1.00 if the stock closes at or above the strike. No tokens pay $1.00 if it closes below.",
            },
            {
              step: "3",
              title: "Settle & Redeem",
              desc: "At 4:00 PM ET, markets settle automatically. Winning tokens pay $1.00 USDC. Losers pay $0.",
            },
          ].map((item) => (
            <div
              key={item.step}
              className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-6"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-yellow-500/15 text-sm font-bold text-yellow-400 ring-1 ring-inset ring-yellow-500/25">
                {item.step}
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">
                {item.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-500">
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* $1.00 Invariant */}
      <div className="mt-16 rounded-2xl border border-yellow-500/20 bg-yellow-500/5 p-8 text-center">
        <p className="text-lg font-bold text-yellow-400">
          The $1.00 Invariant
        </p>
        <p className="mt-2 text-sm text-gray-400">
          Yes payout + No payout = $1.00 USDC. Always. For every contract.
          Enforced on-chain at every transaction.
        </p>
        <div className="mt-4 flex items-center justify-center gap-8 font-mono text-sm">
          <span className="text-green-400">
            Yes @ $0.65 →{" "}
            <span className="text-white">win $1.00</span>
          </span>
          <span className="text-gray-600">|</span>
          <span className="text-red-400">
            No @ $0.35 →{" "}
            <span className="text-white">win $1.00</span>
          </span>
        </div>
      </div>

      {/* Supported Assets */}
      <div className="mt-16">
        <h2 className="text-center text-2xl font-bold text-white">
          Supported Assets
        </h2>
        <p className="mt-2 text-center text-sm text-gray-500">
          The Magnificent 7 — the most liquid US equities
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {MAG7.map((s) => (
            <div
              key={s.ticker}
              className="rounded-xl border border-gray-800/60 bg-gray-900/50 px-5 py-3 text-center"
            >
              <span className={`text-lg font-bold ${s.color}`}>
                {s.ticker}
              </span>
              <p className="text-xs text-gray-600">{s.name}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Key Features */}
      <div className="mt-16 grid gap-4 sm:grid-cols-2">
        {[
          {
            title: "Non-Custodial",
            desc: "Your tokens stay in your wallet. No KYC, no intermediaries.",
          },
          {
            title: "On-Chain Order Book",
            desc: "Limit orders matched on Solana with sub-second finality.",
          },
          {
            title: "0DTE Contracts",
            desc: "Zero days to expiry — markets created each morning, settled at close.",
          },
          {
            title: "4 Trade Paths",
            desc: "Buy Yes, Buy No, Sell Yes, Sell No — all on a single order book.",
          },
        ].map((f) => (
          <div
            key={f.title}
            className="rounded-2xl border border-gray-800/60 bg-gray-900/50 p-5"
          >
            <h3 className="text-sm font-semibold text-white">{f.title}</h3>
            <p className="mt-1 text-xs text-gray-500">{f.desc}</p>
          </div>
        ))}
      </div>

      {/* CTA */}
      <div className="mt-16 text-center">
        <Link
          href="/markets"
          className="inline-block rounded-xl bg-gradient-to-r from-yellow-500 to-amber-500 px-10 py-4 text-base font-bold text-black shadow-lg shadow-yellow-500/20 transition-all hover:shadow-yellow-500/40"
        >
          Start Trading →
        </Link>
        <p className="mt-4 text-xs text-gray-600">
          Solana Devnet · No real funds · Not financial advice
        </p>
      </div>
    </div>
  );
}
