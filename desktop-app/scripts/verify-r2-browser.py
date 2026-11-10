"""Optional real-Chromium smoke test for v1.3.8-R2 task cards.
Requires Python playwright and an installed Chromium; not part of npm verify.
"""
import os
from pathlib import Path
from shutil import which
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
script = (root.parent / 'edge-extension' / 'background.js').read_text(encoding='utf-8')
start = script.index('function ybInject(action, payload) {')
stop = script.index('\nasync function tabIds()', start)
injected = script[start:stop]
fixture = root / 'tests' / 'fixtures' / 'r2-task-card-dom.html'
exe = os.environ.get('CHROMIUM_PATH') or which('chromium') or which('chrome')
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=exe, headless=True, args=['--no-sandbox']) if exe else p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width':900,'height':950})
    page.set_content(fixture.read_text(encoding='utf-8'))
    page.add_script_tag(content=injected)
    pending = page.evaluate('ybInject("human.scan",{includeDone:false,full:true})')
    titles = [c['title'] for c in pending['cards']]
    for t in ['任务A','任务B','任务C','任务E','任务F','Offer not completed','同名奖励']:
        assert t in titles, f'Incomplete pending detection: {t} {titles}'
    assert len([c for c in pending['cards'] if c['title']=='同名奖励']) == 2, 'Same-name distinct offers were collapsed'
    assert not any('任务D' in s for s in titles), 'Completed task not filtered'
    assert not any('隐藏任务' in s for s in titles), 'Hidden task must not be clicked'
    assert not any('可用积分' in s for s in titles), 'Profile balance must not be a task'
    assert not any(s == 'Offer completed' for s in titles), 'Completed offer must not be clicked'
    all_cards = page.evaluate('ybInject("human.scan",{includeDone:true,full:true})')['cards']
    assert any(c['title']=='任务D' for c in all_cards), 'Completed task should appear if opted in'
    for c in pending['cards']:
        aimed = page.evaluate('(c)=>ybInject("human.aim", {...c,includeDone:false,full:true})', c)
        assert aimed.get('ok'), f"Unable to recalculate clickable coordinates: {c['title']} {aimed.get('reason')}"
    indexed = page.evaluate('ybInject("human.aimIndexed",{href:"https://www.bing.com/search?q=one&form=OTHER",title:"任务A",points:10})')
    assert indexed.get('ok'), f'Indexed matching should ignore changed marketing form: {indexed}'
    ambiguous = page.evaluate('ybInject("human.aimIndexed",{title:"同名奖励",points:10})')
    assert not ambiguous.get('ok'), 'Ambiguous same-title cards must never be clicked arbitrarily'
    print(f'PASS Chromium card DOM: {len(pending["cards"])} pending targets, badges, pointer wrapper, unique IDs, completed/hidden filtering, hit-tests, URL fingerprint, ambiguity')
    browser.close()
