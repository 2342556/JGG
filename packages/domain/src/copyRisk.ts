import { dec, add, sub, mul, div, gt, lte, cmp, str, min, isZero, type Dec } from './decimal.ts';

// ---------------- Copy trading (spec §13.2, fixture A07) ----------------

export type SourceSell = { sourcePreSellBalance: string | null; sourceSellQty: string };

/** Fraction sold by the source, from its known pre-sell inventory. */
export function sourceSellFraction(ev: SourceSell): { ok: true; fraction: Dec } | { ok: false; code: 'SOURCE_POSITION_UNKNOWN' } {
  if (ev.sourcePreSellBalance === null || !gt(ev.sourcePreSellBalance, '0')) return { ok: false, code: 'SOURCE_POSITION_UNKNOWN' };
  const f = div(ev.sourceSellQty, ev.sourcePreSellBalance, 18, 'trunc');
  return { ok: true, fraction: cmp(f, '1') > 0 ? dec('1') : f };
}

/** Applies the source fraction only to the task's own remaining lots. Other tasks untouched. */
export function followSell(taskHoldings: Record<string, string>, taskId: string, ev: SourceSell):
  { ok: true; sellQty: string; after: Record<string, string> } | { ok: false; code: 'SOURCE_POSITION_UNKNOWN' | 'TASK_HAS_NO_POSITION' } {
  const f = sourceSellFraction(ev);
  if (!f.ok) return f;
  const own = taskHoldings[taskId];
  if (own === undefined || !gt(own, '0')) return { ok: false, code: 'TASK_HAS_NO_POSITION' };
  const sellQty = mul(own, f.fraction);
  const after = { ...taskHoldings, [taskId]: str(sub(own, sellQty)) };
  return { ok: true, sellQty: str(sellQty), after };
}

export const copyDedupeKey = (taskId: string, sourceEventId: string, action: 'buy' | 'sell') => `${taskId}:${sourceEventId}:${action}`;

export type CopyBuyEvent = { sourceEventId: string; observedAt: number; sourceAmount: string; commitment: 'processed' | 'confirmed' | 'finalized' };
export type CopyBuyConfig = {
  sizing: { mode: 'fixed'; amount: string } | { mode: 'capped_source'; cap: string } | { mode: 'ratio'; ratio: string };
  maxEventAgeMs: number; minAmount: string; maxAmount: string; requireConfirmed: boolean;
};

export function copyBuyDecision(cfg: CopyBuyConfig, ev: CopyBuyEvent, now: number, seen: Set<string>, taskId: string):
  { action: 'buy'; amount: string } | { action: 'skip'; reason: string } {
  const key = copyDedupeKey(taskId, ev.sourceEventId, 'buy');
  if (seen.has(key)) return { action: 'skip', reason: 'DUPLICATE_SOURCE_EVENT' };
  if (cfg.requireConfirmed && ev.commitment === 'processed') return { action: 'skip', reason: 'EVENT_NOT_CONFIRMED' };
  if (now - ev.observedAt > cfg.maxEventAgeMs) return { action: 'skip', reason: 'STALE_SOURCE_EVENT' };
  let amount: Dec;
  if (cfg.sizing.mode === 'fixed') amount = dec(cfg.sizing.amount);
  else if (cfg.sizing.mode === 'capped_source') amount = min(ev.sourceAmount, cfg.sizing.cap);
  else amount = mul(ev.sourceAmount, cfg.sizing.ratio);
  if (cmp(amount, cfg.minAmount) < 0) return { action: 'skip', reason: 'BELOW_MIN_SIZE' };
  if (cmp(amount, cfg.maxAmount) > 0) amount = dec(cfg.maxAmount);
  return { action: 'buy', amount: str(amount) };
}

// ---------------- Risk budgets (spec §12.5) ----------------

export type RiskPolicy = {
  maxPerTrade: string; maxPerAssetExposure: string; maxDailyGrossBuy: string; maxRealizedDailyLoss: string;
  maxOpenPositions: number; maxSlippageBps: number; maxFeeQuote: string; maxDataAgeMs: number;
  allowedChains: string[]; entriesPaused: boolean; killSwitch: boolean; killSwitchVersion: number;
};
export type RiskUsage = { dailyGrossBuy: string; realizedDailyLoss: string; assetExposure: string; openPositions: number };
export type RiskCheckInput = { side: 'buy' | 'sell'; amountQuote: string; slippageBps: number; feeQuote: string; dataAgeMs: number; chain: string; riskReducing: boolean; policyVersionSeen: number };

