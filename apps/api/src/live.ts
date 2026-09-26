// JGG standalone live data (Option B): our own pump.fun indexer over a Solana RPC, plus Jupiter Price for SOL/USD
// (and price-only estimates for graduated tokens). No GMGN. Solana only in v1.
import { type DB, tx, q1, qa, run } from './db.ts';
import * as D from '../../../packages/domain/src/index.ts';
import * as P from '../../../packages/providers/src/solana/pump.ts';
import type { Rpc } from '../../../packages/providers/src/solana/rpc.ts';
import { type MarketSource, type QuoteResult, type PriceObs, NETWORK_FEE, PRIORITY_FEE } from '../../../packages/providers/src/execution.ts';
import type { Chain } from '../../../packages/contracts/src/index.ts';

export const LIVE_MODEL = { id: 'jgg-pump-curve-v1', description: 'Paper fills on the live pump.fun bonding curve: x*y=k on virtual reserves from the latest indexed TradeEvent, fee = latest observed protocol+creator bps (fallback 125 bps, flagged).' };
const DEFAULT_FEE_BPS = 125n;
const SUPPLY = P.PUMP_DEFAULTS.tokenTotalSupply;

// ---------------- Ingestion ----------------
export type IngestStats = { notifications: number; failedTx: number; events: number; trades: number; creates: number; completes: number; dupes: number; decodeErrors: number; txFetchQueued: number; modelChecks: number; modelMismatches: number };
export const newStats = (): IngestStats => ({ notifications: 0, failedTx: 0, events: 0, trades: 0, creates: 0, completes: 0, dupes: 0, decodeErrors: 0, txFetchQueued: 0, modelChecks: 0, modelMismatches: 0 });

/** Handle one logsNotification value. Returns true when logs had pump instructions but no decodable events (→ fetch tx for emit_cpi events). */
export function ingestLogs(db: DB, v: { signature: string; err: unknown; logs: string[] }, slot: number, receivedAt: number, st: IngestStats): boolean {
  st.notifications++;
  if (v.err !== null && v.err !== undefined) { st.failedTx++; return false; }
  let events: P.PumpEvent[] = [];
  try { events = P.eventsFromLogs(v.logs ?? []); } catch { st.decodeErrors++; }
  if (events.length) { applyEvents(db, v.signature, slot, events, receivedAt, st); return false; }
  const pumpIx = (v.logs ?? []).some(l => /^Program log: Instruction: (Buy|Sell|Create|BuyExactQuoteIn|BuyV2|SellV2|CreateV2)/i.test(l));
  if (pumpIx) st.txFetchQueued++;
  return pumpIx;
}
export function ingestTransaction(db: DB, sig: string, txr: any, receivedAt: number, st: IngestStats) {
  const events = P.eventsFromTransaction(txr);
  if (events.length) applyEvents(db, sig, txr?.slot ?? 0, events, receivedAt, st);
}

