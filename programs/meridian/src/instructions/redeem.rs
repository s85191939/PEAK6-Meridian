use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::state::Market;
use crate::errors::MeridianError;

/// Redeem winning tokens after settlement.
/// Winning tokens (Yes if yes_wins, No if !yes_wins) pay $1.00 USDC each.
/// Losing tokens pay $0.00 (they can still be burned but receive nothing).
///
/// The user burns their tokens and receives USDC from the vault.
/// This enforces the core invariant: Yes payout + No payout = $1.00.
pub fn handler(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(market.settled, MeridianError::MarketNotSettled);
    require!(amount > 0, MeridianError::NoTokensToRedeem);
    require!(
        ctx.accounts.token_mint.key() == market.yes_mint
            || ctx.accounts.token_mint.key() == market.no_mint,
        MeridianError::InvalidTokenMint
    );

    // Determine if the user is redeeming the winning token
    let is_redeeming_yes = ctx.accounts.token_mint.key() == market.yes_mint;
    let is_winner = if is_redeeming_yes {
        market.outcome_yes_wins
    } else {
        !market.outcome_yes_wins
    };

    // Burn the tokens regardless (cleaning up supply)
    let burn_ctx = if is_redeeming_yes {
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.token_mint.to_account_info(),
                from: ctx.accounts.user_token.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        )
    } else {
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.token_mint.to_account_info(),
                from: ctx.accounts.user_token.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        )
    };
    token::burn(burn_ctx, amount)?;

    // If winner, transfer USDC from vault to user
    if is_winner {
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

        // Each winning token pays 1:1 USDC (amount is in 6-decimal micro-units)
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

        msg!(
            "Redeemed {} winning {} tokens for {} USDC",
            amount,
            if is_redeeming_yes { "YES" } else { "NO" },
            amount
        );
    } else {
        msg!(
            "Burned {} losing {} tokens (no USDC payout)",
            amount,
            if is_redeeming_yes { "YES" } else { "NO" }
        );
    }

    Ok(())
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.ticker.as_bytes(), &market.strike_price.to_le_bytes(), &market.date.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// The mint of the token being redeemed (either yes_mint or no_mint)
    #[account(mut)]
    pub token_mint: Account<'info, Mint>,

    /// User's token account for the token being redeemed
    #[account(mut, constraint = user_token.mint == token_mint.key())]
    pub user_token: Account<'info, TokenAccount>,

    /// User's USDC account to receive payout
    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
