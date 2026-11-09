#!/usr/bin/env node
/* ============================================================================
 * 用「用户真机抓到的官网 HTML」跑完整链路（v1.1.4）
 *
 * 与 verify-logged-in-e2e.js 的区别：
 *   · fixture 不是仿真页，而是用户 debug 现场里 349KB 的真实
 *     Rewards 首页 outerHTML（已脱敏姓名），含真实的 React 结构、
 *     RSC flight payload、20,192 积分卡与任务区；
 *   · 在 host 页面里**显式模拟 Chromium contextBridge 的函数代理行为**：
 *     把 spec.func 换成 toString() === 'function () { [native code] }' 的代理，
 *     保留 spec.funcSource。这样真实浏览器也走真机那条路径 ——
 *     修复前必现 855 次 SyntaxError，修复后必须正常读到积分；
 *   · 断言落在 storage 与 popup 渲染上，不是静态字符串匹配。
 *
 * 运行： npm run verify:real
 *       HSA_REAL_HTML=<你自己的 side-panel-*.html> npm run verify:real
 * ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-real-'));
process.env.HSA_HEADLESS = '1';
process.env.HSA_E2E = '1';
process.env.HSA_USER_DATA = tmp;
process.env.HSA_DEBUG = '1';   // v1.1.6：调试默认禁用，验证脚本显式开启
process.env.HSA_DEBUG_DIR = path.join(tmp, 'debug');
process.env.HSA_CHROMIUM = process.env.HSA_CHROMIUM || '/usr/local/bin/chromium';

const ROOT = path.join(__dirname, '..');
const defaultFixture = path.join(ROOT, 'tests', 'fixtures', 'rewards-dashboard-real.html');
const FIXTURE_PATH = process.env.HSA_REAL_HTML || defaultFixture;

let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = () => {
  try { return JSON.parse(fs.readFileSync(path.join(tmp, 'storage.json'), 'utf8')); }
  catch { return {}; }
};
async function waitFor(label, predicate, timeoutMs = 22000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return true;
    await sleep(300);
  }
  ck(false, `${label}（等待 ${timeoutMs}ms 超时）`);
  return false;
}

async function main() {
  group('1. 真机现场 HTML');
  ck(fs.existsSync(FIXTURE_PATH), '找到页面 HTML：' + path.basename(FIXTURE_PATH));
  const FIXTURE = fs.readFileSync(FIXTURE_PATH, 'utf8');
  ck(FIXTURE.length > 100000, '是完整的官网 outerHTML（' + FIXTURE.length + ' 字节）');
  ck(/20,192/.test(FIXTURE) && /可用积分/.test(FIXTURE), '页面里确实有 20,192 分与「可用积分」');
  ck(!/红涛|康/.test(FIXTURE), 'fixture 已脱敏姓名');

  const lite = require('../lib/electron-lite');
  const ctx = await lite._onReady();
  await ctx.route('https://rewards.bing.com/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE }));
  await ctx.route('https://login.live.com/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<html><body>Sign in to your Microsoft account. No account? Create one.</body></html>' }));
  await ctx.route('https://www.bing.com/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html>Bing</html>' }));

  require('../main.js');
  await sleep(6500);

  const pages = lite._pages();
  const host = pages.find(p => p.url.includes('host.html'));
  const popup = pages.find(p => p.url.includes('popup.html'));
  ck(!!host && !!host.page && !!popup && !!popup.page, 'host 与 popup 页面已就绪');

  group('2. 注入 Chromium contextBridge 的函数代理模拟（真机病灶）');
  const bridge = await host.page.evaluate(() => {
    const c = window.chrome;
    if (!c || !c.scripting || typeof c.scripting.executeScript !== 'function') {
      return { ok: false, reason: 'chrome.scripting 不可用' };
    }
    const orig = c.scripting.executeScript;
    /* contextBridge 把 main world 的函数属性换成 isolated world 代理 */
    const proxy = function () {};
    Object.defineProperty(proxy, 'toString', {
      value: () => 'function () { [native code] }', configurable: true
    });
    const patched = Object.assign({}, c.scripting, {
      executeScript: spec => orig.call(c.scripting, Object.assign({}, spec || {}, { func: proxy }))
    });
    Object.defineProperty(window, 'chrome', {
      value: Object.assign({}, c, { scripting: patched }),
      configurable: true, writable: true
    });
    return { ok: true, proxyToString: String(window.chrome.scripting ? proxy : '') };
  });
  ck(bridge.ok === true, '已在 host 页面模拟 contextBridge 代理');
  ck(/\[native code\]/.test(bridge.proxyToString || ''),
     '代理函数 toString() 确为真机那个值：' + (bridge.proxyToString || '').slice(0, 60));

  group('3. 打开右侧官网面板（真实加载 349KB 页面）');
  await lite.ipcMain.invoke('chrome:panel:show', 'https://rewards.bing.com/dashboard');
  await sleep(3000);
  const panel = await lite.ipcMain.invoke('chrome:panel:state');
  ck(panel.open === true, '右侧面板展开');
  const side = ctx.pages().find(p => /rewards\.bing\.com/.test(p.url()));
  ck(!!side, 'BrowserView 创建了真实页面');
  if (side) {
    const txt = await side.evaluate(() => document.body.innerText);
    ck(/20,192/.test(txt), '官网页面真实渲染出 20,192（与用户截图一致）');
  }

  group('4. 在代理模拟下触发全量刷新，走完整注入 → 解析链路');
  const before = state();
  /* 串行触发，模拟 startup 的顺序刷新；并发触发会人为制造导航竞态 */
  const fired = await host.page.evaluate(async () => {
    try { if (typeof window.invalidateEmbeddedCache === 'function') window.invalidateEmbeddedCache(); } catch {}
    let n = 0;
    for (const name of ['detectLogin', 'refreshPointsOnly', 'refreshTodayTasks']) {
      try {
        if (typeof window[name] === 'function') { await Promise.resolve(window[name]()).catch(() => null); n++; }
      } catch {}
    }
    return n;
  }).catch(e => { console.log('    evaluate err:', e.message); return 0; });
  ck(fired >= 2, '主动调用了 ' + fired + ' 个后台刷新函数');
  const ok = await waitFor('积分写入 storage', () => {
    const s = state();
    return s.pointsSummary && Number(s.pointsSummary.available) === 20192;
  }, 24000);
  /* 后台可能连续跑几轮刷新，等任务列表也稳定为非估算再断言 */
  await waitFor('任务列表非估算', () => {
    const s = state();
    return s.todayTasks && s.todayTasks.approx === false;
  }, 18000);

  group('5. storage 与界面断言（不是静态匹配）');
  const s = state();
  ck(Number(s.pointsSummary && s.pointsSummary.available) === 20192,
     '可用积分 = 20,192（实际 ' + (s.pointsSummary && s.pointsSummary.available) + '）');
  ck(s.loginStatus === 'in', 'loginStatus = in（实际 ' + s.loginStatus + '）');
  ck(s.pointsSummary && !s.pointsSummary.signedOut, '未误判为未登录');
  ck(s.todayTasks && Array.isArray(s.todayTasks.items) && s.todayTasks.items.length > 0,
     '今日任务列表非空（' + (s.todayTasks && s.todayTasks.items || []).length + ' 条）');
  ck(s.todayTasks && s.todayTasks.approx !== true,
     '任务数据不是兜底估算（approx=' + (s.todayTasks && s.todayTasks.approx) + '）');
  const badge = await popup.page.evaluate(() => {
    const b = document.getElementById('login-badge');
    const icon = document.getElementById('login-badge-icon');
    const grid = document.querySelector('.points-grid');
    const start = document.getElementById('start-points');
    return { cls: b ? b.className : '',
      iconVisible: !!(icon && !icon.hidden),
      gridHidden: !!(grid && grid.hidden),
      start: start ? (start.dataset.odo || start.textContent || '') : '',
      body: document.body.innerText.slice(0, 600) };
  });
  ck(/in/.test(badge.cls) && badge.iconVisible, '已登录显示重绘勋章图标');
  ck(!badge.gridHidden, '左侧三张积分卡保留以呈现今日积分');
  ck(/20,192/.test(badge.start), '积分仍正确写入（三张卡显示）');
  ck(!/暂时读不到 Microsoft Rewards/.test(badge.body), '不再显示「暂时读不到积分数据」错误条');

  group('6. 本次运行没有再出现 native code 注入错误');
  const DBG = process.env.HSA_DEBUG_DIR;
  const logs = [];
  for (const d of fs.readdirSync(DBG).filter(x => x.startsWith('session-'))) {
    const p = path.join(DBG, d, 'runtime.log');
    if (fs.existsSync(p)) logs.push(fs.readFileSync(p, 'utf8'));
  }
  const recent = logs.slice(-2).join('\n');
  ck(!/Unexpected identifier 'code'/.test(recent), 'runtime.log 没有 Unexpected identifier');
  ck(!/not serialized in main world/.test(recent), 'runtime.log 没有 funcSource 缺失告警');
  const injectFailLines = (recent.match(/\[inject\] [^\n]+注入失败[^\n]*/g) || []);
  const fatal = injectFailLines.filter(l =>
    /\[native code\]|Unexpected identifier|not serialized in main world/.test(l));
  ck(fatal.length === 0, '没有序列化类注入失败（' + fatal.length + ' 条）');
  console.log('    本次注入失败明细（导航竞态等瞬时错误）：' + injectFailLines.length + ' 条');
  for (const l of injectFailLines.slice(0, 3)) console.log('      ' + l.slice(0, 190));

  console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
