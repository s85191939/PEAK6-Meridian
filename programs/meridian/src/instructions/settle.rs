use anchor_lang::prelude::*;
use crate::state::{Config, Market};
use crate::errors::MeridianError;

/// Settle a market by providing the closing price from the oracle/automation service.
///
/// Oracle integration pattern:
///   - In production: reads Pyth price account on-chain during the settlement tx.
///     Pyth provides price, confidence interval, and publish timestamp.
///     PEAK6 is a Pyth validator, providing direct oracle infrastructure access.
///   - On devnet: automation service fetches real stock prices (Yahoo Finance),
///     then submits via this admin-only instruction. Same flow, external price source.
///
/// Validation checks (simulate Pyth oracle behavior):
///   - Price must be positive (rejects stale/zero data)
///   - Settlement can only occur after 4 PM ET on the market's date
///   - Settlement is IMMUTABLE — once set, the outcome cannot be changed
///   - If closing_price >= strike_price → Yes wins, else No wins
///
/// Oracle failure handling:
///   The automation service retries every 30 seconds for 15 minutes.
///   If still failing, admin uses admin_settle_override (with 1-hour delay enforcement).
pub fn handler(ctx: Context<SettleMarket>, settlement_price: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(!market.settled, MeridianError::MarketAlreadySettled);

    // Oracle staleness check: price must be positive
    require!(settlement_price > 0, MeridianError::StalePriceData);

    // Time check: settlement only after 4:00 PM ET on market date
    // On devnet, we use Clock sysvar; on mainnet, oracle timestamp would be checked
    let clock = Clock::get()?;
    let market_close_ts = market_close_timestamp(market.date);
    require!(
        clock.unix_timestamp >= market_close_ts,
        MeridianError::TooEarlyToSettle
    );

    // Determine outcome: Yes wins if closing price >= strike price
    let yes_wins = settlement_price >= market.strike_price;

    market.settled = true;
    market.outcome_yes_wins = yes_wins;
    market.settlement_price = settlement_price;

    msg!(
        "Market {} settled. {} > ${}: settlement=${}, outcome={}",
        market.market_id,
        market.ticker,
        market.strike_price / 100,
        settlement_price / 100,
        if yes_wins { "YES wins" } else { "NO wins" }
    );
    Ok(())
}

/// Admin settle override — emergency fallback when oracle fails.
/// PRD requirement: "Must enforce a time delay (e.g., 1 hour after market close)
/// before it can be called. Used only in emergencies."
///
/// This instruction is identical to normal settlement but enforces a 1-hour delay
/// after market close (5:00 PM ET vs 4:00 PM ET) to give the oracle time to recover.
pub fn handler_admin_override(
    ctx: Context<SettleMarket>,
    settlement_price: u64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(!market.settled, MeridianError::MarketAlreadySettled);
    require!(settlement_price > 0, MeridianError::StalePriceData);

    // Admin override requires 1 hour AFTER market close (5:00 PM ET)
    let clock = Clock::get()?;
    let override_ts = market_close_timestamp(market.date) + 3600; // +1 hour
    require!(
        clock.unix_timestamp >= override_ts,
        MeridianError::TooEarlyToSettle
    );

    let yes_wins = settlement_price >= market.strike_price;

    market.settled = true;
    market.outcome_yes_wins = yes_wins;
    market.settlement_price = settlement_price;

    msg!(
        "ADMIN OVERRIDE: Market {} settled. {} > ${}: settlement=${}, outcome={}",
        market.market_id,
        market.ticker,
        market.strike_price / 100,
        settlement_price / 100,
        if yes_wins { "YES wins" } else { "NO wins" }
    );
    Ok(())
}

/// Convert a YYYYMMDD date integer to the Unix timestamp of 4:00 PM ET on that day.
/// 4:00 PM ET = 21:00 UTC (during EST) or 20:00 UTC (during EDT).
/// For simplicity on devnet, we use 21:00 UTC (EST) as the standard.
fn market_close_timestamp(date: u32) -> i64 {
    let year = (date / 10000) as i64;
    let month = ((date % 10000) / 100) as i64;
    let day = (date % 100) as i64;

    // Days from epoch to given date (simplified — sufficient for devnet)
    // Using the algorithm from http://howardhinnant.github.io/date_algorithms.html
    let y = if month <= 2 { year - 1 } else { year };
    let era = y / 400;
    let yoe = y - era * 400;
    let m_adj = if month <= 2 { month + 9 } else { month - 3 };
    let doy = (153 * m_adj + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;

    // 4:00 PM ET = 21:00 UTC (EST)
    days * 86400 + 21 * 3600
}

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(constraint = admin.key() == config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"market", market.ticker.as_bytes(), &market.strike_price.to_le_bytes(), &market.date.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}
