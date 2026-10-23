# 端對端瀏覽器測試（Playwright + Chromium，手機尺寸）
# 用法：先啟動伺服器 PORT=3100 npm start，再執行 python3 test/e2e/e2e.py [截圖資料夾]
import sys, os
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else 'test/e2e/shots'
os.makedirs(OUT, exist_ok=True)
B = os.environ.get('BASE', 'http://localhost:3100')
errors = []

with sync_playwright() as p:
    br = p.chromium.launch(channel='chromium')  # 新版 headless 才會正確回報通知權限
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, timezone_id='Asia/Taipei',
                         locale='zh-TW', has_touch=True, is_mobile=True, permissions=['notifications'])
    pg = ctx.new_page()
    pg.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))

    pg.goto(B); pg.wait_for_selector('#authf')
    pg.screenshot(path=f'{OUT}/01-auth.png')
    pg.click('[data-m=register]')
    pg.fill('#dn', 'Jaynie'); pg.fill('#em', f'jaynie{os.getpid()}@example.com'); pg.fill('#pw', 'password123')
    pg.click('#authf [type=submit]')
    pg.wait_for_selector('.empty h2'); pg.wait_for_timeout(450)
    pg.screenshot(path=f'{OUT}/02-empty.png')

    def add(name, times, amt='1', unit='顆', note=None, cat=None, stock=None, thr=None):
        pg.goto(B + '/#/items'); pg.wait_for_selector('[data-new]'); pg.click('[data-new]')
        pg.wait_for_selector('#medf')
        pg.fill('#name', name)
        if cat: pg.click(f'#cat [data-v={cat}]')
        pg.fill('#amt', amt); pg.fill('#unit', unit)
        for i, t in enumerate(times):
            if i > 0: pg.click('#addtime')
            pg.fill(f'#times input[data-i="{i}"]', t)
        if note: pg.click(f'#notechips [data-n="{note}"]')
        if stock: pg.fill('#stock', stock)
        if thr: pg.fill('#thr', thr)
        if name == '維他命 D':
            pg.screenshot(path=f'{OUT}/03-form.png')
            pg.locator('.sheet-body').evaluate('e=>e.scrollTop=9999')
            pg.screenshot(path=f'{OUT}/03b-form-bottom.png')
        pg.click('[data-save]')
        pg.wait_for_selector('#medf', state='detached', timeout=5000)

    # 表單驗證：空名稱
    pg.goto(B + '/#/items'); pg.wait_for_selector('[data-new]'); pg.click('[data-new]'); pg.wait_for_selector('#medf')
    pg.click('[data-save]'); pg.wait_for_timeout(300)
    assert '名稱' in pg.inner_text('#ferr'), pg.inner_text('#ferr')
    pg.click('.sheet [data-close]')

    add('維他命 D', ['08:00'], note='飯後', stock='12', thr='10')
    pg.wait_for_selector('.sheet h2:has-text("開啟提醒通知")', timeout=4000)
    pg.wait_for_timeout(300)
    pg.screenshot(path=f'{OUT}/04-push-guide.png'); pg.click('.sheet [data-close]')
    add('魚油', ['08:00', '20:00'], amt='2', unit='粒', note='隨餐')
    add('血壓藥', ['12:30'], amt='1', unit='錠', cat='medicine', note='飯後')
    add('益生菌', ['22:00'], amt='1', unit='包', cat='other', note='空腹')
    pg.wait_for_timeout(300)
    pg.screenshot(path=f'{OUT}/05-items.png', full_page=True)

    pg.goto(B + '/#/today'); pg.wait_for_selector('.sprout-card'); pg.wait_for_timeout(450)
    pg.screenshot(path=f'{OUT}/06-today.png')
    pg.screenshot(path=f'{OUT}/06b-today-full.png', full_page=True)
    pg.click('.slot-morning [data-act=take] >> nth=0'); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{OUT}/07-after-take.png')
    pg.click('.slot-morning [data-act=take] >> nth=0'); pg.wait_for_timeout(400)
    pg.click('.slot-noon [data-act=snooze]'); pg.wait_for_selector('[data-min]')
    pg.screenshot(path=f'{OUT}/08-snooze.png')
    pg.click('[data-min="30"]'); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{OUT}/09-progress.png', full_page=True)
    for sel in ['.slot-noon [data-act=take]', '.slot-evening [data-act=skip]', '.slot-bedtime [data-act=take]']:
        pg.click(sel); pg.wait_for_timeout(450)
    pg.wait_for_selector('.celebrate', timeout=3000)
    pg.wait_for_timeout(1200)
    pg.screenshot(path=f'{OUT}/10-celebrate.png')
    pg.click('.celebrate button')
    pg.screenshot(path=f'{OUT}/11-done.png', full_page=True)

    pg.click('.slot-morning [data-act=edit] >> nth=0'); pg.wait_for_selector('#ta')
    pg.fill('#ta', '07:45'); pg.screenshot(path=f'{OUT}/12-edit.png')
    pg.click('[data-s=taken]'); pg.wait_for_timeout(400)
    assert '07:45' in pg.inner_text('.slot-morning'), '補登時間未更新'

    pg.goto(B + '/#/calendar'); pg.wait_for_selector('.cal-grid'); pg.wait_for_timeout(450)
    pg.screenshot(path=f'{OUT}/13-calendar.png', full_page=True)
    pg.click('.cal-day.today'); pg.wait_for_selector('.sheet .item')
    pg.screenshot(path=f'{OUT}/14-day-detail.png')
    pg.click('.sheet [data-close]')

    pg.goto(B + '/#/settings'); pg.wait_for_selector('.group'); pg.wait_for_timeout(450)
    pg.screenshot(path=f'{OUT}/15-settings.png', full_page=True)
    pg.click('[data-a=push-guide]'); pg.wait_for_selector('#pon')
    pg.screenshot(path=f'{OUT}/16-push-diag.png')
    pg.click('#pon'); pg.wait_for_timeout(8000)
    perr = pg.locator('#perr')
    print('push attempt:', perr.inner_text() if perr.count() else '(sheet closed → subscribed)')
    pg.screenshot(path=f'{OUT}/17-push-attempt.png')
    print('sw controller:', pg.evaluate('navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL'))

    d = br.new_context(viewport={'width': 1280, 'height': 860}, timezone_id='Asia/Taipei')
    d.add_cookies(ctx.cookies())
    dp = d.new_page(); dp.goto(B + '/#/today'); dp.wait_for_selector('.sprout-card')
    dp.screenshot(path=f'{OUT}/18-desktop.png')
    br.close()

print('\n'.join(errors) or 'no console errors')
