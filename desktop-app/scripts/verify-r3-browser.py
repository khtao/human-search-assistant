"""Chromium smoke test for R3 calendar day/week/month and genuine scrollable DOM.
Uses an isolated mock storage so no user accounts or network are accessed.
"""
from pathlib import Path
from shutil import which
import json
from playwright.sync_api import sync_playwright
root = Path(__file__).resolve().parents[1]
pop = (root.parent/'edge-extension'/'popup.js').read_text(encoding='utf-8')
other = (root/'src'/'popup.js').read_text(encoding='utf-8')
a = pop.index('  let calMode = ')
b = pop.index('  /* 桌面版专有设置', a)
calendar = pop[a:b]
c = other.index('  let calMode = ')
d = other.index('  /* 桌面版专有设置', c)
assert calendar == other[c:d], 'Extension and desktop calendar logic must match'
bg = (root.parent/'edge-extension'/'background.js').read_text(encoding='utf-8')
a = bg.index('function ybInject(action, payload) {')
b = bg.index('\nasync function tabIds()',a)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=which('chromium'),headless=True,args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':440,'height':850})
    page.on('pageerror', lambda e: print('PAGE ERROR:', e))
    page.set_content('''<style>html,body{margin:0} #long{height:1500px}
      #inner{height:180px;overflow-y:auto;border:1px solid #ccc}
      #inner-content{height:1200px}</style>
      <div id="cal-range"></div><button id="cal-prev"></button><button id="cal-next"></button>
      <div id="cal-total"></div><div id="cal-hero-label"></div><div id="cal-weekdays"></div>
      <div id="cal-grid"></div><div id="cal-summary"></div>
      <div id="long"></div><div id="inner"><div id="inner-content"></div></div>''')
    page.add_style_tag(content=(root.parent/'edge-extension'/'popup.css').read_text(encoding='utf-8'))
    page.add_script_tag(content=bg[a:b])
    moved = page.evaluate('ybInject("human.scrollTo",{y:500})')
    assert moved['y'] > 300, moved
    inners = page.evaluate('ybInject("human.scrollers",{})')['scrollers']
    assert inners, 'Internal scrollable container is detected'
    moved_inner = page.evaluate('(idx)=>ybInject("human.scrollInner",{idx,y:430})',inners[0]['idx'])
    assert moved_inner['y'] >= 400, moved_inner
    now = __import__('datetime').datetime.now()
    today = f'{now.year}-{now.month:02d}-{now.day:02d}'
    prev_month = (now.replace(day=1) - __import__('datetime').timedelta(days=1)).strftime('%Y-%m-01')
    stub = '''const $ = id => document.getElementById(id);
      const lang = 'zh';
      const t = (key, vars) => {let out = key; for (const [k,v] of Object.entries(vars||{})) out=out.replace('{'+k+'}',v); return out;};
      const setSegment = ()=>{};
      window.chrome.storage = {local:{get:async () => ({pointsHistory: {
        'TODAY': {today: 35}, 'PREV': {today: 15}}, pointsSummary:{today:35}})}};
    '''.replace('TODAY',today).replace('PREV',prev_month)
    page.add_script_tag(content=stub+'\n'+calendar)
    page.evaluate("calMode='week'; calCursor=new Date(); renderPointsCalendar()")
    page.wait_for_timeout(100)
    week = page.locator('.cal-grid.cal-week .cal-cell')
    assert week.count() in (4,5,6), f'Expect 4-6 week cards; got {week.count()}'
    assert page.locator('.cal-week-strip .cal-week-dot').count() == week.count()*7
    page.evaluate("calMode='month'; renderPointsCalendar()")
    page.wait_for_timeout(100)
    assert page.locator('.cal-grid.cal-month .cal-cell').count()==12
    assert page.locator('.cal-cell.cal-month.cal-has').count() >= 1
    # A page with all-zero history must mute both arrows in the month and week views.
    page.evaluate("calCursor=new Date(2020,0,1); renderPointsCalendar()")
    page.wait_for_timeout(100)
    assert page.locator('#cal-prev').get_attribute('data-empty') == 'true'
    assert page.locator('#cal-next').get_attribute('data-empty') == 'true'
    assert page.locator('.cal-grid.cal-month .cal-cell.cal-past-empty').count()==12
    page.evaluate("calMode='week'; renderPointsCalendar()")
    page.wait_for_timeout(100)
    assert page.locator('#cal-prev').get_attribute('data-empty') == 'true'
    assert page.locator('#cal-next').get_attribute('data-empty') == 'true'
    print('PASS Chromium R3: real outer/inner scrolling, 7-day weekly strips, 12 monthly cards, empty-period grey navigation, extension/desktop parity')
    browser.close()
