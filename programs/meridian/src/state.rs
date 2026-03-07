use anchor_lang::prelude::*;

/// Global configuration — initialized once by admin
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub market_count: u64,
    pub bump: u8,
}

/// Represents a single binary outcome market for one strike
/// e.g., "AAPL > $230 on 2026-03-06"
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub config: Pubkey,
    pub market_id: u64,
    /// Stock ticker as bytes (e.g., "AAPL" padded to 8 bytes)
    #[max_len(8)]
    pub ticker: String,
    /// Strike price in USD cents (e.g., 23000 = $230.00)
    pub strike_price: u64,
    /// Trading date as YYYYMMDD integer (e.g., 20260306)
    pub date: u32,
    /// Yes token mint
    pub yes_mint: Pubkey,
    /// No token mint
    pub no_mint: Pubkey,
    /// USDC vault
    pub vault: Pubkey,
    /// Total pairs minted (for invariant checking)
    pub total_pairs_minted: u64,
    /// Whether the market has been settled
    pub settled: bool,
    /// Settlement outcome: true = Yes wins (close >= strike), false = No wins
    pub outcome_yes_wins: bool,
    /// Oracle settlement price in USD cents
    pub settlement_price: u64,
    pub bump: u8,
    pub yes_mint_bump: u8,
    pub no_mint_bump: u8,
    pub vault_bump: u8,
}

/// Simplified order book — stores up to MAX_ORDERS limit orders
/// For production, this would be replaced with Phoenix DEX integration
pub const MAX_ORDERS: usize = 64;

#[account]
#[derive(InitSpace)]
pub struct OrderBook {
    pub market: Pubkey,
    pub order_count: u64,
    /// Orders stored inline (simplified — production would use a heap/tree)
    #[max_len(MAX_ORDERS)]
    pub orders: Vec<Order>,
    pub bump: u8,
}

/// A single limit order on the book
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Order {
    pub order_id: u64,
    pub maker: Pubkey,
    /// true = bid (buying Yes tokens with USDC), false = ask (selling Yes tokens for USDC)
    pub is_bid: bool,
    /// Price in USDC micro-units (6 decimals). Range: 1_000 ($0.001) to 1_000_000 ($1.00)
    pub price: u64,
    /// Quantity of Yes tokens (6 decimals)
    pub quantity: u64,
    /// Quantity already filled
    pub filled: u64,
    /// Timestamp of order placement
    pub timestamp: i64,
    /// Whether this order has been cancelled
    pub cancelled: bool,
}

impl Order {
    pub fn remaining(&self) -> u64 {
        self.quantity.saturating_sub(self.filled)
    }

    pub fn is_active(&self) -> bool {
        !self.cancelled && self.remaining() > 0
    }
}
