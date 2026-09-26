"""Auto page on a phone viewport: Finder renders, starter limits, start auto trader, worker buys + attaches exits."""
import sys, json
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8790'
res = {}
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(BASE + '/auto'); pg.wait_for_timeout(900)
    res['finder_rows_signed_out'] = pg.locator('.finder-row').count()
    pg.get_by_role('button', name='Log In', exact=True).click(); pg.get_by_role('button', name='Continue with a Demo account').click(); pg.wait_for_timeout(900)
    pg.screenshot(path='docs/screenshots/390x844_auto_setup.png', full_page=True)
    pg.get_by_label('Min finder score').fill('0')  # mechanism test: take the top pick whatever its score (default 50 may rightly buy nothing)
    pg.get_by_role('button', name='Use these limits').click(); pg.wait_for_timeout(700)
    pg.get_by_role('button', name='Start auto trader (paper)').click(); pg.wait_for_timeout(6000)  # worker tick = 2 s
    res['status_text'] = pg.locator('.auto-run h2').inner_text()
    res['positions'] = pg.locator('.pos-list li').count()
    res['win_rate_text'] = pg.locator('.stat-grid.compact .stat').first.inner_text().replace('\n', ' ')
    res['overflow'] = pg.evaluate("document.documentElement.scrollWidth > innerWidth + 1")
    pg.screenshot(path='docs/screenshots/390x844_auto_running.png', full_page=True)
    res['console_errors'] = errs[:3]
    b.close()
print(json.dumps(res, indent=1))
