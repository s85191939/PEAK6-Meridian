# CLAUDE.md - Meridian Project Guide

## Project Overview

Meridian is a binary stock outcome prediction market built on Solana devnet. It is a non-custodial, CLOB-based platform for trading 0DTE (zero days to expiry) contracts on MAG7 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA). Each contract asks "Will [STOCK] close above [PRICE] today?" and pays $1 USDC if yes, $0 if no. Contracts expire same-day and settle at 4:00 PM ET. Built for the PEAK6/Gauntlet AI evaluation.

## Architecture

- **Solana program** (Anchor 0.30.1 / Rust, edition 2021) at `programs/meridian/`
- **Next.js 16 frontend** (React 19, Tailwind CSS 4, App Router) at `app/`
- **TypeScript automation scripts** at `scripts/`
- **Integration tests** (23 passing) at `tests/meridian.ts`
- **17 smart contract instructions** (see full list below)
- **Single YES orderbook design** -- No price = $1 - Yes price (Polymarket convention)
- **$1.00 invariant**: vault holds exactly `$1 x total_pairs_minted` at all times
- **Three separate escrow accounts**: vault (mint/merge/redeem only), bid_escrow (USDC for bids), escrow_yes (Yes tokens for asks)

## Key Addresses (Devnet)

| Entity | Address |
|--------|---------|
| Program ID | `2zchyfx482vagebbGJ2ePq8AuuafwS1Hc6YoSkgAfTe1` |
| USDC Mint | `9L1fhmF2PbANM3XJE2527aZXh596EunDDdMYgZXYxntW` |
| Config PDA | `5tXBkv1zxmupqNvhbRrp8nLwTiCHZWGSnrM1UayhzZ8w` |
| Registry PDA | `6iqr4J87k7SHttkgcVpvZyGmMEHauyCKXWq2W5K96Fwb` |
| Admin wallet | `BPsWi1a8v2FSKHd95jXoVkTMiMQ4AfuufdahgzT3qqhn` |
| RPC URL | `https://api.devnet.solana.com` |
| Token Program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |

## Build Commands

| Command | Description |
|---------|-------------|
| `make install` | Install Anchor + frontend npm dependencies |
| `make build` | Build the Solana program (`anchor build --no-idl`) |
| `make test` | Run all 23 integration tests on local validator (`anchor test --skip-build`) |
| `make frontend` | Start Next.js dev server on port 3000 |
| `make demo` | Run full lifecycle script on local validator (create, mint, trade, settle, redeem) |
| `make demo-devnet` | Run lifecycle demo against devnet |
| `make deploy` | Deploy program to Solana devnet |
| `make create-markets` | Create today's strike markets on devnet |
| `make settle-markets` | Settle markets on devnet |
| `make build-frontend` | Build frontend for production |
| `make clean` | Clean build artifacts |

Important: The Makefile sets explicit PATH entries for Anchor and Solana binaries:
```
ANCHOR := $(HOME)/.cargo/bin/anchor
SOLANA := $(HOME)/.local/share/solana/install/active_release/bin/solana
```

## Smart Contract Instructions (17 total)

| Instruction | Description | Who |
|-------------|-------------|-----|
| `initialize` | Set admin + USDC mint in global Config | Admin (once) |
| `init_registry` | Create on-chain MarketRegistry | Admin (once) |
| `create_market` | Create market + Yes/No mints for a ticker/strike/date | Admin |
| `add_strike` | Add an extra strike intraday for a stock | Admin |
| `register_market` | Add market pubkey to registry for frontend discovery | Admin |
| `init_orderbook` | Create vault + orderbook for a market | Admin |
| `init_escrow_yes` | Create Yes token escrow for ask collateral | Admin |
| `init_bid_escrow` | Create USDC escrow for bid collateral | Admin |
| `mint_pair` | $1 USDC -> 1 Yes + 1 No token | Any user |
| `merge_pair` | 1 Yes + 1 No -> $1 USDC (pre-settlement exit) | Any user |
| `place_order` | Post limit order (bid/ask) with match-at-place | Any user |
| `cancel_order` | Cancel order + return collateral from escrow | Order owner |
| `settle_market` | Set outcome, immutable once set (requires market close time) | Admin |
| `admin_settle_override` | Emergency settle with 1-hour delay after close (5 PM ET) | Admin |
| `redeem` | Burn winning tokens -> USDC (validates token_mint) | Any user |
| `pause` | Emergency pause -- blocks minting, trading, merging | Admin |
| `unpause` | Resume protocol operations | Admin |

