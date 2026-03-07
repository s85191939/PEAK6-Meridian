use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};
use crate::state::Market;
use crate::errors::MeridianError;

/// Mint a Yes/No pair by depositing 1 USDC (1_000_000 micro-units).
/// The user receives 1 Yes token + 1 No token. USDC goes to the vault.
/// This is the ONLY way to create outcome tokens — enforcing the $1.00 invariant.
pub fn handler(ctx: Context<MintPair>, amount: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(!market.settled, MeridianError::MarketAlreadySettled);
    require!(amount > 0, MeridianError::InvalidOrderQuantity);

    // Transfer USDC from user to vault (amount is in USDC micro-units, 6 decimals)
    // 1 pair = 1_000_000 micro-units = $1.00 USDC
    let usdc_amount = amount; // amount is number of micro-units of pairs

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_amount,
    )?;

    // Mint Yes tokens to user
    let ticker_bytes = market.ticker.as_bytes();
    let strike_bytes = market.strike_price.to_le_bytes();
    let date_bytes = market.date.to_le_bytes();
    let bump = market.bump;
    let seeds = &[
        b"market" as &[u8],
        ticker_bytes,
        &strike_bytes,
        &date_bytes,
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // Mint No tokens to user
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.user_no.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // Update total pairs minted
    let market = &mut ctx.accounts.market;
    market.total_pairs_minted = market
        .total_pairs_minted
        .checked_add(amount)
        .ok_or(MeridianError::MathOverflow)?;

    msg!(
        "Minted {} pairs for market {}. Total pairs: {}",
        amount,
        market.market_id,
        market.total_pairs_minted
    );
    Ok(())
}

#[derive(Accounts)]
pub struct MintPair<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.ticker.as_bytes(), &market.strike_price.to_le_bytes(), &market.date.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump = market.yes_mint_bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"no_mint", market.key().as_ref()],
        bump = market.no_mint_bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// User's USDC token account (source of deposit)
    #[account(mut, constraint = user_usdc.mint == vault.mint)]
    pub user_usdc: Account<'info, TokenAccount>,

    /// User's Yes token account (receives minted Yes tokens)
    #[account(mut, constraint = user_yes.mint == market.yes_mint)]
    pub user_yes: Account<'info, TokenAccount>,

    /// User's No token account (receives minted No tokens)
    #[account(mut, constraint = user_no.mint == market.no_mint)]
    pub user_no: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
