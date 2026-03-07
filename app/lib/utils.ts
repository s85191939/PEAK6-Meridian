import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { PROGRAM_ID, USDC_DECIMALS, PRICE_DECIMALS } from "./constants";

// ---------------------------------------------------------------------------
// PDA derivation helpers
// ---------------------------------------------------------------------------

export function findConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );
}

export function findMarketPda(marketId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );
}

export function findYesMintPda(marketPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("yes_mint"), marketPubkey.toBuffer()],
    PROGRAM_ID
  );
}

export function findNoMintPda(marketPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("no_mint"), marketPubkey.toBuffer()],
    PROGRAM_ID
  );
}

export function findVaultPda(marketPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPubkey.toBuffer()],
    PROGRAM_ID
  );
}

export function findOrderbookPda(marketPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("orderbook"), marketPubkey.toBuffer()],
    PROGRAM_ID
  );
}

export function findEscrowYesPda(marketPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_yes"), marketPubkey.toBuffer()],
    PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Price formatting
// ---------------------------------------------------------------------------

/** Convert on-chain price (u64 with PRICE_DECIMALS) to a human-readable cent value 0-100. */
export function priceToPercent(price: BN): number {
  const divisor = new BN(10).pow(new BN(PRICE_DECIMALS));
  // price is in USDC terms (e.g. 500_000 = $0.50 = 50%)
  const cents = price.mul(new BN(100)).div(divisor);
  return cents.toNumber();
}

/** Format a price BN as a dollar string like "$0.50". */
export function formatPrice(price: BN): string {
  const divisor = Math.pow(10, PRICE_DECIMALS);
  const value = price.toNumber() / divisor;
  return `$${value.toFixed(2)}`;
}

/** Format a price BN as a cent string like "50c". */
export function formatPriceCents(price: BN): string {
  const percent = priceToPercent(price);
  return `${percent}\u00A2`;
}

/** Convert a human percentage (0-100) to an on-chain price BN. */
export function percentToPrice(percent: number): BN {
  const divisor = new BN(10).pow(new BN(PRICE_DECIMALS));
  return divisor.mul(new BN(Math.round(percent))).div(new BN(100));
}

/** Convert a dollar value string (e.g. "0.50") to an on-chain price BN. */
export function dollarToPrice(dollar: string): BN {
  const value = parseFloat(dollar);
  const raw = Math.round(value * Math.pow(10, PRICE_DECIMALS));
  return new BN(raw);
}

// ---------------------------------------------------------------------------
// USDC amount formatting
// ---------------------------------------------------------------------------

/** Format a USDC amount (u64 with 6 decimals) to a human string. */
export function formatUsdc(amount: BN): string {
  const divisor = Math.pow(10, USDC_DECIMALS);
  const value = amount.toNumber() / divisor;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Convert a human USDC string to a BN with 6 decimals. */
export function parseUsdc(amount: string): BN {
  const value = parseFloat(amount);
  const raw = Math.round(value * Math.pow(10, USDC_DECIMALS));
  return new BN(raw);
}

/** Format a token amount (u64 with 6 decimals) to a human string. */
export function formatTokenAmount(amount: BN): string {
  const divisor = Math.pow(10, USDC_DECIMALS);
  const value = amount.toNumber() / divisor;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

// ---------------------------------------------------------------------------
// Strike price formatting
// ---------------------------------------------------------------------------

/** Format an on-chain strike price to a dollar string. */
export function formatStrikePrice(strikePrice: BN): string {
  const divisor = Math.pow(10, USDC_DECIMALS);
  const value = strikePrice.toNumber() / divisor;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Convert an on-chain date (u32 YYYYMMDD) to a human-readable string. */
export function formatMarketDate(date: number): string {
  const year = Math.floor(date / 10000);
  const month = Math.floor((date % 10000) / 100);
  const day = date % 100;
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Check if a market date has passed. */
export function isExpired(date: number): boolean {
  const year = Math.floor(date / 10000);
  const month = Math.floor((date % 10000) / 100);
  const day = date % 100;
  const marketDate = new Date(year, month - 1, day, 16, 0, 0); // 4pm close
  return new Date() > marketDate;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Shorten a public key for display. */
export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/** No price = 1 - Yes price. */
export function noPrice(yesPrice: BN): BN {
  const one = new BN(10).pow(new BN(PRICE_DECIMALS));
  return one.sub(yesPrice);
}
