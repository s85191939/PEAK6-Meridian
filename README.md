# Meridian: Binary Stock Outcome Markets on Solana

A non-custodial decentralized application for trading binary outcome contracts tied to the daily closing prices of MAG7 US equities (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA) on Solana devnet.

Each contract asks: *"Will [STOCK] close above [PRICE] today?"* — pays $1 USDC if yes, $0 if no. Contracts expire same-day (0DTE) and settle at 4:00 PM ET. Users trade Yes and No tokens on an on-chain order book. No KYC, no custody, no margin.

## Quick Start

```bash
git clone https://github.com/s85191939/PEAK6-Meridian.git
cd PEAK6-Meridian

# Install everything, build, and test
make install build test

# Start the frontend
make frontend
# Open http://localhost:3000
```

### Prerequisites

- Rust 1.70+ (`rustup install stable`)
- Solana CLI 1.18+ (`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`)
- Anchor CLI 0.30.1 (`cargo install --git https://github.com/coral-xyz/anchor avm && avm install 0.30.1 && avm use 0.30.1`)
- Node.js 18+ and npm

### Individual Commands

| Command | What it does |
|---------|-------------|
| `make install` | Install Anchor + frontend npm dependencies |
| `make build` | Build the Solana program |
| `make test` | Run all 23 integration tests on local validator |
| `make frontend` | Start Next.js dev server on port 3000 |
| `make demo` | Run full lifecycle script (create → mint → trade → settle → redeem) |
| `make deploy` | Deploy program to Solana devnet |
| `make create-markets` | Create today's strike markets on devnet |
| `make settle-markets` | Settle markets on devnet |

### How It Runs

There is no separate backend server. The **Solana program is the backend** — it runs on-chain and processes all transactions directly.

- **`make test`** — Spins up a local Solana validator automatically, deploys the program, runs all 23 tests, then shuts down. This is the fastest way to verify everything works.
- **`make frontend`** — Starts the Next.js UI on `localhost:3000`. It connects to Solana devnet by default (configurable in `app/lib/constants.ts`).
- **`make demo`** — Full feature demo on local validator (see below).
- **`make deploy`** — Deploys the compiled program to Solana devnet so the frontend can interact with it live.

### `make demo`

`make demo` does this:

1. Kills any leftover validator from a previous run
2. Starts a fresh `solana-test-validator` locally with the Meridian program preloaded
3. Waits up to 15 seconds for it to be ready
4. Runs `demo-lifecycle.ts` which demonstrates all 25 features:
   * Creates 3 users (Alice the bull, Bob the bear, Charlie the market maker)
   * Funds them each with $20 mock USDC
   * Initializes the protocol (config + registry)
   * Creates 2 markets: AAPL > $230 and TSLA > $350
   * Charlie mints 10 pairs and posts liquidity
   * Buy Yes — Alice buys Yes from Charlie's ask
   * Sell Yes — Alice sells Yes, Bob takes it
   * Buy No — Bob mints pairs + sells Yes (keeps No)
   * Sell No — Bob buys Yes + merges with No
   * Cancel order — Charlie cancels, gets collateral back
   * Merge pairs — Charlie exits 2 positions early
   * Pause/unpause — minting blocked while paused
   * Add intraday strike — AAPL > $250 added mid-day
   * Settlement — AAPL at $235.50 (Yes wins), TSLA at $340 (No wins)
   * Stale price rejection — zero price blocked
   * Settlement immutability — can't re-settle
   * Admin override — time delay enforced (TooEarlyToSettle)
   * Redemption — winners get $1 each, losers get $0
   * P&L summary — net $0.00 across all users (zero-sum verified)
   * Invariant — both vaults drain to $0 after all redeems
5. Shuts down the validator

Fully self-contained. No wallet needed, no devnet, no internet, works any time of day. Takes about 10 seconds.

## Live Deployment

