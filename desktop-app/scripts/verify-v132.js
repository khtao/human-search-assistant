#!/usr/bin/env node
/* ============================================================================
 * v1.3.2 · 任务侧栏滚动点击 / 运行期 UI 不清空 / 登录态绑定可用积分
 *
 * 用户本轮 8 点反馈的可机器验证部分：
 *  ① 自动完成任务时 UI 被错误清空 → 运行期任何登出信号都不写业务键
 *  ② 任务列表已正确解析 → 统一同步含 daily + promo（复用 v131 场景）
 *  ③ 桌面版没有多个标签页 → 新增任务侧栏 + 隐藏结果视图，扫描页不被覆盖
 *  ④ 从头滚动到结束、所有 +N 卡片不漏 → 真实 Chromium 里执行 TASK_SCAN_SRC
 *  ⑤ 点击登录按键不刷新积分/登录状态 → 主进程只在 loginReturn 派发同步
 *  ⑥ 登录状态绑定可用积分 → popup 徽标只看 pointsSummary.available
 *  ⑦ 刷新不清空、仅改变变化的值 → desktopSyncRewards 只写差异键
 *  ⑧ 运行中只要能继续跑就不抢焦点 → 沿用 v1.3.1 的静默焦点函数
 *
 * 运行： npm run verify:v132
 * ========================================================================== */
