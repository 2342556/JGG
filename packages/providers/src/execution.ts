// ExecutionProvider — PAPER SIMULATOR. Virtual fills only; never touches a chain.
// Model: constant-product pool built from fixture liquidity + price, DEX fee and token tax
// embedded in output, network/priority fee charged separately in the native asset.
import * as D from '../../domain/src/index.ts';
import { CHAIN_META, type Chain } from '../../contracts/src/index.ts';
import { findFixtureToken, priceAt, num, NATIVE_USD } from '../../test-fixtures/src/index.ts';

export const PAPER_MODEL = {
  id: 'jgg-paper-cpmm-v1',
  description: 'Constant-product pool reconstructed from fixture liquidity/price; DEX fee 25 bps and token tax embedded in output; fixed network+priority fee; 400–1200 ms modeled latency; fails when liquidity is unknown.',
  fillPolicy: 'Contemporaneous fixture price at quote time; requote at execution; never fills at a candle extreme.',
};
export const NETWORK_FEE: Record<Chain, string> = { solana: '0.000005', bsc: '0.00015', base: '0.00001', ethereum: '0.0012' };
export const PRIORITY_FEE: Record<Chain, string> = { solana: '0.0001', bsc: '0', base: '0', ethereum: '0.0005' };
const DEX_FEE_BPS = 25;
export const JGG_FEE_BPS = 0; // spec §0.3: 0 bps until configured

export type PaperQuote = {
  chain: Chain; token: string; side: 'buy' | 'sell'; amountIn: string; assetIn: string; expectedOut: string; assetOut: string;
  minOut: string; slippageBps: number; priceImpactBps: number; executionPriceUsd: string; route: string;
  fees: D.FeeComponent[]; quotedAt: number; expiresAt: number; model: string; decimalsOut: number;
};

function poolFor(chain: Chain, token: string, now: number) {
  const t = findFixtureToken(chain, token); if (!t) return { error: 'TOKEN_NOT_FOUND' as const };
  const p = priceAt(t, now); if (p === null) return { error: 'NO_PRICE' as const };
  if (t.liquidityBase === null) return { error: 'LIQUIDITY_UNKNOWN' as const };
  const quoteUsd = D.dec((t.liquidityBase / 2).toFixed(2));
  const nat = NATIVE_USD[chain];
  const x = D.div(quoteUsd, nat, 12); // native reserve
  const y = D.div(quoteUsd, num(p), 12); // token reserve
  return { t, p: num(p), x, y };
}

// ---------------- Market source (fixture by default; the standalone Solana indexer when configured) ----------------
export type PriceObs = { usd: string | null; at: number | null; source: string; staleReason: string | null };
export type QuoteResult = { ok: true; quote: PaperQuote } | { ok: false; code: string };
export type MarketSource = {
  kind: 'fixture' | 'solana_live'; label: string;
  now(): number;
  priceUsd(chain: Chain, token: string, now: number): string | null;
  /** Price with the time it was known to be valid, for exits (stale prices must never trigger a sale). */
  priceObs?(chain: Chain, token: string, now: number): PriceObs;
  quote(chain: Chain, token: string, side: 'buy' | 'sell', amount: string, slippageBps: number, now: number, ttlMs?: number, opts?: { live?: boolean }): QuoteResult;
  finderCandidates(chain: Chain, now: number): D.FinderInput[];
  finderConfig?: D.FinderConfig; finderExclude?: string[];
  /** USD per native unit for accounting (latest known value; may be older than quote freshness rules allow). */
  nativeUsd(chain: Chain, now: number): string | null;
};
let source: MarketSource | null = null;
export const setMarketSource = (s: MarketSource | null) => { source = s; };
export const getMarketSource = (): MarketSource | null => source;
/** USD per native unit from the active source (fixture constants in Demo). */
export function nativeUsdOf(chain: Chain, now: number): string {
  if (source && source.kind !== 'fixture') { const v = source.nativeUsd(chain, now); if (v === null) throw Object.assign(new Error('Native USD price unavailable'), { code: 'PROVIDER_UNAVAILABLE' }); return v; }
  return NATIVE_USD[chain];
}

