# Meridian: Binary Stock Outcome Markets on Solana

A proof-of-concept binary outcome market protocol for MAG7 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA) built on Solana devnet.

**Core question:** "Will AAPL close above $230 today?" Buy Yes if you think so, Buy No if you don't. Winning tokens pay $1.00. Losing tokens pay $0.00.

## Solana Devnet Deployment

| | |
|---|---|
| **Network** | Solana Devnet |
| **Program ID** | `2zchyfx482vagebbGJ2ePq8AuuafwS1Hc6YoSkgAfTe1` |
| **Admin Wallet** | `BPsWi1a8v2FSKHd95jXoVkTMiMQ4AfuufdahgzT3qqhn` |
| **Explorer** | [View on Solana Explorer](https://explorer.solana.com/address/2zchyfx482vagebbGJ2ePq8AuuafwS1Hc6YoSkgAfTe1?cluster=devnet) |
| **RPC Endpoint** | `https://api.devnet.solana.com` |
| **Framework** | Anchor 0.30.1 / Rust |

## Quick Start

### Prerequisites

- Rust 1.70+ (`rustup install stable`)
- Solana CLI 1.18+ (`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`)
- Anchor CLI 0.30.1 (`cargo install --git https://github.com/coral-xyz/anchor avm && avm install 0.30.1 && avm use 0.30.1`)
- Node.js 18+ and npm

### Build & Test

```bash
# Clone
git clone https://github.com/s85191939/PEAK6-Meridian.git
cd PEAK6-Meridian

# Install dependencies
npm install

# Build the smart contract
anchor build --no-idl

# Run all 13 integration tests
anchor test --skip-build
```

### Run the Frontend

```bash
cd app
npm install
npm run dev
# Open http://localhost:3000
```

### Deploy to Devnet

```bash
# Fund your wallet (may be rate-limited, retry after 8 hours or use https://faucet.solana.com)
solana config set --url devnet
solana airdrop 5

# Deploy
solana program deploy target/deploy/meridian.so --program-id target/deploy/meridian-keypair.json --url devnet
```

### Run the Demo Lifecycle

```bash
# Full end-to-end: create market -> mint pairs -> merge pairs -> settle -> redeem
npx ts-node scripts/demo-lifecycle.ts
```

## How It Works

### The $1.00 Invariant

Every market enforces: **Yes payout + No payout = $1.00 USDC**

```
mint_pair:   $1 USDC  ->  1 Yes + 1 No    (deposit)
merge_pair:  1 Yes + 1 No  ->  $1 USDC    (pre-settlement exit)
redeem:      1 Winner  ->  $1 USDC         (post-settlement)
             1 Loser   ->  $0 USDC         (burned)
```

### One Book, Four Actions

A single Yes/USDC order book powers all four trade paths. No tokens are synthetic inverses.

| User Action | On-Chain Flow | User Pays | User Gets |
|-------------|---------------|-----------|-----------|
| Buy Yes @ $0.65 | Bid on Yes book | $0.65 | 1 Yes token |
| Sell Yes @ $0.65 | Ask on Yes book | 1 Yes token | $0.65 |
| Buy No @ $0.35 | mint_pair + sell Yes @ $0.65 | $0.35 net | 1 No token |
| Sell No @ $0.35 | buy Yes @ $0.65 + merge_pair | 1 No token | $0.35 net |

The frontend abstracts this. Users see Buy Yes / Buy No / Sell Yes / Sell No buttons.

### Smart Contract Instructions (9 total)

| Instruction | Description | Who |
|-------------|-------------|-----|
| `initialize` | Set admin + USDC mint | Admin (once) |
| `create_market` | Create market + Yes/No mints | Admin |
| `init_orderbook` | Create vault + orderbook | Admin |
| `mint_pair` | $1 USDC -> 1 Yes + 1 No | Any user |
| `merge_pair` | 1 Yes + 1 No -> $1 USDC | Any user |
| `place_order` | Post limit order (bid/ask) | Any user |
| `cancel_order` | Cancel + return collateral | Order owner |
| `settle_market` | Set outcome (immutable) | Admin |
| `redeem` | Burn tokens, receive USDC | Any user |

### Account Structure (PDAs)

```
Config:      seeds = ["config"]
Market:      seeds = ["market", ticker, strike_price, date]
Yes Mint:    seeds = ["yes_mint", market_key]
No Mint:     seeds = ["no_mint", market_key]
Vault:       seeds = ["vault", market_key]
OrderBook:   seeds = ["orderbook", market_key]
```

## Architecture

```
+---------------------------------------------------+
|            Frontend (Next.js 14 + Tailwind)        |
|  Markets | Trade | Portfolio                       |
|  Wallet Adapter | Anchor Client                    |
+------------------------+--------------------------+
                         | RPC (Solana Devnet)
+------------------------+--------------------------+
|          Solana Program (Anchor / Rust)             |
|  +----------+ +----------+ +-------------------+   |
|  | Markets  | | Tokens   | | Order Book        |   |
|  | Config   | | Yes/No   | | (simplified CLOB) |   |
|  +----------+ +----------+ +-------------------+   |
|  +----------+ +----------+ +-------------------+   |
|  | Vault    | | Oracle   | | Settlement        |   |
|  | USDC     | | (admin)  | | (immutable)       |   |
|  +----------+ +----------+ +-------------------+   |
+----------------------------------------------------+
                         |
+------------------------+--------------------------+
|          Automation Scripts (TypeScript)            |
|  create-markets.ts | settle-markets.ts             |
+----------------------------------------------------+
```

## Architecture Decisions & Trade-offs

| Decision | Choice | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Blockchain | Solana (Anchor) | EVM L2 | Sub-second finality for order matching. PRD specifies Solana. Anchor has best Rust DX. |
| Order Book | On-chain simplified CLOB | Phoenix DEX | Phoenix adds 3+ days of integration. Simplified CLOB demonstrates mechanics. For production: Phoenix for liquidity depth. |
| Oracle | Admin-submitted price | Pyth Network | Simulates oracle for MVP. Production would use Pyth pull-oracle with staleness/confidence checks. PEAK6 is a Pyth validator. |
| No Token | Synthetic (via mint/merge) | Separate No book | Single book = no liquidity fragmentation. Same approach as Polymarket. |
| Token Standard | SPL Token | Token-2022 | Simpler, better tooling. Token-2022 extensions not needed for binary tokens. |
| Frontend | Next.js 14 (App Router) | Create-Solana-dApp / Vite | App Router gives server components for SEO, file-based routing for clean URL structure (`/trade/[market]`), and built-in API routes if needed. Generic Solana scaffolds lack trading-specific UX patterns. |
| Styling | Tailwind CSS | CSS Modules / styled-components | Utility-first approach enables rapid iteration on trading UI without context-switching between files. Co-located styles make components self-contained. Dark theme is a single `dark` class on `<html>`. No runtime CSS-in-JS overhead, which matters for a data-heavy trading dashboard that re-renders on every price tick. |
| State Mgmt | React hooks + Anchor | Redux / Zustand | Anchor's `useProgram` + `useConnection` + `useWallet` hooks already provide the core state. Adding Redux would be overengineering for 3 pages. Would introduce Zustand if the app grew beyond 10+ pages with cross-cutting concerns. |
| Market Creation | 2-step (create + init) | Single instruction | Solana's 4KB BPF stack frame limit requires splitting. Documented trade-off. |

### Why Next.js 14 (App Router)

The App Router was chosen over Pages Router or Vite SPA for three reasons:

1. **File-based dynamic routes** map cleanly to the market model: `/trade/[market]` resolves each market's public key directly from the URL. No client-side router config needed.
2. **Server Components** allow the markets listing page to pre-render static shells and hydrate with on-chain data client-side, avoiding a blank loading screen.
3. **Built-in optimizations** (automatic code splitting, image optimization, font loading) reduce time-to-interactive for a data-heavy trading UI without manual webpack config.

The trade-off is more complex SSR/hydration boundaries (every component using wallet hooks needs `'use client'`), but this is manageable for 3 pages.

### Why Tailwind CSS

Three factors made Tailwind the clear choice for a trading dashboard:

1. **Speed of iteration**: Trading UIs require constant visual tuning (padding, colors, responsive breakpoints). Tailwind's utility classes eliminate the CSS file round-trip. A single `className` string describes the entire visual state.
2. **Dark theme without complexity**: The entire app is dark-themed (Polymarket-style `bg-gray-950`). With Tailwind, this is one `dark` class on `<html>` plus dark-variant utilities. No theme provider, no CSS variables, no runtime overhead.
3. **Zero runtime cost**: Unlike styled-components or Emotion, Tailwind compiles to static CSS at build time. For a trading UI that re-renders on every price update and order book change, zero runtime CSS overhead is a performance advantage.

The trade-off is longer `className` strings, but this is a worthwhile exchange for a prototype where iteration speed matters more than class name aesthetics.

## Transaction Performance

Solana's architecture gives Meridian sub-second transaction finality out of the box. Here's how each layer contributes to speed and what we'd do to push it further:

### What Makes It Fast Now

**On-chain (400ms block time)**:
- **Single-transaction execution**: Every user action (mint, merge, place order, settle, redeem) completes in one atomic Solana transaction. Compare this to EVM, where a simple token swap requires two transactions (approve + swap). On Meridian, when a user clicks "Mint Pair," one transaction moves USDC to the vault and mints both Yes and No tokens to the user — all in ~400ms. No approval step, no intermediate states, no second wallet popup. This is possible because Solana's account model lets the program read and write multiple accounts (vault, two token mints, user's three token accounts) in a single instruction, and the user's signature authorizes all of it at once.
- PDA-based account derivation means zero on-chain lookups. The client computes all account addresses deterministically and passes them in. The program just verifies seeds and bumps.
- `Box<Account>` heap allocation keeps all instruction handlers under Solana's 4KB stack frame limit while avoiding account splitting (except for the unavoidable create_market/init_orderbook split).
- All arithmetic uses `checked_*` operations. No unchecked math means no panic paths that waste compute.

