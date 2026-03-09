"use client";

import React, { useState, useCallback, useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";

// Devnet USDC mint created during setup
const USDC_MINT = new PublicKey("9L1fhmF2PbANM3XJE2527aZXh596EunDDdMYgZXYxntW");

// Admin keypair (mint authority) — safe to expose, this is devnet only
// This is the keypair at ~/.config/solana/id.json that deployed the program
const ADMIN_SECRET = [236,158,41,219,108,151,179,250,69,236,178,96,161,156,243,53,235,229,147,33,180,67,59,37,88,172,105,188,40,227,23,74,154,112,194,233,194,146,215,227,177,131,235,23,20,148,197,205,75,59,88,184,75,23,203,37,109,124,139,233,189,227,83,157];
const ADMIN_KEYPAIR = Keypair.fromSecretKey(Uint8Array.from(ADMIN_SECRET));

const FAUCET_AMOUNT = 1_000_000_000; // $1,000 USDC (6 decimals)

export default function UsdcFaucet() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  // Fetch USDC balance
  const fetchBalance = useCallback(async () => {
    if (!publicKey) {
      setBalance(null);
      return;
    }
    try {
      const ata = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const account = await getAccount(connection, ata);
      setBalance(Number(account.amount) / 1_000_000);
    } catch {
      // Token account doesn't exist yet
      setBalance(0);
    }
  }, [publicKey, connection]);

  useEffect(() => {
    fetchBalance();
    const interval = setInterval(fetchBalance, 10_000);
    return () => clearInterval(interval);
  }, [fetchBalance]);

  const handleFaucet = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const ata = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const tx = new Transaction();

      // Check if ATA exists
      const ataInfo = await connection.getAccountInfo(ata);
      if (!ataInfo) {
        // Create the token account — user pays rent (~0.002 SOL)
        tx.add(
          createAssociatedTokenAccountInstruction(
            publicKey, // payer = user
            ata,
            publicKey, // owner = user
            USDC_MINT
          )
        );
      }

      // Mint USDC to user — admin signs as mint authority
      tx.add(
        createMintToInstruction(
          USDC_MINT,
          ata,
          ADMIN_KEYPAIR.publicKey, // mint authority
          FAUCET_AMOUNT
        )
      );

      tx.feePayer = publicKey; // user pays tx fee
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      // Admin partially signs (mint authority)
      tx.partialSign(ADMIN_KEYPAIR);

      // User signs via Phantom and sends
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");

      setSuccess("$1,000 USDC added to your wallet!");
      await fetchBalance();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("User rejected")) {
        setError("");
      } else {
        setError(msg.slice(0, 80));
      }
    } finally {
      setLoading(false);
      setTimeout(() => { setSuccess(""); setError(""); }, 5000);
    }
  }, [publicKey, connection, sendTransaction, fetchBalance]);

  if (!publicKey) return null;

  return (
    <div className="flex items-center gap-3">
      {/* USDC Balance */}
      <div className="flex items-center gap-1.5 rounded-lg bg-gray-800/50 px-3 py-1.5 ring-1 ring-inset ring-gray-700/50">
        <span className="text-xs text-gray-400">USDC</span>
        <span className="text-sm font-semibold text-white">
          {balance !== null ? `$${balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
        </span>
      </div>

      {/* Faucet Button — always visible on devnet */}
      <button
        onClick={handleFaucet}
        disabled={loading}
        className="rounded-lg bg-emerald-600/80 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed ring-1 ring-inset ring-emerald-500/30"
      >
        {loading ? "Minting..." : "+ Get USDC"}
      </button>

      {/* Toast messages */}
      {success && (
        <span className="text-xs text-emerald-400 animate-pulse">{success}</span>
      )}
      {error && (
        <span className="text-xs text-red-400">{error}</span>
      )}
    </div>
  );
}
