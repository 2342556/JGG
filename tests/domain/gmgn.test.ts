// GMGN adapter: pure builders/mapping + runner guards (no network needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../packages/providers/src/gmgn.ts';
import * as D from '../../packages/domain/src/index.ts';

test('gmgn: documented CLI arguments are built exactly', () => {
  assert.deepEqual(G.trendingArgs({ chain: 'sol', interval: '1h', limit: 50, orderBy: 'volume', filters: ['not_risk', 'not_honeypot'], min: { liquidity: 10000, 'smart-degen-count': 1 }, maxCreated: '6h' }),
    ['market', 'trending', '--chain', 'sol', '--interval', '1h', '--limit', '50', '--order-by', 'volume', '--filter', 'not_risk', '--filter', 'not_honeypot', '--min-liquidity', '10000', '--min-smart-degen-count', '1', '--max-created', '6h', '--raw']);
  assert.deepEqual(G.trenchesArgs('sol', ['new_creation']), ['market', 'trenches', '--chain', 'sol', '--type', 'new_creation', '--raw']);
  assert.throws(() => G.tokenArgs('info', 'sol', 'not-an-address; rm -rf /'), /Invalid token address/);
  assert.throws(() => G.trendingArgs({ chain: 'sol', interval: '1h', maxCreated: '6' }), /suffix/);
});

test('gmgn: auto-exit plan → documented condition orders (buy_amount ratios)', () => {
  const c = G.conditionOrders(D.autoExitParams(D.DEFAULT_AUTO_EXIT));
  assert.deepEqual(c, [
    { order_type: 'profit_stop', side: 'sell', price_scale: '50', sell_ratio: '50' },
    { order_type: 'profit_stop', side: 'sell', price_scale: '100', sell_ratio: '50' },
    { order_type: 'loss_stop', side: 'sell', price_scale: '30', sell_ratio: '100' }]);
  const a = G.swapArgs({ chain: 'sol', from: 'W', inputToken: 'So11111111111111111111111111111111111111112', outputToken: 'T', amountRaw: '100000000', slippagePct: 15, conditions: c });
  assert.ok(a.includes('--condition-orders') && a.includes('buy_amount') && a.includes('--anti-mev'));
  assert.throws(() => G.swapArgs({ chain: 'sol', from: 'W', inputToken: 'a', outputToken: 'b', amountRaw: '0.1', slippagePct: 15 }), /smallest unit/);
  assert.throws(() => G.swapArgs({ chain: 'sol', from: 'W', inputToken: 'a', outputToken: 'b', amountRaw: '1', slippagePct: 1.5 }), /integer/);
});

test('gmgn: runner refuses execution commands and missing configuration; never needs the private key for reads', async () => {
  await assert.rejects(G.runGmgn(['swap', '--chain', 'sol'], { GMGN_API_KEY: 'k' }), (e: any) => e.code === 'EXECUTION_BLOCKED');
  await assert.rejects(G.runGmgn(['market', 'trending'], {}), (e: any) => e.code === 'NOT_CONFIGURED');
  await assert.rejects(G.runGmgn(['market', 'trending'], { GMGN_API_KEY: 'k', GMGN_CLI: '/nonexistent/gmgn-cli', PATH: '' }), (e: any) => e.code === 'CLI_MISSING');
});

test('gmgn: tolerant RankItem mapping keeps unknowns null and uses provider-attested filters', () => {
  const now = 1_790_000_000;
  const m = G.mapRankItem({ address: 'Abc', symbol: 'CAT', liquidity: '25000', market_cap: 180000, volume: 52000, holder_count: 800, buys: 300, sells: 200,
    smart_degen_count: 4, renowned_count: 2, top_10_holder_rate: 0.18, dev_team_hold_rate: 0.02, creation_timestamp: now - 45 * 60, renounced_mint: true, renounced_freeze_account: true }, { requestedFilters: ['not_honeypot'], nowSec: now });
  assert.equal(m.ageMin, 45); assert.equal(m.top10Bps, 1800); assert.equal(m.devHoldingBps, 200); assert.equal(m.honeypot, 'safe'); assert.equal(m.mintAuthority, 'safe');
  assert.equal(m.change1hBps, null); assert.ok(m.unmapped.includes('change1hBps'));
  const u = G.mapRankItem({ address: 'X', symbol: 'Y' }, { nowSec: now });
  assert.equal(u.honeypot, 'unknown'); assert.equal(D.finderScore(u).passed, false, 'unknown data never passes');
  assert.equal(G.mapRankItem({ address: 'X', is_honeypot: 1 }).honeypot, 'risky');
});
