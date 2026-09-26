// JGG shared runtime contracts. One source for validation (server) and JSON-schema display (client).

// ---------------- Minimal runtime schema library ----------------
export type Issue = { path: string; message: string };
export type Schema<T> = {
  kind: string;
  parse(v: unknown, path?: string): { ok: true; value: T } | { ok: false; issues: Issue[] };
  json(): Record<string, unknown>;
  optional(): Schema<T | undefined>;
  describe(d: string): Schema<T>;
};
export type Infer<S> = S extends Schema<infer T> ? T : never;

function make<T>(kind: string, check: (v: unknown, path: string) => { ok: true; value: T } | { ok: false; issues: Issue[] }, json: () => Record<string, unknown>): Schema<T> {
  let desc: string | undefined;
  const s: Schema<T> = {
    kind,
    parse: (v, path = '$') => check(v, path),
    json: () => ({ ...json(), ...(desc ? { description: desc } : {}) }),
    optional: () => make<T | undefined>(kind, (v, p) => (v === undefined ? { ok: true, value: undefined } : check(v, p)), () => ({ ...s.json(), optional: true })),
    describe: (d: string) => { desc = d; return s; },
  };
  return s;
}
const fail = (path: string, message: string) => ({ ok: false as const, issues: [{ path, message }] });

export const v = {
  string: (o: { min?: number; max?: number; pattern?: RegExp } = {}) => make<string>('string', (x, p) => {
    if (typeof x !== 'string') return fail(p, 'expected string');
    if (o.min !== undefined && x.length < o.min) return fail(p, `min length ${o.min}`);
    if (o.max !== undefined && x.length > o.max) return fail(p, `max length ${o.max}`);
    if (o.pattern && !o.pattern.test(x)) return fail(p, 'invalid format');
    return { ok: true, value: x };
  }, () => ({ type: 'string', ...o, pattern: o.pattern?.source })),
  /** Decimal string; exact, never a JS number. */
  decimal: (o: { positive?: boolean; nonNegative?: boolean } = {}) => make<string>('decimal', (x, p) => {
    if (typeof x !== 'string' || !/^\d+(\.\d+)?$/.test(x)) return fail(p, 'expected non-negative decimal string');
    if (o.positive && /^0+(\.0+)?$/.test(x)) return fail(p, 'must be > 0');
    return { ok: true, value: x };
  }, () => ({ type: 'string', format: 'decimal', ...o })),
  rawAmount: () => make<string>('raw', (x, p) => (typeof x === 'string' && /^\d+$/.test(x) && x.length <= 78 ? { ok: true, value: x } : fail(p, 'expected base-10 integer string')), () => ({ type: 'string', format: 'raw-integer' })),
  int: (o: { min?: number; max?: number } = {}) => make<number>('int', (x, p) => {
    if (typeof x !== 'number' || !Number.isInteger(x)) return fail(p, 'expected integer');
    if (o.min !== undefined && x < o.min) return fail(p, `min ${o.min}`);
    if (o.max !== undefined && x > o.max) return fail(p, `max ${o.max}`);
    return { ok: true, value: x };
  }, () => ({ type: 'integer', ...o })),
  boolean: () => make<boolean>('boolean', (x, p) => (typeof x === 'boolean' ? { ok: true, value: x } : fail(p, 'expected boolean')), () => ({ type: 'boolean' })),
  enum: <const E extends readonly string[]>(vals: E) => make<E[number]>('enum', (x, p) => (typeof x === 'string' && vals.includes(x) ? { ok: true, value: x as E[number] } : fail(p, `expected one of ${vals.join('|')}`)), () => ({ type: 'string', enum: [...vals] })),
  array: <T>(item: Schema<T>, o: { min?: number; max?: number } = {}) => make<T[]>('array', (x, p) => {
    if (!Array.isArray(x)) return fail(p, 'expected array');
    if (o.min !== undefined && x.length < o.min) return fail(p, `min items ${o.min}`);
    if (o.max !== undefined && x.length > o.max) return fail(p, `max items ${o.max}`);
    const out: T[] = []; const issues: Issue[] = [];
    x.forEach((e, i) => { const r = item.parse(e, `${p}[${i}]`); r.ok ? out.push(r.value) : issues.push(...r.issues); });
    return issues.length ? { ok: false, issues } : { ok: true, value: out };
  }, () => ({ type: 'array', items: item.json(), ...o })),
  object: <S extends Record<string, Schema<any>>>(shape: S, o: { strict?: boolean } = { strict: true }) =>
    make<{ [K in keyof S]: Infer<S[K]> }>('object', (x, p) => {
      if (typeof x !== 'object' || x === null || Array.isArray(x)) return fail(p, 'expected object');
      const out: Record<string, unknown> = {}; const issues: Issue[] = [];
      for (const [k, sch] of Object.entries(shape)) {
        const r = sch.parse((x as Record<string, unknown>)[k], `${p}.${k}`);
        if (r.ok) { if (r.value !== undefined) out[k] = r.value; } else issues.push(...r.issues);
      }
      if (o.strict !== false) for (const k of Object.keys(x)) if (!(k in shape)) issues.push({ path: `${p}.${k}`, message: 'unknown field' });
      return issues.length ? { ok: false, issues } : { ok: true, value: out as any };
    }, () => ({ type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, s.json()])),
      required: Object.entries(shape).filter(([, s]) => !s.json().optional).map(([k]) => k) })),
};

