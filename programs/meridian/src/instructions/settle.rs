use anchor_lang::prelude::*;
use crate::state::{Config, Market};
use crate::errors::MeridianError;

/// Settle a market by providing the closing price.
/// In production, this would read from Pyth oracle on-chain.
/// For the MVP, the admin provides the settlement price directly
/// (simulating oracle behavior — documented as a trade-off).
///
/// Settlement is IMMUTABLE — once set, the outcome cannot be changed.
/// If closing_price >= strike_price → Yes wins, else No wins.
pub fn handler(ctx: Context<SettleMarket>, settlement_price: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(!market.settled, MeridianError::MarketAlreadySettled);
    require!(settlement_price > 0, MeridianError::StalePriceData);

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
