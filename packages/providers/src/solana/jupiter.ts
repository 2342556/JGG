// Jupiter Price API v3 (developers.jup.ag/docs/price): GET https://api.jup.ag/price/v3?ids=<≤50 mints>, header x-api-key.
// Tokens without a reliable price are OMITTED from the response (no key) — callers must treat missing as unknown, never 0.
export const JUP_PRICE_URL = 'https://api.jup.ag/price/v3';
export async function jupiterPrices(ids: string[], apiKey: string, timeoutMs = 8_000): Promise<Record<string, { usdPrice: number; blockId: number | null; decimals: number | null }>> {
  if (!apiKey) throw new Error('JGG_JUPITER_API_KEY not set');
  if (!ids.length || ids.length > 50) throw new Error('1–50 ids per request');
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${JUP_PRICE_URL}?ids=${ids.map(encodeURIComponent).join(',')}`, { headers: { 'x-api-key': apiKey }, signal: ac.signal });
    if (!res.ok) throw new Error(`Jupiter price HTTP ${res.status}`);
    const j: any = await res.json(); const out: Record<string, any> = {};
    for (const id of ids) { const v = j?.[id]; if (v && typeof v.usdPrice === 'number' && Number.isFinite(v.usdPrice) && v.usdPrice > 0) out[id] = { usdPrice: v.usdPrice, blockId: v.blockId ?? null, decimals: v.decimals ?? null }; }
    return out;
  } finally { clearTimeout(t); }
}
