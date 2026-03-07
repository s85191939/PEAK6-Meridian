use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::state::Market;
use crate::errors::MeridianError;

/// Merge (close) a Yes/No pair pre-settlement → return 1 USDC per pair.
/// This is the inverse of mint_pair:
///   mint_pair:  1 USDC → 1 Yes + 1 No
///   merge_pair: 1 Yes + 1 No → 1 USDC
///
/// This enables the "Sell No" flow on the frontend:
///   1. User holds No tokens and wants to sell
///   2. Frontend buys Yes from the order book (user pays USDC)
///   3. Frontend calls merge_pair with the Yes + No → returns 1 USDC each
///   4. Net effect: user sold No at (1 - Yes_price)
///
/// The $1.00 invariant is preserved: total_pairs_minted decreases by `amount`,
/// and `amount` USDC leaves the vault.
pub fn handler(ctx: Context<MergePair>, amount: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(!market.settled, MeridianError::MarketAlreadySettled);
    require!(amount > 0, MeridianError::InvalidOrderQuantity);

    // Burn Yes tokens from user
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.yes_mint.to_account_info(),
                from: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Burn No tokens from user
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.no_mint.to_account_info(),
                from: ctx.accounts.user_no.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Transfer USDC from vault back to user (market PDA signs)
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

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // Update total pairs minted (decrease)
    let market = &mut ctx.accounts.market;
    market.total_pairs_minted = market
        .total_pairs_minted
        .checked_sub(amount)
        .ok_or(MeridianError::MathOverflow)?;

    msg!(
        "Merged {} pairs for market {}. Total pairs: {}",
        amount,
        market.market_id,
        market.total_pairs_minted
    );
    Ok(())
}

#[derive(Accounts)]
pub struct MergePair<'info> {
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

    /// User's USDC token account (receives returned USDC)
    #[account(mut, constraint = user_usdc.mint == vault.mint)]
    pub user_usdc: Account<'info, TokenAccount>,

    /// User's Yes token account (source of Yes tokens to burn)
    #[account(mut, constraint = user_yes.mint == market.yes_mint)]
    pub user_yes: Account<'info, TokenAccount>,

    /// User's No token account (source of No tokens to burn)
    #[account(mut, constraint = user_no.mint == market.no_mint)]
    pub user_no: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
