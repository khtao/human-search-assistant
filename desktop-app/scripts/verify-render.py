#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
可选的端到端渲染验证（需要 playwright + 本机 Chromium，CI 不依赖此脚本）。

它不启动 Electron，而是用无头浏览器加载桌面版的两个页面，并注入一份与
preload.js 等价的 chrome.* stub，用来证明：
  1. host.html 能加载「一字未改」的 src/background.js 且无脚本错误；
  2. 全局 fetch 被换成会话代理后仍返回 background.js 期待的 Response-like；
  3. popup.html 在兼容层下正常渲染，点击「可领取」会走 chrome.tabs.create；
  4. 桌面设置页的 skipCompletedCards 控件可读写。

运行： python3 scripts/verify-render.py
"""
import json
import os
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.environ.get('HSA_CHROMIUM') or next((p for p in ('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/local/bin/chromium') if os.path.exists(p)), '/usr/local/bin/chromium')
PAGE = None
checks = []


def ck(cond, msg):
    checks.append((bool(cond), msg))


STUB = r"""
window.__tabs = [];
window.__fetchCalls = [];
window.__storage = SEED;
const evt = () => ({ addListener(){}, removeListener(){}, hasListener(){return false;}, hasListeners(){return false;} });
const noop = () => Promise.resolve(null);
const keysOf = k => Array.isArray(k) ? k : (typeof k === 'string' ? [k] : Object.keys(k || {}));
window.chrome = {
  storage: {
    local: {
      get: k => { const o = {}; for (const x of keysOf(k)) if (x in window.__storage) o[x] = window.__storage[x]; return Promise.resolve(o); },
      set: o => { Object.assign(window.__storage, o); return Promise.resolve(); },
      remove: noop, clear: () => Promise.resolve()
    },
    onChanged: evt()
  },
  runtime: {
    id: 'desktop-stub',
    sendMessage: () => Promise.resolve({ ok: true }),
    getURL: p => p, getManifest: () => Promise.resolve({}),
    onMessage: evt(), onInstalled: evt(), onStartup: evt()
  },
  tabs: {
    get: () => Promise.resolve(null), query: () => Promise.resolve([]),
    create: o => { window.__tabs.push(o.url); return Promise.resolve({ id: 1, url: o.url }); },
    update: () => Promise.resolve({}), remove: noop, goBack: noop,
    onUpdated: evt(), onRemoved: evt(), onActivated: evt()
  },
  scripting: { executeScript: () => Promise.resolve([{ frameId: 0, result: null, error: null }]) },
  debugger: { attach: noop, detach: noop, sendCommand: () => Promise.resolve({}), onEvent: evt(), onDetach: evt() },
  alarms: { create: noop, clear: () => Promise.resolve(true), get: () => Promise.resolve(null),
            getAll: () => Promise.resolve([]), onAlarm: evt() },
  windows: { update: noop, get: noop, getCurrent: noop, onCreated: evt(), onRemoved: evt() },
  permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true),
                 remove: () => Promise.resolve(true), getAll: () => Promise.resolve({ origins: [] }),
                 onAdded: evt(), onRemoved: evt() },
  action: { setBadgeText: noop, setTitle: noop },
  i18n: { getUILanguage: () => 'zh-CN' }
};
window.__desktop = {
  nextId: (() => { let i = 0; return () => ++i; })(),
  abort: () => {},
  fetchRaw: (url, init, id) => {
    window.__fetchCalls.push({ url, id });
    return Promise.resolve({
      ok: true, status: 200, url, headers: { 'content-type': 'text/html' },
      body: '<html><body>fake rewards payload</body></html>', error: null
    });
  },
  shimVersion: 'stub'
};
"""


# v1.0.9：桌面版 stub 额外提供 desktopPanel / onPanel，用来验证右侧面板按钮
STUB_DESKTOP = STUB + r"""
window.__panelCalls = [];
window.__panelOpen = false;
window.__panelListeners = [];
const emitPanel = open => { for (const fn of window.__panelListeners) fn({ open }); };
window.chrome.desktopPanel = {
  show: url => { window.__panelCalls.push(['show', url]); window.__panelOpen = true;
                 emitPanel(true); return Promise.resolve({ open: true, url }); },
  hide: () => { window.__panelCalls.push(['hide']); window.__panelOpen = false;
                emitPanel(false); return Promise.resolve({ open: false }); },
  toggle: () => { window.__panelOpen = !window.__panelOpen;
                  window.__panelCalls.push(['toggle', window.__panelOpen]);
                  emitPanel(window.__panelOpen);
                  return Promise.resolve({ open: window.__panelOpen }); },
  state: () => Promise.resolve({ open: window.__panelOpen, reason: null })
};
window.chrome.onPanel = { addListener: fn => window.__panelListeners.push(fn),
  removeListener(){}, hasListener(){return false;}, hasListeners(){return false;} };
