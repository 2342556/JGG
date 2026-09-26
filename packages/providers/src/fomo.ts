// OPTIONAL third-party signal: fomoapi.io (independent, unofficial API about fomo.family traders — NOT fomo.family itself).
// Docs (reviewed 2026-09-25, fomoapi.io/docs): base https://api.fomoapi.io, header `authorization: Bearer <key>`,
// GET /v2/leaderboard/{24h|7d|30d|all}?limit=1..150 → { window, capturedAt, count, traders:[{ rank, handle, userId, pnlUsd, volumeUsd, trades, followers, wallets:{solana,evm}, verified }] }.
// Credits: 250 per leaderboard call; free key = 250,000 credits/month (~1,000 calls). JGG polls at most hourly and stops at a reserve.
// JGG uses ONLY the wallet→handle labels; PnL figures are FOMO-reported and shown as such. Trading never depends on this data.
export const FOMO_API_BASE = 'https://api.fomoapi.io';
export type FomoTrader = { wallet: string; handle: string; userId: string | null; rank: number | null; pnlUsd: number | null; volumeUsd: number | null; verified: boolean };
export class FomoError extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function fomoLeaderboard(apiKey: string, window: '24h' | '7d' | '30d' | 'all' = '7d', opts: { base?: string; limit?: number; timeoutMs?: number; minCreditsReserve?: number } = {}) {
  if (!apiKey) throw new FomoError('NOT_CONFIGURED', 'JGG_FOMOAPI_KEY not set');
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${opts.base ?? FOMO_API_BASE}/v2/leaderboard/${window}?limit=${Math.min(Math.max(opts.limit ?? 150, 1), 150)}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: ac.signal });
    const remaining = Number(res.headers.get('x-credits-remaining') ?? NaN);
    if (res.status === 401) throw new FomoError('AUTH', 'fomoapi.io rejected the API key');
    if (res.status === 402) throw new FomoError('CREDITS_EXHAUSTED', 'fomoapi.io credits exhausted');
    if (res.status === 429) throw new FomoError('RATE_LIMITED', 'fomoapi.io rate limited');
    if (!res.ok) throw new FomoError('HTTP_' + res.status, `fomoapi.io HTTP ${res.status}`);
    const j: any = await res.json();
    if (!Array.isArray(j?.traders)) throw new FomoError('BAD_RESPONSE', 'leaderboard response has no traders[]');
    const traders: FomoTrader[] = [];
    for (const r of j.traders) {
      const wallet = r?.wallets?.solana;
      if (typeof wallet !== 'string' || !SOL_ADDR.test(wallet) || typeof r.handle !== 'string') continue; // Solana wallets only; malformed rows dropped
      traders.push({ wallet, handle: String(r.handle).slice(0, 40), userId: typeof r.userId === 'string' ? r.userId : null, rank: Number.isInteger(r.rank) ? r.rank : null,
        pnlUsd: typeof r.pnlUsd === 'number' && Number.isFinite(r.pnlUsd) ? r.pnlUsd : null, volumeUsd: typeof r.volumeUsd === 'number' && Number.isFinite(r.volumeUsd) ? r.volumeUsd : null, verified: r.verified === true });
    }
    return { window, capturedAt: typeof j.capturedAt === 'string' ? j.capturedAt : null, traders, creditsRemaining: Number.isFinite(remaining) ? remaining : null,
      belowReserve: Number.isFinite(remaining) && remaining < (opts.minCreditsReserve ?? 5_000) };
  } catch (e) { if ((e as Error).name === 'AbortError') throw new FomoError('TIMEOUT', 'fomoapi.io timed out'); throw e; } finally { clearTimeout(t); }
}