**Client-side (parallelism)**:
- Account addresses are derived client-side via `PublicKey.findProgramAddressSync`. No RPC calls needed before constructing a transaction.
- The frontend pre-fetches market data and orderbook state on page load with 5-15 second polling intervals, so when a user clicks "Buy Yes," the transaction is ready to send immediately.

### Future Iterations for Even Faster Execution

| Optimization | Impact | Effort |
|-------------|--------|--------|
| **Jito bundles** | Atomic multi-instruction execution (mint+sell for Buy No) in a single block, guaranteed ordering | Medium — Jito SDK integration |
| **Priority fees** | Skip to front of block during congestion by bidding for compute | Low — add `computeBudget` instruction |
| **Helius WebSocket subscriptions** | Real-time order book updates instead of 5s polling. Sub-100ms price display. | Low — swap polling for `onAccountChange` |
| **Transaction pre-signing** | Pre-sign common transactions (e.g., cancel order) and store locally. One-click execution with no wallet popup. | Medium — UX improvement, not protocol change |
| **Lookup tables (ALTs)** | Reduce transaction size by referencing accounts via index instead of full pubkey. Enables more instructions per tx. | Low — `createLookupTable` + `extendLookupTable` |
| **Versioned transactions** | Required for ALTs. Also enables future Solana features (address tables, compute budget hints). | Low — already supported by wallet adapters |
| **Cranking engine** | Off-chain service that matches orders and submits fill transactions. Separates order placement from matching. | High — new service, but eliminates on-chain matching latency |

