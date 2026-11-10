"""Optional Chromium test for the shared Calendar UI (Edge + Electron source).
Run: python scripts/verify-ui-calendar-browser.py
Requires Playwright and locally installed Chromium; no account/network access.
"""
from pathlib import Path
from shutil import which
import json
from datetime import date, timedelta
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
start = '  let calMode = '
end = '  /* 桌面版专有设置'
last_month = date.today().replace(day=1) - timedelta(days=1)
first = last_month.replace(day=1)
keys = [first,first + timedelta(days=1),first + timedelta(days=8)]
assert all(d.month == first.month for d in keys)
values = {d.strftime('%Y-%m-%d'): {'today': v} for d,v in zip(keys,(10,20,90))}

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=which('chromium'),headless=True,args=['--no-sandbox'])
    results = []
    for name in ('edge-extension','desktop-app/src'):
        base = root / name
        pop = (base/'popup.js').read_text(encoding='utf-8')
        fragment = pop[pop.index(start):pop.index(end,pop.index(start))]
        page = b.new_page(viewport={'width':380,'height':900})
        page.set_content('''<div class="set-group" id="calendar-group"><div class="cal-head">
          <button id="cal-prev" class="cal-nav"></button><span id="cal-range" class="cal-range"></span>
          <button id="cal-next" class="cal-nav"></button></div><div class="cal-hero">
          <span id="cal-total" class="cal-total"></span><span id="cal-hero-label"></span></div>
          <div id="cal-weekdays"></div><div id="cal-grid"></div>
          <div id="cal-summary"></div><div id="cal-mode"></div></div>''')
        page.add_style_tag(content=(base/'popup.css').read_text(encoding='utf-8'))
        setup = '''
          const $ = id => document.getElementById(id);
          let lang = 'zh';
          const dictionary = { 'calendar.summary': '日均 {avg} · 最高 {max} · {n} 天有积分',
            'calendar.weekLabel':'第{n}周', 'calendar.monthLabel':'{n}月',
            'calendar.cellTip':'{date}: {points}', 'calendar.noPointsTip':'{date}',
            'calendar.earnedDays':'{n} 天有积分' };
          function t(key,args) { let text = dictionary[key] || key;
            for (const [k,v] of Object.entries(args||{})) text=text.replace('{'+k+'}',v);
            return text; }
          const setSegment = () => {};
          window.chrome = {storage:{local:{get: async () => ({pointsHistory: HIST, pointsSummary:{today:null}})}}};
        '''.replace('HIST',json.dumps(values,ensure_ascii=False))
        page.add_script_tag(content=setup+'\n'+fragment)
        rows = []
        for mode in ('day','week','month'):
            page.evaluate('''async (args) => {
              calMode=args.mode;
              calCursor=new Date(args.year,args.month,1);
              await renderPointsCalendar();
            }''',{'mode':mode,'year':first.year,'month':first.month-1})
            value = page.locator('#cal-total').inner_text()
            summary = page.locator('#cal-summary').inner_text()
            cards = page.locator('#cal-grid .cal-cell').count()
            grey = page.locator('#cal-prev').get_attribute('data-empty')
            style = page.locator('#cal-grid').evaluate('''e=>({columns:getComputedStyle(e).gridTemplateColumns,
                width:Math.round(e.getBoundingClientRect().width)})''')
            assert value=='120',(name,mode,value)
            assert summary.startswith('日均 40 · 最高 90 · 3 天有积分'),(name,mode,summary)
            assert style['width'] <= 380,(name,mode,'Overflow',style)
            rows.append((mode, value, summary, cards, grey, style))
        results.append(rows)
        page.close()
    assert results[0] == results[1], 'Calendar rendering differs between extension & desktop'
    for row in results[0]:print('  ',row[0],':',row[1],row[2],':',row[3],'cards')
    print('PASS Chromium R4.2: Edge + desktop render matching daily/weekly/monthly layouts with correct 3-day averages and peaks')
    b.close()
