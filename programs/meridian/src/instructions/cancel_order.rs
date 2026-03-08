use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Market, OrderBook};
use crate::errors::MeridianError;

/// Cancel an open order and return locked collateral to the maker.
///   - Bids: return USDC from bid_escrow
///   - Asks: return Yes tokens from escrow_yes
pub fn handler(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
    let orderbook = &mut ctx.accounts.orderbook;

    // Find the order
    let order_idx = orderbook
        .orders
        .iter()
        .position(|o| o.order_id == order_id && o.is_active())
        .ok_or(MeridianError::OrderNotFound)?;

    let order = &orderbook.orders[order_idx];
    require!(order.maker == ctx.accounts.user.key(), MeridianError::NotOrderOwner);

    let remaining = order.remaining();
    let is_bid = order.is_bid;
    let price = order.price;

    // Market PDA signer seeds
    let market = &ctx.accounts.market;
    let ticker_bytes = market.ticker.as_bytes();
    let strike_bytes = market.strike_price.to_le_bytes();
    let date_bytes = market.date.to_le_bytes();
    let bump = market.bump;
    let seeds: &[&[u8]] = &[
        b"market",
        ticker_bytes,
        &strike_bytes,
        &date_bytes,
        &[bump],
    ];
    let signer_seeds = &[seeds];

    if is_bid {
        // Return locked USDC from bid_escrow
        let usdc_to_return = (price as u128)
            .checked_mul(remaining as u128)
            .ok_or(MeridianError::MathOverflow)?
            .checked_div(1_000_000)
            .ok_or(MeridianError::MathOverflow)? as u64;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bid_escrow.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            usdc_to_return,
        )?;
    } else {
        // Return locked Yes tokens from escrow_yes
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_yes.to_account_info(),
                    to: ctx.accounts.user_yes.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            remaining,
        )?;
    }

    // Mark order as cancelled
    orderbook.orders[order_idx].cancelled = true;

    msg!("Order {} cancelled, collateral returned", order_id);
    Ok(())
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.ticker.as_bytes(), &market.strike_price.to_le_bytes(), &market.date.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"orderbook", market.key().as_ref()],
        bump = orderbook.bump,
    )]
    pub orderbook: Box<Account<'info, OrderBook>>,

    /// Escrow for bid USDC collateral
    #[account(
        mut,
        seeds = [b"bid_escrow", market.key().as_ref()],
        bump = market.bid_escrow_bump,
    )]
    pub bid_escrow: Box<Account<'info, TokenAccount>>,

    /// Escrow for ask Yes token collateral
    #[account(
        mut,
        seeds = [b"escrow_yes", market.key().as_ref()],
        bump = market.escrow_yes_bump,
    )]
    pub escrow_yes: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_yes: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
