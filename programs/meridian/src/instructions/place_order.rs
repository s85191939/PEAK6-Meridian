use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Config, Market, OrderBook, Order, MAX_ORDERS};
use crate::errors::MeridianError;

/// Place a limit order with match-at-place.
///
/// - Bids: buying Yes tokens with USDC. User locks USDC into bid_escrow.
/// - Asks: selling Yes tokens for USDC. User locks Yes tokens into escrow_yes.
///
/// Before appending to the book, crossing orders are filled immediately:
///   - Bid walks asks (lowest price first): Yes → bidder, USDC → ask maker
///   - Ask walks bids (highest price first): USDC → asker, Yes → bid maker
///
/// Counterparty token accounts are passed via remaining_accounts:
///   - For bids:  remaining_accounts = [ask_maker_usdc_0, ask_maker_usdc_1, ...]
///   - For asks:  remaining_accounts = [bid_maker_yes_0, bid_maker_yes_1, ...]
///
/// Price is in USDC micro-units per Yes token (6 decimals).
/// Range: 10_000 ($0.01) to 990_000 ($0.99)
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, PlaceOrder<'info>>,
    is_bid: bool,
    price: u64,
    quantity: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, MeridianError::ProtocolPaused);
    let market = &ctx.accounts.market;
    require!(!market.settled, MeridianError::MarketAlreadySettled);
    require!(price >= 10_000 && price <= 990_000, MeridianError::InvalidOrderPrice);
    require!(quantity > 0, MeridianError::InvalidOrderQuantity);

    // Build market PDA signer seeds (market is authority of escrow accounts)
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

    // ── Phase 1: Lock collateral ──────────────────────────────────
    if is_bid {
        // Bidder locks USDC: price * quantity / 1_000_000
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
                    to: ctx.accounts.bid_escrow.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            usdc_to_lock,
        )?;
    } else {
        // Asker locks Yes tokens into escrow
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

    // ── Phase 2: Match-at-place ───────────────────────────────────
    let orderbook = &mut ctx.accounts.orderbook;
    let remaining_accts = &ctx.remaining_accounts;
    let mut ra_idx: usize = 0;
    let mut total_filled: u64 = 0;
    let mut total_usdc_matched: u64 = 0;

    if is_bid {
        // Walk asks from lowest price up; fill while ask.price <= bid.price
        loop {
            if total_filled >= quantity { break; }
            if ra_idx >= remaining_accts.len() { break; }

            // Find best (lowest-price) active ask that crosses
            let mut best_idx: Option<usize> = None;
            let mut best_price: u64 = u64::MAX;
            for i in 0..orderbook.orders.len() {
                let o = &orderbook.orders[i];
                if !o.is_bid && o.is_active() && o.price <= price && o.price < best_price {
                    best_idx = Some(i);
                    best_price = o.price;
                }
            }
            let Some(oi) = best_idx else { break };

            let ask_remaining = orderbook.orders[oi].remaining();
            let fill_qty = std::cmp::min(ask_remaining, quantity - total_filled);
            let fill_usdc = (orderbook.orders[oi].price as u128)
                .checked_mul(fill_qty as u128)
                .ok_or(MeridianError::MathOverflow)?
                .checked_div(1_000_000)
                .ok_or(MeridianError::MathOverflow)? as u64;
            require!(fill_usdc > 0, MeridianError::MathOverflow);

            // Yes: escrow_yes → bidder (taker)
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
                fill_qty,
            )?;

            // USDC: bid_escrow → ask maker (via remaining_accounts)
            let maker_usdc = &remaining_accts[ra_idx];
            ra_idx += 1;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.bid_escrow.to_account_info(),
                        to: maker_usdc.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    signer_seeds,
                ),
                fill_usdc,
            )?;

            orderbook.orders[oi].filled += fill_qty;
            total_filled += fill_qty;
            total_usdc_matched += fill_usdc;
        }

        // Refund price-improvement USDC to bidder
        let total_locked = (price as u128)
            .checked_mul(quantity as u128)
            .ok_or(MeridianError::MathOverflow)?
            .checked_div(1_000_000)
            .ok_or(MeridianError::MathOverflow)? as u64;
        let resting_qty = quantity - total_filled;
        let resting_lock = (price as u128)
            .checked_mul(resting_qty as u128)
            .ok_or(MeridianError::MathOverflow)?
            .checked_div(1_000_000)
            .ok_or(MeridianError::MathOverflow)? as u64;
        let refund = total_locked
            .saturating_sub(total_usdc_matched)
            .saturating_sub(resting_lock);
        if refund > 0 {
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
                refund,
            )?;
        }
    } else {
        // Walk bids from highest price down; fill while bid.price >= ask.price
        loop {
            if total_filled >= quantity { break; }
            if ra_idx >= remaining_accts.len() { break; }

            let mut best_idx: Option<usize> = None;
            let mut best_price: u64 = 0;
            for i in 0..orderbook.orders.len() {
                let o = &orderbook.orders[i];
                if o.is_bid && o.is_active() && o.price >= price && o.price > best_price {
                    best_idx = Some(i);
                    best_price = o.price;
                }
            }
            let Some(oi) = best_idx else { break };

            let bid_remaining = orderbook.orders[oi].remaining();
            let fill_qty = std::cmp::min(bid_remaining, quantity - total_filled);
            let fill_usdc = (orderbook.orders[oi].price as u128)
                .checked_mul(fill_qty as u128)
                .ok_or(MeridianError::MathOverflow)?
                .checked_div(1_000_000)
                .ok_or(MeridianError::MathOverflow)? as u64;
            require!(fill_usdc > 0, MeridianError::MathOverflow);

            // USDC: bid_escrow → asker (taker)
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
                fill_usdc,
            )?;

            // Yes: escrow_yes → bid maker (via remaining_accounts)
            let maker_yes = &remaining_accts[ra_idx];
            ra_idx += 1;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_yes.to_account_info(),
                        to: maker_yes.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    signer_seeds,
                ),
                fill_qty,
            )?;

            orderbook.orders[oi].filled += fill_qty;
            total_filled += fill_qty;
        }
    }

    // ── Phase 2.5: Compact order book — remove fully-filled and cancelled orders ──
    orderbook.orders.retain(|o| o.is_active());

    // ── Phase 3: Add resting order (if any unfilled quantity) ─────
    let resting_qty = quantity - total_filled;
    if resting_qty > 0 {
        require!(orderbook.orders.len() < MAX_ORDERS, MeridianError::OrderBookFull);

        let order_id = orderbook.order_count;
        orderbook.order_count += 1;

        let clock = Clock::get()?;
        orderbook.orders.push(Order {
            order_id,
            maker: ctx.accounts.user.key(),
            is_bid,
            price,
            quantity: resting_qty,
            filled: 0,
            timestamp: clock.unix_timestamp,
            cancelled: false,
        });

        msg!(
            "Order placed: {} {} Yes @ ${:.2} (id: {}, matched: {})",
            if is_bid { "BID" } else { "ASK" },
            resting_qty,
            price as f64 / 1_000_000.0,
            order_id,
            total_filled
        );
    }

    if total_filled > 0 {
        msg!("Filled {} of {} requested", total_filled, quantity);
    }

    Ok(())
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

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

    /// Escrow for bid USDC collateral (separate from vault)
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

    /// User's USDC account (bid source / ask proceeds)
    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,

    /// User's Yes token account (ask source / bid proceeds)
    #[account(mut)]
    pub user_yes: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
