#!/usr/bin/env node
/* ============================================================================
 * v1.3.3 · 「点击登录按键却把积分设成 null」与「登录态单击/双击纯界面动作」
 *
 * 用户本轮反馈：
 *  ① 点击登录按键却将积分设置为了 null
 *  ② 登录状态下，单击登录按键开关侧栏，双击打开主页，都不会影响图标状态
 *
 * 根因（两条真路径）：
 *  A. main.js did-finish-load 里 `isLoginPageUrl(u) → markSignedOut('login-page')`
 *     把「官网短暂 302 / OAuth 授权跳转 / /earn 返回登录页 DOM」当成确凿登出，
 *     直接写 available:null + loginStatus:out → 三张卡变 —、金色图标翻灰。
 *  B. desktopSyncRewards 里有一条「快照全是登录页就把 available 置 null」的例外，
 *     登录跳回同步时同样会把 20,192 清掉。
 *
 * 本脚本不是静态字符串匹配：
 *   1. 真实 Chromium 启动 main.js，先写入已登录 20,192 分；
 *   2. 路由把官网返回成「Microsoft 登录页」（复现用户提交的 /earn 登录页文本）；
 *   3. 真实点击徽标（单击展开）→ 断言积分/登录态/图标 class 一个都没变；
 *   4. 双击打开主页、再单击收起 → 断言图标状态始终不变；
 *   5. vm 实跑 markSignedOut：保护窗口内零写入零广播；窗口外的确凿 Cookie
 *      删除信号仍能把 available 置 null（真登出没被误伤）。
 *
 * 运行： npm run verify:v133
 * ========================================================================== */
'use strict';
process.env.HSA_HEADLESS = '1';
process.env.HSA_E2E = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const bgSource = fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(ROOT, 'src', 'popup.js'), 'utf8');

