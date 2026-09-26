"""T56 offline shell + T09 automated accessibility checks + T05 layout persistence. Usage: python3 tests/e2e/pwa_a11y.py [base]"""
import sys, json
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8790'
ROUTES = ['/trenches','/trending','/copy-trade/rank','/monitor','/track','/portfolio','/rewards','/up-down','/perpetuals','/launch','/ai','/watchlist','/settings','/status']
A11Y_JS = """() => {
  const name = el => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('alt') || '').trim();
  const out = [];
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=option], [role=radio]')) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (!name(el)) out.push({ issue: 'no accessible name', tag: el.tagName, cls: el.className });
  }
  for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) out.push({ issue: 'img without alt', src: img.src });
  if (!document.querySelector('main')) out.push({ issue: 'no main landmark' });
  if (!document.querySelector('h1')) out.push({ issue: 'no h1' });
  return out;
}"""
def lum(hexc):
    c=[int(hexc[i:i+2],16)/255 for i in (1,3,5)]; c=[x/12.92 if x<=0.03928 else ((x+0.055)/1.055)**2.4 for x in c]; return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def contrast(a,b): la,lb=sorted([lum(a),lum(b)],reverse=True); return (la+0.05)/(lb+0.05)
res = {'a11y': {}, 'contrast': {}, 'offline': None, 'layout_persisted': None, 'focus_visible': None}
for fg,label in [('#F3F5F6','text'),('#A1A8AF','text2'),('#8A939B','muted'),('#2DCF89','pos'),('#F05260','neg'),('#35CFFF','cyan'),('#FFBA45','amber')]:
    res['contrast'][label] = {bg: round(contrast(fg,bgc),2) for bg,bgc in [('canvas','#0B0B0C'),('panel','#111213'),('raised','#181A1B')]}
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width':1440,'height':900}); pg = ctx.new_page()
    pg.goto(BASE + '/trenches'); pg.wait_for_timeout(700)
    pg.get_by_role('button', name='Log In', exact=True).click(); pg.get_by_role('button', name='Continue with a Demo account').click(); pg.wait_for_timeout(900)
    for r in ROUTES:
        pg.goto(BASE + r); pg.wait_for_timeout(600)
        issues = pg.evaluate(A11Y_JS)
        if issues: res['a11y'][r] = issues[:5]
    # keyboard: Tab reaches a control with a visible focus outline
    pg.goto(BASE + '/trenches'); pg.wait_for_timeout(500); pg.keyboard.press('Tab'); pg.keyboard.press('Tab')
    res['focus_visible'] = pg.evaluate("(() => { const e = document.activeElement; const s = getComputedStyle(e); return !!e && e !== document.body && (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0); })()")
    # '/' focuses search; Escape closes a drawer and restores focus
    pg.keyboard.press('Escape'); pg.locator('body').click(position={'x':700,'y':400}); pg.keyboard.press('/')
    res['slash_focuses_search'] = pg.evaluate("document.activeElement?.getAttribute('aria-label')?.startsWith('Search') ?? false")
    # T05: collapse dock → reload in a fresh context (same account cookie) → still collapsed
    pg.goto(BASE + '/trenches'); pg.wait_for_timeout(500); pg.get_by_role('button', name='Collapse dock').click(); pg.wait_for_timeout(1500)
    pg.evaluate("localStorage.clear()"); pg.reload(); pg.wait_for_timeout(1500)
    res['layout_persisted'] = pg.locator('aside.dock').count() == 0
    pg.get_by_role('button', name='Toggle tracker dock').click() if pg.get_by_role('button', name='Toggle tracker dock').count() else None
    # T56: offline shell
    pg.goto(BASE + '/ai'); pg.wait_for_timeout(1500)  # SW installed + shell cached
    ctx.set_offline(True); pg.reload(); pg.wait_for_timeout(1500)
    res['offline'] = { 'shell_rendered': pg.locator('header.topnav').count() == 1, 'shows_offline_banner': pg.locator('.offline-banner').count() == 1, 'shows_error_state': pg.locator('.state.err').count() > 0 }
    pg.screenshot(path='docs/screenshots/offline_shell.png'); ctx.set_offline(False); b.close()
print(json.dumps(res, indent=1))
