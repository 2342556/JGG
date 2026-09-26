// GMGN provider (owner-selected, 2026-09-25). Integration path: the official `gmgn-cli` (npm, MIT, provenance-signed),
// using ONLY commands/flags documented in github.com/GMGNAI/gmgn-skills docs/cli-usage.md. No private web endpoints.
// Status: SUPPORTED by docs, NOT yet VERIFIED against live responses (no network in the build env).
// Run `node scripts/verify-gmgn.mjs` on a networked machine to capture real samples and confirm the field mapping.
import { spawn } from 'node:child_process';
import type { FinderInput, Tri } from '../../domain/src/index.ts';

export type GmgnChain = 'sol' | 'bsc' | 'base' | 'eth';
export const GMGN_CHAIN: Record<string, GmgnChain> = { solana: 'sol', bsc: 'bsc', base: 'base', ethereum: 'eth' };
export class GmgnError extends Error { code: string; retryAfterMs?: number; constructor(code: string, msg: string, retryAfterMs?: number) { super(msg); this.code = code; this.retryAfterMs = retryAfterMs; } }

// ---------------- Argument builders (pure; unit-tested) ----------------
export function trendingArgs(o: { chain: GmgnChain; interval: '1m' | '5m' | '1h' | '6h' | '24h'; limit?: number; orderBy?: string; filters?: string[]; min?: Record<string, number>; max?: Record<string, number>; maxCreated?: string }) {
  const a = ['market', 'trending', '--chain', o.chain, '--interval', o.interval, '--limit', String(Math.min(o.limit ?? 100, 100))];
  if (o.orderBy) a.push('--order-by', o.orderBy);
  for (const f of o.filters ?? []) a.push('--filter', f);
  for (const [k, v] of Object.entries(o.min ?? {})) a.push(`--min-${k}`, String(v));
  for (const [k, v] of Object.entries(o.max ?? {})) a.push(`--max-${k}`, String(v));
  if (o.maxCreated) { if (!/^\d+[mhd]$/.test(o.maxCreated)) throw new GmgnError('BAD_ARGS', 'maxCreated needs m/h/d suffix'); a.push('--max-created', o.maxCreated); }
  return [...a, '--raw'];
}
export const trenchesArgs = (chain: GmgnChain, types: ('new_creation' | 'near_completion' | 'completed')[] = ['new_creation', 'near_completion', 'completed']) =>
  ['market', 'trenches', '--chain', chain, ...types.flatMap(t => ['--type', t]), '--raw'];
export const tokenArgs = (kind: 'info' | 'security' | 'pool' | 'holders' | 'traders', chain: GmgnChain, address: string) => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$|^0x[0-9a-fA-F]{40}$/.test(address)) throw new GmgnError('BAD_ARGS', 'Invalid token address');
  return ['token', kind, '--chain', chain, '--address', address, '--raw'];
};
export const klineArgs = (chain: GmgnChain, address: string, resolution: string, fromSec?: number, toSec?: number) =>
  ['market', 'kline', '--chain', chain, '--address', address, '--resolution', resolution, ...(fromSec ? ['--from', String(fromSec)] : []), ...(toSec ? ['--to', String(toSec)] : []), '--raw'];
export const smartMoneyArgs = (chain: GmgnChain, side?: 'buy' | 'sell', limit = 100) => ['track', 'smartmoney', '--chain', chain, '--limit', String(limit), ...(side ? ['--side', side] : []), '--raw'];

/** Documented condition-order JSON for `swap --condition-orders` (fields: order_type, side, price_scale, sell_ratio only).
 *  Trailing is NOT expressed here: its GMGN parameters are not documented, so JGG keeps trailing in its own worker. */
