"""Live-mode UI check (seeded pump-shaped data): pages render live shapes, unsupported views say so, auto trader buys a live coin."""
import sys, json, re
from playwright.sync_api import sync_playwright
BASE = sys.argv[1]; GOOD = sys.argv[2]; DB = sys.argv[3] if len(sys.argv) > 3 else None
import sqlite3, time
def indexer_alive():
    """Stand-in for a running indexer: fresh heartbeat (stream live) and fresh SOL/USD, so exit prices count as fresh."""
    if not DB: return
    c = sqlite3.connect(DB, timeout=10); now = int(time.time() * 1000)
    c.execute("INSERT INTO worker_state (key, value, updated_at) VALUES ('indexer', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", (json.dumps({'conn': 'live', 'liveSince': None}), now))
    r = c.execute("SELECT value FROM worker_state WHERE key = 'sol_usd'").fetchone()
    if r: v = json.loads(r[0]); v['at'] = now; c.execute("UPDATE worker_state SET value = ?, updated_at = ? WHERE key = 'sol_usd'", (json.dumps(v), now))
    c.commit(); c.close()
res = {'errors': [], 'overflow': [], 'checks': {}}
with sync_playwright() as p:
    b = p.chromium.launch()
    for vp in [(1440, 900), (390, 844)]:
        ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}); pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and '503' not in m.text else None)
        pg.goto(BASE + '/trenches'); pg.wait_for_timeout(700)
        pg.get_by_role('button', name='Log In', exact=True).click(); pg.get_by_role('button', name='Continue with a Demo account').click(); pg.wait_for_timeout(800)
        for r in ['/trenches', '/trending', '/auto', f'/token/solana/{GOOD}', '/portfolio', '/copy-trade/rank', '/monitor', '/ai']:
            errs.clear(); pg.goto(BASE + r); pg.wait_for_timeout(1000)
            if pg.evaluate("document.documentElement.scrollWidth > innerWidth + 1"): res['overflow'].append(f'{vp} {r}')
            if errs: res['errors'].append({'vp': vp, 'route': r, 'e': errs[:2]})
            if vp == (390, 844) or r in ('/auto', f'/token/solana/{GOOD}', '/copy-trade/rank'):
                pg.screenshot(path=f"docs/screenshots/live_{vp[0]}_{re.sub('[^a-z]+', '_', r.split('/')[1])}.png")
        if vp == (1440, 900):
            pg.goto(BASE + '/trenches'); pg.wait_for_timeout(800)
            res['checks']['trenches_live_cards'] = pg.locator('.tcard').count()
            res['checks']['live_tag'] = pg.locator('.sim-tag.live').count() > 0
            pg.goto(BASE + '/copy-trade/rank'); pg.wait_for_timeout(800)
            res['checks']['rank_renders_live'] = pg.locator('.state.err').count() == 0 and ('Realized P&L from pump.fun' in pg.content() or 'Nothing here' in pg.content() or pg.locator('table.rank').count() == 1)
            pg.goto(BASE + '/settings?tab=wallet'); pg.wait_for_timeout(900)
            res['checks']['wallet_tab_explains_gate'] = 'Sign in with your Solana wallet' in pg.content() or 'switched off' in pg.content()
            pg.screenshot(path='docs/screenshots/live_1440_trading_wallet.png')
            pg.goto(BASE + '/auto'); pg.wait_for_timeout(1000)
            res['checks']['finder_rows'] = pg.locator('.finder-row').count()
            pg.get_by_text('Fine-tune the numbers').click(); pg.get_by_label('Min quality score').fill('40')  # the seeded coin scores 45; default 50 correctly buys nothing
            indexer_alive()
            pg.get_by_role('button', name='Start auto trader', exact=True).click(); pg.wait_for_timeout(1500); indexer_alive(); pg.wait_for_timeout(4500)
            res['checks']['auto_positions'] = pg.locator('.pos-list li').count()
            res['checks']['auto_first_position'] = pg.locator('.pos-list li').first.inner_text()[:60] if res['checks']['auto_positions'] else None
            pg.screenshot(path='docs/screenshots/live_1440_auto_running.png', full_page=True)
        ctx.close()
    b.close()
print(json.dumps(res, indent=1))
