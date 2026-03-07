# My Understanding of PEAK6 and This Project

## Who PEAK6 Is

PEAK6 is a $400M+ revenue financial services and technology conglomerate founded in 1997 by options traders Matt Hulsizer and Jenny Just. They are not just a trading firm. They are a vertical integrator of financial market infrastructure across four business lines:

**PEAK6 Capital Management** has been one of the largest U.S. options market makers for 25+ years. Options pricing is fundamentally about valuing binary outcomes ("will this stock be above/below X by date Y?"), which maps directly to what Meridian does on-chain.

**Apex Fintech Solutions** provides clearing and custody for Robinhood, Webull, SoFi, and 200+ other fintechs. With 22 million accounts and $200B+ assets under custody, Apex is the invisible infrastructure behind modern retail trading.

**Bruce Markets** is PEAK6's brand-new overnight equities trading venue, launched in 2025 with backing from Fidelity, Nasdaq, and Robinhood. This demonstrates PEAK6's ability to take a new market concept through regulatory approval and launch.

The company relocated from Chicago to Austin, TX in January 2025.

## Why Binary Stock Outcomes Now

Three forces are converging:

1. **Prediction markets exploded.** Kalshi and Polymarket combined for $44B+ in volume in 2025. Retail demand for simple yes/no contracts on real-world events is proven.

2. **Regulators are moving.** In March 2026, Nasdaq and Cboe both filed with the SEC to offer binary/prediction-market-style contracts on stock indices. The regulatory path is opening.

3. **0DTE options show demand.** Zero-days-to-expiration options now account for ~45% of S&P 500 options volume. Retail traders want short-duration, binary-like instruments with defined risk.

PEAK6 is uniquely positioned because they already have every layer of the stack needed to launch this product:

| Layer | PEAK6 Asset | Role |
|-------|-------------|------|
| Pricing models | 25 years of options market-making | They know how to price binary outcomes |
| Clearing infrastructure | Apex (200+ fintechs) | Settle trades for 22M accounts |
| Market-making capability | PEAK6 Capital | Provide liquidity from day one |
| Distribution | Apex client network | Access 22M accounts instantly |
| Regulatory track record | Bruce ATS launch | Proven ability to get SEC/FINRA approval |

The question is not whether binary stock outcomes will exist. Nasdaq and Cboe are already pursuing them. The question is who builds the best infrastructure for it. PEAK6 has the most complete vertical stack of any potential player.

## What I Built and Why

**Meridian** demonstrates the core mechanics of a binary stock outcome market on Solana devnet. It is a proof-of-concept that could inform the architecture of a regulated product.

### The Core Invariant

The entire system rests on one rule: **Yes payout + No payout = $1.00 USDC, always.**

- Mint a pair: deposit $1.00 USDC, receive 1 Yes + 1 No token
- At settlement: winning token redeems for $1.00, losing token redeems for $0.00
- Pre-settlement: merge 1 Yes + 1 No back into $1.00 USDC

This invariant is enforced on-chain and verified in every integration test. If this breaks, nothing else matters.

### One Book, Four Actions

Instead of building separate Yes and No order books, Meridian uses a single Yes/USDC order book. No tokens are synthetic inverses:

| User Intent | What Actually Happens On-Chain |
|-------------|-------------------------------|
| **Buy Yes** | Place bid on Yes/USDC book |
| **Sell Yes** | Place ask on Yes/USDC book |
| **Buy No** | Mint pair (get Yes+No), sell Yes on book, keep No |
| **Sell No** | Buy Yes from book, merge Yes+No into $1 USDC |

The frontend hides all of this complexity. The user sees four buttons: Buy Yes, Buy No, Sell Yes, Sell No. The `merge_pair` instruction is the key insight that makes "Sell No" clean and atomic.

### What I Prioritized

1. **Correctness over features.** The $1.00 invariant is the business. 13 integration tests verify it never breaks, including edge cases (settled markets, merge-then-settle, No-wins scenarios).

2. **The core user journey.** Connect wallet, browse markets, buy/sell, settle, redeem. One complete loop that works end-to-end.

3. **Defensible architecture.** Every component choice has a reason tied to PEAK6's constraints and the product requirements.

### Architecture Decisions

| Decision | Chose | Why |
|----------|-------|-----|
| Chain | Solana (Anchor) | Sub-second finality for order book. PRD specifies Solana. |
| Order Book | Simplified on-chain CLOB | Demonstrates matching mechanics. For production, I would integrate Phoenix DEX for its battle-tested engine and existing liquidity. |
| Token Standard | SPL Token (original) | Simpler, better tooling. Token-2022 extensions are not needed for binary tokens. |
| Oracle | Admin-submitted price (MVP) | Simulates Pyth oracle behavior. In production, reads directly from Pyth on-chain with staleness and confidence checks. |
| Frontend | Next.js 14 + Tailwind | Full control over trading UI. Not a generic scaffold. |
| No Token | Synthetic inverse | Single order book, no liquidity fragmentation. Same approach Polymarket uses. |

### What I Would Change for Production

**Immediate (pre-launch):**
- Integrate Phoenix DEX for real order matching and liquidity depth
- Add Pyth oracle integration with staleness < 60s and confidence < 1% checks
- Implement position limits and circuit breakers
- Add WebSocket subscriptions (Helius gRPC) for real-time order book updates

**For scale (post-launch):**
- Move to regulated infrastructure (Apex for clearing)
- Implement automated market-making algorithms for liquidity provision
- Add margin requirements and risk management
- Build a matching engine that can handle 10K+ orders per second

**For multi-tenant/multi-region:**
- Shard order books by ticker across multiple Solana programs
- Use geographic load balancing for RPC endpoints
- Implement cross-region settlement with eventual consistency guarantees
- Add tenant isolation at the config level (separate admin authorities per region)

## Potential Failure Modes

1. **Oracle manipulation.** If the price feed is compromised, markets settle incorrectly. Mitigation: multiple oracle sources, TWAP instead of spot, settlement delay with dispute window.

2. **Vault drain.** If a bug in mint/merge/redeem breaks the $1.00 invariant, the vault could be drained. Mitigation: on-chain invariant checks on every transaction, formal verification of the core accounting.

3. **Front-running.** Validators could reorder transactions to front-run large orders. Mitigation: use Jito bundles for atomic execution, implement MEV protection.

4. **Order book spam.** Malicious actors could fill the 64-slot order book with dust orders. Mitigation: minimum order size, maker fees, order book capacity increase with heap allocation.

5. **Clock manipulation.** Settlement depends on timestamps. Mitigation: use on-chain slot-based timing, not wall-clock time.

## What Doubling Traffic Would Require

If trading volume doubled, the bottlenecks would be:

1. **Order book capacity** (currently 64 slots) would need to move to a heap-allocated data structure or Phoenix DEX integration
2. **RPC throughput** would need dedicated Helius/QuickNode endpoints with WebSocket support
3. **Frontend** would need server-side rendering optimization and CDN caching for market data
4. **Transaction throughput** would benefit from Solana's priority fees and Jito's MEV protection for order execution

None of these are architectural changes. They are scaling the same architecture with better infrastructure.