export function paperQuote(chain: Chain, token: string, side: 'buy' | 'sell', amount: string, slippageBps: number, now: number, ttlMs = 15_000, opts?: { live?: boolean }): QuoteResult {
  if (source && source.kind !== 'fixture') return source.quote(chain, token, side, amount, slippageBps, now, ttlMs, opts);
  if (opts?.live) return { ok: false, code: 'LIVE_NEEDS_LIVE_DATA' };
  return fixtureQuote(chain, token, side, amount, slippageBps, now, ttlMs);
}
function fixtureQuote(chain: Chain, token: string, side: 'buy' | 'sell', amount: string, slippageBps: number, now: number, ttlMs = 15_000): QuoteResult {
  D.validateSlippageBps(slippageBps, true);
  const pool = poolFor(chain, token, now); if ('error' in pool) return { ok: false, code: pool.error! };
  const native = CHAIN_META[chain].native;
  const tax = side === 'buy' ? pool.t.security.buyTaxBps : pool.t.security.sellTaxBps;
  if (tax === null) return { ok: false, code: 'TOKEN_TAX_UNKNOWN' };
  const feeFactor = D.div(String(10_000 - DEX_FEE_BPS - JGG_FEE_BPS), '10000', 12);
  const dx = D.mul(amount, feeFactor);
  const [rin, rout] = side === 'buy' ? [pool.x, pool.y] : [pool.y, pool.x];
  const grossOut = D.div(D.mul(rout, dx), D.add(rin, dx), 12, 'floor');
  const out = D.mul(grossOut, D.div(String(10_000 - tax), '10000', 12));
  const spot = side === 'buy' ? D.div(rout, rin, 18) : D.div(rout, rin, 18);
  const ideal = D.mul(amount, spot);
  const impact = D.isZero(ideal) ? 0 : Number(D.rescale(D.mul(D.div(D.sub(ideal, grossOut), ideal, 12), '10000'), 0).int);
  const decimalsOut = side === 'buy' ? pool.t.decimals : 9;
  const outRaw = D.decToRaw(D.fixed(D.rescale(out, decimalsOut, 'floor'), decimalsOut), decimalsOut);
  const minOutRaw = D.minimumOutRaw(outRaw, slippageBps);
  const usdIn = side === 'buy' ? D.mul(amount, NATIVE_USD[chain]) : D.mul(amount, pool.p);
  const execPrice = side === 'buy' ? (D.isZero(out) ? D.dec('0') : D.div(usdIn, out, 18)) : (D.isZero(amount) ? D.dec('0') : D.div(D.mul(out, NATIVE_USD[chain]), amount, 18));
  const fees: D.FeeComponent[] = [
    { kind: 'dex', amount: D.str(D.mul(amount, D.div(String(DEX_FEE_BPS), '10000', 8))), asset: side === 'buy' ? native : pool.t.symbol, includedInQuotedOutput: true, note: `${DEX_FEE_BPS} bps pool fee (modeled)` },
    { kind: 'jgg', amount: '0', asset: native, includedInQuotedOutput: true, note: `${JGG_FEE_BPS} bps — JGG fee not configured` },
    { kind: 'token_tax', amount: `${tax} bps`, asset: side === 'buy' ? pool.t.symbol : native, includedInQuotedOutput: true, note: 'Token transfer tax observed by security check' },
    { kind: 'network', amount: NETWORK_FEE[chain], asset: native, includedInQuotedOutput: false, note: 'Modeled base network fee' },
    { kind: 'priority', amount: PRIORITY_FEE[chain], asset: native, includedInQuotedOutput: false, note: chain === 'solana' ? 'Modeled priority fee' : 'Included in gas estimate' },
  ];
  return { ok: true, quote: {
    chain, token, side, amountIn: amount, assetIn: side === 'buy' ? native : pool.t.symbol, expectedOut: D.str(D.rawToDec(outRaw, decimalsOut)), assetOut: side === 'buy' ? pool.t.symbol : native,
    minOut: D.str(D.rawToDec(minOutRaw, decimalsOut)), slippageBps, priceImpactBps: Math.max(0, impact), executionPriceUsd: D.str(D.rescale(execPrice, 12)),
    route: `paper:${pool.t.lifecycle === 'migrated' ? 'amm' : pool.t.launchpad + '-curve'}`, fees, quotedAt: now, expiresAt: now + ttlMs, model: PAPER_MODEL.id, decimalsOut,
  } };
}