'use strict';
/* 无图形桌面环境：显式开启 headless，与 verify:e2e / verify:real 一致 */
process.env.HSA_HEADLESS = '1';
process.env.HSA_E2E = '1';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const bgSource = fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(ROOT, 'src', 'popup.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const upBg = fs.readFileSync(path.join(ROOT, 'tests', 'github-upload', 'background.js'), 'utf8');

let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* -------------------------------------------------- 从 main.js 提取真实片段 */
function extract(re) {
  const m = re.exec(mainSource);
  if (!m) throw new Error('提取失败：' + re);
  return m;
}
const scanLiteral = extract(/const TASK_SCAN_SRC = (`[\s\S]*?`);/)[1];
const TASK_SCAN_SRC = new Function('return ' + scanLiteral)();
/* 用大括号配对提取（函数体内含模板字符串，不能用「第一个行首 }」截断） */
function extractFn(name) {
  const i = mainSource.indexOf('function ' + name + '(');
  const j = mainSource.indexOf('{', i);
  let d = 0;
  for (let k = j; k < mainSource.length; k++) {
    if (mainSource[k] === '{') d++;
    else if (mainSource[k] === '}' && --d === 0) return mainSource.slice(i, k + 1);
  }
  throw new Error('提取函数失败: ' + name);
}
const taskClickSrc = new Function(extractFn('taskClickSrc') + '\nreturn taskClickSrc;')();
/* 大括号配对提取，避免正则在模板字符串/对象字面量里提前截断 */
const quietFnSrc = extractFn('desktopQuietRun');
const signOutFnSrc = extractFn('markSignedOut');

/* --------------------------------------------------------------- 测试页面 */
/* 12 张卡：2 张已完成、1 张重复、1 张指标卡、1 张 /redeem 卡；
   每张前后插入长 spacer，确保必须从头滚动到结束才能收集全。 */
const TASK_HTML = `<!DOCTYPE html><html><body style="margin:0">
<h2>每日活动</h2>
${Array.from({ length: 12 }, (_, i) => `
<div style="height:420px"></div>
<a class="task-card" href="https://rewards.bing.com/earn/task-${i}">
  <h3>任务卡片 ${i}</h3><p>说明 ${i}</p><span>+10</span>
  ${i === 3 || i === 8 ? '<em>已完成</em>' : ''}
</a>`).join('')}
<div style="height:420px"></div>
<a class="task-card" href="https://rewards.bing.com/earn/task-4">
  <h3>任务卡片 4</h3><p>说明 4</p><span>+10</span></a>
<a class="metric" href="https://rewards.bing.com/earn/metric">
  <h3>可用积分 20,192</h3><span>+10</span></a>
<a class="redeem" href="https://rewards.bing.com/redeem/x">
  <h3>兑换</h3><span>+10</span></a>
<div style="height:900px"></div>
</body></html>`;

async function main() {
  group('1. 任务侧栏：从顶部滚动到底，收集全部 +N 卡片（真实 Chromium）');
  const lite = require('../lib/electron-lite');
  const ctx = await lite._onReady();
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.setContent(TASK_HTML, { waitUntil: 'load' });

  const cards = await page.evaluate(TASK_SCAN_SRC);
  ck(Array.isArray(cards) && cards.length === 10,
     '12 张卡中 2 张已完成被跳过，重复的 1 张去重 → 收集 10 张（实际 ' +
     (Array.isArray(cards) ? cards.length : '非数组') + '）');
  ck(cards.some(c => /任务卡片 0/.test(c.name)), '包含页面顶部的第 1 张卡');
  ck(cards.some(c => /任务卡片 11/.test(c.name)),
     '包含页面最底部的最后一张卡（证明滚动到了结束）');
  ck(!cards.some(c => /可用积分|兑换/.test(c.name)), '指标卡与 /redeem 兑换卡被排除');
  ck(cards.every(c => c.points === 10 && /rewards\.bing\.com/.test(c.href)),
     '每张卡都带积分与合法 href');
  ck(cards.every((c, i) => c.idx === i), 'idx 连续，可供逐张点击定位');

  group('2. 逐张点击：全部卡片都点到，扫描页不被覆盖');
  await page.evaluate(() => {
    window.__clicked = [];
    for (const a of document.querySelectorAll('a[href]')) {
      a.addEventListener('click', e => {
        e.preventDefault();                       // 测试页不真的导航
        window.__clicked.push(a.getAttribute('href'));
      });
    }
  });
  const results = [];
  for (const c of cards) {
    const r = await page.evaluate(taskClickSrc(c));
    results.push(r);
  }
  ck(results.every(r => r && r.ok),
     '10 张卡依次点击全部成功（' + results.filter(r => r && r.ok).length + '/10）');
  const clicked = await page.evaluate(() => window.__clicked);
  ck(clicked.length === 10, '实际触发 10 次 click 事件（' + clicked.length + '）');
  ck(new Set(clicked).size === 10, '10 次点击落在 10 张不同的卡片上，无重复无遗漏');
  const urlAfter = await page.evaluate(() => location.href);
  ck(/about:blank|^$/.test(urlAfter),
     '点击没有把扫描页导航走（结果页由主进程隐藏视图承接）');

  group('3. 主进程：任务侧栏与隐藏结果视图');
  ck(/const TASK_PANEL_URLS = \[[\s\S]*?dashboard[\s\S]*?earn[\s\S]*?\]/.test(mainSource),
     '任务侧栏依次加载 /dashboard 与 /earn 两页');
  ck(/function ensureTaskView\(\)/.test(mainSource) &&
     /function ensureTaskResultView\(\)/.test(mainSource),
     '存在任务侧栏与隐藏结果视图两个独立视图');
  ck(/taskView\.webContents\.setWindowOpenHandler[\s\S]{0,300}?ensureTaskResultView\(\)/.test(mainSource),
     '卡片 target=_blank 的任务页落到结果视图，扫描页保持不变');
  ck(/for \(const url of TASK_PANEL_URLS\)[\s\S]{0,1200}?TASK_CLICK_INTERVAL_MS/.test(mainSource),
     'IPC 遍历两页、相邻点击间隔 5 秒');
  ck(/if \(!state\.running\) break;/.test(mainSource),
     '点「停止」时立即中断剩余卡片');
  ck(/finally \{[\s\S]{0,200}?hideTaskView\(\)/.test(mainSource),
     '无论成功失败都会收起任务侧栏');
  const ipcStart = mainSource.indexOf("ipcMain.handle('chrome:task:clickAll'");
  const ipcBody = mainSource.slice(ipcStart, ipcStart + 3200);
  ck(ipcStart > 0 && !/safeAutoFocus|bringToFront|popupWin\.focus\(\)/.test(ipcBody),
     '任务点击过程不抢系统焦点');

  group('4. 后台绑定：上传版函数体不动，只换调用');
  const fnBody = s => {
    const i = s.indexOf('async function completePendingTaskCards(level, token)');
    const j = s.indexOf('{', i);
    let d = 0;
    for (let k = j; k < s.length; k++) {
      if (s[k] === '{') d++;
      else if (s[k] === '}' && --d === 0) return s.slice(i, k + 1);
    }
    return '';
  };
  ck(fnBody(upBg) === fnBody(bgSource),
     'completePendingTaskCards 函数体与上传版逐字节相同（未改业务逻辑）');
  ck(/completePendingTaskCards = async function \(level, token\)/.test(bgSource) &&
     /panel\.clickAll\(\)/.test(bgSource),
     '桌面版只把绑定换成任务侧栏一次调用');
  ck(/chrome\.taskPanel[\s\S]{0,300}?__desktop\.taskClickAll/.test(bgSource),
     '半份 window.chrome 时仍有 __desktop 备用通道');
  ck(/taskPanel: \{ clickAll/.test(preloadSource) && /taskClickAll:/.test(preloadSource),
     'preload 暴露任务侧栏 IPC 并备份到 __desktop');

  group('5. 运行期 UI 不被清空（markSignedOut 实跑）');
  const logs = [];
  let broadcasts = 0;
  const env = {
    desktopQuietRun: null,
    state: {
      running: true, phase: 'completingTasks', loginStatus: 'in',
      pointsSummary: { available: 20192, today: 257, claimable: 0, updatedAt: 1 },
      todayTasks: { items: [{ name: 'a', points: 10 }], earned: 0, total: 10, percent: 0 }
    },
    DBG: { log: (...a) => logs.push(a.join(' ')) },
    /* v1.3.3：主进程用户面板动作保护窗口，本组测的是运行期，恒为 false */
    panelActionActive: () => false,
    emitStorageChanges: () => ({}),
    saveState: () => {},
    broadcast: () => { broadcasts++; },
    Date, console, Object, Number, String, RegExp, JSON
  };
  const sandbox = vm.createContext(env);
  vm.runInContext(quietFnSrc + '\n' + signOutFnSrc, sandbox);
  const before = JSON.stringify({ ps: env.state.pointsSummary, tt: env.state.todayTasks,
    login: env.state.loginStatus });
  vm.runInContext("markSignedOut('cookie-removed:.bing.com')", sandbox);
  vm.runInContext("markSignedOut('login-page')", sandbox);
  const after = JSON.stringify({ ps: env.state.pointsSummary, tt: env.state.todayTasks,
    login: env.state.loginStatus });
  ck(before === after,
     '运行中两种登出信号都不写任何业务键，积分 20,192 与任务列表原样保留');
  ck(logs.some(l => /运行中忽略登出信号/.test(l)), '运行期信号只记 debug 日志');
  ck(broadcasts === 0, '运行期没有任何 storage.onChanged 广播，UI 一次都不重绘');

  /* 非运行期确凿登出：只改 available 与 loginStatus，任务列表不清空 */
  env.state.running = false;
  env.state.phase = 'idle';
  vm.runInContext("markSignedOut('cookie-removed:.bing.com')", sandbox);
  ck(env.state.loginStatus === 'out', '空闲时确凿登出 → loginStatus=out');
  ck(env.state.pointsSummary.available === null, 'available 变为 null（登录态绑定它）');
  ck(env.state.pointsSummary.today === 257 && env.state.pointsSummary.claimable === 0,
     '今日积分 / 可领取保持不变（不清空，仅改变变化的值）');
  ck(env.state.todayTasks.items.length === 1,
     '任务列表原样保留，不会被清空成「未登录，请先登录后点刷新」');

  group('6. 点击登录按键不刷新 / 登录态绑定可用积分');
  ck(/loginReturn && !desktopQuietRun\(\)/.test(mainSource) &&
     !/panelReason === 'user'[\s\S]{0,200}?syncRewards/.test(mainSource),
     '只有登录成功跳回 Rewards 才同步一次；点徽标展开官网不刷新积分/登录状态');
  ck(/const signedIn = Number\.isFinite\(ps\.available\)/.test(popupSource),
     'popup 徽标状态只看 pointsSummary.available');
  ck(!/d\.loginStatus === 'in' \|\| hasData/.test(popupSource),
     '不再用 loginStatus / todayTasks 参与登录判定');

  group('7. 刷新只改变变化的值');
  ck(/function desktopFingerprint/.test(bgSource) && /function desktopSame/.test(bgSource),
     '统一同步有语义指纹比较');
  ck(/if \(!desktopSame\(before, v\)\) patch\[k\] = v/.test(bgSource),
     '逐键比较，只把真正变化的业务值写进 storage');
  ck(/if \(Object\.keys\(patch\)\.length\) await store\(patch\)/.test(bgSource),
     '值全没变时一次 store 都不做，UI 完全不动');
  ck(!/pointsSummary: \{ available: null, today: null, claimable: null, signedOut: true/.test(
       bgSource.slice(bgSource.indexOf('async function desktopSyncRewards'))),
     '统一同步里没有任何「先清空成 null」的分支');
  ck(/const readData = !!pages\.reachable \|\| snaps\.length > 0/.test(bgSource) &&
     /const ok = readData && !outOnly/.test(bgSource),
     '本次没读到官网数据时零动作返回，不凭旧缓存空跑');
  ck(/const keep =[\s\S]{0,300}?Number\.isFinite\(prevPs\[key\]\)/.test(bgSource),
     '值缺失时沿用上一次有效值，绝不把 UI 先清空成 —');

  group('8. 运行中界面保持不动且始终同一套刷新逻辑');
  ck(/if \(desktopQuietRun\(\)\) \{[\s\S]{0,220}?return;/.test(
       mainSource.slice(mainSource.indexOf('function markSignedOut'))),
     '运行期任何登出信号直接返回（不看 reason）');
  ck(/refreshTodayTasks = async function[\s\S]{0,300}?desktopSyncRewards\(/.test(bgSource) &&
     /refreshPointsOnly = async function[\s\S]{0,200}?desktopSyncRewards\(/.test(bgSource) &&
     /syncStart[\s\S]{0,700}?desktopSyncRewards\(/.test(bgSource) &&
     /presetSyncFinish[\s\S]{0,500}?desktopSyncRewards\(/.test(bgSource),
     '开始 / 收尾 / 手动刷新 / 各 refresh 入口仍绑定同一套统一同步');

  try { await page.close(); } catch {}
  console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('\x1b[31m验证异常：' + String(err && err.stack || err) + '\x1b[0m');
  process.exit(1);
});