### Market Setup Flow (7 transactions)
```
initialize -> init_registry -> create_market -> register_market -> init_orderbook -> init_escrow_yes -> init_bid_escrow
```

## PDA Seeds

| Account | Seeds |
|---------|-------|
| Config | `["config"]` |
| MarketRegistry | `["market_registry"]` |
| Market | `["market", ticker, strike_price, date]` |
| Yes Mint | `["yes_mint", market_key]` |
| No Mint | `["no_mint", market_key]` |
| Vault | `["vault", market_key]` -- only mint/merge/redeem |
| OrderBook | `["orderbook", market_key]` |
| Escrow Yes | `["escrow_yes", market_key]` -- ask collateral |
| Bid Escrow | `["bid_escrow", market_key]` -- bid collateral |

Note: The frontend PDA helpers use a different derivation for Market -- `["market", market_id_le_8bytes]` -- see `app/lib/utils.ts`.

## On-Chain State Structs

- **Config**: admin, usdc_mint, market_count, paused, bump
- **Market**: config, market_id, ticker (max 8 chars), strike_price (USD cents), date (YYYYMMDD u32), yes_mint, no_mint, vault, total_pairs_minted, settled, outcome_yes_wins, settlement_price, bumps
- **MarketRegistry**: admin, markets (Vec<Pubkey>, max 100), bump
- **OrderBook**: market, order_count, orders (Vec<Order>, max 64), bump
- **Order**: order_id, maker, is_bid, price (6 decimals), quantity (6 decimals), filled, timestamp, cancelled

## Error Codes (20 total)

Defined in `programs/meridian/src/errors.rs`: Unauthorized, MarketAlreadySettled, MarketNotSettled, InvalidStrikePrice, InvalidTicker, OrderBookFull, InvalidOrderPrice, InvalidOrderQuantity, OrderNotFound, NotOrderOwner, InsufficientBalance, NoTokensToRedeem, StalePriceData, LowConfidencePrice, TooEarlyToSettle, VaultInvariantViolated, MathOverflow, InvalidTokenMint, RegistryFull, ProtocolPaused.

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Blockchain | Solana (Anchor 0.30.1) | Sub-second finality for order matching |
| Language | Rust | Required by Solana runtime |
| Order Book | On-chain CLOB with matching | Demonstrates matching mechanics; production would use Phoenix DEX |
| No Token | Synthetic (via mint/merge) | Single book = no liquidity fragmentation (Polymarket convention) |
| Token Standard | SPL Token (not Token-2022) | Simpler, better tooling |
| Escrow Design | Separate vault + bid_escrow + escrow_yes | Isolates $1.00 invariant from order collateral |
| CLOB Implementation | Vec<Order> with 64 max slots, linear scan matching | Simple for MVP; production would use heap/tree |
| Market Discovery | On-chain MarketRegistry | Single source of truth, no off-chain state needed |
| Oracle | Pyth Network (primary) + Yahoo Finance (fallback) | PEAK6 is a Pyth validator; real institutional prices from 120+ publishers |
| USDC | Mock SPL token (own mint, not Circle USDC) | Devnet-only, faucet mints tokens |
| Frontend | Next.js 16 (App Router) + Tailwind CSS 4 | File-based dynamic routes (`/trade/[market]`), server components |
| Admin faucet | Admin keypair embedded client-side in UsdcFaucet | Devnet convenience only |
| IDL copies | IDL duplicated to `app/lib/idl/` | Required for Vercel deployment (no access to `target/`) |

## File Structure