// ---------------- Chains and identity ----------------
export const CHAINS = ['solana', 'bsc', 'base', 'ethereum'] as const;
export type Chain = typeof CHAINS[number];
export const CHAIN_META: Record<Chain, { namespace: 'solana' | 'eip155'; chainId: string; network: string; native: string; label: string; explorerTx: string; explorerAddr: string; feeUnit: string }> = {
  solana: { namespace: 'solana', chainId: 'mainnet-beta', network: 'mainnet', native: 'SOL', label: 'SOL', explorerTx: 'https://solscan.io/tx/', explorerAddr: 'https://solscan.io/account/', feeUnit: 'micro-lamports per CU (priority)' },
  bsc: { namespace: 'eip155', chainId: '56', network: 'mainnet', native: 'BNB', label: 'BSC', explorerTx: 'https://bscscan.com/tx/', explorerAddr: 'https://bscscan.com/address/', feeUnit: 'gwei' },
  base: { namespace: 'eip155', chainId: '8453', network: 'mainnet', native: 'ETH', label: 'Base', explorerTx: 'https://basescan.org/tx/', explorerAddr: 'https://basescan.org/address/', feeUnit: 'gwei' },
  ethereum: { namespace: 'eip155', chainId: '1', network: 'mainnet', native: 'ETH', label: 'ETH', explorerTx: 'https://etherscan.io/tx/', explorerAddr: 'https://etherscan.io/address/', feeUnit: 'gwei' },
};
export const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
export function isValidAddress(chain: Chain, a: string): boolean {
  return CHAIN_META[chain].namespace === 'solana' ? SOLANA_ADDR.test(a) : EVM_ADDR.test(a);
}
/** Canonical identity key. Solana preserves case; EVM lower-cased for identity (display keeps original). */
export function assetKey(chain: Chain, address: string): string {
  return `${chain}:${CHAIN_META[chain].namespace === 'eip155' ? address.toLowerCase() : address}`;
}

// ---------------- Statuses, modes, errors ----------------
export const DATA_STATUS = ['live', 'delayed', 'stale', 'unknown', 'unavailable', 'simulated'] as const;
export type DataStatus = typeof DATA_STATUS[number];
export const MODES = ['demo', 'live_readonly', 'paper', 'live'] as const;
export type Mode = typeof MODES[number];
export const MODE_LABEL: Record<Mode, string> = { demo: 'Demo', live_readonly: 'Live read-only', paper: 'Paper trading', live: 'Live trading' };
export const CAPABILITY_STATUS = ['not_started', 'in_progress', 'implemented_demo', 'implemented_paper', 'implemented_live_unverified', 'verified_live', 'blocked_external', 'unsupported_by_selected_provider'] as const;
export type CapabilityStatus = typeof CAPABILITY_STATUS[number];

