# JGG — Provider & capability matrix

| Capability | Interface | Provider in this build | Status | To enable |
|---|---|---|---|---|
| Market data (Solana pump.fun: new coins, trades, curve reserves, security, concentration, smart-money labels) | **JGG indexer (standalone)** | own decoder over any standard Solana RPC | built + tested offline; **live stream not yet verified** | `JGG_SOLANA_RPC_HTTP/WS`, then `node scripts/verify-live.mjs 120` |
| SOL/USD | Price | Jupiter Price API v3 | built; unverified live | `JGG_JUPITER_API_KEY` (free) or `JGG_SOL_USD_MANUAL` |
| Market data (other chains, social/KOL, wallet PnL history beyond our own index) | — | not in standalone v1 | disabled in live mode | future indexers |
| GMGN (optional, not required) | MarketDataProvider | gmgn-cli adapter kept but unused | unverified | only if the owner opts in later |
| Wallet analytics / labels | WalletAnalyticsProvider | `jgg-fixture` rule labels | available (simulated) | Same as above; label provenance must be carried through |
| Token security | SecurityProvider | `jgg-fixture` tri-state | available (simulated) | GMGN security / GoPlus-class provider |
| Execution (Solana/BSC/Base) | ExecutionProvider | `jgg-paper` | paper only | GMGN `swap` (+ documented condition orders) — builder ready and tested, **execution disabled**; needs signing key + IP whitelist + owner-authorized funded test (T59) |
| Execution (EVM) | ExecutionProvider | `jgg-paper` | paper only | Aggregator (0x/1inch/OKX-class) + RPC + signer |
| Signing | SignerProvider | none | blocked_external | Isolated signer service / wallet adapter; unattended signing needs explicit scoped grants |
| Wallet sign-in | Auth | Solana SIWS-style (ed25519, built-in) | available | EVM SIWE needs an audited secp256k1/keccak library |
| X / Twitter, 6551 OpenTwitter | SocialProvider | none | blocked_external | `X_API_BEARER_TOKEN` / `OPEN6551_API_KEY` |
| News | NewsProvider | none | blocked_external | Licensed news provider (e.g. 6551 OpenNews) |
| Notifications | Delivery | in-app | available | Telegram bot token; Web Push VAPID keys |
| Launchpads (Pump.fun, FourMeme, Clanker, Flap) | LaunchProvider | validation/review only | blocked_external | Verified current SDK/contract per launchpad + signer + owner authorization |
| Perpetuals | DerivativesProvider | none | blocked_external | Selected venue API, jurisdiction/eligibility checks, separate risk budget |
| Up/Down | — | none | blocked_external | Documented product contract, settlement source, eligibility |
| LLM | AIProvider | rule-based planner | available (no LLM) | `ANTHROPIC_API_KEY` (tool-use with the same registry + output validation) |

## Cost & access worksheet (unknowns to fill in with the owner)
| Item | Unknown | Needed decision |
|---|---|---|
| GMGN / indexer API | plan tier, rate limits, allowed commercial use | choose tier; confirm ToS for redistribution |
| RPC (Solana/EVM) | request volume at target users | provider + plan |
| Execution aggregator | fees, referral fee support | whether JGG fee > 0 bps (affects Rewards) |
| Signer | custody model (non-custodial only vs hosted) | legal review before any hosted keys |
| X API | tier cost | only if Track/Social is a priority |
| Derivatives venue | jurisdiction | venue selection + eligibility gating |
