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

    /// Initialize the on-chain market registry (admin only, called once)
    pub fn init_registry(ctx: Context<InitRegistry>) -> Result<()> {
        instructions::init_registry::handler(ctx)
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

    /// Add an extra strike intraday for a stock (admin only)
    pub fn add_strike(
        ctx: Context<AddStrike>,
        ticker: String,
        strike_price: u64,
        date: u32,
    ) -> Result<()> {
        instructions::add_strike::handler(ctx, ticker, strike_price, date)
    }

    /// Register a market in the on-chain registry (admin only, after create_market)
    pub fn register_market(ctx: Context<RegisterMarket>) -> Result<()> {
        instructions::register_market::handler(ctx)
    }

    /// Initialize vault + order book for a market (after create_market)
    pub fn init_orderbook(ctx: Context<InitOrderbook>) -> Result<()> {
        instructions::init_orderbook::handler(ctx)
    }

    /// Initialize Yes token escrow for ask orders (after init_orderbook)
    pub fn init_escrow_yes(ctx: Context<InitEscrowYes>) -> Result<()> {
        instructions::init_escrows::handler_yes(ctx)
    }

    /// Initialize USDC escrow for bid orders (after init_orderbook)
    pub fn init_bid_escrow(ctx: Context<InitBidEscrow>) -> Result<()> {
        instructions::init_escrows::handler_bid(ctx)
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

    /// Place a limit order with match-at-place
    pub fn place_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, PlaceOrder<'info>>,
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

    /// Pause the protocol — blocks minting, trading, merging (admin only)
    pub fn pause(ctx: Context<SetPause>) -> Result<()> {
        instructions::pause::handler_pause(ctx)
    }

    /// Unpause the protocol (admin only)
    pub fn unpause(ctx: Context<SetPause>) -> Result<()> {
        instructions::pause::handler_unpause(ctx)
    }
}
