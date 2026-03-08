use anchor_lang::prelude::*;
use crate::state::{Config, MarketRegistry};
use crate::errors::MeridianError;

/// Initialize the global market registry.
/// Called once after `initialize`. Stores a list of all market pubkeys
/// so the frontend can enumerate them with a single fetch.
pub fn handler(ctx: Context<InitRegistry>) -> Result<()> {
    let registry = &mut ctx.accounts.market_registry;
    registry.admin = ctx.accounts.admin.key();
    registry.markets = Vec::new();
    registry.bump = ctx.bumps.market_registry;

    msg!("Market registry initialized");
    Ok(())
}

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    #[account(mut, constraint = admin.key() == config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = admin,
        space = 8 + MarketRegistry::INIT_SPACE,
        seeds = [b"market_registry"],
        bump,
    )]
    pub market_registry: Account<'info, MarketRegistry>,

    pub system_program: Program<'info, System>,
}