export const ERROR_CODES = ['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'CHAIN_UNSUPPORTED', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'STALE_DATA',
  'QUOTE_EXPIRED', 'INSUFFICIENT_BALANCE', 'BUDGET_EXCEEDED', 'POLICY_DENIED', 'APPROVAL_REQUIRED', 'DUPLICATE_REQUEST', 'IDEMPOTENCY_KEY_REUSED',
  'TRANSACTION_UNCERTAIN', 'CANCEL_TOO_LATE', 'UNKNOWN_COST_BASIS', 'MODE_MISMATCH', 'INVALID_TRANSITION', 'VERSION_CONFLICT', 'AUTOMATION_STOPPED',
  'CAPABILITY_BLOCKED', 'INTERNAL'] as const;
export type ErrorCode = typeof ERROR_CODES[number];
export type ErrorEnvelope = { error: { code: ErrorCode; message: string; retryable: boolean; correlationId: string; details?: unknown } };

export type Provenance = { status: DataStatus; source: string; asOf: string; coverage?: string; warnings?: string[] };
export type Envelope<T> = { data: T; meta: Provenance };

export type StreamEvent<T> = {
  schemaVersion: 1; eventId: string; topic: string; sequence: string; occurredAt: string; receivedAt: string;
  chain?: string; entityId: string; status: DataStatus; source: string; data: T;
};