let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 用户提交的 https://rewards.bing.com/earn 登录页可见文本形态 */
const LOGIN_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><title>登录</title></head><body>
<h1>登录</h1><p>登录使用你的 Microsoft 帐户。电子邮件或电话号码 忘记用户名?</p>
<button>下一步</button><p>或使用 Google 继续 使用 Apple 继续</p>
<p>不熟悉 Microsoft? 创建帐户 帮助和反馈 使用条款 隐私与 Cookie</p>
<p>如果这不是你的设备，请使用专用浏览。</p>
</body></html>`;
const DASH_HTML = fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'rewards-dashboard.html'), 'utf8');

function extract(re) {
  const m = re.exec(mainSource);
  if (!m) throw new Error('提取失败：' + re);
  return m[0];
}

async function main() {
  group('1. 静态：两条把积分写 null 的旧路径都已拆除');
  ck(!/isLoginPageUrl\(u\)[^\n]*markSignedOut|markSignedOut\('login-page'\)/.test(mainSource),
     '侧栏 did-finish-load 不再把「登录页导航」当成确凿登出');
  ck(/if \(\/\(\?:\\\/logout\|signout\)\/i\.test\(u\)\) markSignedOut\('logout-url'\)/.test(mainSource),
     '只保留 URL 明确带 logout/signout 的登出动作');
  ck(/const loginPageOnly = !!pages\.signedOut/.test(bgSource) &&
     /if \(loginPageOnly\)[\s\S]{0,400}?changed: \[\]/.test(bgSource),
     '登录页场景由 loginPageOnly 早退：零业务键写回、UI 完全不动');
  ck(!/key === 'available'\) \? null/.test(bgSource) &&
     !/available: null/.test(bgSource.slice(bgSource.indexOf('async function desktopSyncRewards'))),
     '统一同步里没有任何把 available 置 null 的分支');
  ck(/const ok = readData && !outOnly && !pages\.signedOut/.test(bgSource),
     '两页明确登录页时零动作返回，但仍不写任何业务键（UI 保持不动）');
  ck(/用户面板动作期间忽略登出信号/.test(mainSource),
     'markSignedOut 有用户面板动作保护窗口');
  const ipcCalls = (mainSource.match(/notePanelAction\(\);/g) || []).length;
  ck(ipcCalls >= 4, '面板 show / hide / toggle / openOfficial 四个 IPC 都标记了保护窗口（' + ipcCalls + ' 处）');

  group('2. popup：已登录单击/双击是纯界面动作');
  ck(/const signedIn = loginBadge\.classList\.contains\('in'\)/.test(popupSource),
     '点击前读取当前图标状态（绑定 available 的镜像）');
  ck(/awaitingLogin = !signedIn/.test(popupSource),
     '已登录时不登记等待登录 → 不会被后续状态写回自动收起侧栏');
  ck(/const signedIn = Number\.isFinite\(ps\.available\)/.test(popupSource),
     '图标状态仍只看 pointsSummary.available');
  const badgeHandler = popupSource.slice(popupSource.indexOf("loginBadge.addEventListener('click'"));
  ck(!/chrome\.storage\.local\.set\(\{[^}]*(pointsSummary|loginStatus)/.test(badgeHandler),
     '徽标点击处理器不写积分 / 登录态业务键');

  group('3. 真实 Chromium：已登录 20,192 → 点击徽标 → 官网返回登录页');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-v133-'));
  process.env.HSA_USER_DATA = path.join(tmp, 'userdata');
  process.env.HSA_DEBUG = '0';
  process.env.HSA_DEBUG_DIR = path.join(tmp, 'debug');   // 不污染工作区
  process.env.HSA_CHROMIUM = process.env.HSA_CHROMIUM || '/usr/local/bin/chromium';
  const lite = require('../lib/electron-lite');
  const ctx = await lite._onReady();
  let loginMode = true;
  await ctx.route('https://rewards.bing.com/**', r =>
    r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: loginMode ? LOGIN_HTML : DASH_HTML }));
  await ctx.route('https://login.live.com/**', r =>
    r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: LOGIN_HTML }));
  await ctx.route('https://www.bing.com/**', r =>
    r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html>Bing</html>' }));
  require('../main.js');
  await sleep(6000);

  const pages = lite._pages();
  const popup = pages.find(p => p.url.includes('popup.html'));
  ck(!!popup && !!popup.page, 'popup 主界面真实加载');
  if (!popup) throw new Error('popup 未加载，无法继续');

  /* 先写入「已登录」的完整状态，让徽标变金、三张卡有值 */
  await lite.ipcMain.invoke('chrome:storage:set', {
    pointsSummary: { available: 20192, today: 257, claimable: 0, signedOut: false, updatedAt: Date.now() },
    todayTasks: { items: [
      { name: '每日活动', section: 'daily', points: 50, earned: 10, completed: false },
      { name: '日常任务', section: 'promo', points: 30, earned: 0, completed: false }
    ], earned: 10, total: 80, percent: 13, approx: false, signedOut: false },
    loginStatus: 'in'
  });
  await sleep(900);
  const badgeBefore = await popup.page.evaluate(() =>
    document.getElementById('login-badge').className);
  const stBefore = await lite.ipcMain.invoke('chrome:storage:get',
    ['pointsSummary', 'loginStatus', 'todayTasks']);
  ck(/in/.test(badgeBefore) && stBefore.pointsSummary.available === 20192,
     '起始状态：金色图标 + 可用积分 20,192（' + badgeBefore.trim() + '）');

  /* 单击徽标：面板当前收起 → 展开官网，官网返回登录页 */
  await popup.page.evaluate(() => document.getElementById('login-badge').click());
  await sleep(3200);
  const stAfterClick = await lite.ipcMain.invoke('chrome:storage:get',
    ['pointsSummary', 'loginStatus', 'todayTasks']);
  const badgeAfterClick = await popup.page.evaluate(() =>
    document.getElementById('login-badge').className);
  const panelAfterClick = await lite.ipcMain.invoke('chrome:panel:state');
  ck(stAfterClick.pointsSummary.available === 20192,
     '★ 单击后可用积分仍是 20,192，没有被写成 null（实际 ' +
     stAfterClick.pointsSummary.available + '）');
  ck(stAfterClick.pointsSummary.today === 257 && stAfterClick.pointsSummary.claimable === 0,
     '今日积分 / 可领取也没被清空');
  ck(stAfterClick.loginStatus === 'in',
     '登录状态仍是 in（实际 ' + stAfterClick.loginStatus + '）');
  ck(/in/.test(badgeAfterClick) && !/signed-out/.test(badgeAfterClick),
     '★ 图标仍是金色已登录态：' + badgeAfterClick.trim());
  ck(panelAfterClick.open === true,
     '单击确实把右侧侧栏展开了（纯界面动作有反馈）');
  ck(stAfterClick.todayTasks.items && stAfterClick.todayTasks.items.length === 2,
     '任务列表保持完整，没有被「未登录请先登录」覆盖');

  group('4. 双击打开主页，图标与积分不变');
  loginMode = false;
  await popup.page.evaluate(() => {
    const b = document.getElementById('login-badge');
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await sleep(3000);
  const stAfterDbl = await lite.ipcMain.invoke('chrome:storage:get',
    ['pointsSummary', 'loginStatus']);
  const badgeAfterDbl = await popup.page.evaluate(() =>
    document.getElementById('login-badge').className);
  const panelAfterDbl = await lite.ipcMain.invoke('chrome:panel:state');
  ck(String(panelAfterDbl.url || '').startsWith('https://rewards.bing.com/'),
     '双击打开官网主页：' + String(panelAfterDbl.url || ''));
  ck(stAfterDbl.pointsSummary.available === 20192 && stAfterDbl.loginStatus === 'in',
     '★ 双击后 20,192 与 in 都没变');
  ck(/in/.test(badgeAfterDbl) && !/signed-out/.test(badgeAfterDbl),
     '★ 双击后图标状态不变：' + badgeAfterDbl.trim());

  group('5. 再单击收起侧栏，图标仍不变');
  await popup.page.evaluate(() => document.getElementById('login-badge').click());
  await sleep(900);
  const panelHidden = await lite.ipcMain.invoke('chrome:panel:state');
  const badgeAfterHide = await popup.page.evaluate(() =>
    document.getElementById('login-badge').className);
  ck(panelHidden.open === false, '单击把侧栏收起（开关侧栏生效）');
  ck(/in/.test(badgeAfterHide), '★ 收起侧栏后图标仍是已登录态');
  const stFinal = await lite.ipcMain.invoke('chrome:storage:get', 'pointsSummary');
  ck(stFinal.pointsSummary.available === 20192, '整轮点击结束，可用积分始终 20,192');

  group('6. vm 实跑 markSignedOut：保护窗口内零写入，窗口外真登出仍生效');
  const quietSrc = extract(/function desktopQuietRun\(\) \{[\s\S]*?\n\}/);
  const signOutSrc = extract(/function markSignedOut\(reason\) \{[\s\S]*?\n\}/);
  let broadcasts = 0;
  const logs = [];
  let protectedMode = true;
  const env = {
    DBG: { log: (...a) => logs.push(a.join(' ')) },
    panelActionActive: () => protectedMode,
    state: {
      running: false, phase: 'idle', loginStatus: 'in',
      pointsSummary: { available: 20192, today: 257, claimable: 0, updatedAt: 1 },
      todayTasks: { items: [{ name: 'a', points: 10 }] }
    },
    emitStorageChanges: () => ({}),
    saveState: () => {},
    broadcast: () => { broadcasts++; },
    Date, console, Object, Number, String, RegExp, JSON
  };
  const sandbox = vm.createContext(env);
  vm.runInContext(quietSrc + '\n' + signOutSrc, sandbox);
  const before = JSON.stringify({ ps: env.state.pointsSummary, login: env.state.loginStatus,
    tt: env.state.todayTasks });
  vm.runInContext("markSignedOut('cookie-removed:.bing.com')", sandbox);
  vm.runInContext("markSignedOut('logout-url')", sandbox);
  ck(before === JSON.stringify({ ps: env.state.pointsSummary, login: env.state.loginStatus,
    tt: env.state.todayTasks }),
     '用户面板动作保护窗口内：两种登出信号都不写任何业务键');
  ck(broadcasts === 0, '保护窗口内零 storage.onChanged 广播，UI 一次都不重绘');
  ck(logs.some(l => /用户面板动作期间忽略登出信号/.test(l)), '只记 debug 日志');

  protectedMode = false;
  vm.runInContext("markSignedOut('cookie-removed:.bing.com')", sandbox);
  ck(env.state.loginStatus === 'out' && env.state.pointsSummary.available === null,
     '窗口外的确凿 Cookie 删除信号仍能即时登出（真登出没被误伤）');
  ck(env.state.pointsSummary.today === 257 && env.state.todayTasks.items.length === 1,
     '真登出也只改变化的值：其余积分与任务列表保留');

  console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('\x1b[31m验证异常：' + String(err && err.stack || err) + '\x1b[0m');
  process.exit(1);
});
