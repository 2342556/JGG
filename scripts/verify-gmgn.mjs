// Run on a networked machine (IPv4) to VERIFY the GMGN integration against live responses.
//   npm install -g gmgn-cli
//   GMGN_API_KEY=<your key> node scripts/verify-gmgn.mjs      (GMGN's public demo key works for read-only testing per their README)
// Saves raw samples to docs/gmgn-samples/ and reports which Finder fields mapped (unknown fields stay null by design).
import { mkdirSync, writeFileSync } from 'node:fs';
const G = await import('../packages/providers/src/gmgn.ts');
const D = await import('../packages/domain/src/index.ts');
const env = { ...process.env };
if (!env.GMGN_API_KEY) { console.error('Set GMGN_API_KEY'); process.exit(1); }
mkdirSync('docs/gmgn-samples', { recursive: true });
const report = {};
for (const [name, args] of [
  ['trending_sol_1h', G.trendingArgs({ chain: 'sol', interval: '1h', limit: 20, filters: ['not_risk', 'not_honeypot'] })],
  ['trenches_sol', G.trenchesArgs('sol')],
  ['smartmoney_sol', G.smartMoneyArgs('sol', 'buy', 20)],
]) {
  try {
    const raw = await G.runGmgn(args, env);
    writeFileSync(`docs/gmgn-samples/${name}.json`, JSON.stringify(raw, null, 2).slice(0, 200_000));
    const items = Array.isArray(raw?.data?.rank) ? raw.data.rank : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.data?.new_creation) ? raw.data.new_creation : [];
    const first = items[0] ?? {};
    const mapped = items.map(it => G.mapRankItem(it, { requestedFilters: ['not_honeypot'] }));
    report[name] = { ok: true, items: items.length, topLevelKeys: Object.keys(raw ?? {}), itemKeys: Object.keys(first).sort(), unmapped: [...new Set(mapped.flatMap(m => m.unmapped))], finderPassed: D.runFinder(mapped).passed.length };
  } catch (e) { report[name] = { ok: false, code: e.code, message: e.message }; }
}
writeFileSync('docs/gmgn-samples/REPORT.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('\nSend docs/gmgn-samples/REPORT.json back so the field mapping can be confirmed (it contains no secrets).');
