"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

export default function Navbar() {
  const pathname = usePathname();

  const navLinks = [
    { href: "/markets", label: "Markets" },
    { href: "/portfolio", label: "Portfolio" },
    { href: "/history", label: "History" },
  ];

  return (
    <nav className="sticky top-0 z-50 border-b border-gray-800/60 bg-[#0a0a0a]/95 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        {/* Logo — PEAK6 Meridian */}
        <Link href="/" className="flex items-center gap-3">
          <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-yellow-400 to-amber-500 shadow-lg shadow-yellow-500/20">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="h-5 w-5 text-black"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 17l6-6 4 4 8-8"
              />
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 7h4v4" />
            </svg>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-black uppercase tracking-widest text-yellow-400">
              PEAK6
            </span>
            <span className="text-lg font-bold tracking-tight text-white">
              Meridian
            </span>
          </div>
          <span className="ml-1 rounded-md bg-yellow-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-yellow-400 ring-1 ring-inset ring-yellow-500/25">
            Devnet
          </span>
        </Link>

        {/* Nav Links */}
        <div className="flex items-center gap-1">
          {navLinks.map((link) => {
            const isActive =
              link.href === "/markets"
                ? pathname === "/markets" || pathname.startsWith("/trade")
                : pathname.startsWith(link.href);

            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-xl px-4 py-2 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? "bg-yellow-500/10 text-yellow-400 ring-1 ring-inset ring-yellow-500/20"
                    : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>

        {/* Wallet */}
        <div className="wallet-adapter-button-wrapper">
          <WalletMultiButton />
        </div>
      </div>
    </nav>
  );
}
