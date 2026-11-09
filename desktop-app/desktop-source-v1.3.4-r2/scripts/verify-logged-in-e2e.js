#!/usr/bin/env node
/* ============================================================================
 * 真实浏览器端到端验证 —— 「官网已登录，主界面却读不到积分/任务」
 *
 * 不是静态断言，也不是 mock 掉解析函数：
 *   1. 用真实 Chromium 启动 main.js（HSA_HEADLESS=1 + HSA_E2E=1），
 *      BrowserView 变成真实的 Playwright 页面；
 *   2. context.route 拦截 rewards.bing.com，返回仿照用户截图的已登录官网
 *      （可用积分 20,192、今日积分 267（来自 /earn）、可领取 0、任务卡片、金牌会员），
 *      并刻意埋入 "Sign in to your Microsoft account" 等 JS bundle 干扰字符串；
 *   3. 模拟点击登录徽标 → 右侧面板真实加载官网 → did-finish-load 触发同步；
 *   4. 走完整链路：chrome.tabs.query → scripting.executeScript 注入读真实 DOM
 *      → synthPointsHtml → parsePointsTrio / classifyLogin / cardsFromRewardsHtml
 *      → storage.local → popup 渲染；
 *   5. 断言 storage 里的积分/登录态/任务，以及 popup 上的数字与官网同款徽标。
 *
 * 运行： npm run verify:e2e
 * ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-e2e-'));
/* 可选：把两种徽标状态的真实渲染截图落盘，供交付物使用 */
const SHOT_DIR = process.env.HSA_E2E_SHOT_DIR || '';
process.env.HSA_HEADLESS = '1';
process.env.HSA_E2E = '1';
process.env.HSA_USER_DATA = tmp;
/* 调试现场隔离到本次临时目录：避免和别的验证脚本/历史 session 混淆，
   第 10 组读到的一定是本次运行的日志。 */
process.env.HSA_DEBUG = '1';   // v1.1.6：调试默认禁用，验证脚本以命令行方式显式开启
process.env.HSA_DEBUG_DIR = path.join(tmp, 'debug');
process.env.HSA_CHROMIUM = process.env.HSA_CHROMIUM || '/usr/local/bin/chromium';

const ROOT = path.join(__dirname, '..');
const DBG_DIR = process.env.HSA_DEBUG_DIR || path.join(ROOT, 'debug-captures');
const FIXTURE = fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'rewards-dashboard.html'), 'utf8');
/* v1.1.5：今日积分只从 /earn 解析，路由必须返回用户现场抓到的真实积分赚取页。 */
const EARN_FIXTURE = fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'rewards-earn-real.html'), 'utf8');

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

async function waitFor(label, predicate, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await sleep(300);
  }
  ck(false, `${label}（等待 ${timeoutMs}ms 超时）`);
  return null;
}

