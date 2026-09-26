"""JGG browser smoke: every route renders without console errors at each viewport; key flows work.
Usage: python3 tests/e2e/smoke.py [base_url] [out_dir]"""
import sys, json, os, re
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8790'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'docs/screenshots'
os.makedirs(OUT, exist_ok=True)
VIEWPORTS = [(1920,1080),(1440,900),(1280,800),(1024,768),(768,1024),(390,844),(360,800)]
ROUTES = ['/trenches','/auto','/trending','/copy-trade/rank','/copy-trade/radar','/monitor','/track','/portfolio','/rewards','/up-down','/perpetuals','/launch','/ai','/watchlist','/settings','/status']
results = {'errors': [], 'overflow': [], 'shots': [], 'flows': {}}
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width':1440,'height':900})
    page = ctx.new_page()
    errs = []
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/trenches'); page.wait_for_timeout(800)
    # sign in (demo)
    page.get_by_role('button', name='Log In', exact=True).click()
    page.get_by_role('button', name='Continue with a Demo account').click()
    page.wait_for_timeout(800)
    # discover a token + wallet for deep routes
    tok = page.evaluate("fetch('/api/v1/markets/migrated?chain=solana').then(r=>r.json()).then(j=>j.data.rows[0].address)")
    wal = page.evaluate("fetch('/api/v1/rank?chain=solana&period=7d').then(r=>r.json()).then(j=>j.data.rows[0].address)")
    routes = ROUTES + [f'/token/solana/{tok}', f'/wallet/solana/{wal}']
    for (w,h) in VIEWPORTS:
        page.set_viewport_size({'width':w,'height':h})
        for r in routes:
            errs.clear()
            page.goto(BASE + r); page.wait_for_timeout(900 if r in ('/trenches','/trending','/ai') or r.startswith('/token') else 500)
            ov = page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
            if ov: results['overflow'].append(f'{w}x{h} {r}')
            real = [e for e in errs if 'favicon' not in e]
            if real: results['errors'].append({'vp': f'{w}x{h}', 'route': r, 'errors': real[:3]})
            if (w,h) in [(1920,1080),(390,844)] or r in ('/trenches','/ai') or (r.startswith('/token') and (w,h) in [(1280,800),(768,1024)]):
                name = f"{OUT}/{w}x{h}_{re.sub('[^a-z0-9]+','_',r.split('/')[1] if not r.startswith('/token') and not r.startswith('/wallet') else r.split('/')[1])}{'_'+r.split('/')[2] if r.startswith('/copy-trade') else ''}.png"
                page.screenshot(path=name); results['shots'].append(name)
    # ---- Flow: quick buy from trending -> approve -> filled
    page.set_viewport_size({'width':1440,'height':900})
    page.goto(BASE + '/trending'); page.wait_for_timeout(1200)
    skipped = []
    for n in range(8):  # some fixture tokens have unknown liquidity → quote correctly refused; try the next row
        page.locator('button.qbuy').nth(n).click()
        try: page.get_by_role('button', name=re.compile('Approve & buy')).wait_for(timeout=3000); break
        except Exception: pass
        skipped.append(page.locator('.toasts').inner_text()[:80])
    results['flows']['quick_buy_refusals_seen'] = skipped
    page.get_by_role('button', name=re.compile('Approve & buy')).click(); page.wait_for_timeout(900)
    txt = page.locator('.drawer').inner_text()
    results['flows']['quick_buy'] = 'finalized' in txt.lower() and page.url.endswith('/trending')  # stayed on page (no row navigation)
    page.screenshot(path=f'{OUT}/flow_quickbuy_result.png')
    page.get_by_role('button', name='Done').click()
    # ---- Flow: portfolio shows the position
    page.goto(BASE + '/portfolio'); page.wait_for_timeout(1000)
    results['flows']['portfolio_position'] = page.locator('table.tbl tbody tr').count() > 0
    page.screenshot(path=f'{OUT}/flow_portfolio.png')
    # ---- Flow: AI run produces grounded answer
    page.goto(BASE + '/ai'); page.wait_for_timeout(800)
    page.get_by_role('button', name='Top trending tokens right now').click(); page.wait_for_timeout(1200)
    results['flows']['ai_run'] = page.locator('.answer p').count() > 0
    page.screenshot(path=f'{OUT}/flow_ai_run.png', full_page=False)
    # ---- Flow: skill detail + run C05 via drawer
    page.goto(BASE + f'/ai?skill=C05'); page.wait_for_timeout(900)
    page.get_by_label(re.compile('^address')).fill(tok)
    page.locator('.drawer').get_by_role('button', name='Run').click(); page.wait_for_timeout(900)
    results['flows']['skill_run'] = 'succeeded' in page.locator('.drawer').inner_text()
    page.screenshot(path=f'{OUT}/flow_skill_run.png')
    # ---- Flow: strategy needs risk policy (deny by default)
    page.goto(BASE + f'/token/solana/{tok}'); page.wait_for_timeout(1200)
    page.get_by_role('button', name='Set exits', exact=True).click(); page.wait_for_timeout(300)
    page.locator('.drawer').get_by_role('radio', name='Limit buy').click()
    page.locator('.drawer').get_by_label('Target price (USD)').fill('0.0000001')
    page.locator('.drawer').get_by_role('button', name='Activate').click(); page.wait_for_timeout(700)
    results['flows']['strategy_denied_without_policy'] = page.locator('.toast').count() > 0 and 'risk policy' in page.locator('.toasts').inner_text().lower()
    page.screenshot(path=f'{OUT}/flow_strategy_denied.png')
    b.close()
print(json.dumps(results, indent=1))