// ---------------- Request schemas (API) ----------------
export const chainSchema = v.enum(CHAINS);
export const quoteRequest = v.object({
  chain: chainSchema, tokenAddress: v.string({ min: 32, max: 44 }), side: v.enum(['buy', 'sell'] as const),
  amount: v.decimal({ positive: true }).describe('Input amount: native for buy, token for sell'),
  slippageBps: v.int({ min: 1, max: 5000 }), explicitHighSlippage: v.boolean().optional(), walletId: v.string({ min: 1, max: 64 }),
});
export const intentRequest = v.object({
  quoteId: v.string({ min: 1, max: 64 }), source: v.enum(['manual', 'quick_buy', 'ai_proposal', 'strategy', 'copy'] as const),
});
export const watchlistCreate = v.object({ name: v.string({ min: 1, max: 40 }) });
export const watchlistItem = v.object({ chain: chainSchema, address: v.string({ min: 32, max: 44 }), note: v.string({ max: 200 }).optional() });
export const presetSchema = v.object({
  slot: v.enum(['P1', 'P2', 'P3'] as const), chain: chainSchema,
  buyAmounts: v.array(v.decimal({ positive: true }), { min: 1, max: 6 }), slippageBps: v.int({ min: 1, max: 5000 }),
  maxFee: v.decimal(), mevProtect: v.boolean(), exitTemplate: v.enum(['none', 'tp_sl_basic', 'trailing_tp', 'trailing_sl'] as const),
});
// Exit plan (owner spec 2026-09-26). Percentages are decimal strings; ranges and cross-rule rules are checked by domain validateExitConfig.
const pctStr = v.string({ min: 1, max: 12, pattern: /^\d{1,6}(\.\d{1,4})?$/ });
export const exitConfigSchema = v.object({
  stopLoss: v.object({ enabled: v.boolean(), pct: pctStr }),
  partialTp: v.object({ enabled: v.boolean(), triggerPct: pctStr, sellPct: pctStr }),
  trailing: v.object({ enabled: v.boolean(), pct: pctStr, activation: v.enum(['after_partial', 'at_gain', 'immediate'] as const), activationGainPct: pctStr.optional() }),
});
export const exitPresetSave = v.object({ name: v.string({ min: 1, max: 40, pattern: /^[\p{L}\p{N} ._\-]+$/u }), config: exitConfigSchema, version: v.int({ min: 0 }).optional() });
export const exitPreview = v.object({ config: exitConfigSchema, chain: chainSchema, tokenAddress: v.string({ min: 32, max: 44 }).optional(), walletId: v.string({ min: 1, max: 64 }).optional(), amount: v.decimal({ positive: true }).optional(), strategyId: v.string({ min: 1, max: 64 }).optional() });
export const exitOverride = v.object({ config: exitConfigSchema, version: v.int({ min: 0 }) });
export const strategyCreate = v.object({
  kind: v.enum(['limit_buy', 'limit_sell', 'tp_sl', 'trailing_tp', 'trailing_sl', 'limit_buy_tp_sl', 'copy', 'migration_buy', 'dev_sell_exit', 'dev_snipe', 'token_snipe', 'snipex', 'auto_trader', 'position_exit'] as const),
  chain: chainSchema, tokenAddress: v.string({ min: 32, max: 44 }).optional(), walletId: v.string({ min: 1, max: 64 }),
  params: v.object({
    targetPrice: v.decimal({ positive: true }).optional(), amount: v.decimal({ positive: true }).optional(),
    activation: v.decimal().optional(), retracement: v.decimal().optional(),
    stages: v.array(v.object({ percentBps: v.int({ min: 1, max: 10000 }), gain: v.decimal({ positive: true }) }), { max: 6 }).optional(),
    stopLoss: v.decimal().optional(), expiresInSec: v.int({ min: 60, max: 30 * 86400 }).optional(),
    sourceWallet: v.string({ min: 32, max: 44 }).optional(), sizing: v.enum(['fixed', 'capped_source', 'ratio'] as const).optional(),
    ratio: v.decimal().optional(), sellMode: v.enum(['follow_source', 'manual', 'jgg_exits'] as const).optional(),
    maxEventAgeSec: v.int({ min: 1, max: 3600 }).optional(), creatorWallet: v.string({ min: 32, max: 44 }).optional(),
    minScore: v.int({ min: 0, max: 100 }).optional(), maxPositions: v.int({ min: 1, max: 20 }).optional(), scanEverySec: v.int({ min: 5, max: 3600 }).optional(),
    partialBps: v.int({ min: 0, max: 9900 }).optional(), trailActivation: v.decimal({ positive: true }).optional(), tpGain: v.decimal({ positive: true }).optional(),
    maxAmount: v.decimal({ positive: true }).optional(), exit: exitConfigSchema.optional(),
  }, { strict: true }),
});
export const alertCreate = v.object({
  name: v.string({ min: 1, max: 60 }), chain: chainSchema, kind: v.enum(['price_swing', 'smart_buy_cluster', 'smart_exit', 'surge', 'dev_sell', 'wallet_trade'] as const),
  thresholdBps: v.int({ min: 1, max: 100000 }).optional(), windowSec: v.int({ min: 60, max: 86400 }), cooldownSec: v.int({ min: 0, max: 86400 }),
  destination: v.enum(['in_app', 'browser_push', 'telegram'] as const), watchlistId: v.string().optional(),
});
export const launchCreate = v.object({
  launchpad: v.enum(['pumpfun', 'fourmeme', 'clanker', 'fourmeme_tax', 'pumpfun_special', 'flap_tax'] as const),
  name: v.string({ min: 1, max: 32 }), symbol: v.string({ min: 1, max: 10, pattern: /^[A-Za-z0-9]+$/ }), description: v.string({ max: 500 }),
  website: v.string({ max: 200, pattern: /^https:\/\/[^\s]+$/ }).optional(), twitter: v.string({ max: 200, pattern: /^https:\/\/(x|twitter)\.com\/[^\s]+$/ }).optional(),
  initialBuy: v.decimal().optional(), buyTaxBps: v.int({ min: 0, max: 1000 }).optional(), sellTaxBps: v.int({ min: 0, max: 1000 }).optional(),
  walletId: v.string({ min: 1, max: 64 }),
});
