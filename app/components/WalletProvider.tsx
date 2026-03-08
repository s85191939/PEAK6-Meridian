"use client";

import React, { useMemo, useCallback } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { WalletError } from "@solana/wallet-adapter-base";
import { RPC_URL } from "@/lib/constants";

import "@solana/wallet-adapter-react-ui/styles.css";

export default function WalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Modern wallets (Phantom, Solflare, Backpack, etc.) register via
  // the Wallet Standard and are auto-detected — no manual adapters needed.
  const wallets = useMemo(() => [], []);

  // Silently handle wallet errors — user rejections, disconnects, etc.
  // should not surface as unhandled console errors.
  const onError = useCallback((error: WalletError) => {
    // User rejected connection or transaction — no action needed
    if (
      error.name === "WalletConnectionError" ||
      error.name === "WalletDisconnectedError" ||
      error.name === "WalletSignTransactionError" ||
      error.message?.includes("User rejected")
    ) {
      return;
    }
    // Only log genuinely unexpected errors for debugging
    console.warn("[Wallet]", error.name, error.message);
  }, []);

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <SolanaWalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