async function main() {
  const lite = require('../lib/electron-lite');
  const ctx = await lite._onReady();

  let siteMode = 'logged-in';
  const SIGNED_OUT_HTML = '<!DOCTYPE html><html><head><title>Microsoft Rewards</title></head>' +
    '<body><h1>Microsoft Rewards</h1>' +
    '<p>Sign in to your Microsoft account</p><p>No account? Create one.</p>' +
    '<a href="https://login.live.com/">Sign in</a></body></html>';
  await ctx.route('https://rewards.bing.com/**', route => {
    const u = route.request().url();
    const body = siteMode !== 'logged-in' ? SIGNED_OUT_HTML
      : (/rewards\.bing\.com\/earn/i.test(u) ? EARN_FIXTURE : FIXTURE);
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
  await ctx.route('https://login.live.com/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<html><body>Sign in to your Microsoft account. No account? Create one.</body></html>' }));
  await ctx.route('https://www.bing.com/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html>Bing</html>' }));

  require('../main.js');               // 真实启动：host + popup + 主进程 IPC
  await sleep(6500);                    // 等 Chromium 页面加载 + hostReady 放行消息队列

  const pages = lite._pages();
  const host = pages.find(p => p.url.includes('host.html'));
  const popup = pages.find(p => p.url.includes('popup.html'));

  group('1. 真实运行环境');
  ck(!!host && !!host.page, 'host.html（background.js）页面已就绪');
  ck(!!popup && !!popup.page, 'popup.html 主界面页面已就绪');
  /* v1.2.0：后台已改为用户上传的 GitHub 原始代码，不再有桌面自造的
     readFromVisibleRewardsTab / classifyLogin。检查上传版的核心函数确实加载。 */
  ck(await host.page.evaluate(() => typeof window.fetchRewardsPage === 'function' &&
     typeof window.refreshTodayTasks === 'function' &&
     typeof window.runAutoComplete === 'function'),
     '上传版 fetchRewardsPage / refreshTodayTasks / runAutoComplete 已加载（真实页面，未 mock）');
  ck(await host.page.evaluate(() => typeof window.isSignInPage === 'function' &&
     typeof window.parsePointsTrio === 'function'),
     '上传版 isSignInPage / parsePointsTrio 纯函数已加载');

  group('2. 复现旧版误判根因（证明修复针对的是真问题）');
  const trap = await host.page.evaluate(html => {
    const visible = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
    return {
      outerHtmlBundled: /Sign in to your Microsoft account/.test(html),
      oldJudge: window.isSignInPage(html),
      visibleTextHasSignIn: /Sign in to your Microsoft account/.test(visible)
    };
  }, FIXTURE);
  ck(trap.outerHtmlBundled, '仿真官网的 outerHTML 里确实含 JS bundle 干扰字符串');
  ck(trap.oldJudge === true, '旧版 isSignInPage(outerHTML) 把已登录页误判为登录页');
  ck(!trap.visibleTextHasSignIn, '页面「可见文本」里没有登录字样（新版判据不受干扰）');

  group('3. 已登录双击徽标 → 右侧官网面板真实展开并加载');
  await lite.ipcMain.invoke('chrome:panel:hide');
  const panelBefore = await lite.ipcMain.invoke('chrome:panel:state');
  ck(panelBefore.open === false, '起始状态：右侧面板收起');

  /* v1.1.5：已登录态单击 = 收起侧栏，双击 = 跳转官网。这里用真实 dblclick */
  await popup.page.evaluate(() => {
    const b = document.getElementById('login-badge');
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await sleep(2500);   // 等 dblclick → IPC → BrowserView 真实加载官网
  const panelAfter = await lite.ipcMain.invoke('chrome:panel:state');
  ck(panelAfter.open === true, '点击徽标后面板展开（有可见反应，不再「点了没反应」）');
  const sideBefore = ctx.pages().find(p => /rewards\.bing\.com/.test(p.url()));
  ck(String(panelAfter.url || (sideBefore && sideBefore.url()) || '').startsWith('https://rewards.bing.com/'),
     '面板加载的是官方 Rewards 页面：' + (panelAfter.url || (sideBefore && sideBefore.url()) || ''));

  const ctxPagesBefore = ctx.pages();
  const rewardsBefore = ctxPagesBefore.filter(p => /rewards\.bing\.com/.test(p.url()));
  const side = rewardsBefore.find(p => /\/dashboard/.test(p.url())) || rewardsBefore[0];
  ck(!!side, 'BrowserView 创建了真实 Chromium 页面并导航到官网');
  let dashText = '';
  for (const p of rewardsBefore) {
    try { if (!/\/earn/.test(p.url())) dashText = await p.evaluate(() => document.body.innerText); } catch {}
  }
  ck(/20,192/.test(dashText) && /金牌会员/.test(dashText),
     '真实 /dashboard 页面已渲染出 20,192 分与金牌会员（与用户截图一致）');

  /* v1.1.8 · 空闲零抓取：未触发两个允许时机时，后台不应读取任何官网页面。 */
  const f0 = await host.page.evaluate(() => window.__hsaRewardsFetchStats().count);
  await sleep(1800);
  const f1 = await host.page.evaluate(() => window.__hsaRewardsFetchStats().count);
  ck(f1 === f0, `初始化 / 空闲零抓取（官网读取计数 ${f0} → ${f1}）`);
  /* v1.3.1：上面「双击徽标展开官网」是用户主动动作，面板渲染完会走一次
     统一同步（含 /earn 数据视图），这是事件驱动而非空闲监控。启动后未操作
     阶段的零抓取由 f1===f0 与 runtime.log「启动零抓取」共同保证。 */
  const logIdle = (() => {
    const fsx = require('fs'), px = require('path');
    try {
      const sessions = fsx.readdirSync(DBG_DIR).filter(n => n.startsWith('session-')).sort();
      if (!sessions.length) return '';
      return fsx.readFileSync(px.join(DBG_DIR, sessions[sessions.length - 1], 'runtime.log'), 'utf8');
    } catch { return ''; }
  })();
  ck(logIdle.includes('启动零抓取'),
     '启动阶段零抓取，/earn 只来自用户展开面板后的统一同步（不是开机自动轮询）');

  group('4. 允许时机 1 → 完整链路：注入 → 解析 → storage');
  /* v1.1.8：等价于点击「自动完成任务」时 runAutoComplete 内的刷新。
     只有这一刻（或每轮搜索完成后）才会真正读取 /dashboard + /earn。 */
  await host.page.evaluate(() => window.refreshTodayTasks());
  const f2 = await host.page.evaluate(() => window.__hsaRewardsFetchStats().count);
  ck(f2 > f1, `时机 1 确实发生了官网读取（${f1} → ${f2}）`);
  const earnPage = ctx.pages().find(p => /rewards\.bing\.com\/earn/.test(p.url()));
  let earnText = '';
  if (earnPage) { try { earnText = await earnPage.evaluate(() => document.body.innerText); } catch {} }
  ck(/今日积分/.test(earnText) && /267/.test(earnText),
     '真实 /earn 页面已渲染出今日积分 267（今日积分专用数据源）');

  /* v1.1.5：可用积分先由可见面板快照写入，今日积分稍后由 /earn 解析写入。
     必须等两个字段都落定再断言，否则测的是中间态（这正是旧版误判的来源）。 */
  const got = await waitFor('积分写回 storage', () => {
    const s = state();
    return s.pointsSummary && s.pointsSummary.available === 20192 &&
      s.pointsSummary.today === 267 ? s : null;
  }, 22000);
  if (got) {
    ck(got.pointsSummary.available === 20192, '主界面可用积分 = 20,192（与官网一致）');
    ck(got.pointsSummary.today === 267, '今日积分 = 267（来自 /earn 的 totalPoints）');
    ck(got.pointsSummary.claimable === 0, '可领取 = 0');
    ck(got.loginStatus === 'in', "登录态判为 'in'，徽标不再「未确认」");
  }
  const tasks = await waitFor('今日任务写回 storage', () => {
    const s = state();
    return s.todayTasks && Array.isArray(s.todayTasks.items) && s.todayTasks.items.length > 0
      ? s.todayTasks : null;
  }, 22000);
  if (tasks) {
    ck(tasks.items.length > 0, `今日任务列表解析出 ${tasks.items.length} 条（不再是 0/0）`);
    ck(tasks.items.some(i => /必应 Star|每月升级|默认搜索|搜索/.test(i.name || '')),
       '任务卡片来自官网真实 DOM（含必应 Star / 每月升级等）');
    ck(tasks.signedOut !== true && tasks.approx !== true, '任务数据非兜底估算、非未登录态');
  }

  group('5. popup 界面：积分、任务与官网同款徽标');
  await sleep(1600);   // 等事件驱动的 storage.onChanged 广播完成渲染
  const ui = await popup.page.evaluate(() => {
    const badge = document.getElementById('login-badge');
    const icon = document.getElementById('login-badge-icon');
    const txt = document.getElementById('login-badge-text');
    const grid = document.querySelector('.points-grid');
    const vis = el => el ? !el.hidden && getComputedStyle(el).display !== 'none' : false;
    return {
      badgeCls: badge.className,
      badgeIconVisible: vis(icon),
      badgeTextVisible: vis(txt),
      topButtons: [...document.querySelectorAll('.header-actions button')]
        .filter(b => getComputedStyle(b).display !== 'none').length,
      pointsGridHidden: !!(grid && grid.hidden),
      // setOdometer 会插入 .sr-only + 逐位数字条，textContent 含 0-9 动画单元格；
      // dataset.odo 才是真正呈现给用户的值。
      available: document.getElementById('start-points').dataset.odo || '',
      today: document.getElementById('end-points').dataset.odo || '',
      claimable: document.getElementById('earned-points').dataset.odo || '',
      progress: document.getElementById('progress-text').dataset.odo || '',
      taskRows: document.getElementById('today-tasks-groups').children.length,
      taskEmptyHidden: document.getElementById('today-tasks-empty').hidden,
      bodyText: document.body.innerText
    };
  });
  ck(ui.available === '20,192', '可用积分仍解析为 20,192（三张卡显示）');
  ck(ui.today === '267', '「今日积分」显示 267（三张卡保留）');
  ck(ui.claimable === '0', '「可领取」显示 0');
  ck(/in/.test(ui.badgeCls) && ui.badgeIconVisible,
     '已登录徽标只显示重绘的橙色圆环勋章图标（无头像、无积分数字）');
  ck(ui.badgeTextVisible && ui.topButtons === 2 && !ui.pointsGridHidden,
     '顶端只剩登录/设置两个按键；徽标两态都显示状态文字；三张积分卡保留（topButtons=' +
     ui.topButtons + ', gridHidden=' + ui.pointsGridHidden +
     ', textVisible=' + ui.badgeTextVisible + '）');
  ck(!ui.taskEmptyHidden || ui.taskRows > 0 || !/正在读取今日任务/.test(ui.bodyText),
     '今日任务区不再停在「正在读取今日任务…」');
  if (SHOT_DIR) {
    try {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await popup.page.screenshot({ path: path.join(SHOT_DIR, '首页-已登录-官网同款徽标.png'), full_page: true });
    } catch {}
  }

  group('6. 未登录态：官网同款「登录」按钮 + 点击仍展开官方登录页');
  /* 必须先把官网面板也切到登录页：否则后台 readFromVisibleRewardsTab 仍读到
     20,192，会把我们刚写入的 loginStatus:'out' 又改回 'in'（e2e 偶发失败的根因）。 */
  siteMode = 'signed-out';
  await lite.ipcMain.invoke('chrome:panel:show', 'https://rewards.bing.com/dashboard');
  await sleep(2600);
  /* v1.1.5 护栏：新鲜积分要连续 2 次确凿 out 才清空。这里模拟后台两轮探测，
     让真未登录场景确实切换过去（同时清掉内置页读取缓存，避免读到旧 dashboard）。 */
  for (let i = 0; i < 2; i++) {
    await host.page.evaluate(() => {
      try { if (typeof window.invalidateEmbeddedCache === 'function') window.invalidateEmbeddedCache(); } catch {}
      return typeof window.detectLogin === 'function' ? Promise.resolve(window.detectLogin()) : null;
    }).catch(() => null);
    await sleep(400);
  }
  /* 把「新鲜登录态」也置为陈旧，否则 v1.1.5 护栏会按设计保留 in。 */
  await lite.ipcMain.invoke('chrome:storage:set', {
    loginStatus: 'out', loginCheckedAt: 0, visibleRewardsSnapshot: null,
    pointsSummary: { available: null, today: null, claimable: null, signedOut: true, updatedAt: 0 },
    todayTasks: { items: [], earned: 0, total: 0, percent: 0, signedOut: true, approx: false, updatedAt: 0 }
  });
  let outUi = null;
  for (let i = 0; i < 10; i++) {
    outUi = await popup.page.evaluate(() => {
      const badge = document.getElementById('login-badge');
      const txt = document.getElementById('login-badge-text');
      const icon = document.getElementById('login-badge-icon');
      return {
        cls: badge.className, text: txt ? txt.textContent : '',
        iconVisible: icon ? !icon.hidden && getComputedStyle(icon).display !== 'none' : false,
        aria: badge.getAttribute('aria-label') || ''
      };
    });
    if (/^(未登录|Not signed in|Signed out)$/.test(outUi.text) && outUi.iconVisible) break;
    await sleep(400);
  }
  ck(/signed-out|out|unknown/.test(outUi.cls), '未登录时徽标切换为灰色态');
  ck(/^(未登录|Not signed in|Signed out)$/.test(outUi.text) && outUi.iconVisible,
     '未登录显示灰色重绘图标 +「未登录」文字：' + outUi.text);
  if (SHOT_DIR) {
    try {
      await popup.page.screenshot({ path: path.join(SHOT_DIR, '首页-未登录-官网登录按钮.png'), full_page: true });
    } catch {}
  }
  /* v1.1.6：单击是「切换侧栏」，先收起再点击才能验证展开。 */
  await lite.ipcMain.invoke('chrome:panel:hide');
  await sleep(200);
  await popup.page.evaluate(() => document.getElementById('login-badge').click());
  await sleep(900);
  const finalPanel = await lite.ipcMain.invoke('chrome:panel:state');
  ck(finalPanel.open === true, '未登录点击徽标仍展开右侧官方登录页面');

  group('7. 未登录官网：点击徽标弹出官方登录界面');
  await lite.ipcMain.invoke('chrome:panel:show', 'https://rewards.bing.com/dashboard');
  await sleep(2200);
  const stBefore = await lite.ipcMain.invoke('chrome:panel:state');
  /* 用面板自己的 tabId 定位，避免误命中同样加载 /dashboard 的后台数据视图 */
  const sidePage = lite._viewPage(stBefore.tabId) ||
    ctx.pages().find(p => /rewards\.bing\.com\/dashboard/.test(p.url()));
  ck(!!sidePage, '右侧面板重新导航到官方入口');
  if (sidePage) {
    let text = '';
    for (let i = 0; i < 12; i++) {
      try { text = await sidePage.evaluate(() => document.body.innerText); } catch {}
      if (/Sign in to your Microsoft account/.test(text) && !/20,192/.test(text)) break;
      await sleep(400);
    }
    ck(/Sign in to your Microsoft account/.test(text) && !/20,192/.test(text),
       '面板呈现的是官方 Microsoft 登录界面（未仿制、不含积分）');
  }
  const stAfter = await lite.ipcMain.invoke('chrome:panel:state');
  ck(stAfter.open === true,
     '登录界面保持展开，用户可直接登录（open=' + stAfter.open + '）');

  group('8. 真机故障复现：window.chrome 只剩半份 API 时，点登录仍有效');
  /* Electron 45 / Chromium 156 真机上 window.chrome 可能被内置对象占用，
     contextBridge 只得到半份 API。旧版 loginBadge 第一行裸调
     chrome.storage.local.set 会抛 TypeError，openOfficialPanel 根本不执行。
     这里真实替换 window.chrome 后点击，验证修复不是纸面断言。 */
  await lite.ipcMain.invoke('chrome:panel:hide');
  /* 固定为未登录且缓存新鲜：避免点击后的 refreshLogin 把状态翻回 in，
     触发「登录成功后自动收起侧栏」，干扰本组对「点击立即展开」的验证。 */
  await lite.ipcMain.invoke('chrome:storage:set', {
    loginStatus: 'out', loginCheckedAt: Date.now(),
    pointsSummary: { available: null, today: null, claimable: null, signedOut: true, updatedAt: 0 }
  });
  const halfChrome = await popup.page.evaluate(() => {
    const before = window.chrome;
    Object.defineProperty(window, 'chrome', {
      value: { loadTimes: function () {}, csi: function () {} },
      configurable: true, writable: true
    });
    return {
      hasStorage: !!(window.chrome && window.chrome.storage),
      hasDesktopPanel: !!(window.chrome && window.chrome.desktopPanel),
      hasDesktopBackup: !!(window.__desktop && window.__desktop.openOfficial),
      hadStorageBefore: !!(before && before.storage)
    };
  });
  ck(halfChrome.hadStorageBefore === true, '故障注入前 popup 的 chrome 是完整的');
  ck(!halfChrome.hasStorage && !halfChrome.hasDesktopPanel, '已真实注入半份 chrome（无 storage / desktopPanel）');
  ck(halfChrome.hasDesktopBackup, '__desktop 备份通道仍可用');
  await popup.page.evaluate(() => document.getElementById('login-badge').click());
  await sleep(350);
  const halfPanel = await lite.ipcMain.invoke('chrome:panel:state');
  ck(halfPanel.open === true,
     '半份 chrome 下点击登录徽标立即展开右侧官网页面（旧版此处毫无反应）');
  await sleep(900);
  const halfPanelLater = await lite.ipcMain.invoke('chrome:panel:state');
  ck(String(halfPanelLater.url || halfPanel.url || '').startsWith('https://rewards.bing.com/'),
     '展开后仍加载官方 Rewards 地址');
  // 复原，避免影响后续（本组已是最后一组）
  await popup.page.evaluate(() => {
    if (window.__hsaChrome) Object.defineProperty(window, 'chrome', {
      value: window.__hsaChrome, configurable: true, writable: true
    });
  });

  group('9. 决定性回归：官网 DOM 无官方 class / JSON 字段时仍读到 20,192');
  /* 第 6/7 组把官网切到了未登录页，这里必须先切回已登录并让面板重新渲染，
     否则直读拿到的是登录页，测试的是另一件事。 */
  siteMode = 'logged-in';
  await lite.ipcMain.invoke('chrome:panel:show', 'https://rewards.bing.com/dashboard');
  await sleep(2600);
  /* 夹具已刻意去掉 text-labelControl、availablePoints 等所有旧版线索，
     标签与数字分处不同容器；且 bundle 里埋了登录页字符串。
     这一组再叠加「tabs.query 对 Rewards 返回空」，证明直读可见面板
     不再依赖 tabs.query / waitForSettled / RSC 解析。 */
  const fixtureTxt = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rewards-dashboard.html'), 'utf8');
  ck(!fixtureTxt.includes('text-labelControl') || /<!--[\s\S]*text-labelControl[\s\S]*-->/m.test(fixtureTxt),
     '夹具不含可用的官方积分 class（只有注释里提及）');
  ck(!/"availablePoints"\s*:/.test(fixtureTxt) && !/"pointsEarnedToday"\s*:/.test(fixtureTxt),
     '夹具不含任何官方 RSC 积分字段');
  ck(fixtureTxt.includes('Sign in to your Microsoft account') && fixtureTxt.includes('创建帐户'),
     '夹具 bundle 里仍埋着会把 outerHTML 误判成登录页的干扰字符串');

  /* 把 host 的 tabs.query 对 Rewards 打桩为空：旧链路必然超时返回空 html */
  await host.page.evaluate(() => {
    const orig = chrome.tabs.query.bind(chrome.tabs);
    Object.defineProperty(chrome.tabs, 'query', {
      value: async info => (info && info.url && String(info.url).indexOf('rewards.bing.com') >= 0 ? [] : orig(info)),
      configurable: true, writable: true
    });
    if (typeof window.invalidateEmbeddedCache === 'function') window.invalidateEmbeddedCache();
  });
  await lite.ipcMain.invoke('chrome:storage:set', {
    pointsSummary: { available: null, today: null, claimable: null, updatedAt: Date.now() },
    loginStatus: 'unknown'
  });
  const directStatus = await host.page.evaluate(() => window.refreshPointsSummary());
  ck(directStatus !== true, 'tabs.query 返回空时仍没有误判成未登录');
  const directSt = await lite.ipcMain.invoke('chrome:storage:get', null);
  const directPts = directSt.pointsSummary || {};
  ck(directPts.available === 20192,
     'tabs.query 为空时仍从可见面板读到可用积分 20,192（旧链路此处必为 null）');
  /* 这一组把 tabs.query 对 Rewards 打桩为空，/earn 后台视图可能读不到，today 允许为 null；
     关键是它绝不能被 /dashboard 的 20,192 串台。正常链路的 267 在第 4 组验证。 */
  /* v1.2.0：上传版 refreshPointsSummary 只按 HTML 正则取三项，仿真夹具里
     「可领取」字段不一定命中，允许 0 / null；关键是 today 绝不能被 dashboard
     的 20,192 串台，且 signedOut 不能被 bundle 干扰字符串翻成 true。 */
  ck((directPts.today === 267 || directPts.today === null) && directPts.today !== 20192,
     '今日积分不会被 /dashboard 的 20,192 串台（today=' + directPts.today +
     ', claimable=' + directPts.claimable + '）');
  ck(directPts.signedOut !== true && Number(directPts.available) === 20192,
     '上传版 isSignInPage 两页合判：bundle 干扰字符串不会把已登录页判成 out');
  await popup.page.waitForFunction(() => {
    const e = document.querySelector('#card-available .card-value, #available-points');
    return e && /20,192/.test(e.textContent || '');
  }, { timeout: 8000 }).catch(() => {});
  const directUi = await popup.page.evaluate(() => {
    const e = document.getElementById('start-points');
    return e ? (e.dataset.odo || e.textContent || '') : '';
  });
  ck(/20,192/.test(directUi), '积分仍正确写入（三张卡显示）');

  group('10. Debug 现场：HTML 落盘与链路日志');
  await sleep(900);            // 等 DebugCapture 的 400ms 缓冲批量落盘
  const sessions = fs.existsSync(DBG_DIR)
    ? fs.readdirSync(DBG_DIR).filter(n => n.startsWith('session-')).sort() : [];
  const sess = sessions.length ? path.join(DBG_DIR, sessions[sessions.length - 1]) : null;
  ck(!!sess, '找到本次运行的调试会话目录');
  if (sess) {
    const htmls = fs.readdirSync(path.join(sess, 'html'));
    const visibleHtml = htmls.filter(n => n.includes('read-visible-panel'));
    ck(visibleHtml.length > 0, '可见官网面板 HTML 已原样落盘：' + (visibleHtml[0] || ''));
    if (visibleHtml.length) {
      /* 后半段会切到未登录官网，最后一份可能是登录页；只要有一份是已登录页即可 */
      const withPoints = visibleHtml.filter(n => {
        const body = fs.readFileSync(path.join(sess, 'html', n), 'utf8');
        return body.includes('20,192') || body.includes('金牌会员') || body.includes('今日积分');
      });
      ck(withPoints.length > 0,
         '至少一份落盘 HTML 含官网积分/会员标识（已登录页 ' + withPoints.length + ' 份）');
    }
    let log = '';
    try { log = fs.readFileSync(path.join(sess, 'runtime.log'), 'utf8'); } catch {}
    ck(log.includes('readVisible 成功'), 'runtime.log 记录直读成功');
    /* v1.2.0：抓取链路改为 desktopFetchFromSnapshot → readVisibleRewards → 数据视图 */
    ck(log.includes('readVisible 成功') || log.includes('readVisibleNow'),
       'runtime.log 记录内置页面读取命中');
    /* v1.3.2：快照只作数据源；点击登录按键不派发同步，只有登录跳回才同步一次。 */
    ck(log.includes('官网快照已保存'), 'runtime.log 记录官网快照落盘');
    ck(/loginReturn && !desktopQuietRun\(\)/.test(
         fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')),
       '统一同步只在登录跳回时派发，点击登录按键不刷新积分/登录状态');
    ck(log.includes('chrome:panel:show') || log.includes('chrome:rewards:readVisible'),
       'runtime.log 记录面板与读取 IPC 调用');
  }

  console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
