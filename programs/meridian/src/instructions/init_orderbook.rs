use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::{Config, Market, OrderBook};
use crate::errors::MeridianError;

/// Initialize the vault and order book for an existing market.
/// Called after create_market to stay within Solana's 4KB stack limit.
/// This two-step process (create_market → init_orderbook) is a trade-off:
/// more transactions, but keeps each within the BPF stack frame limit.
pub fn handler(ctx: Context<InitOrderbook>) -> Result<()> {
    // Set vault on the market
    let market = &mut ctx.accounts.market;
    market.vault = ctx.accounts.vault.key();
    market.vault_bump = ctx.bumps.vault;

    let market_id = market.market_id;

    // Init orderbook
    let orderbook = &mut ctx.accounts.orderbook;
    orderbook.market = ctx.accounts.market.key();
    orderbook.order_count = 0;
    orderbook.orders = Vec::new();
    orderbook.bump = ctx.bumps.orderbook;

    msg!("Vault + OrderBook initialized for market {}", market_id);
    Ok(())
}

#[derive(Accounts)]
pub struct InitOrderbook<'info> {
    #[account(mut, constraint = admin.key() == config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"market", market.ticker.as_bytes(), &market.strike_price.to_le_bytes(), &market.date.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        space = 8 + OrderBook::INIT_SPACE,
        seeds = [b"orderbook", market.key().as_ref()],
        bump,
    )]
    pub orderbook: Box<Account<'info, OrderBook>>,

    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