```
PEAK6/
  programs/meridian/src/
    lib.rs                  # Program entry (16 instructions)
    state.rs                # Config, Market, MarketRegistry, OrderBook, Order
    errors.rs               # 20 custom error codes
    instructions/
      initialize.rs         # Global config setup
      create_market.rs      # Market + mints creation
      add_strike.rs         # Add extra strike intraday
      init_registry.rs      # On-chain market registry
      register_market.rs    # Add market to registry
      init_orderbook.rs     # Vault + orderbook creation
      init_escrows.rs       # escrow_yes + bid_escrow creation
      mint_pair.rs          # Deposit USDC -> Yes + No
      merge_pair.rs         # Yes + No -> USDC (inverse)
      place_order.rs        # Limit orders with match-at-place
      cancel_order.rs       # Cancel + return collateral
      settle.rs             # Immutable settlement
      redeem.rs             # Burn tokens -> USDC
      pause.rs              # Emergency pause/unpause
  tests/meridian.ts         # 23 integration tests
  scripts/
    create-markets.ts       # Morning: create strike markets on devnet
    create-today.ts         # Create today's markets
    settle-markets.ts       # 4 PM ET: settle via oracle
    seed-orders.ts          # Seed liquidity on orderbooks
    demo-lifecycle.ts       # Full end-to-end demo
    setup-devnet.ts         # One-time devnet setup
    deploy.sh               # Deployment script
  app/                      # Next.js 16 frontend
    app/
      page.tsx              # Home / landing page
      layout.tsx            # Root layout with providers
      markets/page.tsx      # Markets listing page
      trade/[market]/page.tsx  # Trading page (dynamic route)
      portfolio/page.tsx    # User portfolio
      history/page.tsx      # Trade history
      api/create-markets/route.ts  # Vercel cron: morning market creation
      api/settle-markets/route.ts  # Vercel cron: 4 PM Pyth settlement
    components/
      Navbar.tsx            # Navigation bar
      WalletProvider.tsx    # Solana wallet adapter setup
      MarketCard.tsx        # Market card in listings
      TradePanel.tsx        # Order entry panel
      OrderBook.tsx         # Live orderbook display
      PortfolioView.tsx     # User positions
      UsdcFaucet.tsx        # Devnet USDC faucet (admin key embedded)
      CountdownTimer.tsx    # Market expiry countdown
    lib/
      constants.ts          # Program ID, RPC URL, MAG7 tickers, decimals
      utils.ts              # PDA derivation helpers, price/USDC formatters, error parsing
      idl/                  # Copies of target/idl/ and target/types/ for Vercel
  Anchor.toml               # Anchor config (localnet + devnet)
  Cargo.toml                # Rust workspace
  Makefile                  # One-command build/test/deploy
  package.json              # Root Node.js dependencies
```

## Common Issues and Fixes

### 429 Rate Limit Errors
Solana devnet RPC rate limits. Fixed by using `fetchMultiple` batched RPC calls instead of individual fetch calls per account.

### `anchor` not found
The Makefile resolves this by using the absolute path `$(HOME)/.cargo/bin/anchor`. If running manually, ensure `~/.cargo/bin` is on your PATH.

### `edition2024` build error
Some transitive crate dependencies publish with Rust edition 2024 which is incompatible with Solana's bundled Cargo 1.79. Fix: pin `constant_time_eq = "=0.3.1"` in `programs/meridian/Cargo.toml`.

### `anchor build --no-idl`
IDL generation is skipped due to Rust 1.94 incompatibility with `anchor-syn`. The IDL was generated once and is committed. Use `--no-idl` flag for all builds.

### Target imports for Vercel
Vercel does not have access to `target/` build artifacts. The IDL and TypeScript types are copied to `app/lib/idl/` for deployment.

### Wallet not connected errors
The frontend uses `@solana/wallet-adapter-react`. Users must connect a Phantom/Solflare wallet. The WalletProvider component in `app/components/WalletProvider.tsx` handles the adapter setup.

## Settlement Architecture

- Markets have a `date` field in YYYYMMDD format (u32)
- Settlement is admin-only via the `settle_market` instruction
- Settlement is immutable -- once settled, cannot be changed (double-settlement prevented)
- Outcome is binary: `outcome_yes_wins = true` if close >= strike, `false` otherwise
- `admin_settle_override` instruction requires 1-hour delay after market close (5 PM ET)
- Smart contract validates: `clock.unix_timestamp >= market_close_timestamp(date)` for normal settle
- Smart contract validates: `clock.unix_timestamp >= market_close_timestamp(date) + 3600` for admin override

