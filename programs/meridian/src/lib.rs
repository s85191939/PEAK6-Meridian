use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("2zchyfx482vagebbGJ2ePq8AuuafwS1Hc6YoSkgAfTe1");

#[program]
pub mod meridian {
    use super::*;

    /// Initialize global config with admin authority and USDC mint
    pub fn initialize(ctx: Context<Initialize>, usdc_mint: Pubkey) -> Result<()> {
        instructions::initialize::handler(ctx, usdc_mint)
    }

    /// Create a new strike market (admin only)
    pub fn create_market(
        ctx: Context<CreateMarket>,
        ticker: String,
        strike_price: u64,
        date: u32,
    ) -> Result<()> {
        instructions::create_market::handler(ctx, ticker, strike_price, date)
    }

    /// Initialize the order book for a market (called after create_market)
    pub fn init_orderbook(ctx: Context<InitOrderbook>) -> Result<()> {
        instructions::init_orderbook::handler(ctx)
    }

    /// Mint a Yes/No pair by depositing USDC
    pub fn mint_pair(ctx: Context<MintPair>, amount: u64) -> Result<()> {
        instructions::mint_pair::handler(ctx, amount)
    }

    /// Merge (close) a Yes/No pair pre-settlement → return USDC
    /// Inverse of mint_pair. Enables synthetic "Sell No" flow.
    pub fn merge_pair(ctx: Context<MergePair>, amount: u64) -> Result<()> {
        instructions::merge_pair::handler(ctx, amount)
    }

    /// Place a limit order on the order book
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        is_bid: bool,
        price: u64,
        quantity: u64,
    ) -> Result<()> {
        instructions::place_order::handler(ctx, is_bid, price, quantity)
    }

    /// Cancel an open order
    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
        instructions::cancel_order::handler(ctx, order_id)
    }

    /// Settle a market with the closing price (admin/oracle)
    pub fn settle_market(ctx: Context<SettleMarket>, settlement_price: u64) -> Result<()> {
        instructions::settle::handler(ctx, settlement_price)
    }

    /// Redeem winning tokens for USDC after settlement
    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        instructions::redeem::handler(ctx, amount)
    }
}
