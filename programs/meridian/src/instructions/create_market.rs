use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};
use crate::state::{Config, Market};
use crate::errors::MeridianError;

/// Create a new strike market for a given stock, strike price, and date.
/// This creates the Market PDA and Yes/No token mints.
/// The vault and order book are created via init_orderbook to stay within stack limits.
/// The market is registered via register_market (separate instruction to avoid stack overflow).
pub fn handler(
    ctx: Context<CreateMarket>,
    ticker: String,
    strike_price: u64,
    date: u32,
) -> Result<()> {
    require!(ticker.len() >= 1 && ticker.len() <= 8, MeridianError::InvalidTicker);
    require!(strike_price > 0 && strike_price % 1000 == 0, MeridianError::InvalidStrikePrice);

    let config = &mut ctx.accounts.config;
    let market_id = config.market_count;
    config.market_count += 1;

    let market = &mut ctx.accounts.market;
    market.config = config.key();
    market.market_id = market_id;
    market.ticker = ticker.clone();
    market.strike_price = strike_price;
    market.date = date;
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.vault = Pubkey::default(); // Set by init_orderbook
    market.total_pairs_minted = 0;
    market.settled = false;
    market.outcome_yes_wins = false;
    market.settlement_price = 0;
    market.bump = ctx.bumps.market;
    market.yes_mint_bump = ctx.bumps.yes_mint;
    market.no_mint_bump = ctx.bumps.no_mint;
    market.vault_bump = 0; // Set by init_orderbook
    market.escrow_yes_bump = 0; // Set by init_escrows
    market.bid_escrow_bump = 0; // Set by init_escrows

    msg!(
        "Market created: {} > ${} on {} (id: {})",
        ticker,
        strike_price / 100,
        date,
        market_id
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: String, strike_price: u64, date: u32)]
pub struct CreateMarket<'info> {
    #[account(mut, constraint = admin.key() == config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", ticker.as_bytes(), &strike_price.to_le_bytes(), &date.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
