use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Market, OrderBook, Order, MAX_ORDERS};
use crate::errors::MeridianError;

/// Place a limit order on the simplified order book.
/// - Bids: buying Yes tokens with USDC. User locks USDC.
/// - Asks: selling Yes tokens for USDC. User locks Yes tokens.
///
/// Price is in USDC micro-units per Yes token (6 decimals).
/// Range: 10_000 ($0.01) to 990_000 ($0.99)
/// $1.00 and $0.00 are excluded — at those prices, just mint/redeem directly.
pub fn handler(
    ctx: Context<PlaceOrder>,
    is_bid: bool,
    price: u64,
    quantity: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(!market.settled, MeridianError::MarketAlreadySettled);
    require!(price >= 10_000 && price <= 990_000, MeridianError::InvalidOrderPrice);
    require!(quantity > 0, MeridianError::InvalidOrderQuantity);

    // Lock collateral
    if is_bid {
        // Bidder locks USDC: price * quantity / 1_000_000 (since both are 6-decimal)
        let usdc_to_lock = (price as u128)
            .checked_mul(quantity as u128)
            .ok_or(MeridianError::MathOverflow)?
            .checked_div(1_000_000)
            .ok_or(MeridianError::MathOverflow)? as u64;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            usdc_to_lock,
        )?;
    } else {
        // Asker locks Yes tokens into the vault (we use a simple escrow pattern)
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_yes.to_account_info(),
                    to: ctx.accounts.escrow_yes.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            quantity,
        )?;
    }

    // Add order to book
    let orderbook = &mut ctx.accounts.orderbook;
    require!(orderbook.orders.len() < MAX_ORDERS, MeridianError::OrderBookFull);

    let order_id = orderbook.order_count;
    orderbook.order_count += 1;

    let clock = Clock::get()?;
    orderbook.orders.push(Order {
        order_id,
        maker: ctx.accounts.user.key(),
        is_bid,
        price,
        quantity,
        filled: 0,
        timestamp: clock.unix_timestamp,
        cancelled: false,
    });

    msg!(
        "Order placed: {} {} Yes @ ${:.2} (id: {})",
        if is_bid { "BID" } else { "ASK" },
        quantity,
        price as f64 / 1_000_000.0,
        order_id
    );
    Ok(())
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.ticker.as_bytes(), &market.strike_price.to_le_bytes(), &market.date.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"orderbook", market.key().as_ref()],
        bump = orderbook.bump,
    )]
    pub orderbook: Account<'info, OrderBook>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// User's USDC account (for bid collateral)
    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,

    /// User's Yes token account (for ask collateral)
    #[account(mut)]
    pub user_yes: Account<'info, TokenAccount>,

    /// Escrow account for Yes tokens locked by asks
    /// Uses the vault for simplicity in MVP
    #[account(mut)]
    pub escrow_yes: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
