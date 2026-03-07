"use client";

import React, { useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { MarketData } from "./MarketCard";
import {
  findOrderbookPda,
  findEscrowYesPda,
  findVaultPda,
  percentToPrice,
  parseUsdc,
  formatPrice,
  noPrice as computeNoPrice,
  priceToPercent,
} from "@/lib/utils";
import { PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/constants";
import type { Meridian } from "../../target/types/meridian";
import idl from "../../target/idl/meridian.json";

type TradeAction = "buy_yes" | "buy_no" | "sell_yes" | "sell_no";

interface TradePanelProps {
  market: MarketData;
  onTradeComplete?: () => void;
}

export default function TradePanel({ market, onTradeComplete }: TradePanelProps) {
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [action, setAction] = useState<TradeAction>("buy_yes");
  const [priceInput, setPriceInput] = useState("50");
  const [quantityInput, setQuantityInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const isBuy = action === "buy_yes" || action === "buy_no";
  const isYes = action === "buy_yes" || action === "sell_yes";

  const pricePercent = Math.min(100, Math.max(1, parseInt(priceInput) || 50));
  const priceBn = percentToPrice(pricePercent);
  const noPriceBn = computeNoPrice(priceBn);
  const displayPrice = isYes ? priceBn : noPriceBn;

  const getProgram = useCallback(() => {
    if (!publicKey || !signTransaction) return null;
    const provider = new AnchorProvider(
      connection,
      { publicKey, signTransaction, signAllTransactions: async (txs) => txs },
      { commitment: "confirmed" }
    );
    return new Program<Meridian>(idl as Meridian, provider);
  }, [publicKey, signTransaction, connection]);

  const executeTrade = useCallback(async () => {
    if (!publicKey || !signTransaction) {
      setError("Connect your wallet first");
      return;
    }

    const qty = parseFloat(quantityInput);
    if (isNaN(qty) || qty <= 0) {
      setError("Enter a valid quantity");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const program = getProgram();
      if (!program) throw new Error("Failed to initialize program");

      const marketKey = market.publicKey;
      const [orderbookPda] = findOrderbookPda(marketKey);
      const [vaultPda] = findVaultPda(marketKey);
      const [escrowYesPda] = findEscrowYesPda(marketKey);

      const userUsdc = await getAssociatedTokenAddress(
        market.noMint, // We use vault's mint which is USDC - need config
        publicKey
      );

      const userYes = await getAssociatedTokenAddress(
        market.yesMint,
        publicKey
      );
      const userNo = await getAssociatedTokenAddress(
        market.noMint,
        publicKey
      );

      const quantityBn = parseUsdc(quantityInput);
      const tx = new Transaction();

      // Determine the on-chain Yes price for order placement
      // For Buy Yes / Sell Yes: use the Yes price directly
      // For Buy No: we mintPair + sell Yes (place ask on Yes book at complementary price)
      // For Sell No: we buy Yes (place bid on Yes book) + mergePair

      const yesOrderPrice = isYes ? priceBn : computeNoPrice(priceBn);
      const yesSideIsBid = action === "buy_yes" || action === "sell_no";

      if (action === "buy_no") {
        // Buy No = mintPair() + sell Yes on the book
        // First mint pairs: deposits USDC, gets Yes + No tokens
        const mintIx = await program.methods
          .mintPair(quantityBn)
          .accounts({
            user: publicKey,
            market: marketKey,
            yesMint: market.yesMint,
            noMint: market.noMint,
            vault: vaultPda,
            userUsdc,
            userYes,
            userNo,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();
        tx.add(mintIx);

        // Then sell Yes tokens (place ask)
        const placeIx = await program.methods
          .placeOrder(false, yesOrderPrice, quantityBn)
          .accounts({
            user: publicKey,
            market: marketKey,
            orderbook: orderbookPda,
            vault: vaultPda,
            userUsdc,
            userYes,
            escrowYes: escrowYesPda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();
        tx.add(placeIx);
      } else if (action === "sell_no") {
        // Sell No = buy Yes (bid) + mergePair
        // First buy Yes tokens (place bid)
        const placeIx = await program.methods
          .placeOrder(true, yesOrderPrice, quantityBn)
          .accounts({
            user: publicKey,
            market: marketKey,
            orderbook: orderbookPda,
            vault: vaultPda,
            userUsdc,
            userYes,
            escrowYes: escrowYesPda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();
        tx.add(placeIx);

        // Then merge pairs to get USDC back
        const mergeIx = await program.methods
          .mergePair(quantityBn)
          .accounts({
            user: publicKey,
            market: marketKey,
            yesMint: market.yesMint,
            noMint: market.noMint,
            vault: vaultPda,
            userUsdc,
            userYes,
            userNo,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();
        tx.add(mergeIx);
      } else {
        // Buy Yes (bid) or Sell Yes (ask) - simple placeOrder
        const placeIx = await program.methods
          .placeOrder(yesSideIsBid, yesOrderPrice, quantityBn)
          .accounts({
            user: publicKey,
            market: marketKey,
            orderbook: orderbookPda,
            vault: vaultPda,
            userUsdc,
            userYes,
            escrowYes: escrowYesPda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();
        tx.add(placeIx);
      }

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");

      setSuccess(`Order placed. Tx: ${sig.slice(0, 8)}...`);
      onTradeComplete?.();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Transaction failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [
    publicKey,
    signTransaction,
    quantityInput,
    action,
    priceBn,
    market,
    getProgram,
    sendTransaction,
    connection,
    onTradeComplete,
  ]);

  const actionLabels: Record<TradeAction, string> = {
    buy_yes: "Buy Yes",
    buy_no: "Buy No",
    sell_yes: "Sell Yes",
    sell_no: "Sell No",
  };

  const actionColors: Record<TradeAction, string> = {
    buy_yes: "bg-emerald-600 hover:bg-emerald-500",
    buy_no: "bg-red-600 hover:bg-red-500",
    sell_yes: "bg-red-600 hover:bg-red-500",
    sell_no: "bg-emerald-600 hover:bg-emerald-500",
  };

  const tabColors: Record<TradeAction, string> = {
    buy_yes: "bg-emerald-600 text-white",
    buy_no: "bg-red-600 text-white",
    sell_yes: "bg-red-600 text-white",
    sell_no: "bg-emerald-600 text-white",
  };

  const estimatedCost = (pricePercent / 100) * (parseFloat(quantityInput) || 0);

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900">
      {/* Action tabs */}
      <div className="grid grid-cols-4 border-b border-gray-800">
        {(Object.keys(actionLabels) as TradeAction[]).map((a) => (
          <button
            key={a}
            onClick={() => setAction(a)}
            className={`px-2 py-3 text-xs font-semibold transition-colors sm:text-sm ${
              action === a
                ? tabColors[a]
                : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            }`}
          >
            {actionLabels[a]}
          </button>
        ))}
      </div>

      <div className="space-y-4 p-5">
        {/* Price slider */}
        <div>
          <label className="mb-1.5 flex items-center justify-between text-sm text-gray-400">
            <span>Price</span>
            <span className="text-sm font-semibold text-white">
              {formatPrice(displayPrice)} ({isYes ? pricePercent : 100 - pricePercent}%)
            </span>
          </label>
          <input
            type="range"
            min={1}
            max={99}
            value={pricePercent}
            onChange={(e) => setPriceInput(e.target.value)}
            className="accent-emerald-500 h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-800"
          />
          <div className="mt-1 flex justify-between text-xs text-gray-600">
            <span>1\u00A2</span>
            <span>99\u00A2</span>
          </div>
        </div>

        {/* Quantity */}
        <div>
          <label className="mb-1.5 block text-sm text-gray-400">
            Quantity (contracts)
          </label>
          <input
            type="number"
            min="0"
            step="1"
            placeholder="0"
            value={quantityInput}
            onChange={(e) => setQuantityInput(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-sm text-white placeholder-gray-600 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        {/* Summary */}
        <div className="rounded-lg bg-gray-800/50 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-400">Estimated cost</span>
            <span className="font-semibold text-white">
              ${estimatedCost.toFixed(2)} USDC
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-sm">
            <span className="text-gray-400">Potential payout</span>
            <span className="font-semibold text-emerald-400">
              ${(parseFloat(quantityInput) || 0).toFixed(2)} USDC
            </span>
          </div>
        </div>

        {/* Error / Success */}
        {error && (
          <div className="rounded-lg bg-red-900/30 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-lg bg-emerald-900/30 px-3 py-2 text-sm text-emerald-400">
            {success}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={executeTrade}
          disabled={loading || !publicKey || market.settled}
          className={`w-full rounded-lg py-3.5 text-sm font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${actionColors[action]}`}
        >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Placing order...
            </span>
          ) : !publicKey ? (
            "Connect Wallet"
          ) : market.settled ? (
            "Market Settled"
          ) : (
            actionLabels[action]
          )}
        </button>
      </div>
    </div>
  );
}
