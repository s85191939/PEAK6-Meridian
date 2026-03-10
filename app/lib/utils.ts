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

export function findBidEscrowPda(marketPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bid_escrow"), marketPubkey.toBuffer()],
    PROGRAM_ID
  );
}

export function findMarketRegistryPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_registry")],
    PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Price formatting
// ---------------------------------------------------------------------------

/** Convert on-chain price (u64 with PRICE_DECIMALS) to a human-readable cent value 0-100. */
export function priceToPercent(price: BN): number {
  const divisor = new BN(10).pow(new BN(PRICE_DECIMALS));
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

/** Format an on-chain strike price (stored in cents) to a dollar string. */
export function formatStrikePrice(strikePrice: BN): string {
  const value = strikePrice.toNumber() / 100;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Convert an on-chain date (u32 YYYYMMDD) to a human-readable string. */
export function formatMarketDate(date: number): string {
  const year = Math.floor(date / 10000);
  const month = Math.floor((date % 10000) / 100);
  const day = date % 100;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[month - 1]} ${day}, ${year}`;
}

/**
 * Check if a market date has passed (4:00 PM ET).
 * Uses ET-aware UTC calculation instead of local time.
 */
export function isExpired(date: number): boolean {
  const year = Math.floor(date / 10000);
  const month = Math.floor((date % 10000) / 100);
  const day = date % 100;

  // Compute 4:00 PM ET in UTC
  // ET is UTC-5 (EST) or UTC-4 (EDT)
  // Simple DST heuristic: Mar-Nov is EDT (UTC-4), else EST (UTC-5)
  const isDST = month >= 3 && month <= 11;
  const etOffsetHours = isDST ? 4 : 5;
  const closeUTC = new Date(
    Date.UTC(year, month - 1, day, 16 + etOffsetHours, 0, 0)
  );

  return Date.now() > closeUTC.getTime();
}

// ---------------------------------------------------------------------------
// Solana error parsing
// ---------------------------------------------------------------------------

/** Parse Solana/Anchor errors into user-friendly messages. */
export function parseSolanaError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  // Wallet not connected
  if (msg.includes("WalletNotConnectedError") || msg.includes("Wallet not connected")) {
    return "Please connect your wallet to continue.";
  }

  // User rejected
  if (msg.includes("User rejected") || msg.includes("Transaction cancelled")) {
    return "Transaction cancelled by user.";
  }

  // Insufficient funds
  if (msg.includes("insufficient funds") || msg.includes("0x1")) {
    return "Insufficient funds. Please ensure you have enough SOL and USDC.";
  }

  // Account not found
  if (msg.includes("Account does not exist") || msg.includes("could not find account")) {
    return "Account not found. You may need to create a token account first.";
  }

  // Network errors
  if (msg.includes("Network request failed") || msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
    return "Network error. Please check your connection and try again.";
  }

  // RPC rate limit
  if (msg.includes("429") || msg.includes("Too many requests")) {
    return "Rate limited by RPC. Please wait a moment and try again.";
  }

  // Transaction too large
  if (msg.includes("Transaction too large")) {
    return "Transaction too large. Try reducing the quantity.";
  }

  // Simulation failed
  if (msg.includes("Simulation failed") || msg.includes("SimulationFailed")) {
    return "Transaction simulation failed. The order may not be valid at this time.";
  }

  // Program errors
  if (msg.includes("MarketAlreadySettled")) return "This market has already been settled.";
  if (msg.includes("MarketNotSettled")) return "This market has not been settled yet.";
  if (msg.includes("InvalidOrderPrice")) return "Price must be between $0.01 and $0.99.";
  if (msg.includes("InvalidOrderQuantity")) return "Quantity must be greater than zero.";
  if (msg.includes("OrderBookFull")) return "Order book is full. Try cancelling existing orders.";
  if (msg.includes("NoTokensToRedeem")) return "No tokens to redeem.";
  if (msg.includes("InsufficientBalance")) return "Insufficient token balance.";

  // Blockhash expired
  if (msg.includes("Blockhash not found") || msg.includes("block height exceeded")) {
    return "Transaction expired. Please try again.";
  }

  // Token account missing
  if (msg.includes("AccountNotFound") || msg.includes("could not find mint")) {
    return "Token account not found. Click '+ Get USDC' first to set up your wallet.";
  }

  // ATA / owner mismatch
  if (msg.includes("ConstraintTokenOwner") || msg.includes("owner constraint")) {
    return "Token account ownership mismatch. Please try refreshing the page.";
  }

  // Custom program error
  if (msg.includes("custom program error")) {
    const match = msg.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (match) return `Program error: ${match[1]}. The transaction was rejected by the smart contract.`;
  }

  // Generic fallback — truncate long messages
  if (msg.length > 120) {
    return msg.slice(0, 120) + "...";
  }

  return msg || "An unexpected error occurred. Please try again.";
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

/** Generate Solana Explorer URL for a transaction. */
export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}
