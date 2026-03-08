use anchor_lang::prelude::*;
use crate::state::Config;
use crate::errors::MeridianError;

/// Pause the protocol — blocks minting, trading, and merging.
/// Admin-only emergency control. Does not affect settlement or redemption.
pub fn handler_pause(ctx: Context<SetPause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = true;
    msg!("⚠️  Protocol PAUSED by admin");
    Ok(())
}

/// Unpause the protocol — re-enables minting, trading, and merging.
pub fn handler_unpause(ctx: Context<SetPause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = false;
    msg!("✅ Protocol UNPAUSED by admin");
    Ok(())
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    #[account(constraint = admin.key() == config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}
