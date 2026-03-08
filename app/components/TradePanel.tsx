"use client";

import React, { useState, useCallback, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { MarketData } from "./MarketCard";
import {
  findConfigPda,
  findOrderbookPda,
  findEscrowYesPda,
  findBidEscrowPda,
  findVaultPda,
  percentToPrice,
  parseUsdc,
  formatPrice,
  noPrice as computeNoPrice,
  parseSolanaError,
  explorerUrl,
} from "@/lib/utils";
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
  const [txSignature, setTxSignature] = useState<string | null>(null);

  // Position constraint state
  const [yesBalance, setYesBalance] = useState<BN>(new BN(0));
  const [noBalance, setNoBalance] = useState<BN>(new BN(0));
  const [balanceLoading, setBalanceLoading] = useState(false);

  const isBuy = action === "buy_yes" || action === "buy_no";
  const isYes = action === "buy_yes" || action === "sell_yes";

  const pricePercent = Math.min(99, Math.max(1, parseInt(priceInput) || 50));
  const priceBn = percentToPrice(pricePercent);
  const noPriceBn = computeNoPrice(priceBn);
  const displayPrice = isYes ? priceBn : noPriceBn;

  // Fetch user's token balances for position constraints
  useEffect(() => {
    async function fetchBalances() {
      if (!publicKey) {
        setYesBalance(new BN(0));
        setNoBalance(new BN(0));
        return;
      }
      setBalanceLoading(true);
      try {
        const [userYesAta, userNoAta] = await Promise.all([
          getAssociatedTokenAddress(market.yesMint, publicKey),
          getAssociatedTokenAddress(market.noMint, publicKey),
        ]);

        const [yesResult, noResult] = await Promise.allSettled([
          connection.getTokenAccountBalance(userYesAta),
          connection.getTokenAccountBalance(userNoAta),
        ]);

        setYesBalance(
          yesResult.status === "fulfilled"
            ? new BN(yesResult.value.value.amount)
            : new BN(0)
        );
        setNoBalance(
          noResult.status === "fulfilled"
            ? new BN(noResult.value.value.amount)
            : new BN(0)
        );
      } catch {
        // Token accounts may not exist yet
      } finally {
        setBalanceLoading(false);
      }
    }
    fetchBalances();
  }, [publicKey, market.yesMint, market.noMint, connection]);

  // Position constraints: if user holds Yes, can't buy No (and vice versa)
  const hasYesPosition = yesBalance.gt(new BN(0));
  const hasNoPosition = noBalance.gt(new BN(0));

  const isActionDisabled = (a: TradeAction): boolean => {
    if (hasYesPosition && (a === "buy_no")) return true;
    if (hasNoPosition && (a === "buy_yes")) return true;
    return false;
  };

  const getConstraintMessage = (): string | null => {
    if (hasYesPosition && action === "buy_no") {
      return "You hold Yes tokens. Sell your Yes position before buying No.";
    }
    if (hasNoPosition && action === "buy_yes") {
      return "You hold No tokens. Sell your No position before buying Yes.";
    }
    return null;
  };

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

    const constraintMsg = getConstraintMessage();
    if (constraintMsg) {
      setError(constraintMsg);
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
    setTxSignature(null);

    try {
      const program = getProgram();
      if (!program) throw new Error("Failed to initialize program");

      const marketKey = market.publicKey;
      const [orderbookPda] = findOrderbookPda(marketKey);
      const [vaultPda] = findVaultPda(marketKey);
      const [escrowYesPda] = findEscrowYesPda(marketKey);
      const [bidEscrowPda] = findBidEscrowPda(marketKey);

      const [configPda] = findConfigPda();
      const configAccount = await program.account.config.fetch(configPda);
      const usdcMint = configAccount.usdcMint as PublicKey;

      const userUsdc = await getAssociatedTokenAddress(usdcMint, publicKey);
      const userYes = await getAssociatedTokenAddress(market.yesMint, publicKey);
      const userNo = await getAssociatedTokenAddress(market.noMint, publicKey);

      const quantityBn = parseUsdc(quantityInput);
      const tx = new Transaction();

      const yesOrderPrice = isYes ? priceBn : computeNoPrice(priceBn);
      const yesSideIsBid = action === "buy_yes" || action === "sell_no";

      if (action === "buy_no") {
        const mintIx = await program.methods
          .mintPair(quantityBn)
          .accounts({
            user: publicKey,
            config: configPda,
            market: marketKey,
            yesMint: market.yesMint,
            noMint: market.noMint,
            vault: vaultPda,
            userUsdc,
            userYes,
            userNo,
          } as any)
          .instruction();
        tx.add(mintIx);

        const placeIx = await program.methods
          .placeOrder(false, yesOrderPrice, quantityBn)
          .accounts({
            user: publicKey,
            config: configPda,
            market: marketKey,
            orderbook: orderbookPda,
            bidEscrow: bidEscrowPda,
            userUsdc,
            userYes,
            escrowYes: escrowYesPda,
          } as any)
          .instruction();
        tx.add(placeIx);
      } else if (action === "sell_no") {
        const placeIx = await program.methods
          .placeOrder(true, yesOrderPrice, quantityBn)
          .accounts({
            user: publicKey,
            config: configPda,
            market: marketKey,
            orderbook: orderbookPda,
            bidEscrow: bidEscrowPda,
            userUsdc,
            userYes,
            escrowYes: escrowYesPda,
          } as any)
          .instruction();
        tx.add(placeIx);

        const mergeIx = await program.methods
          .mergePair(quantityBn)
          .accounts({
            user: publicKey,
            config: configPda,
            market: marketKey,
            yesMint: market.yesMint,
            noMint: market.noMint,
            vault: vaultPda,
            userUsdc,
            userYes,
            userNo,
          } as any)
          .instruction();
        tx.add(mergeIx);
      } else {
        const placeIx = await program.methods
          .placeOrder(yesSideIsBid, yesOrderPrice, quantityBn)
          .accounts({
            user: publicKey,
            config: configPda,
            market: marketKey,
            orderbook: orderbookPda,
            bidEscrow: bidEscrowPda,
            userUsdc,
            userYes,
            escrowYes: escrowYesPda,
          } as any)
          .instruction();
        tx.add(placeIx);
      }

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");

      setTxSignature(sig);
      setSuccess("Order placed successfully!");
      setQuantityInput("");
      onTradeComplete?.();
    } catch (err: unknown) {
      setError(parseSolanaError(err));
    } finally {
      setLoading(false);
    }
  }, [
    publicKey,
    signTransaction,
    quantityInput,
    action,
    priceBn,
    isYes,
    market,
    getProgram,
    sendTransaction,
    connection,
    onTradeComplete,
    getConstraintMessage,
  ]);

  const actionLabels: Record<TradeAction, string> = {
    buy_yes: "Buy Yes",
    buy_no: "Buy No",
    sell_yes: "Sell Yes",
    sell_no: "Sell No",
  };

  const actionColors: Record<TradeAction, string> = {
    buy_yes: "bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 shadow-emerald-500/20",
    buy_no: "bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 shadow-red-500/20",
    sell_yes: "bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 shadow-red-500/20",
    sell_no: "bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 shadow-emerald-500/20",
  };

  const tabStyle = (a: TradeAction, active: boolean): string => {
    const disabled = isActionDisabled(a);
    if (disabled) return "text-gray-600 cursor-not-allowed opacity-40";
    if (!active) return "text-gray-400 hover:bg-gray-800/50 hover:text-gray-200";
    if (a === "buy_yes" || a === "sell_no") return "bg-emerald-600 text-white";
    return "bg-red-600 text-white";
  };

  // Estimated cost/proceeds calculation
  const qty = parseFloat(quantityInput) || 0;
  let estimatedCost: number;
  let costLabel: string;

  if (action === "buy_yes") {
    estimatedCost = (pricePercent / 100) * qty;
    costLabel = "Estimated cost";
  } else if (action === "buy_no") {
    estimatedCost = ((100 - pricePercent) / 100) * qty;
    costLabel = "Estimated cost";
  } else if (action === "sell_yes") {
    estimatedCost = (pricePercent / 100) * qty;
    costLabel = "Estimated proceeds";
  } else {
    estimatedCost = ((100 - pricePercent) / 100) * qty;
    costLabel = "Estimated proceeds";
  }

  // Payoff display
  const strikeStr = market.strikePrice.toNumber() / 1_000_000;
  const payoffText = (() => {
    if (!qty || qty <= 0) return null;
    const cost = estimatedCost.toFixed(2);
    if (action === "buy_yes") {
      return `You pay $${cost}. You win $${qty.toFixed(2)} if ${market.ticker} closes above $${strikeStr.toFixed(2)}.`;
    }
    if (action === "buy_no") {
      return `You pay $${cost}. You win $${qty.toFixed(2)} if ${market.ticker} closes below $${strikeStr.toFixed(2)}.`;
    }
    if (action === "sell_yes") {
      return `You receive $${cost} if your ask is filled. Max loss: $${(qty - estimatedCost).toFixed(2)} if ${market.ticker} closes above $${strikeStr.toFixed(2)}.`;
    }
    return `You receive $${cost} if your bid is filled.`;
  })();

  const constraintMessage = getConstraintMessage();

  return (
    <div className="rounded-2xl border border-gray-800/60 bg-gray-900/50">
      {/* Action tabs */}
      <div className="grid grid-cols-4 border-b border-gray-800/60">
        {(Object.keys(actionLabels) as TradeAction[]).map((a) => (
          <button
            key={a}
            onClick={() => !isActionDisabled(a) && setAction(a)}
            disabled={isActionDisabled(a)}
            className={`px-2 py-3 text-xs font-bold transition-all sm:text-sm ${tabStyle(a, action === a)}`}
            title={isActionDisabled(a) ? "Position constraint" : undefined}
          >
            {actionLabels[a]}
          </button>
        ))}
      </div>

      <div className="space-y-4 p-5">
        {/* Position constraint warning */}
        {constraintMessage && (
          <div className="flex items-start gap-2 rounded-xl bg-yellow-500/8 px-3 py-2.5 ring-1 ring-inset ring-yellow-500/20">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <span className="text-xs text-yellow-400">{constraintMessage}</span>
          </div>
        )}

        {/* Current position display */}
        {!balanceLoading && (hasYesPosition || hasNoPosition) && (
          <div className="flex gap-2">
            {hasYesPosition && (
              <div className="flex-1 rounded-xl bg-emerald-500/8 px-3 py-2 ring-1 ring-inset ring-emerald-500/20">
                <span className="text-[11px] text-gray-400">Your Yes</span>
                <p className="font-mono text-sm font-bold text-emerald-400">
                  {(yesBalance.toNumber() / 1_000_000).toFixed(2)}
                </p>
              </div>
            )}
            {hasNoPosition && (
              <div className="flex-1 rounded-xl bg-red-500/8 px-3 py-2 ring-1 ring-inset ring-red-500/20">
                <span className="text-[11px] text-gray-400">Your No</span>
                <p className="font-mono text-sm font-bold text-red-400">
                  {(noBalance.toNumber() / 1_000_000).toFixed(2)}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Price slider */}
        <div>
          <label className="mb-2 flex items-center justify-between text-sm text-gray-400">
            <span>Price</span>
            <span className="font-mono text-sm font-bold text-white">
              {formatPrice(displayPrice)} ({isYes ? pricePercent : 100 - pricePercent}%)
            </span>
          </label>
          <input
            type="range"
            min={1}
            max={99}
            value={pricePercent}
            onChange={(e) => setPriceInput(e.target.value)}
            className="h-2 w-full cursor-pointer"
          />
          <div className="mt-1 flex justify-between text-[11px] text-gray-600">
            <span>$0.01</span>
            <span>$0.99</span>
          </div>
        </div>

        {/* Quantity */}
        <div>
          <label className="mb-2 block text-sm text-gray-400">
            Quantity (contracts)
          </label>
          <input
            type="number"
            min="0"
            step="1"
            placeholder="0"
            value={quantityInput}
            onChange={(e) => setQuantityInput(e.target.value)}
            className="w-full rounded-xl border border-gray-700/60 bg-gray-800/50 px-4 py-3 font-mono text-sm text-white placeholder-gray-600 outline-none transition-colors focus:border-yellow-500 focus:ring-1 focus:ring-yellow-500/50"
          />
        </div>

        {/* Summary */}
        <div className="space-y-2 rounded-xl bg-gray-800/30 p-4 ring-1 ring-inset ring-gray-700/30">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-400">{costLabel}</span>
            <span className="font-mono font-bold text-white">
              ${estimatedCost.toFixed(2)} USDC
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-400">Max payout</span>
            <span className="font-mono font-bold text-emerald-400">
              ${qty.toFixed(2)} USDC
            </span>
          </div>
          {qty > 0 && estimatedCost > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Return</span>
              <span className="font-mono font-bold text-emerald-400">
                {((qty / estimatedCost - 1) * 100).toFixed(0)}%
              </span>
            </div>
          )}
        </div>

        {/* Payoff display */}
        {payoffText && (
          <p className="rounded-xl bg-gray-800/20 px-3 py-2.5 text-xs leading-relaxed text-gray-400">
            {payoffText}
          </p>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-red-500/8 px-3 py-2.5 ring-1 ring-inset ring-red-500/20">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <span className="text-xs text-red-400">{error}</span>
          </div>
        )}

        {/* Success */}
        {success && (
          <div className="flex items-start gap-2 rounded-xl bg-emerald-500/8 px-3 py-2.5 ring-1 ring-inset ring-emerald-500/20">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="text-xs text-emerald-400">
              <span>{success}</span>
              {txSignature && (
                <a
                  href={explorerUrl(txSignature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 underline hover:text-emerald-300"
                >
                  View on Explorer &rarr;
                </a>
              )}
            </div>
          </div>
        )}

        {/* Submit */}
        <button
          onClick={executeTrade}
          disabled={loading || !publicKey || market.settled || !!constraintMessage}
          className={`w-full rounded-xl py-3.5 text-sm font-bold text-white shadow-lg transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none ${actionColors[action]}`}
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
              Processing...
            </span>
          ) : !publicKey ? (
            "Connect Wallet to Trade"
          ) : market.settled ? (
            "Market Settled"
          ) : constraintMessage ? (
            "Position Constraint"
          ) : (
            actionLabels[action]
          )}
        </button>

        {/* $1.00 invariant note */}
        <p className="text-center text-[11px] text-gray-600">
          Yes + No = $1.00 &middot; $1.00 invariant
        </p>
      </div>
    </div>
  );
}