### Daily Lifecycle
| Time | Event | Script/API |
|------|-------|------------|
| 8:00 AM ET | Read previous close, calculate strikes | `POST /api/create-markets` |
| 8:30 AM ET | Create contracts and order books | `POST /api/create-markets` |
| 9:00 AM ET | Markets visible on frontend | -- |
| 9:30 AM ET | US market open, trading begins | `seed-orders.ts` (optional) |
| 4:00 PM ET | US market close | -- |
| ~4:05 PM ET | Fetch Pyth prices, settle all contracts | `POST /api/settle-markets` |
| 4:05 PM ET+ | Redemption enabled, winners claim USDC | -- |

## Pyth Network Oracle Integration

Meridian uses **Pyth Network** as the primary price oracle. PEAK6 is a Pyth validator, providing direct infrastructure relationship.

### Oracle Hierarchy
1. **PRIMARY**: Pyth Network via Hermes API (`https://hermes.pyth.network`)
   - Fetches real stock prices from 120+ institutional data publishers
   - Validates staleness (< 5 min) and confidence (< 1% of price)
   - Price = `rawPrice * 10^exponent` (equities typically use expo = -5)
2. **FALLBACK**: Yahoo Finance (only if Pyth unavailable)

### Pyth Feed IDs (MAG7 US Equities)
| Ticker | Feed ID |
|--------|---------|
| AAPL | `0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688` |
| MSFT | `0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1` |
| GOOGL | `0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6` |
| AMZN | `0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a` |
| NVDA | `0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593` |
| META | `0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe` |
| TSLA | `0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1` |

### API Routes (Vercel Serverless)
| Route | Method | Description |
|-------|--------|-------------|
| `/api/create-markets` | POST/GET | Morning market creation — fetches prev close, calculates strikes, creates 5 txs per market |
| `/api/settle-markets` | POST/GET | 4:05 PM settlement — fetches Pyth prices, validates staleness/confidence, settles markets |

Both routes are protected by `CRON_SECRET` env var (`Authorization: Bearer <secret>`).

## Frontend Deployment

- Deployed on Vercel from the `app/` subdirectory
- Root directory must be set to `app` in Vercel project configuration
- GitHub repo: https://github.com/s85191939/PEAK6-Meridian
- The frontend connects to Solana devnet by default (configured in `app/lib/constants.ts`)
- No separate backend server -- the Solana program IS the backend

## Price and Amount Conventions

- **USDC amounts**: 6 decimal places (1_000_000 = $1.00)
- **Order prices**: 6 decimal places (500_000 = $0.50)
- **Strike prices**: stored in USD cents (23000 = $230.00)
- **No price**: always `1_000_000 - yes_price` (the $1 complement)
- Helper functions in `app/lib/utils.ts`: `formatPrice()`, `formatUsdc()`, `priceToPercent()`, `percentToPrice()`, `dollarToPrice()`, `noPrice()`

## Testing

Run all 23 tests with `make test`. Tests run on a local Solana validator (spun up automatically by Anchor). The test suite covers:

1. Config initialization
2. Market registry creation
3. Market creation with Yes/No mints
4. Market registration in registry
5. Vault + orderbook initialization
6. Escrow initialization (yes + bid)
7. Pair minting (USDC -> Yes + No)
8. Resting bid orders
9. Crossing ask orders (immediate fill)
10. Order cancellation + collateral return
11. Unauthorized cancel prevention
12. Pair merging (pre-settlement)
13. Unauthorized settlement prevention
14. Settlement (Yes wins)
15. Double-settlement prevention (immutability)
16. Winning token redemption
17. Losing token burn ($0 payout)
18. Maker token redemption
19. Post-settlement mint prevention
20. Post-settlement merge prevention
21. Post-settlement order prevention
22. No-wins scenario
23. Full lifecycle validation

The $1.00 vault invariant (`vault.amount == total_pairs_minted * 1_000_000`) is asserted at every state transition.

## Prerequisites

- Rust 1.70+ (`rustup install stable`)
- Solana CLI 1.18+ (`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`)
- Anchor CLI 0.30.1 (`cargo install --git https://github.com/coral-xyz/anchor avm && avm install 0.30.1 && avm use 0.30.1`)
- Node.js 18+ and npm