/** Simulated execution. Fault injection is for tests only (T23/T24/T53). */
export type PaperFault = 'none' | 'timeout_after_dispatch' | 'revert' | 'expire';
export function paperExecute(q: PaperQuote, now: number, fault: PaperFault = 'none'):
  { outcome: 'filled'; filledOut: string; txRef: string; networkFee: string; latencyMs: number }
  | { outcome: 'uncertain'; txRef: string } | { outcome: 'failed'; reason: string; networkFee: string; txRef: string } {
  const txRef = 'paper_' + D.canonicalJson([q.chain, q.token, q.side, q.amountIn, q.quotedAt]).length.toString(36) + '_' + now.toString(36);
  if (fault === 'timeout_after_dispatch') return { outcome: 'uncertain', txRef };
  if (fault === 'revert') return { outcome: 'failed', reason: 'SIMULATED_REVERT_SLIPPAGE', networkFee: NETWORK_FEE[q.chain], txRef };
  if (fault === 'expire' || now > q.expiresAt) return { outcome: 'failed', reason: 'QUOTE_EXPIRED', networkFee: '0', txRef };
  const re = paperQuote(q.chain, q.token, q.side, q.amountIn, q.slippageBps, now);
  if (!re.ok) return { outcome: 'failed', reason: re.code, networkFee: '0', txRef };
  if (D.lt(re.quote.expectedOut, q.minOut)) return { outcome: 'failed', reason: 'MIN_OUT_NOT_MET', networkFee: NETWORK_FEE[q.chain], txRef };
  return { outcome: 'filled', filledOut: re.quote.expectedOut, txRef, networkFee: D.str(D.add(NETWORK_FEE[q.chain], PRIORITY_FEE[q.chain])), latencyMs: 400 + (now % 800) };
}

// ---------------- Provider registry (spec §8.2) ----------------
export type ProviderEntry = {
  id: string; interface: string; kind: 'fixture' | 'simulator' | 'live'; chains: string[]; status: 'available' | 'blocked_external' | 'unverified';
  auth: string; rateLimit: string; freshness: string; reason?: string; docs?: string; envVars?: string[];
};