| | |
|---|---|
| **Frontend** | [peak-6-meridian.vercel.app](https://peak-6-meridian.vercel.app) |
| **Network** | Solana Devnet |
| **Program ID** | `2zchyfx482vagebbGJ2ePq8AuuafwS1Hc6YoSkgAfTe1` |
| **Explorer** | [View on Solana Explorer](https://explorer.solana.com/address/2zchyfx482vagebbGJ2ePq8AuuafwS1Hc6YoSkgAfTe1?cluster=devnet) |
| **Framework** | Anchor 0.30.1 / Rust |

## How It Works

### The $1.00 Invariant

Every market enforces: **Yes payout + No payout = $1.00 USDC, always.**

```
mint_pair:   $1 USDC  →  1 Yes + 1 No    (deposit)
merge_pair:  1 Yes + 1 No  →  $1 USDC    (pre-settlement exit)
redeem:      1 Winner  →  $1 USDC         (post-settlement)
             1 Loser   →  $0 USDC         (burned)
```

The vault holds exactly `$1.00 × total_pairs_minted` at all times. Order collateral is isolated in separate escrow accounts (bid_escrow for USDC bids, escrow_yes for Yes token asks), keeping the vault invariant clean.

### One Book, Four Actions

A single Yes/USDC order book powers all four trade paths:

| User Action | On-Chain Flow | User Pays | User Gets |
|-------------|---------------|-----------|-----------|
| Buy Yes @ $0.65 | Bid on Yes book | $0.65 USDC | 1 Yes token |
| Sell Yes @ $0.65 | Ask on Yes book | 1 Yes token | $0.65 USDC |
| Buy No @ $0.35 | mint_pair + sell Yes @ $0.65 | $0.35 net | 1 No token |
| Sell No @ $0.35 | buy Yes @ $0.65 + merge_pair | 1 No token | $0.35 net |

The frontend abstracts this — users see Buy Yes / Buy No / Sell Yes / Sell No buttons.

### Order Matching

Orders fill immediately when prices cross (match-at-place). When a new bid meets a resting ask at an equal or better price, the trade executes atomically in the same transaction — USDC moves from bid_escrow to the ask maker, Yes tokens move from escrow_yes to the bidder. Remaining unfilled quantity rests on the book.

### Daily Lifecycle

| Time | Event |
|------|-------|
| 8:00 AM ET | Automation reads previous close, calculates strikes |
| 8:30 AM ET | Creates contracts and order books for each strike |
| 9:00 AM ET | Markets visible on frontend, minting enabled |
| 9:30 AM ET | US market open, live trading begins |
| 4:00 PM ET | US market close |
| ~4:05 PM ET | Automation reads closing price, settles all contracts |
| 4:05 PM ET+ | Redemption enabled — winners claim USDC |

## Smart Contract Instructions (13 total)

| Instruction | Description | Who |
|-------------|-------------|-----|
| `initialize` | Set admin + USDC mint | Admin (once) |
| `init_registry` | Create on-chain market registry | Admin (once) |
| `create_market` | Create market + Yes/No mints | Admin |
| `register_market` | Add market to registry for frontend discovery | Admin |
| `init_orderbook` | Create vault + orderbook | Admin |
| `init_escrow_yes` | Create Yes token escrow for ask collateral | Admin |
| `init_bid_escrow` | Create USDC escrow for bid collateral | Admin |
| `mint_pair` | $1 USDC → 1 Yes + 1 No | Any user |
| `merge_pair` | 1 Yes + 1 No → $1 USDC | Any user |
| `place_order` | Post limit order (bid/ask) with match-at-place | Any user |
| `cancel_order` | Cancel + return collateral from escrow | Order owner |
| `settle_market` | Set outcome (immutable) | Admin |
| `redeem` | Burn tokens, receive USDC (validates token_mint) | Any user |

### Market Setup Flow (7 transactions)

```
initialize → init_registry → create_market → register_market → init_orderbook → init_escrow_yes → init_bid_escrow
```

### Account Structure (PDAs)

```
Config:          seeds = ["config"]
MarketRegistry:  seeds = ["market_registry"]
Market:          seeds = ["market", ticker, strike_price, date]
Yes Mint:        seeds = ["yes_mint", market_key]
No Mint:         seeds = ["no_mint", market_key]
Vault:           seeds = ["vault", market_key]          — only mint/merge/redeem
OrderBook:       seeds = ["orderbook", market_key]
Escrow Yes:      seeds = ["escrow_yes", market_key]     — ask collateral
Bid Escrow:      seeds = ["bid_escrow", market_key]     — bid collateral
```

## Architecture

```
┌───────────────────────────────────────────────┐
│         Frontend (Next.js 14 + Tailwind)      │
│  Markets │ Trade │ Portfolio                  │
│  Wallet Adapter │ Anchor Client              │
├───────────────────┬───────────────────────────┤
                    │ RPC (Solana Devnet)
├───────────────────┴───────────────────────────┤
│       Solana Program (Anchor / Rust)          │
│  ┌────────┐ ┌────────┐ ┌──────────────────┐  │
│  │Markets │ │Tokens  │ │ Order Book       │  │
│  │Config  │ │Yes/No  │ │ (CLOB + matching)│  │
│  ├────────┤ ├────────┤ ├──────────────────┤  │
│  │Vault   │ │Escrows │ │ Settlement       │  │
│  │(USDC)  │ │bid/ask │ │ (immutable)      │  │
│  └────────┘ └────────┘ └──────────────────┘  │
├───────────────────────────────────────────────┤
│       Automation Scripts (TypeScript)         │
│  create-markets.ts │ settle-markets.ts        │
└───────────────────────────────────────────────┘
```

## Architecture Decisions

| Decision | Choice | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Blockchain | Solana (Anchor) | EVM L2 | Sub-second finality for order matching. PRD specifies Solana. |
| Order Book | On-chain CLOB with matching | Phoenix DEX | Demonstrates deep understanding of matching mechanics. Production would integrate Phoenix for liquidity depth. |
| Oracle | Pyth Network (primary) + Yahoo Finance (fallback) | Admin-only | Pyth pull-oracle with staleness (<5 min) and confidence (<1%) checks. Yahoo Finance as backup. PEAK6 is a Pyth validator. |
| No Token | Synthetic (via mint/merge) | Separate No book | Single book = no liquidity fragmentation. Same approach as Polymarket. |
| Token Standard | SPL Token | Token-2022 | Simpler, better tooling. Token-2022 extensions not needed for binary tokens. |
| Frontend | Next.js 14 (App Router) + Tailwind | Create-Solana-dApp / Vite | App Router gives file-based dynamic routes (`/trade/[market]`), server components for pre-rendering. Tailwind enables rapid iteration on trading UI with zero runtime CSS cost. |
| Escrow Design | Separate vault + bid_escrow + escrow_yes | Single vault | Isolates $1.00 invariant from order collateral. Vault only touched by mint/merge/redeem. |
| Market Discovery | On-chain MarketRegistry | Index-based iteration | Single source of truth. Frontend fetches registry, iterates market pubkeys. No off-chain state needed. |

## Project Structure

```
├── programs/meridian/src/
│   ├── lib.rs                # Program entry (13 instructions)
│   ├── state.rs              # Config, Market, MarketRegistry, OrderBook, Order
│   ├── errors.rs             # 19 custom error codes
│   └── instructions/
│       ├── initialize.rs     # Global config setup
│       ├── create_market.rs  # Market + mints creation
│       ├── init_registry.rs  # On-chain market registry
│       ├── register_market.rs # Add market to registry
│       ├── init_orderbook.rs # Vault + orderbook creation
│       ├── init_escrows.rs   # escrow_yes + bid_escrow creation
│       ├── mint_pair.rs      # Deposit USDC → Yes + No
│       ├── merge_pair.rs     # Yes + No → USDC (inverse)
│       ├── place_order.rs    # Limit orders with match-at-place
│       ├── cancel_order.rs   # Cancel + return collateral
│       ├── settle.rs         # Immutable settlement
│       └── redeem.rs         # Burn tokens → USDC
├── tests/meridian.ts         # 23 integration tests
├── scripts/
│   ├── create-markets.ts     # Morning: create strike markets
│   ├── settle-markets.ts     # 4 PM: settle via oracle
│   └── demo-lifecycle.ts     # Full end-to-end demo
├── app/                      # Next.js frontend
│   ├── app/                  # Pages (Markets, Trade, Portfolio)
│   ├── components/           # Navbar, MarketCard, TradePanel, OrderBook, PortfolioView
│   └── lib/                  # Constants, utils, PDA helpers, IDL
├── target/
│   ├── idl/meridian.json     # Program IDL
│   └── types/meridian.ts     # TypeScript types
├── Anchor.toml               # Anchor config
├── Cargo.toml                # Rust workspace
├── Makefile                  # One-command setup
└── package.json              # Node.js dependencies
```

## Test Results (23 passing)

```
  meridian
    ✓ Initializes the global config
    ✓ Initializes the market registry
    ✓ Creates a market with Yes/No mints
    ✓ Registers market in on-chain registry
    ✓ Initializes vault + orderbook
    ✓ Initializes escrow_yes for ask order collateral
    ✓ Initializes bid_escrow for bid order collateral
    ✓ Mints Yes/No token pairs by depositing USDC
    ✓ Places a resting bid order (no crossing asks)
    ✓ Places an ask that crosses bid -> fills immediately
    ✓ Cancels an open bid order and returns USDC collateral
    ✓ Prevents cancelling another user's order
    ✓ Merges Yes/No pairs back to USDC pre-settlement
    ✓ Prevents settlement by non-admin
    ✓ Settles market — Yes wins (close >= strike)
    ✓ Prevents double settlement (immutability)
    ✓ Redeems winning Yes tokens for USDC
    ✓ Burns losing No tokens with $0 payout
    ✓ Maker redeems winning Yes tokens
    ✓ Prevents minting on settled market
    ✓ Prevents merge on settled market
    ✓ Prevents placing orders on settled market
    ✓ Handles No-wins correctly (close < strike)

  23 passing
```

Tests verify the full lifecycle: config → registry → create market → register → init orderbook → init escrows → mint pairs → place orders → match-at-place fills → cancel → merge → settle → redeem. The $1.00 vault invariant (`vault.amount == total_pairs_minted × 1_000_000`) is asserted at every state transition.

## Risks & Limitations

1. **Oracle manipulation**: Compromised price feed settles markets incorrectly. *Mitigation*: Dual oracle sources (Pyth primary + Yahoo fallback), staleness checks (<5 min), confidence interval validation (<1%), admin settle override with time delay.
2. **Vault drain via invariant bug**: Flaw in mint/merge/redeem breaks $1.00 invariant. *Mitigation*: On-chain checked arithmetic, invariant assertions in every test, formal verification for production.
3. **Front-running**: Validators reorder transactions to front-run large orders. *Mitigation*: Jito bundles for atomic execution, MEV protection.
4. **Order book capacity**: Fixed 64-slot book can be filled with dust orders. *Mitigation*: Minimum order size, maker fees, heap-allocated book (production).
5. **Devnet only**: This is a proof-of-concept running on Solana devnet with no real funds. Not intended for production use without further auditing and hardening.
6. **Simplified CLOB**: The on-chain order book demonstrates matching mechanics but is not production-grade. For production, integrate Phoenix DEX for battle-tested matching and existing liquidity.

## Key Dependencies

| Dependency | Purpose | Justification |
|-----------|---------|---------------|
| `@coral-xyz/anchor` | Solana program framework | Industry standard for Solana smart contract development. Provides IDL generation, account serialization, and type-safe client. |
| `@solana/web3.js` | Solana RPC client | Official Solana SDK — required for all blockchain interactions (transactions, account reads). |
| `@solana/spl-token` | SPL token operations | Official library for creating/minting/burning tokens. Yes/No tokens are SPL tokens. |
| `@solana/wallet-adapter-*` | Wallet connection | Official Solana wallet adapter — connects Phantom, Solflare, etc. No custom wallet code needed. |
| `next` (Next.js) | Frontend framework | App Router provides file-based routing (`/trade/[market]`), API routes for cron automation, and server-side rendering. |
| `bn.js` | Big number math | Required for Solana u64/u128 amounts. JavaScript numbers lose precision above 2^53. |
| `buffer` | Buffer polyfill | Required for Solana SDK in browser environment (web3.js uses Node.js Buffer). |
| `tailwindcss` | CSS framework | Utility-first CSS — zero runtime cost, rapid iteration on trading UI. No custom CSS framework overhead. |

No unnecessary abstractions: Pyth oracle and Yahoo Finance are accessed via plain `fetch()` — no SDK packages needed. The Anchor client handles all Solana program interaction directly.

## Production Roadmap

| Priority | Item | Status |
|----------|------|--------|
| ✅ Done | Escrow separation (vault vs bid/ask collateral) | Implemented |
| ✅ Done | Match-at-place order matching | Implemented |
| ✅ Done | On-chain market registry | Implemented |
| ✅ Done | Token mint validation in redeem | Implemented |
| ✅ Done | Frontend: registry-based market discovery | Implemented |
| ✅ Done | Frontend: correct USDC account derivation | Implemented |
| ✅ Done | 23 integration tests covering full lifecycle | Implemented |
| ✅ Done | Pyth oracle integration (staleness + confidence checks) | Implemented |
| ✅ Done | Position constraints in UI (no simultaneous Yes+No) | Implemented |
| ✅ Done | Admin settle override with time delay | Implemented |
| ✅ Done | Automated market creation + settlement (Vercel crons) | Implemented |
| Next | Phoenix DEX integration for production matching | Planned |
| Next | Pause/unpause for emergency admin controls | Planned |
| Later | WebSocket subscriptions for real-time order book | Planned |
| Later | Automated market-making algorithms | Planned |

## License

MIT