export function checkRisk(p: RiskPolicy, u: RiskUsage, x: RiskCheckInput): { ok: true } | { ok: false; code: string } {
  if (p.killSwitch) return { ok: false, code: 'AUTOMATION_STOPPED' };
  if (x.policyVersionSeen !== p.killSwitchVersion) return { ok: false, code: 'POLICY_VERSION_CHANGED' };
  if (!p.allowedChains.includes(x.chain)) return { ok: false, code: 'CHAIN_NOT_ALLOWED' };
  if (x.dataAgeMs > p.maxDataAgeMs) return { ok: false, code: 'STALE_DATA' };
  if (x.slippageBps > p.maxSlippageBps) return { ok: false, code: 'SLIPPAGE_ABOVE_POLICY' };
  if (cmp(x.feeQuote, p.maxFeeQuote) > 0) return { ok: false, code: 'FEE_ABOVE_POLICY' };
  // Exits that reduce risk are not blocked by entry limits.
  if (x.side === 'sell' && x.riskReducing) return { ok: true };
  if (p.entriesPaused) return { ok: false, code: 'ENTRIES_PAUSED' };
  if (cmp(x.amountQuote, p.maxPerTrade) > 0) return { ok: false, code: 'BUDGET_EXCEEDED:PER_TRADE' };
  if (cmp(add(u.assetExposure, x.amountQuote), p.maxPerAssetExposure) > 0) return { ok: false, code: 'BUDGET_EXCEEDED:ASSET_EXPOSURE' };
  if (cmp(add(u.dailyGrossBuy, x.amountQuote), p.maxDailyGrossBuy) > 0) return { ok: false, code: 'BUDGET_EXCEEDED:DAILY_BUY' };
  if (cmp(u.realizedDailyLoss, p.maxRealizedDailyLoss) >= 0) return { ok: false, code: 'BUDGET_EXCEEDED:DAILY_LOSS' };
  if (u.openPositions >= p.maxOpenPositions) return { ok: false, code: 'BUDGET_EXCEEDED:OPEN_POSITIONS' };
  return { ok: true };
}

/** Deny-by-default policy: nothing is allowed until the user configures limits. */
export const DENY_ALL_POLICY: RiskPolicy = {
  maxPerTrade: '0', maxPerAssetExposure: '0', maxDailyGrossBuy: '0', maxRealizedDailyLoss: '0', maxOpenPositions: 0,
  maxSlippageBps: 0, maxFeeQuote: '0', maxDataAgeMs: 0, allowedChains: [], entriesPaused: true, killSwitch: false, killSwitchVersion: 1,
};

// ---------------- Idempotency (spec §10) ----------------

/** Stable canonical JSON (sorted keys) for payload hashing. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

// ---------------- Multi-wallet batch (spec §11.6, T33) ----------------

export type ChildStatus = 'pending' | 'succeeded' | 'failed' | 'skipped' | 'uncertain';
export type BatchChild = { walletId: string; amount: string; status: ChildStatus; attempts: number };

export function summarizeBatch(children: BatchChild[]) {
  const c = { succeeded: 0, pending: 0, failed: 0, skipped: 0, uncertain: 0 };
  for (const ch of children) c[ch.status]++;
  return { ...c, total: children.length, atomic: false as const };
}

/** Retry targets unresolved eligible children only: never succeeded or uncertain ones. */
export const retryableChildren = (children: BatchChild[], maxAttempts: number) =>
  children.filter(ch => ch.status === 'failed' && ch.attempts < maxAttempts);

export function validateBatch(children: { walletId: string; amount: string }[]): void {
  if (children.length === 0 || children.length > 100) throw new Error('BATCH_SIZE_OUT_OF_RANGE');
  const seen = new Set<string>();
  for (const c of children) {
    if (seen.has(c.walletId)) throw new Error('DUPLICATE_WALLET_IN_BATCH');
    seen.add(c.walletId);
    if (!gt(c.amount, '0')) throw new Error('CHILD_AMOUNT_INVALID');
  }
}

export { isZero, lte };
