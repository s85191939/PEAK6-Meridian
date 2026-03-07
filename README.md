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
| Frontend | Next.js 14 + Tailwind | Scaffold template | Full control over trading UI. Custom dark theme, responsive design. |
| State Mgmt | React hooks + Anchor | Redux/Zustand | Sufficient for this scope. Would add Zustand at 20+ pages. |
| Market Creation | 2-step (create + init) | Single instruction | Solana's 4KB BPF stack frame limit requires splitting. Documented trade-off. |

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
