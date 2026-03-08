"use client";

import React, { useState, useEffect } from "react";

/**
 * Counts down to 4:00 PM ET (market close) for a given market date.
 * Shows "Settles in Xh Ym" if before close, "Settlement pending" after.
 */
export default function CountdownTimer({ date }: { date: number }) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    function compute() {
      const dateStr = date.toString();
      const year = parseInt(dateStr.slice(0, 4));
      const month = parseInt(dateStr.slice(4, 6));
      const day = parseInt(dateStr.slice(6, 8));

      // Compute 4:00 PM ET in UTC
      // ET is UTC-5 (EST) or UTC-4 (EDT)
      // Use a simple heuristic: Mar-Nov is EDT (UTC-4), else EST (UTC-5)
      const isDST = month >= 3 && month <= 11;
      const etOffsetHours = isDST ? 4 : 5;
      const closeUTC = new Date(
        Date.UTC(year, month - 1, day, 16 + etOffsetHours, 0, 0)
      );

      const now = Date.now();
      const diff = closeUTC.getTime() - now;

      if (diff <= 0) {
        setTimeLeft("Settlement pending");
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      if (hours > 0) {
        setTimeLeft(`${hours}h ${minutes}m`);
      } else if (minutes > 0) {
        setTimeLeft(`${minutes}m ${seconds}s`);
      } else {
        setTimeLeft(`${seconds}s`);
      }
    }

    compute();
    const interval = setInterval(compute, 1000);
    return () => clearInterval(interval);
  }, [date]);

  const isPending = timeLeft === "Settlement pending";

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium ${
        isPending ? "text-yellow-400" : "text-gray-400"
      }`}
    >
      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
      {isPending ? timeLeft : `Settles in ${timeLeft}`}
    </span>
  );
}
