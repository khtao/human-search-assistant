#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const CORE = require('../lib/core');
const DEBUG = require('../lib/debug-capture');
const DESK_BG = read('src/background.js');
const EXT_BG = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'background.js'), 'utf8');
const DESK_POP = read('src/popup.js');
const EXT_POP = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'popup.js'), 'utf8');
const DESK_HTML = read('src/popup.html');
const EXT_HTML = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'popup.html'), 'utf8');
const PKG = JSON.parse(read('package.json'));
const LOCK = JSON.parse(read('package-lock.json'));
const EXT_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'manifest.json'), 'utf8'));

let pass = 0;
function ck(condition, message) {
  assert.ok(condition, message);
  pass++;
  console.log('  ✓ ' + message);
}
function block(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, 'missing source marker: ' + start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b >= 0, 'missing end marker: ' + end);
  return source.slice(a, b);
}
function settingsIds(html) {
  const start = html.indexOf('<section id="settings"');
  assert.ok(start >= 0, 'settings section exists');
  const end = html.indexOf('</section>', start);
  assert.ok(end > start, 'settings section closes');
  return [...html.slice(start, end).matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
}
function settingsBlock(html) {
  const start = html.indexOf('<section id="settings"');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end + '</section>'.length);
}

console.log('\n拟人搜索助手 · v1.3.7 稳定性与跨端一致性专项\n');

