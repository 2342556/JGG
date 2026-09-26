"""Exit plan UI on a phone (390x844), PAPER mode: editor + validation + preview, auto trader positions with exact levels,
per-position override, and exits on a manually bought coin (exact numbers from the real fill). Usage: python3 tests/e2e/exits_mobile.py <base>"""
import sys, json, re
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8795'
OUT = 'docs/screenshots'
res = {'checks': {}, 'console_errors': []}
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(BASE + '/auto'); pg.wait_for_timeout(900)
    pg.get_by_role('button', name='Log In', exact=True).click(); pg.get_by_role('button', name='Continue with a Demo account').click(); pg.wait_for_timeout(1200)
    pg.get_by_text('Fine-tune the numbers').click(); pg.wait_for_timeout(1200)
    res['checks']['editor_rules'] = pg.locator('.exit-editor .rule').count()
    res['checks']['preview_text'] = pg.locator('.exit-preview').first.inner_text()[:160] if pg.locator('.exit-preview').count() else None
    pg.screenshot(path=f'{OUT}/390x844_exit_editor.png', full_page=True)
    # validation: stop loss 0% is refused, start disabled
    sl = pg.get_by_label('Stop loss percent below entry'); sl.fill('0'); pg.wait_for_timeout(300)
    res['checks']['invalid_message'] = pg.locator('.exit-issues').inner_text() if pg.locator('.exit-issues').count() else None
    res['checks']['start_disabled_when_invalid'] = pg.get_by_role('button', name='Start auto trader', exact=True).is_disabled()
    sl.fill('20'); pg.wait_for_timeout(300)
    pg.get_by_label('Min quality score').fill('0')
    pg.get_by_role('button', name='Start auto trader', exact=True).click(); pg.wait_for_timeout(7000)
    res['checks']['positions'] = pg.locator('.pos-list li').count()
    res['checks']['levels_text'] = pg.locator('.pos-list .levels').first.inner_text() if pg.locator('.pos-list .levels').count() else None
    pg.screenshot(path=f'{OUT}/390x844_auto_exits_running.png', full_page=True)
    if pg.get_by_role('button', name='Edit exits').count():
        pg.get_by_role('button', name='Edit exits').first.click(); pg.wait_for_timeout(1200)
        res['checks']['override_preview_exact'] = 'Exact numbers' in pg.locator('.drawer').inner_text()
        pg.locator('.drawer').get_by_label('Trailing distance percent').fill('25'); pg.wait_for_timeout(600)
        pg.screenshot(path=f'{OUT}/390x844_exit_override.png', full_page=False)
        pg.locator('.drawer').get_by_role('button', name='Save for this position').click(); pg.wait_for_timeout(1200)
        res['checks']['override_saved'] = pg.evaluate("fetch('/api/v1/strategies').then(r=>r.json()).then(j=>j.find(s=>s.kind==='position_exit')?.params?.exit?.trailing?.pct)")
    # manual position on a coin → exits with exact numbers from the real fill
    pg.goto(BASE + '/trending'); pg.wait_for_timeout(1500)
    bought = None
    for n in range(8):
        pg.locator('button.qbuy').nth(n).click()
        try:
            pg.get_by_role('button', name=re.compile('Approve & buy')).wait_for(timeout=3000); pg.get_by_role('button', name=re.compile('Approve & buy')).click(); pg.wait_for_timeout(900)
            pg.get_by_role('button', name='Done').click(); bought = n; break
        except Exception: pass
    tok = pg.evaluate("fetch('/api/v1/orders?limit=5').then(r=>r.json()).then(j=>(j.rows||j.data||j).find(o=>o.side==='buy' && !o.strategyId && o.state==='finalized')?.token)")
    res['checks']['manual_buy_token'] = bool(tok)
    pg.goto(BASE + f'/token/solana/{tok}'); pg.wait_for_timeout(1500)
    pg.get_by_role('button', name='Set exits', exact=True).click(); pg.wait_for_timeout(1500)
    txt = pg.locator('.drawer').inner_text()
    res['checks']['token_preview_exact'] = 'Exact numbers' in txt and 'Entry (avg fill)' in txt
    pg.screenshot(path=f'{OUT}/390x844_token_exits.png', full_page=False)
    pg.locator('.drawer').get_by_role('button', name='Turn on exits').click(); pg.wait_for_timeout(1200)
    res['checks']['token_exit_active'] = pg.evaluate(f"fetch('/api/v1/strategies').then(r=>r.json()).then(j=>j.filter(s=>s.kind==='position_exit' && s.token==='{tok}').map(s=>s.lifecycle))")
    res['checks']['overflow'] = pg.evaluate("document.documentElement.scrollWidth > innerWidth + 1")
    res['console_errors'] = [e for e in errs if 'favicon' not in e][:5]
    b.close()
print(json.dumps(res, indent=1))