### Why Solana Over EVM for Speed

An EVM L2 (Arbitrum, Base) would give ~250ms block times but with fundamentally different trade-offs:
- EVM storage reads/writes are 10-100x more expensive in gas than Solana compute units
- Solana's parallel transaction execution (Sealevel) processes non-overlapping accounts simultaneously; EVM is sequential
- SPL Token operations are native runtime CPIs on Solana vs. external contract calls on EVM

For an order book that needs to read/write market state, orderbook state, token accounts, and vault in a single atomic transaction, Solana's account model is architecturally faster than EVM's storage model.

## Potential Failure Modes

1. **Oracle manipulation**: Compromised price feed settles markets incorrectly.
   - *Mitigation*: Multiple oracle sources, TWAP pricing, settlement delay with dispute window.

2. **Vault drain via invariant bug**: Flaw in mint/merge/redeem breaks $1.00 invariant.
   - *Mitigation*: On-chain checked arithmetic, invariant assertions in every test, formal verification for production.

3. **Front-running**: Validators reorder txs to front-run large orders.
   - *Mitigation*: Jito bundles for atomic execution, MEV protection.

4. **Order book spam**: Malicious actors fill the 64-slot book with dust orders.
   - *Mitigation*: Minimum order size, maker fees, heap-allocated book (production).