export function applyEvents(db: DB, sig: string, slot: number, events: P.PumpEvent[], receivedAt: number, st: IngestStats) {
  tx(db, () => {
    let i = 0;
    for (const e of events) {
      st.events++;
      if (e.type === 'create') {
        st.creates++;
        run(db, `INSERT INTO live_tokens (mint, name, symbol, uri, creator, bonding_curve, created_at, created_sig, v_sol, v_tok, r_sol, r_tok, first_seen_at, seen_from_creation, last_trade_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, 1, ?)
          ON CONFLICT(mint) DO UPDATE SET name = excluded.name, symbol = excluded.symbol, uri = excluded.uri, creator = excluded.creator, bonding_curve = excluded.bonding_curve, created_sig = excluded.created_sig, created_at = MIN(live_tokens.created_at, excluded.created_at), seen_from_creation = 1`,
          e.mint, clean(e.name, 64), clean(e.symbol, 16), clean(e.uri, 300), e.creator ?? e.user, e.bondingCurve, receivedAt, sig,
          String(P.PUMP_DEFAULTS.initialVirtualSolReserves), String(P.PUMP_DEFAULTS.initialVirtualTokenReserves), String(P.PUMP_DEFAULTS.initialRealTokenReserves), receivedAt, receivedAt); // reserves are exactly known at creation
      } else if (e.type === 'trade') {
        const ts = e.timestamp > 0n && e.timestamp < 4_102_444_800n ? Number(e.timestamp) * 1000 : receivedAt;
        const ins = run(db, `INSERT OR IGNORE INTO live_trades (sig, idx, mint, wallet, is_buy, sol, tok, v_sol, v_tok, ts, slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sig, i, e.mint, e.user, e.isBuy ? 1 : 0, String(e.solAmount), String(e.tokenAmount), String(e.virtualSolReserves), String(e.virtualTokenReserves), ts, slot);
        if (Number(ins.changes) === 0) { st.dupes++; i++; continue; }
        st.trades++;
        const fee = e.feeBasisPoints !== null ? Number(e.feeBasisPoints + (e.creatorFeeBasisPoints ?? 0n)) : null;
        run(db, `INSERT INTO live_tokens (mint, created_at, v_sol, v_tok, r_sol, r_tok, state_slot, fee_bps, last_trade_at, first_seen_at, seen_from_creation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(mint) DO UPDATE SET
            v_sol = CASE WHEN excluded.state_slot >= live_tokens.state_slot THEN excluded.v_sol ELSE live_tokens.v_sol END,
            v_tok = CASE WHEN excluded.state_slot >= live_tokens.state_slot THEN excluded.v_tok ELSE live_tokens.v_tok END,
            r_sol = CASE WHEN excluded.state_slot >= live_tokens.state_slot THEN excluded.r_sol ELSE live_tokens.r_sol END,
            r_tok = CASE WHEN excluded.state_slot >= live_tokens.state_slot THEN excluded.r_tok ELSE live_tokens.r_tok END,
            state_slot = MAX(live_tokens.state_slot, excluded.state_slot),
            fee_bps = COALESCE(excluded.fee_bps, live_tokens.fee_bps),
            last_trade_at = MAX(COALESCE(live_tokens.last_trade_at, 0), excluded.last_trade_at)`,
          e.mint, ts, String(e.virtualSolReserves), String(e.virtualTokenReserves), String(e.realSolReserves), String(e.realTokenReserves), slot, fee, ts, receivedAt);
        const err = P.curveModelError(e);
        if (err !== null) { st.modelChecks++; if (err > 0.001) st.modelMismatches++; }
      } else if (e.type === 'complete') {
        st.completes++;
        run(db, `UPDATE live_tokens SET complete = 1 WHERE mint = ?`, e.mint);
      }
      i++;
    }
  });
}
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);

// ---------------- Enrichment (security + concentration) via standard RPC ----------------
const RISKY_EXT = new Set(['transferHook', 'permanentDelegate', 'nonTransferable', 'pausableConfig', 'defaultAccountState', 'transferFeeConfig', 'confidentialTransferMint']);
export async function enrichToken(db: DB, rpc: Rpc, mint: string, now: number) {
  const t = q1(db, `SELECT mint, bonding_curve FROM live_tokens WHERE mint = ?`, mint); if (!t) return;
  try {
    const acct = await rpc.getAccountInfoParsed(mint);
    const v = acct?.value; const info = v?.data?.parsed?.info;
    if (!v || !info || v.data?.parsed?.type !== 'mint') throw new Error('NOT_A_MINT');
    const exts: string[] = (info.extensions ?? []).map((x: any) => String(x.extension)).filter((x: string) => RISKY_EXT.has(x));
    let top10: number | null = null; let pool: string | null = null;
    const largest = (await rpc.getTokenLargestAccounts(mint))?.value ?? [];
    if (largest.length) {
      const owners = (await rpc.getMultipleAccountsParsed(largest.map((a: any) => a.address)))?.value ?? [];
      const supply = BigInt(info.supply ?? '0');
      let sum = 0n; let n = 0;
      for (let k = 0; k < largest.length && n < 10; k++) {
        const owner = owners[k]?.data?.parsed?.info?.owner;
        if (t.bonding_curve && owner === t.bonding_curve) { pool = largest[k].address; continue; } // curve's token account = liquidity, excluded
        sum += BigInt(largest[k].amount); n++;
      }
      if (supply > 0n && t.bonding_curve) top10 = Number((sum * 10_000n) / supply); // only when the pool account could be identified
      else top10 = null;
    }
    run(db, `UPDATE live_tokens SET sec_checked_at = ?, token_program = ?, mint_authority = ?, freeze_authority = ?, risky_ext = ?, top10_bps = ?, pool_account = ?, sec_error = NULL WHERE mint = ?`,
      now, v.owner, info.mintAuthority ?? null, info.freezeAuthority ?? null, exts.join(','), top10, pool, mint);
  } catch (e) {
    run(db, `UPDATE live_tokens SET sec_checked_at = ?, sec_error = ? WHERE mint = ?`, now, String((e as Error).message).slice(0, 200), mint);
  }
}
export const tokensNeedingEnrichment = (db: DB, now: number, limit = 3) => qa(db,
  `SELECT t.mint FROM live_tokens t WHERE t.complete = 0 AND t.seen_from_creation = 1 AND t.created_at < ? AND t.created_at > ? AND (t.sec_checked_at IS NULL OR t.sec_checked_at < ?)
   AND (SELECT COUNT(*) FROM live_trades x WHERE x.mint = t.mint) >= 5 ORDER BY t.last_trade_at DESC LIMIT ?`, now - 3 * 60_000, now - 24 * 3_600_000, now - 10 * 60_000, limit).map(r => r.mint as string);

// ---------------- Smart-money labels from our own history (jgg-smart-v1) ----------------
/** A wallet is "smart" when, over the last 7 days of indexed trades, it closed ≥5 positions (sold ≥90% of what it bought),
 *  won ≥60% of them, and its realized SOL P&L is positive. Needs history: empty during warm-up. */
export function recomputeSmart(db: DB, now: number) {
  const rows = qa(db, `SELECT wallet, mint, SUM(CASE WHEN is_buy = 1 THEN CAST(sol AS INTEGER) ELSE 0 END) bs, SUM(CASE WHEN is_buy = 1 THEN CAST(tok AS INTEGER) ELSE 0 END) bt,
    SUM(CASE WHEN is_buy = 0 THEN CAST(sol AS INTEGER) ELSE 0 END) ss, SUM(CASE WHEN is_buy = 0 THEN CAST(tok AS INTEGER) ELSE 0 END) stok
    FROM live_trades WHERE ts > ? GROUP BY wallet, mint`, now - 7 * 86_400_000);
  const agg = new Map<string, { closed: number; wins: number; pnl: bigint }>();
  for (const r of rows) {
    const bt = BigInt(r.bt), stok = BigInt(r.stok), bs = BigInt(r.bs), ss = BigInt(r.ss);
    if (bt === 0n || stok * 10n < bt * 9n) continue; // not closed
    const cost = (bs * (stok > bt ? bt : stok)) / bt; const pnl = ss - cost;
    const a = agg.get(r.wallet) ?? { closed: 0, wins: 0, pnl: 0n }; a.closed++; if (pnl > 0n) a.wins++; a.pnl += pnl; agg.set(r.wallet, a);
  }
  tx(db, () => {
    run(db, `DELETE FROM live_smart`);
    for (const [w, a] of agg) if (a.closed >= 5 && a.wins * 10 >= a.closed * 6 && a.pnl > 0n)
      run(db, `INSERT INTO live_smart (wallet, closed, wins, pnl_lamports, updated_at) VALUES (?, ?, ?, ?, ?)`, w, a.closed, a.wins, String(a.pnl), now);
  });
  run(db, `INSERT INTO worker_state (key, value, updated_at) VALUES ('live_smart', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    JSON.stringify({ at: now, wallets: q1(db, `SELECT COUNT(*) n FROM live_smart`).n, historyFrom: q1(db, `SELECT MIN(ts) m FROM live_trades`).m }), Date.now());
}

// ---------------- SOL/USD ----------------
export function solUsd(db: DB, now: number): { usd: string; source: string; at: number } | null {
  const r = q1(db, `SELECT value FROM worker_state WHERE key = 'sol_usd'`); if (!r) return null;
  const v = JSON.parse(r.value); return now - v.at > 10 * 60_000 ? null : v; // stale prices are not used
}
export function setSolUsd(db: DB, usd: string, source: string, at: number) {
  run(db, `INSERT INTO worker_state (key, value, updated_at) VALUES ('sol_usd', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify({ usd, source, at }), Date.now());
}

// ---------------- Price freshness for exits (owner decision: USD triggers) ----------------
// A USD price is only as fresh as BOTH inputs: the coin's curve reserves (valid while the indexer's log stream is live and
// the coin has traded since the stream (re)connected — trades missed during a gap would make old reserves wrong) and the
// SOL/USD rate. Graduated coins use Jupiter Price v3 (ext_prices, refreshed by the indexer for coins with active exits).
export const EXIT_PRICE_LIMITS = { heartbeatMs: 10_000, solUsdMs: 180_000, extPriceMs: 60_000 };
export function livePriceObs(db: DB, chain: Chain, token: string, now: number): PriceObs {
  const none = (staleReason: string, usd: string | null = null, at: number | null = null, source = 'jgg-indexer'): PriceObs => ({ usd, at, source, staleReason });
  if (chain !== 'solana') return none('CHAIN_UNSUPPORTED');
  const t = tokenState(db, token); if (!t) return none('TOKEN_NOT_INDEXED');
  const u = solUsd(db, now);
  if (t.complete) {
    const x = q1(db, `SELECT usd, source, at FROM ext_prices WHERE chain = 'solana' AND mint = ?`, token);
    if (!x) return none('GRADUATED_NO_EXTERNAL_PRICE', null, null, 'jupiter-price-v3');
    if (now - x.at > EXIT_PRICE_LIMITS.extPriceMs) return none('EXTERNAL_PRICE_STALE', x.usd, x.at, x.source);
    return { usd: x.usd, at: x.at, source: x.source, staleReason: null };
  }
  const p = priceSolDec(t); if (!p) return none('NO_RESERVES');
  if (!u) return none('SOL_USD_UNAVAILABLE');
  const usd = D.str(D.rescale(D.mul(p, u.usd), 12));
  if (now - u.at > EXIT_PRICE_LIMITS.solUsdMs) return none('SOL_USD_STALE', usd, u.at);
  const ix = q1(db, `SELECT value, updated_at FROM worker_state WHERE key = 'indexer'`);
  if (!ix || now - ix.updated_at > EXIT_PRICE_LIMITS.heartbeatMs) return none('INDEXER_DOWN', usd, ix?.updated_at ?? null);
  const v = JSON.parse(ix.value);
  if (v.conn !== 'live') return none('STREAM_NOT_LIVE', usd, ix.updated_at);
  if (v.liveSince && (!t.last_trade_at || t.last_trade_at < v.liveSince)) return none('NO_TRADE_SINCE_RECONNECT', usd, t.last_trade_at ?? null);
  return { usd, at: Math.min(ix.updated_at, now), source: 'pump-curve × SOL/USD', staleReason: null };
}

/** Jupiter Price v3 for graduated coins that have active exits (curve price no longer applies). Missing = unknown, never 0. */
export function graduatedExitMints(db: DB): string[] {
  return qa(db, `SELECT DISTINCT s.token FROM strategies s JOIN live_tokens t ON t.mint = s.token WHERE s.kind = 'position_exit' AND s.chain = 'solana' AND s.lifecycle IN ('active','paused') AND t.complete = 1 LIMIT 50`).map(r => r.token as string);
}
/** JSON number → exact decimal string without exponent notation (String(1.2e-7) is "1.2e-7", which exact math rejects). 15 significant digits. */
export function numToDec(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error('NOT_A_POSITIVE_NUMBER');
  const [m, e] = n.toExponential(14).split('e'); const exp = Number(e); const digits = m.replace('.', '').replace(/0+$/, '') || '0';
  if (exp < 0) return '0.' + '0'.repeat(-exp - 1) + digits;
  const int = digits.padEnd(exp + 1, '0').slice(0, exp + 1); const frac = digits.slice(exp + 1);
  return frac ? `${int}.${frac}` : int;
}
export function setExtPrice(db: DB, mint: string, usd: string, source: string, at: number) {
  if (!D.gt(usd, '0')) return;
  run(db, `INSERT INTO ext_prices (chain, mint, usd, source, at) VALUES ('solana', ?, ?, ?, ?) ON CONFLICT(chain, mint) DO UPDATE SET usd = excluded.usd, source = excluded.source, at = excluded.at`, mint, usd, source, at);
}

// ---------------- The live market source ----------------
const lamportsToSol = (x: bigint) => D.rawToDec(x.toString(), 9);
function tokenState(db: DB, mint: string) { return q1(db, `SELECT * FROM live_tokens WHERE mint = ?`, mint); }
function priceSolDec(t: any): D.Dec | null { if (!t?.v_sol || !t?.v_tok || BigInt(t.v_tok) === 0n) return null; return D.div(D.rawToDec(t.v_sol, 9), D.rawToDec(t.v_tok, 6), 18); }

/** Shared Finder tuning for live data: curve liquidity in USD (not the fixture default), and KOL is excluded (no social data in v1). */
export function liveFinderTuning(overrides: Partial<D.FinderConfig> = {}): { config: D.FinderConfig; exclude: string[] } {
  return { config: { ...D.DEFAULT_FINDER, minLiquidityUsd: 2_000, ...overrides }, exclude: ['kols'] };
}
export function createLiveSource(db: DB, opts: { finderConfig?: Partial<D.FinderConfig> } = {}): MarketSource {
  const { config: cfg, exclude } = liveFinderTuning(opts.finderConfig);
  const onlySolana = (chain: Chain) => chain === 'solana';
  return {
    kind: 'solana_live', label: 'JGG indexer (Solana · pump.fun bonding curve) + Jupiter SOL/USD', finderConfig: cfg, finderExclude: exclude,
    now: () => Date.now(),
    nativeUsd(chain) {
      if (!onlySolana(chain)) return null;
      const r = q1(db, `SELECT value FROM worker_state WHERE key = 'sol_usd'`); return r ? JSON.parse(r.value).usd : null; // accounting uses the latest known value
    },
    priceUsd(chain, token, now) {
      if (!onlySolana(chain)) return null;
      const t = tokenState(db, token); const p = priceSolDec(t); const u = solUsd(db, now);
      if (!p || !u) return null;
      if (t.complete) return null; // graduated: curve price is no longer the market price (PumpSwap not indexed in v1)
      return D.str(D.rescale(D.mul(p, u.usd), 12));
    },
    priceObs(chain, token, now) { return livePriceObs(db, chain, token, now); },
    quote(chain, token, side, amount, slippageBps, now, ttlMs = 15_000, qopts?: { live?: boolean }): QuoteResult {
      if (!onlySolana(chain)) return { ok: false, code: 'CHAIN_UNSUPPORTED' };
      try { D.validateSlippageBps(slippageBps, true); } catch { return { ok: false, code: 'SLIPPAGE_OUT_OF_RANGE' }; }
      const t = tokenState(db, token);
      if (!t || !t.v_sol) return { ok: false, code: 'TOKEN_NOT_INDEXED' };
      if (t.complete) {
        // Live-only: a graduated coin can still be SOLD through Jupiter. The approval context is a price floor from the last curve
        // price (pump migration keeps price continuity); Jupiter's actual output must meet minOut or the order fails with no funds moved.
        // Paper (owner decision 2026-09-26): graduated sells are modeled at the fresh Jupiter price (no price impact modeled, disclosed in the route).
        if (side !== 'sell') return { ok: false, code: 'CURVE_COMPLETE' };
        const u0 = solUsd(db, now); if (!u0) return { ok: false, code: 'NO_SOL_USD' };
        const ext = q1(db, `SELECT usd, at FROM ext_prices WHERE chain = 'solana' AND mint = ?`, token); const extFresh = ext && now - ext.at <= EXIT_PRICE_LIMITS.extPriceMs;
        if (!qopts?.live && !extFresh) return { ok: false, code: 'CURVE_COMPLETE' };
        let tokRaw: bigint; try { tokRaw = BigInt(D.decToRaw(amount, 6)); } catch { return { ok: false, code: 'AMOUNT_PRECISION' }; }
        // Floor from the fresh Jupiter price when known (a stale last-curve floor would make a stop-loss fail after a post-graduation drop).
        const lastOut = extFresh ? BigInt(D.decToRaw(D.str(D.rescale(D.div(D.mul(D.rawToDec(tokRaw.toString(), 6), ext.usd), u0.usd, 18), 9, 'floor')), 9)) : (tokRaw * BigInt(t.v_sol)) / BigInt(t.v_tok);
        if (lastOut <= 0n) return { ok: false, code: 'NO_OUTPUT' };
        const minOut = D.minimumOutRaw(lastOut.toString(), slippageBps);
        return { ok: true, quote: { chain, token, side, amountIn: amount, assetIn: t.symbol ?? 'TOKEN', expectedOut: D.str(D.rawToDec(lastOut.toString(), 9)), assetOut: 'SOL', minOut: D.str(D.rawToDec(minOut, 9)),
          slippageBps, priceImpactBps: 0, executionPriceUsd: '0', route: extFresh ? (qopts?.live ? 'jupiter (graduated; floor = Jupiter price − slippage)' : 'paper: graduated coin at Jupiter price (price impact NOT modeled)') : 'jupiter (graduated; floor = last curve price − slippage)', fees: [{ kind: 'network', amount: NETWORK_FEE.solana, asset: 'SOL', includedInQuotedOutput: false, note: 'Estimated' }],
          quotedAt: now, expiresAt: now + ttlMs, model: 'jgg-graduated-floor-v1', decimalsOut: 9 } };
      }
      if (!t.last_trade_at || now - t.last_trade_at > 15 * 60_000) return { ok: false, code: 'STALE_DATA' }; // reserves too old to trust
      const vs = BigInt(t.v_sol), vt = BigInt(t.v_tok), rs = BigInt(t.r_sol), rt = BigInt(t.r_tok);
      const feeKnown = t.fee_bps !== null && t.fee_bps !== undefined; const fee = feeKnown ? BigInt(t.fee_bps) : DEFAULT_FEE_BPS;
      let inRaw: bigint;
      try { inRaw = BigInt(D.decToRaw(amount, side === 'buy' ? 9 : 6)); } catch { return { ok: false, code: 'AMOUNT_PRECISION' }; }
      if (inRaw <= 0n) return { ok: false, code: 'AMOUNT_NOT_POSITIVE' };
      const u = solUsd(db, now);
      if (!u) return { ok: false, code: 'NO_SOL_USD' }; // fresh SOL/USD required for USD accounting
      let outRaw: bigint; let feeLamports: bigint; let impactBps = 0;
      if (side === 'buy') {
        const q = P.quoteBuy(vs, vt, rt, inRaw, fee); outRaw = q.tokensOut; feeLamports = q.feeLamports;
        const ideal = (q.netLamports * vt) / vs; impactBps = ideal === 0n ? 0 : Number(((ideal - q.tokensOut) * 10_000n) / ideal);
      } else {
        const q = P.quoteSell(vs, vt, rs, inRaw, fee); outRaw = q.lamportsOut; feeLamports = q.feeLamports;
        const ideal = (inRaw * vs) / vt; impactBps = ideal === 0n ? 0 : Number(((ideal - q.grossLamports) * 10_000n) / ideal);
      }
      if (outRaw <= 0n) return { ok: false, code: 'NO_OUTPUT' };
      const decOut = side === 'buy' ? 6 : 9;
      const minOut = D.minimumOutRaw(outRaw.toString(), slippageBps);
      const solValue = side === 'buy' ? D.dec(amount) : lamportsToSol(outRaw);
      const tokQty = side === 'buy' ? D.rawToDec(outRaw.toString(), 6) : D.dec(amount);
      const execUsd = u && !D.isZero(tokQty) ? D.str(D.rescale(D.div(D.mul(solValue, u.usd), tokQty, 18), 12)) : '0';
      return { ok: true, quote: {
        chain, token, side, amountIn: amount, assetIn: side === 'buy' ? 'SOL' : (t.symbol ?? 'TOKEN'), expectedOut: D.str(D.rawToDec(outRaw.toString(), decOut)), assetOut: side === 'buy' ? (t.symbol ?? 'TOKEN') : 'SOL',
        minOut: D.str(D.rawToDec(minOut, decOut)), slippageBps, priceImpactBps: Math.max(0, impactBps), executionPriceUsd: execUsd, route: 'paper:pump-curve(live reserves)',
        fees: [
          { kind: 'dex', amount: D.str(lamportsToSol(feeLamports)), asset: 'SOL', includedInQuotedOutput: true, note: feeKnown ? `${fee} bps pump protocol+creator fee (latest observed TradeEvent)` : `${fee} bps ESTIMATED — no fee observed yet for this coin` },
          { kind: 'jgg', amount: '0', asset: 'SOL', includedInQuotedOutput: true, note: '0 bps — JGG fee not configured' },
          { kind: 'network', amount: NETWORK_FEE.solana, asset: 'SOL', includedInQuotedOutput: false, note: 'Modeled base network fee' },
          { kind: 'priority', amount: PRIORITY_FEE.solana, asset: 'SOL', includedInQuotedOutput: false, note: 'Modeled priority fee' },
        ], quotedAt: now, expiresAt: now + ttlMs, model: LIVE_MODEL.id, decimalsOut: decOut,
      } };
    },
    finderCandidates(chain, now) { return onlySolana(chain) ? liveFinderInputs(db, now) : []; },
  };
}

/** Build Finder inputs from indexed history. Only coins seen from creation (complete history) that are still on the curve. */
export function liveFinderInputs(db: DB, now: number): D.FinderInput[] {
  const u = solUsd(db, now);
  const smart = new Set(qa(db, `SELECT wallet FROM live_smart`).map(r => r.wallet as string));
  const smartReady = q1(db, `SELECT value FROM worker_state WHERE key = 'live_smart'`) !== undefined;
  const toks = qa(db, `SELECT * FROM live_tokens WHERE seen_from_creation = 1 AND complete = 0 AND created_at > ? AND last_trade_at > ? ORDER BY last_trade_at DESC LIMIT 300`, now - 24 * 3_600_000, now - 30 * 60_000);
  const out: D.FinderInput[] = [];
  for (const t of toks) {
    const trades = qa(db, `SELECT wallet, is_buy, sol, tok, v_sol, v_tok, ts, slot FROM live_trades WHERE mint = ? ORDER BY ts, slot, sig, idx LIMIT 20000`, t.mint);
    if (trades.length < 10) continue;
    const pNow = priceSolDec(t)!;
    const priceAtTs = (cut: number) => { let p: D.Dec | null = D.div(D.rawToDec(String(P.PUMP_DEFAULTS.initialVirtualSolReserves), 9), D.rawToDec(String(P.PUMP_DEFAULTS.initialVirtualTokenReserves), 6), 18);
      for (const x of trades) { if (x.ts > cut) break; p = D.div(D.rawToDec(x.v_sol, 9), D.rawToDec(x.v_tok, 6), 18); } return p; };
    const chg = (ms: number) => { const past = priceAtTs(now - ms); return past && !D.isZero(past) ? Math.round(Number(D.fixed(D.div(D.sub(pNow, past), past, 8), 6)) * 10_000) : null; };
    const h1 = trades.filter(x => x.ts > now - 3_600_000);
    const vol1hSol = h1.reduce((a, x) => a + BigInt(x.sol), 0n);
    const net = new Map<string, bigint>();
    for (const x of trades) net.set(x.wallet, (net.get(x.wallet) ?? 0n) + (x.is_buy ? BigInt(x.tok) : -BigInt(x.tok)));
    const holders = [...net.values()].filter(v => v > 0n).length;
    const creatorNet = t.creator ? (net.get(t.creator) ?? 0n) : null;
    const firstSlot = trades[0].slot;
    const bundleTok = trades.filter(x => x.slot === firstSlot && x.is_buy && x.wallet !== t.creator).reduce((a, x) => a + BigInt(x.tok), 0n);
    const snipers = new Set(trades.filter(x => x.slot <= firstSlot + 1 && x.is_buy && x.wallet !== t.creator).map(x => x.wallet)).size;
    const smartHolders = [...net.entries()].filter(([w, v]) => v > 0n && smart.has(w)).length;
    const liqUsd = u ? Number(D.fixed(D.mul(D.rawToDec(t.r_sol ?? '0', 9), u.usd), 2)) : null;
    const checked = !!t.sec_checked_at && !t.sec_error;
    const freezeRisky = checked && t.freeze_authority !== null;
    const extRisky = checked && !!t.risky_ext;
    const honeypot: D.Tri = !checked ? 'unknown' : freezeRisky || extRisky ? 'risky' : 'safe'; // on-curve coins are sellable by program design when no freeze/transfer restrictions exist
    const mintAuth: D.Tri = !checked ? 'unknown' : t.mint_authority === null ? 'safe' : 'risky';
    const dd = D.dueDiligence({ honeypot, mintAuthority: mintAuth, freezeAuthority: !checked ? 'unknown' : t.freeze_authority === null ? 'safe' : 'risky', lpLockedOrBurned: 'not_applicable', openSource: 'not_applicable',
      top10ConcentrationBps: t.top10_bps ?? null, devHoldingBps: creatorNet === null ? null : Number((creatorNet > 0n ? creatorNet : 0n) * 10_000n / SUPPLY), liquidityUsd: liqUsd === null ? null : String(liqUsd),
      ageMinutes: Math.floor((now - t.created_at) / 60_000), buyTaxBps: 0, sellTaxBps: 0 });
    out.push({
      address: t.mint, symbol: t.symbol ?? '?', ageMin: Math.floor((now - t.created_at) / 60_000), liquidityUsd: liqUsd,
      marketCapUsd: u ? Number(D.fixed(D.mul(lamportsToSol(P.marketCapLamports(BigInt(t.v_sol), BigInt(t.v_tok))), u.usd), 2)) : null,
      volume1hUsd: u ? Number(D.fixed(D.mul(lamportsToSol(vol1hSol), u.usd), 2)) : null, holders,
      buys1h: h1.filter(x => x.is_buy).length, sells1h: h1.filter(x => !x.is_buy).length, change5mBps: chg(300_000), change1hBps: chg(3_600_000),
      smartMoney: smartReady ? smartHolders : null, kols: null,
      top10Bps: t.top10_bps ?? null, devHoldingBps: creatorNet === null ? null : Number((creatorNet > 0n ? creatorNet : 0n) * 10_000n / SUPPLY),
      insiderBps: null, bundleBps: Number(bundleTok * 10_000n / SUPPLY), snipers,
      honeypot, mintAuthority: mintAuth, freezeAuthority: !checked ? 'unknown' : t.freeze_authority === null ? 'safe' : 'risky', rugRatio: null,
      ddVerdict: dd.verdict as D.FinderInput['ddVerdict'], ddScore: dd.score,
    });
  }
  return out;
}

export function liveStatus(db: DB, now: number) {
  const ix = q1(db, `SELECT value, updated_at FROM worker_state WHERE key = 'indexer'`);
  return { indexer: ix ? { ...JSON.parse(ix.value), heartbeatMsAgo: Date.now() - ix.updated_at } : null, solUsd: solUsd(db, now),
    tokens: q1(db, `SELECT COUNT(*) n FROM live_tokens`).n, trades: q1(db, `SELECT COUNT(*) n FROM live_trades`).n,
    smart: q1(db, `SELECT value FROM worker_state WHERE key = 'live_smart'`)?.value ? JSON.parse(q1(db, `SELECT value FROM worker_state WHERE key = 'live_smart'`).value) : null,
    fomo: q1(db, `SELECT value FROM worker_state WHERE key = 'fomo'`)?.value ? JSON.parse(q1(db, `SELECT value FROM worker_state WHERE key = 'fomo'`).value) : null };
}

// ---------------- Live views (shapes compatible with the fixture provider so the UI renders unchanged) ----------------
const hueOf = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
export function liveTokenRow(db: DB, t: any, now: number) {
  const u = solUsd(db, now); const p = priceSolDec(t);
  const priceUsd = p && u && !t.complete ? D.str(D.rescale(D.mul(p, u.usd), 12)) : null;
  const mcUsd = u && t.v_sol && !t.complete ? D.fixed(D.mul(lamportsToSol(P.marketCapLamports(BigInt(t.v_sol), BigInt(t.v_tok))), u.usd), 2) : null;
  const tr = qa(db, `SELECT is_buy, sol, v_sol, v_tok, ts FROM live_trades WHERE mint = ? AND ts > ? ORDER BY ts`, t.mint, now - 86_400_000);
  const win = { '1m': 60e3, '5m': 300e3, '1h': 3600e3, '6h': 21600e3, '24h': 86400e3 } as const;
  const vol: any = {}; const change: any = {};
  for (const [k, ms] of Object.entries(win)) {
    const xs = tr.filter(x => x.ts > now - ms); const lam = xs.reduce((a, x) => a + BigInt(x.sol), 0n);
    vol[k] = u ? D.fixed(D.mul(lamportsToSol(lam), u.usd), 2) : null;
    const before = [...tr].reverse().find(x => x.ts <= now - ms);
    const past = before ? D.div(D.rawToDec(before.v_sol, 9), D.rawToDec(before.v_tok, 6), 18) : (t.seen_from_creation && t.created_at > now - ms ? D.div(D.rawToDec(String(P.PUMP_DEFAULTS.initialVirtualSolReserves), 9), D.rawToDec(String(P.PUMP_DEFAULTS.initialVirtualTokenReserves), 6), 18) : null);
    change[k] = p && past && !D.isZero(past) ? Math.round(Number(D.fixed(D.div(D.sub(p, past), past, 8), 6)) * 10_000) : null;
  }
  const buys = tr.filter(x => x.is_buy).length;
  let holders: number | null = null;
  if (t.seen_from_creation) { // observed net-positive wallets (complete history; transfers between wallets are not seen)
    const net = new Map<string, bigint>();
    for (const x of qa(db, `SELECT wallet, is_buy, tok FROM live_trades WHERE mint = ? LIMIT 50000`, t.mint)) net.set(x.wallet, (net.get(x.wallet) ?? 0n) + (x.is_buy ? BigInt(x.tok) : -BigInt(x.tok)));
    holders = [...net.values()].filter(v => v > 0n).length;
  }
  const checked = !!t.sec_checked_at && !t.sec_error;
  const risk = !checked ? 'unknown' : t.freeze_authority || t.risky_ext ? 'danger' : (t.top10_bps ?? 0) > 3000 ? 'caution' : 'ok';
  return {
    chain: 'solana', address: t.mint, symbol: t.symbol ?? '?', name: t.name ?? '(name not indexed)', launchpad: 'pumpfun', lifecycle: t.complete ? 'migrated' : P.progressBps(BigInt(t.r_tok ?? '0')) >= 8500 ? 'near_completion' : 'new',
    createdAt: t.created_at, ageSec: t.seen_from_creation ? Math.floor((now - t.created_at) / 1000) : null, priceUsd, mcUsd, mcBasis: 'fdv_approx', liqUsd: u && t.r_sol ? D.fixed(D.mul(D.rawToDec(t.r_sol, 9), u.usd), 2) : null,
    athMcUsd: null, vol, txs: { buys, sells: tr.length - buys }, holders, change, top10Bps: t.top10_bps ?? null, devHoldingBps: null, bundleBps: null, insiderBps: null, snipers: null,
    smartMoney: null, kols: null, progressBps: t.complete ? 10_000 : P.progressBps(BigInt(t.r_tok ?? '0')), socials: { x: false, web: false, tg: false }, hue: hueOf(t.mint),
    taxBps: { buy: 0, sell: 0 }, risk, hotSearches: 0, dataSource: 'jgg-indexer',
  };
}
export function liveTrenches(db: DB, stage: 'new' | 'near_completion' | 'migrated', now: number) {
  const where = stage === 'migrated' ? `complete = 1` : stage === 'near_completion' ? `complete = 0 AND CAST(r_tok AS INTEGER) <= ${Number(P.PUMP_DEFAULTS.initialRealTokenReserves * 15n / 100n)}` : `complete = 0 AND seen_from_creation = 1`;
  const rows = qa(db, `SELECT * FROM live_tokens WHERE ${where} AND last_trade_at > ? ORDER BY ${stage === 'new' ? 'created_at' : 'last_trade_at'} DESC LIMIT 60`, now - 6 * 3_600_000);
  return { stage, rows: rows.map(t => liveTokenRow(db, t, now)), excluded: {}, source: 'jgg-indexer' };
}
export function liveTokenDetail(db: DB, mint: string, now: number) {
  const t = q1(db, `SELECT * FROM live_tokens WHERE mint = ?`, mint); if (!t) return null;
  const row = liveTokenRow(db, t, now); const checked = !!t.sec_checked_at && !t.sec_error;
  const tri = (v: any): D.Tri => (!checked ? 'unknown' : v === null ? 'safe' : 'risky');
  const security = { honeypot: !checked ? 'unknown' : t.freeze_authority || t.risky_ext ? 'risky' : t.complete ? 'unknown' : 'safe', mintAuthority: tri(t.mint_authority), freezeAuthority: tri(t.freeze_authority),
    lpLockedOrBurned: 'not_applicable', openSource: 'not_applicable', buyTaxBps: 0, sellTaxBps: 0 } as const;
  const dd = D.dueDiligence({ ...security, top10ConcentrationBps: t.top10_bps ?? null, devHoldingBps: null, liquidityUsd: row.liqUsd, ageMinutes: row.ageSec === null ? null : Math.floor(row.ageSec / 60), buyTaxBps: 0, sellTaxBps: 0 } as D.DdInput);
  return { ...row, decimals: 6, supplyRaw: String(SUPPLY), creator: t.creator, security, dd, concentration: { bps: t.top10_bps ?? null, excluded: t.pool_account ? [t.pool_account] : [], note: 'Top-10 token accounts from RPC, excluding the bonding-curve account' },
    pools: [{ address: t.bonding_curve ?? 'unknown', dex: 'pump.fun bonding curve', quote: 'SOL', liquidityUsd: row.liqUsd, feeBps: t.fee_bps ?? null, lp: 'not_applicable' }],
    migratedPool: null, explorer: `https://solscan.io/token/${mint}`, securityNote: checked ? `Checked via RPC ${new Date(t.sec_checked_at).toISOString()}` : (t.sec_error ? `Security check failed: ${t.sec_error}` : 'Security check pending') };
}
export function liveCandles(db: DB, mint: string, intervalMs: number, count: number, now: number) {
  const u = solUsd(db, now); const from = now - intervalMs * count;
  const tr = qa(db, `SELECT sig, idx, sol, tok, v_sol, v_tok, ts FROM live_trades WHERE mint = ? AND ts >= ? ORDER BY ts, slot, sig, idx`, mint, from);
  if (!u) return { interval: intervalMs, currency: 'unpriced', pool: 'bonding-curve', rows: [] as D.Candle[] }; // no USD candles without SOL/USD
  const trades: D.Trade[] = tr.map(x => ({ eventId: `${x.sig}:${x.idx}`, swapId: `${x.sig}:${x.idx}`, legIndex: 0, ts: x.ts,
    price: D.str(D.rescale(D.mul(D.div(D.rawToDec(x.v_sol, 9), D.rawToDec(x.v_tok, 6), 18), u.usd), 12)), volumeQuote: D.fixed(D.mul(D.rawToDec(x.sol, 9), u.usd), 2) }));
  return { interval: intervalMs, currency: 'USD', pool: 'bonding-curve', rows: D.aggregateCandles(trades, intervalMs, from - (from % intervalMs), now) };
}
export function liveTrades(db: DB, mint: string, now: number) {
  const u = solUsd(db, now);
  return qa(db, `SELECT sig, idx, wallet, is_buy, sol, tok, v_sol, v_tok, ts FROM live_trades WHERE mint = ? ORDER BY ts DESC LIMIT 100`, mint).map(x => ({
    eventId: `${x.sig}:${x.idx}`, ts: x.ts, side: x.is_buy ? 'buy' : 'sell', wallet: x.wallet, walletName: null, labels: [], token: mint,
    amountUsd: u ? D.fixed(D.mul(D.rawToDec(x.sol, 9), u.usd), 2) : null, tokenQty: D.str(D.rawToDec(x.tok, 6)),
    price: u ? D.str(D.rescale(D.mul(D.div(D.rawToDec(x.v_sol, 9), D.rawToDec(x.v_tok, 6), 18), u.usd), 12)) : null, txRef: x.sig, explorer: `https://solscan.io/tx/${x.sig}` }));
}
export function liveTrending(db: DB, now: number, window: string) {
  const ms = ({ '1m': 60e3, '5m': 300e3, '1h': 3600e3, '6h': 21600e3, '24h': 86400e3 } as Record<string, number>)[window] ?? 3600e3;
  const rows = qa(db, `SELECT t.*, (SELECT SUM(CAST(sol AS INTEGER)) FROM live_trades x WHERE x.mint = t.mint AND x.ts > ?) vol FROM live_tokens t WHERE t.last_trade_at > ? ORDER BY vol DESC LIMIT 50`, now - ms, now - ms);
  return { view: 'trending', window, ranking: 'jgg-live-volume-v1 (SOL volume in window, indexed coins only)', rows: rows.map(t => liveTokenRow(db, t, now)), excluded: {} };
}
export function liveSearch(db: DB, q: string, now: number) {
  const s = q.trim(); if (!s) return [];
  const rows = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) ? qa(db, `SELECT * FROM live_tokens WHERE mint = ?`, s)
    : qa(db, `SELECT * FROM live_tokens WHERE symbol LIKE ? ESCAPE '\\' ORDER BY last_trade_at DESC LIMIT 20`, s.replace(/[%_\\]/g, m => '\\' + m) + '%');
  return rows.map(t => { const r = liveTokenRow(db, t, now); return { type: 'token', chain: 'solana', address: t.mint, symbol: r.symbol, name: r.name, mcUsd: r.mcUsd, ageSec: r.ageSec, exact: t.mint === s }; });
}

// ---------------- Optional FOMO labels (third-party; wallet → handle only) ----------------
export function saveFomoTraders(db: DB, window: string, traders: { wallet: string; handle: string; userId: string | null; rank: number | null; pnlUsd: number | null; volumeUsd: number | null; verified: boolean }[], now: number) {
  tx(db, () => {
    run(db, `DELETE FROM fomo_traders WHERE window = ?`, window);
    for (const t of traders) run(db, `INSERT INTO fomo_traders (wallet, handle, user_id, rank, window, pnl_usd, volume_usd, verified, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET handle = excluded.handle, user_id = excluded.user_id, rank = excluded.rank, window = excluded.window, pnl_usd = excluded.pnl_usd, volume_usd = excluded.volume_usd, verified = excluded.verified, updated_at = excluded.updated_at`,
      t.wallet, t.handle, t.userId, t.rank, window, t.pnlUsd, t.volumeUsd, t.verified ? 1 : 0, now);
  });
}
export const fomoLabels = (db: DB, wallets: string[]) => {
  if (!wallets.length) return new Map<string, { handle: string; rank: number | null }>();
  const rows = qa(db, `SELECT wallet, handle, rank FROM fomo_traders WHERE wallet IN (${wallets.map(() => '?').join(',')})`, ...wallets);
  return new Map(rows.map(r => [r.wallet as string, { handle: r.handle as string, rank: r.rank as number | null }]));
};

// ---------------- Live wallet analytics / rank / signals (from our own index) ----------------
const PERIOD_MS: Record<string, number> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
type WalletAgg = { wallet: string; trades: number; buys: number; sells: number; volLamports: bigint; closed: number; wins: number; breakEven: number; realizedLamports: bigint };
/** Realized P&L per closed (wallet, coin) episode in the window, average-cost method, SOL units. Only coins whose buys we saw. */
function aggregateWallets(db: DB, since: number, wallet?: string): WalletAgg[] {
  const rows = qa(db, `SELECT wallet, mint, SUM(is_buy) buys, SUM(1 - is_buy) sells,
      SUM(CASE WHEN is_buy = 1 THEN CAST(sol AS INTEGER) ELSE 0 END) bs, SUM(CASE WHEN is_buy = 1 THEN CAST(tok AS INTEGER) ELSE 0 END) bt,
      SUM(CASE WHEN is_buy = 0 THEN CAST(sol AS INTEGER) ELSE 0 END) ss, SUM(CASE WHEN is_buy = 0 THEN CAST(tok AS INTEGER) ELSE 0 END) st
    FROM live_trades WHERE ts > ? ${wallet ? 'AND wallet = ?' : ''} GROUP BY wallet, mint`, since, ...(wallet ? [wallet] : []));
  const m = new Map<string, WalletAgg>();
  for (const r of rows) {
    const a = m.get(r.wallet) ?? { wallet: r.wallet, trades: 0, buys: 0, sells: 0, volLamports: 0n, closed: 0, wins: 0, breakEven: 0, realizedLamports: 0n };
    a.buys += r.buys; a.sells += r.sells; a.trades += r.buys + r.sells; a.volLamports += BigInt(r.bs) + BigInt(r.ss);
    const bt = BigInt(r.bt), st = BigInt(r.st), bs = BigInt(r.bs), ss = BigInt(r.ss);
    if (bt > 0n && st > 0n) { // realized on the sold portion that we saw bought
      const soldKnown = st > bt ? bt : st; const cost = (bs * soldKnown) / bt; const proceeds = st > bt ? (ss * bt) / st : ss;
      const pnl = proceeds - cost; a.realizedLamports += pnl;
      if (st * 10n >= bt * 9n) { a.closed++; if (pnl > 0n) a.wins++; else if (pnl === 0n) a.breakEven++; }
    }
    m.set(r.wallet, a);
  }
  return [...m.values()];
}
const usdOf = (db: DB, lamports: bigint, now: number) => { const u = solUsd(db, now); return u ? D.fixed(D.mul(lamportsToSol(lamports), u.usd), 2) : null; };

export function liveRank(db: DB, now: number, period: string, category: string) {
  const since = now - (PERIOD_MS[period] ?? PERIOD_MS['7d']);
  let rows = aggregateWallets(db, since).filter(a => a.closed >= 3);
  const smart = new Set(qa(db, `SELECT wallet FROM live_smart`).map(r => r.wallet));
  const fomo = fomoLabels(db, rows.map(r => r.wallet));
  if (category === 'smart_money') rows = rows.filter(r => smart.has(r.wallet));
  if (category === 'fomo') rows = rows.filter(r => fomo.has(r.wallet));
  rows.sort((a, b) => (b.realizedLamports > a.realizedLamports ? 1 : b.realizedLamports < a.realizedLamports ? -1 : a.wallet < b.wallet ? -1 : 1));
  return { period, category, method: 'Realized P&L from pump.fun bonding-curve trades JGG indexed (average cost, coins whose buys were seen). Closed = sold ≥90% of observed buys. Min 3 closed.',
    interval: { from: new Date(since).toISOString(), to: new Date(now).toISOString() },
    rows: rows.slice(0, 100).map(a => ({ address: a.wallet, name: fomo.get(a.wallet)?.handle ? `@${fomo.get(a.wallet)!.handle}` : a.wallet.slice(0, 4) + '…' + a.wallet.slice(-4), hue: hueOf(a.wallet),
      labels: [...(smart.has(a.wallet) ? ['smart_money'] : []), ...(fomo.has(a.wallet) ? ['fomo'] : [])], realizedPnlUsd: usdOf(db, a.realizedLamports, now), winRate: a.closed ? Math.round(a.wins * 1000 / a.closed) / 10 : null,
      winRateDenominator: a.closed, trades: a.trades, nativeBalance: '—' })) };
}

export function liveWalletDetail(db: DB, address: string, now: number, period: string) {
  const since = now - (PERIOD_MS[period] ?? PERIOD_MS['7d']);
  const a = aggregateWallets(db, since, address)[0] ?? { wallet: address, trades: 0, buys: 0, sells: 0, volLamports: 0n, closed: 0, wins: 0, breakEven: 0, realizedLamports: 0n };
  const smart = q1(db, `SELECT closed, wins FROM live_smart WHERE wallet = ?`, address); const fomo = fomoLabels(db, [address]).get(address);
  const u = solUsd(db, now);
  const pos = qa(db, `SELECT mint, SUM(CASE WHEN is_buy = 1 THEN CAST(tok AS INTEGER) ELSE -CAST(tok AS INTEGER) END) net, SUM(CASE WHEN is_buy = 1 THEN CAST(sol AS INTEGER) ELSE 0 END) bs, SUM(CASE WHEN is_buy = 1 THEN CAST(tok AS INTEGER) ELSE 0 END) bt
    FROM live_trades WHERE wallet = ? GROUP BY mint HAVING net > 0 LIMIT 100`, address);
  const holdings = pos.map(p => { const t = q1(db, `SELECT * FROM live_tokens WHERE mint = ?`, p.mint); const price = priceSolDec(t);
    const qty = D.rawToDec(String(p.net), 6); const basis = BigInt(p.bt) > 0n ? (BigInt(p.bs) * BigInt(p.net)) / BigInt(p.bt) : 0n;
    const value = price && u && !t?.complete ? D.mul(D.mul(qty, price), u.usd) : null; const basisUsd = u ? D.mul(lamportsToSol(basis), u.usd) : null;
    return { token: p.mint, symbol: t?.symbol ?? '?', qty: D.str(qty), basisUsd: basisUsd ? D.fixed(basisUsd, 2) : null, valueUsd: value ? D.fixed(value, 2) : null, unrealizedUsd: value && basisUsd ? D.fixed(D.sub(value, basisUsd), 2) : null }; });
  const history = qa(db, `SELECT sig, idx, mint, is_buy, sol, v_sol, v_tok, ts FROM live_trades WHERE wallet = ? ORDER BY ts DESC LIMIT 100`, address).map(x => ({ eventId: `${x.sig}:${x.idx}`, ts: x.ts, side: x.is_buy ? 'buy' : 'sell', token: x.mint,
    amountUsd: u ? D.fixed(D.mul(D.rawToDec(x.sol, 9), u.usd), 2) : null, price: u ? D.str(D.rescale(D.mul(D.div(D.rawToDec(x.v_sol, 9), D.rawToDec(x.v_tok, 6), 18), u.usd), 12)) : null }));
  const labels = [...(smart ? [{ label: 'smart_money', source: 'jgg-smart-v1', method: `${smart.wins}/${smart.closed} winning closed positions in 7d, positive P&L` }] : []),
    ...(fomo ? [{ label: `fomo @${fomo.handle}`, source: 'fomoapi.io (third-party)', method: `FOMO leaderboard rank ${fomo.rank ?? '?'}; FOMO-reported, not verified by JGG` }] : [])];
  return { address, name: fomo ? `@${fomo.handle}` : null, labels, realizedPnlUsd: usdOf(db, a.realizedLamports, now) ?? '0', winRate: a.closed ? Math.round(a.wins * 1000 / a.closed) / 10 : null,
    winRateDenominator: a.closed, breakEven: a.breakEven, trades: a.trades, buys: a.buys, sells: a.sells, volumeUsd: usdOf(db, a.volLamports, now) ?? '0', nativeBalance: '—',
    coverage: 'Only pump.fun bonding-curve trades seen by this JGG indexer (not the wallet\'s full history, not other DEXes).', holdings, history,
    score: { rubric: 'jgg-live-wallet-v1', profitability: a.closed >= 5 ? Math.round(a.wins * 100 / a.closed) : null, copyFeasibility: null, risk: null, sampleSize: a.closed, lowSample: a.closed < 20, note: 'Scores need ≥5 closed positions; copy feasibility needs latency data JGG does not have yet.' } };
}

export function liveSignals(db: DB, now: number, kind: string, o: { label?: string; side?: string; minWallets?: number; windowMs?: number; minChangeBps?: number; tracked?: Set<string> }) {
  const since = now - (o.windowMs ?? 3_600_000); const u = solUsd(db, now);
  const walletSet = (): Set<string> | null => kind === 'wallet_trades' ? (o.tracked ?? new Set()) : o.label === 'fomo' ? new Set(qa(db, `SELECT wallet FROM fomo_traders`).map(r => r.wallet)) : o.label === 'smart_money' || !o.label ? new Set(qa(db, `SELECT wallet FROM live_smart`).map(r => r.wallet)) : null;
  if (kind === 'wallet_trades' || kind === 'label_trades') {
    const ws = walletSet(); if (!ws) throw new Error('UNSUPPORTED_LABEL');
    if (!ws.size) return [];
    const list = [...ws].slice(0, 900);
    const rows = qa(db, `SELECT sig, idx, wallet, mint, is_buy, sol, tok, v_sol, v_tok, ts FROM live_trades WHERE ts > ? AND wallet IN (${list.map(() => '?').join(',')}) ${o.side ? 'AND is_buy = ?' : ''} ORDER BY ts DESC LIMIT 200`,
      now - 3_600_000, ...list, ...(o.side ? [o.side === 'buy' ? 1 : 0] : []));
    const f = fomoLabels(db, [...new Set(rows.map(r => r.wallet))]);
    return rows.map(x => ({ eventId: `${x.sig}:${x.idx}`, ts: x.ts, side: x.is_buy ? 'buy' : 'sell', wallet: x.wallet, walletName: f.get(x.wallet) ? `@${f.get(x.wallet)!.handle}` : null,
      labels: [o.label ?? 'smart_money'], token: x.mint, symbol: q1(db, `SELECT symbol FROM live_tokens WHERE mint = ?`, x.mint)?.symbol ?? '?',
      amountUsd: u ? D.fixed(D.mul(D.rawToDec(x.sol, 9), u.usd), 2) : null, tokenQty: D.str(D.rawToDec(x.tok, 6)), txRef: x.sig }));
  }
  if (kind === 'cluster') {
    const ws = walletSet() ?? new Set<string>(); if (!ws.size) return [];
    const list = [...ws].slice(0, 900);
    const rows = qa(db, `SELECT mint, COUNT(DISTINCT wallet) n FROM live_trades WHERE ts > ? AND is_buy = ? AND wallet IN (${list.map(() => '?').join(',')}) GROUP BY mint HAVING n >= ? ORDER BY n DESC LIMIT 50`,
      since, o.side === 'sell' ? 0 : 1, ...list, o.minWallets ?? 3);
    return rows.map(r => ({ token: r.mint, symbol: q1(db, `SELECT symbol FROM live_tokens WHERE mint = ?`, r.mint)?.symbol ?? '?', distinctWallets: r.n, side: o.side === 'sell' ? 'sell' : 'buy', assumption: 'Distinct addresses; common ownership not inferred.' }));
  }
  if (kind === 'surge') {
    const toks = qa(db, `SELECT * FROM live_tokens WHERE last_trade_at > ? AND complete = 0 ORDER BY last_trade_at DESC LIMIT 200`, now - 300_000);
    return toks.map(t => ({ t, row: liveTokenRow(db, t, now) })).filter(x => (x.row.change['5m'] ?? 0) >= (o.minChangeBps ?? 2000))
      .map(x => ({ token: x.t.mint, symbol: x.row.symbol, changeBps: x.row.change['5m'], risk: x.row.risk })).sort((a, b) => b.changeBps - a.changeBps).slice(0, 50);
  }
  throw new Error('UNSUPPORTED_SIGNAL');
}

// ---------------- Finder outcome tracking (global, model-agnostic evidence of Finder quality) ----------------
// Every coin that PASSES the Finder is tracked forward — regardless of whether any user actually bought it — so
// "is the screening good" can be measured on a much larger sample than any one user's trades, and before any real
// money is risked. This never influences trading; it only measures what already happened on the curve.
export const FINDER_OUTCOME_HORIZONS_MIN = [5, 15, 30, 60, 120, 240, 720, 1440] as const;
const RUG_BPS = -8000; const RUG_LIQ_FRACTION = 5n; // price ≤ -80% AND liquidity ≤ 1/5 of entry
const OUTCOME_RETENTION_MS = 60 * 86_400_000;

/** Runs each live worker tick: records newly-passing coins (bounded per call) and advances existing tracking rows. */
export function recordFinderPasses(db: DB, now: number, limit = 5): number {
  const { config, exclude } = liveFinderTuning();
  const res = D.runFinder(liveFinderInputs(db, now), config, exclude);
  let recorded = 0;
  for (const c of res.passed) {
    if (recorded >= limit) break;
    if (q1(db, `SELECT 1 FROM finder_outcomes WHERE token = ?`, c.address)) continue;
    const t = q1(db, `SELECT v_sol, v_tok, r_sol FROM live_tokens WHERE mint = ?`, c.address);
    if (!t?.v_sol) continue;
    run(db, `INSERT INTO finder_outcomes (token, scanned_at, score, coverage_bps, entry_v_sol, entry_v_tok, entry_liq_lamports, status, last_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'tracking', ?)`,
      c.address, now, c.score, c.coverageBps, t.v_sol, t.v_tok, t.r_sol ?? '0', now);
    recorded++;
  }
  return recorded;
}

export function updateFinderOutcomes(db: DB, now: number) {
  const rows = qa(db, `SELECT * FROM finder_outcomes WHERE status = 'tracking' LIMIT 500`);
  let rugged = 0, graduated = 0, timedOut = 0, missing = 0;
  for (const o of rows) {
    const elapsedMin = Math.floor((now - o.scanned_at) / 60_000);
    const t = q1(db, `SELECT v_sol, v_tok, r_sol, complete FROM live_tokens WHERE mint = ?`, o.token);
    const close = (outcome: string) => { run(db, `UPDATE finder_outcomes SET status = 'complete', outcome = ?, outcome_at = ?, last_checked_at = ? WHERE token = ?`, outcome, now, now, o.token); };
    if (!t) { close('missing'); missing++; continue; }
    if (!t.complete) {
      const entryPrice = D.div(D.rawToDec(o.entry_v_sol, 9), D.rawToDec(o.entry_v_tok, 6), 18);
      const curPrice = D.div(D.rawToDec(t.v_sol, 9), D.rawToDec(t.v_tok, 6), 18);
      const bps = D.isZero(entryPrice) ? null : Math.round(Number(D.fixed(D.div(D.sub(curPrice, entryPrice), entryPrice, 8), 6)) * 10_000);
      for (const h of FINDER_OUTCOME_HORIZONS_MIN) {
        if (elapsedMin < h || q1(db, `SELECT 1 FROM finder_outcome_samples WHERE token = ? AND minutes_since = ?`, o.token, h)) continue;
        run(db, `INSERT INTO finder_outcome_samples (token, minutes_since, at, price_bps_change, liq_lamports) VALUES (?, ?, ?, ?, ?)`, o.token, h, now, bps, t.r_sol ?? '0');
      }
      const liqNow = BigInt(t.r_sol ?? '0'); const liqEntry = BigInt(o.entry_liq_lamports ?? '0');
      if (elapsedMin >= 5 && bps !== null && bps <= RUG_BPS && liqEntry > 0n && liqNow * RUG_LIQ_FRACTION < liqEntry) { close('rugged'); rugged++; continue; }
    } else if (o.status === 'tracking') { close('graduated'); graduated++; continue; } // demand absorbed the curve; v1 does not follow post-migration price
    if (elapsedMin >= 1440) { close('timeout_24h'); timedOut++; } else run(db, `UPDATE finder_outcomes SET last_checked_at = ? WHERE token = ?`, now, o.token);
  }
  run(db, `DELETE FROM finder_outcome_samples WHERE token IN (SELECT token FROM finder_outcomes WHERE status = 'complete' AND outcome_at < ?)`, now - OUTCOME_RETENTION_MS);
  run(db, `DELETE FROM finder_outcomes WHERE status = 'complete' AND outcome_at < ?`, now - OUTCOME_RETENTION_MS);
  return { checked: rows.length, rugged, graduated, timedOut, missing };
}

/** Honest evidence report: hit rates and returns by holding time, over every coin the Finder ever passed — not just traded ones. */
export function finderOutcomeStats(db: DB, now: number) {
  const total = q1(db, `SELECT COUNT(*) n FROM finder_outcomes`).n as number;
  const tracking = q1(db, `SELECT COUNT(*) n FROM finder_outcomes WHERE status = 'tracking'`).n as number;
  const outcomeCounts = Object.fromEntries(qa(db, `SELECT outcome, COUNT(*) n FROM finder_outcomes WHERE status = 'complete' GROUP BY outcome`).map(r => [r.outcome as string, r.n as number]));
  const byHorizon = FINDER_OUTCOME_HORIZONS_MIN.map(h => {
    const samples = qa(db, `SELECT price_bps_change b FROM finder_outcome_samples WHERE minutes_since = ? AND price_bps_change IS NOT NULL`, h).map(r => r.b as number);
    if (!samples.length) return { minutes: h, n: 0, medianBps: null, avgBps: null, hit50Rate: null, hit100Rate: null };
    const sorted = [...samples].sort((a, b) => a - b);
    return { minutes: h, n: samples.length, medianBps: sorted[Math.floor(sorted.length / 2)], avgBps: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length),
      hit50Rate: +(samples.filter(x => x >= 5000).length * 100 / samples.length).toFixed(1), hit100Rate: +(samples.filter(x => x >= 10_000).length * 100 / samples.length).toFixed(1) };
  });
  const oldest = q1(db, `SELECT MIN(scanned_at) m FROM finder_outcomes`)?.m ?? null;
  return { version: 'jgg-finder-v1', totalTracked: total, currentlyTracking: tracking, outcomeCounts, trackingSince: oldest ? new Date(oldest).toISOString() : null, byHorizon,
    method: 'Every coin that PASSED the Finder is followed forward from that moment on this indexer\'s own curve-price history, whether or not anyone actually bought it. hitXRate = share of tracked coins whose price was at least +X% versus the price at scan time, at that time since scan.',
    caveats: [total < 30 ? `Only ${total} coins tracked so far — far too few to trust any rate. Needs continuous indexing over days to weeks.` : 'Sample size noted per horizon below; treat small-n horizons cautiously.',
      'A hit rate is not a trading return: it ignores slippage, fees, execution delay, and whether an order would actually have filled at that size.',
      'graduated = left the bonding curve (v1 does not follow price after migration); rugged = price collapsed ≥80% with liquidity ≤1/5 of entry.'] };
}