export function conditionOrders(e: { stages: { percentBps: number; gain: string }[]; stopLoss?: string }) {
  const pct = (fraction: string) => String(Math.round(Number(fraction) * 100));
  const out = e.stages.map(s => ({ order_type: 'profit_stop', side: 'sell', price_scale: pct(s.gain), sell_ratio: String(s.percentBps / 100) }));
  if (e.stopLoss) out.push({ order_type: 'loss_stop', side: 'sell', price_scale: pct(e.stopLoss), sell_ratio: '100' });
  return out; // used with --sell-ratio-type buy_amount (each ratio is of the ORIGINAL bought amount)
}
/** Builds (never runs) a live swap command. Live execution stays blocked until: signer/API key with IP whitelist,
 *  GMGN_ALLOW_AUTOMATED_TRADES=1 for unattended use, and the owner's explicit funded-test authorization (T59). */
export function swapArgs(o: { chain: GmgnChain; from: string; inputToken: string; outputToken: string; amountRaw?: string; percent?: number; slippagePct: number; conditions?: ReturnType<typeof conditionOrders>; antiMev?: boolean }) {
  if (!!o.amountRaw === (o.percent !== undefined)) throw new GmgnError('BAD_ARGS', 'Exactly one of amountRaw / percent');
  if (o.amountRaw && !/^\d+$/.test(o.amountRaw)) throw new GmgnError('BAD_ARGS', 'amountRaw must be an integer in the smallest unit');
  if (!(Number.isInteger(o.slippagePct) && o.slippagePct >= 0 && o.slippagePct <= 100)) throw new GmgnError('BAD_ARGS', 'slippage is an integer percent 0–100');
  const a = ['swap', '--chain', o.chain, '--from', o.from, '--input-token', o.inputToken, '--output-token', o.outputToken,
    ...(o.amountRaw ? ['--amount', o.amountRaw] : ['--percent', String(o.percent)]), '--slippage', String(o.slippagePct)];
  if (o.antiMev !== false) a.push('--anti-mev');
  if (o.conditions?.length) a.push('--condition-orders', JSON.stringify(o.conditions), '--sell-ratio-type', 'buy_amount');
  return [...a, '--raw'];
}

// ---------------- Runner: rate limit (GMGN: leaky bucket rate=10 cap=10), timeouts, error mapping ----------------
let nextSlot = 0; let bannedUntil = 0;
const MIN_GAP_MS = 125; // ≤ 8 req/s, below the documented 10/s
export async function runGmgn(args: string[], env: Record<string, string | undefined>, timeoutMs = 10_000): Promise<any> {
  if (!env.GMGN_API_KEY) throw new GmgnError('NOT_CONFIGURED', 'GMGN_API_KEY is not set');
  if (args[0] === 'swap' || args[0] === 'multi-swap' || (args[0] === 'order' && args[1] === 'strategy') || args[0] === 'cooking') throw new GmgnError('EXECUTION_BLOCKED', 'Live GMGN execution is disabled in this build (T59 authorization required).');
  const now = Date.now();
  if (now < bannedUntil) throw new GmgnError('RATE_LIMITED', 'GMGN cooldown in effect', bannedUntil - now);
  const wait = Math.max(0, nextSlot - now); nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait) await new Promise(r => setTimeout(r, wait));
  return await new Promise((resolve, reject) => {
    const p = spawn(env.GMGN_CLI ?? 'gmgn-cli', args, { env: { PATH: env.PATH, HOME: env.HOME, GMGN_API_KEY: env.GMGN_API_KEY }, stdio: ['ignore', 'pipe', 'pipe'] }); // private key deliberately NOT passed: read-only
    let out = ''; let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new GmgnError('TIMEOUT', `gmgn-cli timed out after ${timeoutMs}ms`)); }, timeoutMs);
    p.stdout.on('data', (d: any) => { out += d; if (out.length > 20_000_000) p.kill('SIGKILL'); });
    p.stderr.on('data', (d: any) => { err += d; });
    p.on('error', (e: any) => { clearTimeout(t); reject(new GmgnError('CLI_MISSING', `gmgn-cli not runnable: ${e.message}. Install: npm install -g gmgn-cli`)); });
    p.on('close', (code: number) => {
      clearTimeout(t);
      const text = (out || err).trim();
      const m = /(RATE_LIMIT_\w+|ERROR_RATE_LIMIT_BLOCKED|AUTH_\w+|CHAIN_NOT_SUPPORTED|BAD_REQUEST|INTERNAL_API_UNAVAILABLE|INTERNAL_ERROR)/.exec(text);
      if (code !== 0 || m) {
        if (m && m[1].includes('RATE_LIMIT')) { const reset = /reset\D{0,20}(\d{10})/i.exec(text); const ms = reset ? Number(reset[1]) * 1000 - Date.now() : 10_000; bannedUntil = Date.now() + Math.max(ms, 1000); return reject(new GmgnError('RATE_LIMITED', 'GMGN rate limit', Math.max(ms, 1000))); }
        return reject(new GmgnError(m?.[1] ?? 'CLI_ERROR', text.slice(0, 300) || `exit ${code}`));
      }
      try { resolve(JSON.parse(text)); } catch { reject(new GmgnError('BAD_RESPONSE', 'gmgn-cli did not return JSON (use --raw)')); }
    });
  });
}