5. **Clock manipulation**: Settlement depends on time comparisons.
   - *Mitigation*: Slot-based timing instead of wall-clock, multi-block confirmation.

## Scaling Considerations

**If traffic doubled:**
- Order book capacity (64 -> heap-allocated or Phoenix DEX)
- Dedicated RPC endpoints (Helius/QuickNode) with WebSocket subscriptions
- Frontend SSR optimization and CDN caching for market data
- Solana priority fees and Jito MEV protection

**If multi-tenant / multi-region was needed:**
- Shard order books by ticker across multiple Solana programs
- Geographic load balancing for RPC endpoints
- Cross-region settlement with eventual consistency
- Tenant isolation at config level (separate admin authorities)

**None of these require architectural changes** -- they scale the same design with better infrastructure.

## Project Structure

```
meridian/
+-- programs/meridian/src/
|   +-- lib.rs                # Program entry (9 instructions)
|   +-- state.rs              # Config, Market, OrderBook, Order
|   +-- errors.rs             # 17 custom error codes
|   +-- instructions/
|       +-- initialize.rs     # Global config setup
|       +-- create_market.rs  # Market + mints creation
|       +-- init_orderbook.rs # Vault + orderbook creation
|       +-- mint_pair.rs      # Deposit USDC -> Yes + No
|       +-- merge_pair.rs     # Yes + No -> USDC (inverse)
|       +-- place_order.rs    # Limit orders on CLOB
|       +-- cancel_order.rs   # Cancel + return collateral
|       +-- settle.rs         # Immutable settlement
|       +-- redeem.rs         # Burn tokens -> USDC
+-- tests/meridian.ts         # 13 integration tests
+-- scripts/
|   +-- create-markets.ts     # Morning: create strike markets
|   +-- settle-markets.ts     # 4 PM: settle via oracle
|   +-- demo-lifecycle.ts     # Full end-to-end demo
+-- app/                      # Next.js frontend
|   +-- app/                  # Pages (Markets, Trade, Portfolio)
|   +-- components/           # Navbar, MarketCard, TradePanel, OrderBook
|   +-- lib/                  # Constants, utils, PDA helpers
+-- target/
    +-- idl/meridian.json     # Program IDL
    +-- types/meridian.ts     # TypeScript types
```

## Test Results

```
  meridian
    ✓ Initializes the global config
    ✓ Creates a market (step 1: Market + Yes/No mints)
    ✓ Initializes vault + orderbook (step 2)
    ✓ Mints Yes/No token pairs by depositing USDC
    ✓ Merges Yes/No pairs back to USDC pre-settlement
    ✓ Prevents settlement by non-admin
    ✓ Settles market — Yes wins (close >= strike)
    ✓ Prevents double settlement (immutability)
    ✓ Redeems winning Yes tokens for USDC
    ✓ Burns losing No tokens with $0 payout
    ✓ Handles No-wins correctly (close < strike)
    ✓ Prevents minting on settled market
    ✓ Prevents merge_pair on settled market

  13 passing (10s)
```

## License

MIT
