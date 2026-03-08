use anchor_lang::prelude::*;

#[error_code]
pub enum MeridianError {
    #[msg("Only the admin can perform this action")]
    Unauthorized,

    #[msg("Market has already been settled")]
    MarketAlreadySettled,

    #[msg("Market has not been settled yet")]
    MarketNotSettled,

    #[msg("Invalid strike price — must be positive and rounded to $10")]
    InvalidStrikePrice,

    #[msg("Ticker must be 1-8 characters")]
    InvalidTicker,

    #[msg("Order book is full")]
    OrderBookFull,

    #[msg("Invalid order price — must be between $0.01 and $0.99")]
    InvalidOrderPrice,

    #[msg("Invalid order quantity — must be positive")]
    InvalidOrderQuantity,

    #[msg("Order not found")]
    OrderNotFound,

    #[msg("Cannot cancel another user's order")]
    NotOrderOwner,

    #[msg("Insufficient token balance")]
    InsufficientBalance,

    #[msg("No tokens to redeem")]
    NoTokensToRedeem,

    #[msg("Oracle price is stale")]
    StalePriceData,

    #[msg("Oracle confidence interval too wide")]
    LowConfidencePrice,

    #[msg("Settlement can only occur after market close")]
    TooEarlyToSettle,

    #[msg("Vault balance invariant violated: vault != total_pairs_minted * 1_000_000")]
    VaultInvariantViolated,

    #[msg("Arithmetic overflow")]
    MathOverflow,

    #[msg("Invalid token mint — must be yes_mint or no_mint")]
    InvalidTokenMint,

    #[msg("Market registry is full")]
    RegistryFull,
}