// ---------------- Mapping RankItem → FinderInput (tolerant; unknown stays null) ----------------
const pick = (o: any, keys: string[]): any => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return null; };
const n = (v: any): number | null => { if (v === null || v === undefined || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
/** GMGN rates may be fractions (0.12) or percents (12): normalise to basis points; values > 1 treated as percent. */
const rateBps = (v: any): number | null => { const x = n(v); return x === null ? null : Math.round((x <= 1 ? x * 10_000 : x * 100)); };

export function mapRankItem(it: any, opts: { requestedFilters?: string[]; nowSec?: number } = {}): FinderInput & { unmapped: string[] } {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const created = n(pick(it, ['creation_timestamp', 'open_timestamp', 'created_timestamp']));
  const hp = pick(it, ['is_honeypot', 'honeypot']);
  const honeypot: Tri = hp !== null ? (hp && hp !== '0' ? 'risky' : 'safe') : (opts.requestedFilters ?? []).includes('not_honeypot') ? 'safe' : 'unknown'; // provider-attested via server-side filter
  const renounced = pick(it, ['renounced_mint', 'renounced']); const frozen = pick(it, ['renounced_freeze_account', 'frozen']);
  const out: FinderInput & { unmapped: string[] } = {
    address: String(pick(it, ['address', 'token_address']) ?? ''), symbol: String(pick(it, ['symbol']) ?? '?'),
    ageMin: created === null ? null : Math.max(0, Math.floor((nowSec - created) / 60)),
    liquidityUsd: n(pick(it, ['liquidity'])), marketCapUsd: n(pick(it, ['market_cap', 'marketcap'])), volume1hUsd: n(pick(it, ['volume'])),
    holders: n(pick(it, ['holder_count', 'holders'])), buys1h: n(pick(it, ['buys'])), sells1h: n(pick(it, ['sells'])),
    change5mBps: rateBps(pick(it, ['price_change_percent5m', 'change5m'])), change1hBps: rateBps(pick(it, ['price_change_percent1h', 'change1h', 'price_change_percent'])),
    smartMoney: n(pick(it, ['smart_degen_count'])), kols: n(pick(it, ['renowned_count', 'renowned_wallets'])),
    top10Bps: rateBps(pick(it, ['top_10_holder_rate', 'top10_holder_rate'])), devHoldingBps: rateBps(pick(it, ['dev_team_hold_rate', 'creator_hold_rate'])),
    insiderBps: rateBps(pick(it, ['suspected_insider_hold_rate', 'insider_rate', 'rat_trader_amount_rate'])), bundleBps: rateBps(pick(it, ['bundler_trader_amount_rate', 'bundler_rate'])),
    snipers: n(pick(it, ['sniper_count'])), honeypot,
    mintAuthority: renounced === null ? 'unknown' : renounced ? 'safe' : 'risky', freezeAuthority: frozen === null ? 'unknown' : frozen ? 'safe' : 'risky',
    rugRatio: n(pick(it, ['rug_ratio'])), ddVerdict: null, ddScore: null, unmapped: [],
  };
  for (const k of ['ageMin', 'liquidityUsd', 'volume1hUsd', 'holders', 'smartMoney', 'top10Bps', 'change1hBps'] as const) if (out[k] === null) out.unmapped.push(k);
  return out;
}
