use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::{Config, Market};
use crate::errors::MeridianError;

/// Initialize escrow_yes (Yes token escrow for ask orders).
/// Split from init_orderbook to stay within Solana's 4KB stack limit.
pub fn handler_yes(ctx: Context<InitEscrowYes>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.escrow_yes_bump = ctx.bumps.escrow_yes;
    msg!("escrow_yes initialized for market {}", market.market_id);
    Ok(())
}

/// Initialize bid_escrow (USDC escrow for bid orders).
pub fn handler_bid(ctx: Context<InitBidEscrow>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.bid_escrow_bump = ctx.bumps.bid_escrow;
    msg!("bid_escrow initialized for market {}", market.market_id);
    Ok(())
}

#[derive(Accounts)]
pub struct InitEscrowYes<'info> {
    #[account(mut, constraint = admin.key() == config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [b"market", market.ticker.as_bytes(), &market.strike_price.to_le_bytes(), &market.date.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = admin,
        token::mint = yes_mint,
        token::authority = market,
        seeds = [b"escrow_yes", market.key().as_ref()],
        bump,
    )]
    pub escrow_yes: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [b"yes_mint", market.key().as_ref()],
        bump = market.yes_mint_bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitBidEscrow<'info> {
    #[account(mut, constraint = admin.key() == config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

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
        seeds = [b"bid_escrow", market.key().as_ref()],
        bump,
    )]
    pub bid_escrow: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
