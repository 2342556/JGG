// Alert evaluation (spec §7): deduplicated by (alert, window bucket), respects cooldown, in-app delivery log.
import { type DB, qa, q1, run } from './db.ts';
import { newId } from './http.ts';
import * as M from '../../../packages/providers/src/market.ts';
import { fixtureTokens, fixtureTrades } from '../../../packages/test-fixtures/src/index.ts';
import type { Chain } from '../../../packages/contracts/src/index.ts';

export function evaluateAlerts(db: DB, now: number): { evaluated: number; fired: number } {
  const alerts = qa(db, `SELECT * FROM alerts WHERE enabled = 1 LIMIT 1000`);
  let fired = 0;
  for (const a of alerts) {
    const cfg = JSON.parse(a.config); const chain = cfg.chain as Chain;
    if (a.last_fired && now - a.last_fired < cfg.cooldownSec * 1000) { run(db, `UPDATE alerts SET last_eval = ? WHERE id = ?`, now, a.id); continue; }
    const windowMs = cfg.windowSec * 1000; const bucket = Math.floor(now / windowMs);
    const hits: { key: string; title: string; body: string; data: unknown }[] = [];
    if (cfg.kind === 'price_swing') {
      const items = qa(db, `SELECT i.chain, i.address FROM watchlist_items i JOIN watchlists w ON w.id = i.watchlist_id WHERE w.user_id = ? AND i.chain = ? ${cfg.watchlistId ? 'AND w.id = ?' : ''}`, a.user_id, chain, ...(cfg.watchlistId ? [cfg.watchlistId] : []));
      for (const it of items) {
        const t = fixtureTokens(chain, now).find(x => x.address === it.address); if (!t) continue;
        const r = M.tokenRow(t, now); const win = cfg.windowSec <= 60 ? '1m' : cfg.windowSec <= 300 ? '5m' : cfg.windowSec <= 3600 ? '1h' : cfg.windowSec <= 21600 ? '6h' : '24h';
        const ch = r.change[win as keyof typeof r.change];
        if (ch !== null && Math.abs(ch) >= cfg.thresholdBps) hits.push({ key: `${it.address}`, title: `${r.symbol} ${ch > 0 ? '+' : ''}${(ch / 100).toFixed(1)}% (${win})`, body: `Watchlist swing above ${(cfg.thresholdBps / 100).toFixed(1)}% — simulated data`, data: { token: it.address, changeBps: ch, window: win } });
      }
    } else if (cfg.kind === 'smart_buy_cluster' || cfg.kind === 'smart_exit') {
      const side = cfg.kind === 'smart_exit' ? 'sell' : 'buy';
      for (const s of M.signals(chain, now, 'cluster', { side, minWallets: Math.max(2, Math.round((cfg.thresholdBps ?? 300) / 100)), windowMs }) as any[])
        hits.push({ key: s.token, title: `${s.symbol}: ${s.distinctWallets} smart wallets ${side === 'buy' ? 'bought' : 'sold'}`, body: `Cluster within ${cfg.windowSec}s — simulated`, data: s });
    } else if (cfg.kind === 'surge') {
      for (const s of M.signals(chain, now, 'surge', { minChangeBps: cfg.thresholdBps ?? 2000 }) as any[]) hits.push({ key: s.token, title: `${s.symbol} surging +${(s.changeBps / 100).toFixed(1)}%/5m`, body: 'Price surge — simulated', data: s });
    } else if (cfg.kind === 'wallet_trade' || cfg.kind === 'dev_sell') {
      const tracked = new Set(qa(db, `SELECT address FROM tracked_wallets WHERE user_id = ? AND chain = ? AND muted = 0`, a.user_id, chain).map(r => r.address));
      const devs = new Set(fixtureTokens(chain, now).map(t => t.creator));
      for (const x of fixtureTrades(chain, Math.max(a.last_eval ?? now - windowMs, now - windowMs), now))
        if ((cfg.kind === 'wallet_trade' && tracked.has(x.wallet)) || (cfg.kind === 'dev_sell' && x.side === 'sell' && devs.has(x.wallet)))
          hits.push({ key: x.eventId, title: `${cfg.kind === 'dev_sell' ? 'Dev sell' : 'Tracked wallet ' + x.side}`, body: `${x.wallet.slice(0, 6)}… ${x.side} $${x.amountUsd} — simulated`, data: x });
    }
    for (const h of hits.slice(0, 10)) {
      const dedupe = `${a.id}:${h.key}:${bucket}`;
      const ok = Number(run(db, `INSERT OR IGNORE INTO alert_events (id, alert_id, user_id, dedupe, detail, at) VALUES (?, ?, ?, ?, ?, ?)`, newId('ae'), a.id, a.user_id, dedupe, JSON.stringify({ title: h.title, data: h.data }), now).changes) === 1;
      if (!ok) continue;
      fired++;
      run(db, `INSERT OR IGNORE INTO notifications (id, user_id, kind, title, body, dedupe, destination, delivery, at) VALUES (?, ?, 'alert', ?, ?, ?, 'in_app', 'delivered', ?)`, newId('ntf'), a.user_id, `${cfg.name}: ${h.title}`, h.body, `alert:${dedupe}`, Date.now());
      run(db, `INSERT INTO outbox_events (user_id, topic, payload, created_at) VALUES (?, ?, ?, ?)`, a.user_id, `alerts:${a.user_id}`, JSON.stringify({ alertId: a.id, title: h.title }), Date.now());
      run(db, `UPDATE alerts SET last_fired = ? WHERE id = ?`, now, a.id);
    }
    run(db, `UPDATE alerts SET last_eval = ? WHERE id = ?`, now, a.id);
  }
  return { evaluated: alerts.length, fired };
}
void q1;
