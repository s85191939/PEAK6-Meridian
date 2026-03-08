use anchor_lang::prelude::*;
use crate::state::{Config, Market, MarketRegistry, MAX_MARKETS};
use crate::errors::MeridianError;

/// Register an existing market in the on-chain registry so the frontend can discover it.
/// Called after create_market. Kept as a separate instruction to avoid stack overflow
/// in create_market (which already creates 3 accounts: Market + 2 mints).
pub fn handler(ctx: Context<RegisterMarket>) -> Result<()> {
    let registry = &mut ctx.accounts.market_registry;
    require!(registry.markets.len() < MAX_MARKETS, MeridianError::RegistryFull);
    registry.markets.push(ctx.accounts.market.key());

    msg!("Market {} registered in registry", ctx.accounts.market.market_id);
    Ok(())
}

#[derive(Accounts)]
pub struct RegisterMarket<'info> {
    #[account(mut, constraint = admin.key() == config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"market_registry"],
        bump = market_registry.bump,
    )]
    pub market_registry: Box<Account<'info, MarketRegistry>>,

    #[account(
        seeds = [b"market", market.ticker.as_bytes(), &market.strike_price.to_le_bytes(), &market.date.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}
