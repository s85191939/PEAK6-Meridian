use anchor_lang::prelude::*;
use crate::state::Config;

/// Initialize the global config — called once by the deployer/admin.
/// Sets the admin authority and the USDC mint address.
pub fn handler(ctx: Context<Initialize>, usdc_mint: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.usdc_mint = usdc_mint;
    config.market_count = 0;
    config.bump = ctx.bumps.config;
    msg!("Meridian config initialized. Admin: {}", config.admin);
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}