/* v1.1.5：让 storage.onChanged 真正派发，才能验证「登录成功自动收起侧栏」 */
window.__storageListeners = [];
window.chrome.storage.onChanged = {
  addListener: fn => window.__storageListeners.push(fn),
  removeListener(){}, hasListener(){return false;}, hasListeners(){return false;}
};
window.__setStorage = obj => {
  const changes = {};
  for (const [k, v] of Object.entries(obj))
    changes[k] = { oldValue: window.__storage[k], newValue: v };
  Object.assign(window.__storage, obj);
  for (const fn of window.__storageListeners) fn(changes, 'local');
};
window.chrome.storage.local.set = o => { window.__setStorage(o); return Promise.resolve(); };
"""


def make_stub(seed, desktop=False):
    base = STUB_DESKTOP if desktop else STUB
    return base.replace('SEED', json.dumps(seed or {}, ensure_ascii=False))


def run(browser, name, url, seed, desktop=False):
    ctx = browser.new_context(viewport={'width': 420, 'height': 900}, locale='zh-CN')
    ctx.add_init_script(make_stub(seed, desktop))
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='domcontentloaded', timeout=25000)
    page.wait_for_timeout(800)
    r = {'name': name, 'pageErrors': list(errs)}
    r['fetchProxyInstalled'] = page.evaluate("typeof window.fetch === 'function' && !!window.__desktop")
    if name == 'host':
        r['responseLike'] = page.evaluate(
            "async () => { const r = await window.fetch('https://rewards.bing.com/earn'); "
            "return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 20) }; }")
    if name == 'popup':
        r['title'] = page.title()
        r['langToggle'] = page.locator('#lang-toggle').count()
        r['claimClass'] = page.locator('#claim-card').get_attribute('class')
        # v1.1.5：三张积分卡已隐藏，dispatch_event 不要求元素可见
        page.locator('#claim-card').dispatch_event('click')
        page.wait_for_timeout(100)
        r['tabsCreated'] = page.evaluate('window.__tabs')
        r['testGroup'] = page.locator('#test-group').count()
    elif desktop:
        # v1.1.5：顶端只保留登录、设置两个按键；收起按钮已删除
        r['panelToggleCount'] = page.locator('#panel-toggle').count()
        r['topVisibleButtons'] = page.locator('.header-actions button:visible').count()
        r['badgeIconCount'] = page.locator('#login-badge-icon').count()
        r['badgeTextVisible'] = page.locator('#login-badge-text').is_visible()
        r['pointsGridHidden'] = not page.locator('.points-grid').is_visible()
        r['loginAria'] = page.locator('#login-badge').get_attribute('aria-label')
        # v1.3.7：桌面设置页面与浏览器插件共用同一组控件，检查新设置能读写。
        page.locator('#settings-open').click()
        page.wait_for_timeout(80)
        r['skipCompletedExists'] = page.locator('#set-skip-completed').count()
        r['skipCompletedDefault'] = page.locator('#set-skip-completed').is_checked()
        page.locator('#set-skip-completed').check()
        r['skipCompletedPersisted'] = page.evaluate("window.__storage.settings.skipCompletedCards")
        page.locator('#settings-back').click()
        # v1.3.3：先明确置为未登录，点击徽标才是「去登录」并登记等待登录。
        # 已登录时单击只是开关侧栏（纯界面动作），不登记、不会自动收起。
        page.evaluate("""window.__setStorage({loginStatus:'out',
          pointsSummary:{available:null,today:null,claimable:null,signedOut:true,updatedAt:Date.now()}})""")
        page.locator('#login-badge').click()      # 未登录：打开右侧官网登录页
        page.wait_for_timeout(420)
        r['bodyClass'] = page.locator('body').get_attribute('class') or ''
        r['appWidth'] = page.evaluate("getComputedStyle(document.querySelector('.app')).width")
        r['panelCalls'] = page.evaluate('window.__panelCalls')
        # v1.1.5 交互：登录成功（out -> in）应显示图标并自动收起侧栏
        # 真实登录成功时统一同步会「同一批」写回 loginStatus 与有效积分
        page.evaluate("""window.__setStorage({loginStatus:'in',
          pointsSummary:{available:20192,today:257,claimable:0,signedOut:false,updatedAt:Date.now()}})""")
        page.wait_for_timeout(320)
        r['autoHideOnLogin'] = any(c == ['hide'] for c in page.evaluate('window.__panelCalls'))
        r['badgeIconVisibleAfterLogin'] = page.locator('#login-badge-icon').is_visible()
        r['badgeTextVisibleAfterLogin'] = page.locator('#login-badge-text').is_visible()
        # 已登录单击 -> 收起 / 关闭侧栏
        page.evaluate("window.__panelCalls.length = 0")
        # v1.1.6：单击是「切换」，先把侧栏置为展开态，点击才应执行收起
        page.evaluate("document.body.classList.add('panel-open')")
        page.locator('#login-badge').click()
        page.wait_for_timeout(430)
        r['singleClickCalls'] = page.evaluate('window.__panelCalls')
        # 已登录双击 -> 跳转官网；单击定时器必须被取消，不能顺带 hide
        page.evaluate("window.__panelCalls.length = 0")
        page.evaluate("""() => {
          const b = document.getElementById('login-badge');
          b.dispatchEvent(new MouseEvent('click', {bubbles:true}));
          b.dispatchEvent(new MouseEvent('click', {bubbles:true}));
          b.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
        }""")
        page.wait_for_timeout(430)
        r['doubleClickCalls'] = page.evaluate('window.__panelCalls')
        shot = os.environ.get('HSA_RENDER_SHOT')
        if shot:
            try: page.screenshot(path=shot, full_page=True)
            except Exception: pass   # 截图只是可选产物，绝不让验证因此失败
    r['fetchCalls'] = page.evaluate('window.__fetchCalls.length')
    ctx.close()
    return r


def main():
    global PAGE
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=ROOT))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    PAGE = f'http://127.0.0.1:{server.server_port}/'
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path=EXE,
                                        args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'])
            host = run(browser, 'host', PAGE + 'host.html', {})
            popup = run(browser, 'popup', PAGE + 'src/popup.html', {
                'phase': 'idle', 'running': False,
                'todayTasks': {'items': [{'name': '今日 Bing 搜索', 'points': 60, 'earned': 60,
                                          'section': 'search', 'completed': True}],
                               'percent': 100, 'earned': 60, 'total': 60},
                'pointsSummary': {'available': 20182, 'today': 257, 'claimable': 0, 'updatedAt': 1700000000000}
            })
            desktop = run(browser, 'desktop', PAGE + 'src/popup.html', {
                'phase': 'idle', 'running': False,
                'settings': {'skipCompletedCards': False},
                'pointsSummary': {'available': 20192, 'today': 257, 'claimable': 0, 'updatedAt': 1700000000000}
            }, desktop=True)
            browser.close()

        print(json.dumps([host, popup, desktop], ensure_ascii=False, indent=2))
        print('\n=== 断言汇总 ===')
        ck(not host['pageErrors'], 'host.html 加载未改动的 background.js 无脚本错误')
        ck(host['fetchProxyInstalled'], 'host 已安装 fetch 会话代理')
        ck(host['responseLike']['ok'] and host['responseLike']['status'] == 200,
           '代理 fetch 返回 Response-like（ok/status/text）')
        ck(not popup['pageErrors'], 'popup.html 在兼容层下无脚本错误')
        ck(popup['title'] == '拟人搜索助手', '主窗口标题正确')
        ck(popup['langToggle'] == 0, '首页语言切换按钮已移除（沿用修改版）')
        ck('accent' not in (popup['claimClass'] or ''), '可领取卡片与其他卡片外观一致')
        ck(popup['tabsCreated'] == ['https://rewards.bing.com/dashboard'], '点击可领取卡片走 chrome.tabs.create')
        ck(popup['testGroup'] == 0, '拟人搜索测试功能已移除')
        ck(desktop['panelToggleCount'] == 0 and desktop['topVisibleButtons'] == 2,
           'v1.1.5 顶端只保留登录、设置两个按键，收起按钮已删除')
        ck(desktop['badgeIconCount'] == 1 and desktop['badgeTextVisible'],
           '未登录显示灰色重绘图标 +「未登录」文字')
        ck(not desktop['pointsGridHidden'], '左侧三张积分卡保留以呈现今日积分')
        ck(not desktop['pageErrors'], '桌面版 popup 无脚本错误')
        ck(desktop['skipCompletedExists'] == 1 and not desktop['skipCompletedDefault'],
           '桌面设置页显示跳过已完成任务卡，默认关闭')
        ck(desktop['skipCompletedPersisted'] is True, '桌面设置变更写入 skipCompletedCards')
        ck(any(c == ['show', 'https://rewards.bing.com/dashboard'] for c in desktop['panelCalls']),
           '点击登录按钮直达右侧官网登录页（不开新窗口）')
        ck('panel-open' in desktop['bodyClass'],
           '面板广播仍同步 body.panel-open（收起按钮删除后布局不跑偏）')
        ck(desktop['appWidth'] == '400px', '展开时左侧助手 UI 固定 400px')
        ck(desktop['autoHideOnLogin'] and desktop['badgeIconVisibleAfterLogin'] and
           desktop['badgeTextVisibleAfterLogin'],
           '登录成功后显示金色重绘图标 +「已登录」并自动收起右侧侧栏')
        ck(desktop['singleClickCalls'] == [['hide']],
           '已登录单击徽标收起/关闭侧栏')
        ck(any(c[0] == 'show' for c in desktop['doubleClickCalls']) and
           not any(c[0] == 'hide' for c in desktop['doubleClickCalls']),
           '已登录双击徽标跳转官网，且不会顺带收起（单击定时器已取消）')
        for ok, msg in checks:
            print(('✓ ' if ok else '✗ ') + msg)
        bad = [m for ok, m in checks if not ok]
        print(f'\n共 {len(checks)} 项，通过 {len(checks)-len(bad)} 项，失败 {len(bad)} 项')
        if bad:
            raise SystemExit(1)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
