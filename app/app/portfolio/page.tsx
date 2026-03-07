"use client";

import React from "react";
import PortfolioView from "@/components/PortfolioView";

export default function PortfolioPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Portfolio</h1>
        <p className="mt-1 text-sm text-gray-500">
          View your open positions, settled outcomes, and redeem winning tokens.
        </p>
      </div>
      <PortfolioView />
    </div>
  );
}