export function providerRegistry(env: Record<string, string | undefined>, networkAvailable: boolean): ProviderEntry[] {
  const has = (k: string) => !!env[k];
  const live = (id: string, iface: string, chains: string[], vars: string[], docs: string, auth: string, rate: string): ProviderEntry => {
    const missing = vars.filter(v => !has(v));
    return { id, interface: iface, kind: 'live', chains, auth, rateLimit: rate, freshness: 'provider-defined', docs, envVars: vars,
      status: 'blocked_external',
      reason: missing.length ? `Missing configuration: ${missing.join(', ')}` : !networkAvailable ? 'Outbound network unavailable in this environment' : 'Contract not yet pinned/tested against current official docs (no adapter code calls an unverified endpoint)' };
  };
  return [
    { id: 'jgg-fixture', interface: 'MarketDataProvider+WalletAnalyticsProvider+SecurityProvider', kind: 'fixture', chains: ['solana', 'bsc', 'base', 'ethereum'], status: 'available', auth: 'none', rateLimit: 'local', freshness: 'deterministic demo clock' },
    { id: 'jgg-paper', interface: 'ExecutionProvider', kind: 'simulator', chains: ['solana', 'bsc', 'base', 'ethereum'], status: 'available', auth: 'tenant session', rateLimit: 'local', freshness: 'quote TTL 15s' },
    { id: 'gmgn', interface: 'MarketDataProvider (read-only via official gmgn-cli) — owner-selected', kind: 'live', chains: ['solana', 'bsc', 'base', 'ethereum'],
      auth: 'GMGN_API_KEY (from gmgn.ai/ai); swaps additionally need the Ed25519 request-signing key + IP whitelist — NOT used by JGG yet', rateLimit: 'leaky bucket rate 10/cap 10 (docs); JGG caps at 8 req/s and honours X-RateLimit-Reset',
      freshness: 'real-time per docs', docs: 'https://github.com/GMGNAI/gmgn-skills/blob/main/docs/cli-usage.md', envVars: ['GMGN_API_KEY', 'GMGN_CLI (optional path)'],
      status: has('GMGN_API_KEY') ? 'unverified' : 'blocked_external',
      reason: has('GMGN_API_KEY') ? 'Configured. Field mapping not yet confirmed against live samples — run scripts/verify-gmgn.mjs. Live execution stays disabled (T59).' : 'Missing configuration: GMGN_API_KEY (install gmgn-cli; IPv4 egress required per GMGN docs)' },
    live('solana-rpc', 'ChainReader (balances, slots, signatures)', ['solana'], ['JGG_SOLANA_RPC_HTTP', 'JGG_SOLANA_RPC_WS'], 'https://solana.com/docs/rpc', 'provider URL/key', 'plan-dependent'),
    live('jupiter-swap', 'ExecutionProvider (Solana routing)', ['solana'], ['JGG_JUPITER_API_KEY_REF'], 'https://developers.jup.ag/docs/swap', 'API key', 'plan-dependent'),
    live('evm-rpc', 'ChainReader (EVM)', ['bsc', 'base', 'ethereum'], ['JGG_EVM_RPC_BSC', 'JGG_EVM_RPC_BASE', 'JGG_EVM_RPC_ETHEREUM'], 'per-network provider', 'provider URL/key', 'plan-dependent'),
    live('signer-service', 'SignerProvider (policy-enforcing)', ['solana', 'bsc', 'base', 'ethereum'], ['JGG_SIGNER_PROVIDER_URL', 'JGG_SIGNER_POLICY_ID'], 'to be selected (spec §11.1)', 'scoped policy', 'n/a'),
    live('x-api', 'SocialProvider', ['*'], ['JGG_X_PROVIDER_TOKEN_REF'], 'X API terms', 'OAuth', 'plan-dependent'),
    live('6551-open', 'SocialProvider+NewsProvider', ['*'], ['JGG_NEWS_PROVIDER_KEY_REF'], '6551 OpenTwitter/OpenNews', 'API key', 'plan-dependent'),
    live('telegram-bot', 'NotificationProvider', ['*'], ['JGG_TELEGRAM_BOT_TOKEN_REF'], 'Telegram Bot API', 'bot token + authenticated binding', '30 msg/s global (Telegram FAQ; verify)'),
    live('llm', 'AI analysis adapter', ['*'], ['JGG_LLM_PROVIDER', 'JGG_LLM_MODEL', 'JGG_LLM_API_KEY_REF'], 'selected LLM vendor', 'API key (server only)', 'budgeted'),
    live('launchpads', 'LaunchProvider (pump.fun, FourMeme, Clanker, Flap)', ['solana', 'bsc', 'base'], ['JGG_LAUNCH_PROVIDER_CONFIG'], 'per-protocol official docs', 'wallet signature', 'n/a'),
    live('derivatives-venue', 'DerivativesProvider', ['*'], ['JGG_DERIVATIVES_PROVIDER_CONFIG'], 'venue not identified from S16 (spec §18.1)', 'venue account', 'n/a'),
    { ...live('up-down', 'Up/Down product', ['*'], ['JGG_UP_DOWN_PROVIDER_CONFIG'], 'product definition unknown (spec §18.3)', 'unknown', 'n/a'), reason: 'Product definition, settlement source and eligibility not established. No provider selected.' },
  ];
}