// 1. Cookie sign-out classification: only authentication cookies may clear points.
ck(CORE.isRewardsAuthCookie({ name: 'MSPAuth' }), 'MSPAuth 被识别为认证 Cookie');
ck(CORE.isRewardsAuthCookie({ name: 'ESTSAUTHPERSISTENT' }), 'ESTSAUTHPERSISTENT 被识别为认证 Cookie');
ck(CORE.isRewardsAuthCookie({ name: 'RPSSecAuth' }), 'RPSSecAuth 被识别为认证 Cookie');
ck(CORE.isRewardsAuthCookie({ name: 'WLID' }), 'WLID 被识别为旧版 Microsoft 登录 Cookie');
ck(!CORE.isRewardsAuthCookie({ name: 'MUID' }), 'MUID 等统计 Cookie 不会触发登出');
ck(!CORE.isRewardsAuthCookie({ name: 'ai_session' }), 'ai_session 等遥测 Cookie 不会触发登出');
ck(!CORE.isRewardsAuthCookie({ name: 'preferences' }), '偏好设置 Cookie 不会触发登出');
const cookieFlow = block(MAIN, "s.cookies.on('changed'", "    });\n  } catch");
ck(cookieFlow.includes('removed && C.isRewardsAuthCookie(cookie)'), '主进程只记录已删除的明确认证 Cookie');
ck(!cookieFlow.includes('if (removed ||'), '普通 Cookie 删除不再直接触发清空积分');
ck(cookieFlow.includes('保留积分并等待页面确认登录状态') && !cookieFlow.includes('markSignedOut('), '认证 Cookie 删除也只记录诊断，不直接清空积分');
ck((MAIN.match(/markSignedOut\(/g) || []).length === 2 && MAIN.includes("markSignedOut('logout-url')"), '只有明确 logout URL 才直接清除登录态与积分');

// 2. Exact progress: the UI only displays 100% when earned points reach total points.
for (const [label, source] of [['桌面版', DESK_BG], ['浏览器插件', EXT_BG]]) {
  const summaryStart = source.indexOf('function summarizeTaskItems(items, extra) {');
  const helperEnd = source.indexOf('/** 一次刷新', summaryStart + 10);
  const helperSource = source.slice(summaryStart, helperEnd);
  const ctx = { Date, Number, Math };
  vm.createContext(ctx);
  vm.runInContext(helperSource, ctx);
  const rounded = ctx.summarizeTaskItems([
    { earned: 199, points: 200 }
  ]);
  const exact = ctx.summarizeTaskItems([
    { earned: 200, points: 200 }
  ]);
  ck(rounded.percent === 99, label + ' 99.5% 不再四舍五入显示为 100%');
  ck(exact.percent === 100 && ctx.isTaskSummaryComplete(exact), label + ' 只有 earned >= total 才判定全部完成');
  ck(!ctx.isTaskSummaryComplete(rounded), label + ' 未完全完成时禁止触发全完成短路');
  ck(source.includes('const allDone = isTaskSummaryComplete(sync.todayTasks)'), label + ' 开始同步使用精确完成判定');
  const run = block(source, 'async function runAutoComplete(opts) {', '\n/*');
  ck(run.includes("if (sync.allDone && !o.force)"), label + ' 100% 时在点击任务卡片前提前返回');
  ck(run.indexOf("if (sync.allDone && !o.force)") < run.indexOf('completePendingTaskCards(level, token)'), label + ' 全完成判断先于任何卡片点击调用');
}

// 3. Same settings page and setting semantics across desktop and Edge.
/* v1.3.8：开机自启 / 静默完成是桌面版专属，扩展端整组不显示。
   共有部分仍逐字一致；比较前把桌面专有组从两边口径中剔除。 */
const DESKTOP_ONLY_IDS = new Set(['desktop-group', 'set-auto-launch', 'set-silent-run', 'desktop-msg']);
const deskIds = settingsIds(DESK_HTML).filter(id => !DESKTOP_ONLY_IDS.has(id));
const extIds = settingsIds(EXT_HTML).filter(id => !DESKTOP_ONLY_IDS.has(id));
ck(JSON.stringify(deskIds) === JSON.stringify(extIds), '桌面版与 Edge 设置页面共有控件 ID 和顺序完全一致');
const stripDesktop = html => {
  let s = settingsBlock(html);
  const a = s.indexOf('      <!-- v1.3.8 · 桌面版专有');
  if (a >= 0) {
    const g = s.indexOf('id="desktop-group"', a);
    const b = s.indexOf('      </div>', g);
    if (g >= 0 && b > g) s = s.slice(0, a) + s.slice(b + '      </div>'.length);
  }
  return s.replace(/\s+/g, ' ').trim();
};
ck(stripDesktop(DESK_HTML) === stripDesktop(EXT_HTML), '桌面版与 Edge 设置页面共有部分 HTML 结构完全一致');
ck(settingsBlock(DESK_HTML).includes('id="desktop-group"') &&
   !settingsBlock(EXT_HTML).includes('id="desktop-group"'),
   '桌面专有组只在桌面版出现');
ck(deskIds.includes('set-skip-completed'), '两端均提供跳过已完成任务卡设置');
ck(DESK_POP.includes("saveSettings({ skipCompletedCards: e.target.checked })"), '桌面版设置变更写入 skipCompletedCards');
ck(EXT_POP.includes("saveSettings({ skipCompletedCards: e.target.checked })"), '浏览器插件设置变更写入 skipCompletedCards');
ck(DESK_BG.includes('skipCompletedCards: false') && EXT_BG.includes('skipCompletedCards: false'), '两端默认均不跳过已完成任务卡');
ck(!DESK_HTML.includes('set-cooldown') && !EXT_HTML.includes('set-cooldown'), '两端不再出现不一致的独立冷却设置项');

// 4. Desktop click IPC carries the same skipCompletedCards option as extension.
const desktopClick = block(MAIN, "ipcMain.handle('chrome:task:clickAll'", "\nipcMain.handle('chrome:panel:hide'");
ck(desktopClick.includes('options && options.skipCompletedCards'), '桌面主进程读取 skipCompletedCards 点击选项');
ck(desktopClick.includes('!skipCompletedCards || !x.completed'), '桌面点击筛选规则与插件版一致');
ck(PRELOAD.includes("clickAll: (index, options) => invoke('chrome:task:clickAll', index, options || {})"), 'preload 将点击设置透传到主进程');
<<<<<<< HEAD
ck(DESK_BG.includes('panel.clickAll(clickIndex, { skipCompletedCards: skipCompletedCards })'), '桌面后台向 CDP 点击器传入设置');
=======
ck(DESK_BG.includes('panel.clickAll(clickIndex, { skipCompletedCards: skipCompletedCards, cardClickIntervalSec: clickSettings.cardClickIntervalSec })'), '桌面后台向 CDP 点击器传入设置');
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
const extClick = block(EXT_BG, 'const humanClickTasksV136Original = humanClickTasks;', '\nchrome.tabs.onRemoved.addListener');
ck(extClick.includes('const includeDone = !cfg.skipCompletedCards'), '插件点击器按同一设置决定是否包含已完成卡片');

// 5. Long-run memory and lifecycle: bounded diagnostics, no leaked listeners/timers.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-v137-memory-'));
const disabledRoot = path.join(temp, 'disabled-debug');
const off = new DEBUG.DebugCapture({ rootDir: disabledRoot, enabled: false });
for (let i = 0; i < 10000; i++) { off.log('test', 'line ' + i); off.event({ i }); }
ck(!fs.existsSync(disabledRoot), '生产默认关闭调试时不创建空调试目录');
ck(off.logLines.length <= 80 && off.eventLines.length <= 120, '关闭调试时日志与事件内存缓冲有固定上限');
ck(off._pendingLogs.length === 0 && off._pendingEvents.length === 0, '关闭调试时不累积待写磁盘队列');
const enabledRoot = path.join(temp, 'enabled-debug');
const on = new DEBUG.DebugCapture({ rootDir: enabledRoot, enabled: true, maxHtml: 4 });
for (let i = 0; i < 10000; i++) on.log('test', 'line ' + i);
ck(on.logLines.length <= 80 && on.eventLines.length <= 120, '调试模式下近期日志和事件保留数量有上限');
ck(on._pendingLogs.length <= 2000 && on._pendingEvents.length <= 4000, '调试写盘队列有硬上限，避免高频事件导致内存膨胀');
on.close();
ck(on._flushTimer === null && on._onProcessExit === null, '关闭应用时可清理调试定时器与进程监听器');
fs.rmSync(temp, { recursive: true, force: true });
ck(MAIN.includes("wc.on('destroyed', cleanupTab)"), 'WebContentsView 销毁时清理 tabs / 登录标签引用');
ck(MAIN.includes("wc.removeListener('did-finish-load', finish)"), '任务页加载超时或失败时移除残留事件监听器');
ck(MAIN.includes('if (taskResultLoadWatcher) taskResultLoadWatcher.cancel()'), '快速连续打开任务页时取消上一轮导航监听器');
ck(MAIN.includes('finally { if (guardTimer) clearTimeout(guardTimer); }'), 'host 消息排队完成后清除超时定时器');
ck(MAIN.includes("DBG.close()"), 'Electron 退出时释放调试采集资源');

// 6. Version consistency and default verifier inclusion.
ck(PKG.version === '1.3.8' && LOCK.version === '1.3.8' && LOCK.packages[''].version === '1.3.8', '桌面 package 与 lock 版本统一为 1.3.8');
ck(EXT_MANIFEST.version === '1.3.8', 'Edge 插件版本统一为 1.3.8');
ck(PKG.scripts.verify.includes('verify-v137.js') && PKG.scripts.verify.includes('verify-task-index-v137.js'), '默认回归测试包含 v1.3.7 专项');
console.log('\n共 ' + pass + ' 项，通过 ' + pass + ' 项，失败 0 项');
