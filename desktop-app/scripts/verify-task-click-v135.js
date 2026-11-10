#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const EXT = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'background.js'), 'utf8');
const DESK_BG = fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
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

console.log('\n拟人搜索助手 · v1.3.5/v1.3.6 任务卡片鼠标点击专项\n');

const extClick = block(EXT, 'async function humanClickTasks(token, stat) {',
  '\nasync function completePendingTaskCards(level, token) {');
ck(extClick.includes('DASHBOARD_URL') && extClick.includes('EARN_URL'),
  '浏览器插件统一扫描 dashboard 与 earn 两个任务页');
ck(!extClick.includes('PRIMARY_FLYOUT_URL') && !extClick.includes('FLYOUT_URLS'),
  '浏览器插件不再重复打开两个 flyout 入口');
ck(extClick.includes('cdpClickAt(tabId, aim.x, aim.y)'),
  '浏览器插件任务卡点击使用 CDP 鼠标坐标');
ck(!extClick.includes("['human.click'") && !extClick.includes('human.click'),
  '浏览器插件任务流程不调用 DOM 合成点击');
ck(extClick.includes('stat.clicked++') && extClick.includes('stat.realMouse++'),
  '只有 CDP 鼠标事件成功返回后才累计点击数');
ck(extClick.includes('waitForTaskTabsComplete'),
  '浏览器插件等待鼠标打开的任务页完成加载');
ck(extClick.includes('stat.degraded = 0') && extClick.includes('stat.domClick = 0'),
  '浏览器插件不再记录 DOM 降级点击');

ck(EXT.includes("case 'human.click':       return { ok: false, reason: 'synthetic-click-disabled; use CDP mouse input' }"),
  '浏览器插件禁用旧 human.click 合成事件入口');
const extAim = block(EXT, 'var humanAim = function (payload) {', '\n  /* 旧 DOM.click 路径停用');
ck(extAim.includes('document.elementFromPoint') &&
   extAim.includes('covered-or-not-hit-testable'),
  '浏览器插件点击前验证坐标落在卡片内部且未被遮挡');
ck(extAim.includes("target: c.target || c.el.getAttribute('target') || ''"),
  '浏览器插件回传 target 类型，按新标签页加载情况等待验证');
const pick = block(EXT, 'var pickCard = function (cards, payload) {', '\n  /**');
<<<<<<< HEAD
ck(pick.indexOf('if (payload.href)') < pick.indexOf('data-yb-hidx'),
  '浏览器插件优先按稳定 href 定位，避免滚动后旧 index 指向别的卡片');
=======
ck(pick.includes('if (href)') && pick.includes('eligible.length === 1') && pick.includes('byId.length === 1') && !pick.includes('cards[payload.order]'),
  '浏览器插件以 href/稳定身份严格匹配，不按旧顺序误点');
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
const extCdpClick = block(EXT, 'async function cdpClickAt(tabId, x, y) {', '\n/** 粘贴前清空');
ck(extCdpClick.includes("type: 'mousePressed'") &&
   extCdpClick.includes("type: 'mouseReleased'") &&
   extCdpClick.includes('releaseError'),
  '浏览器插件鼠标按下后始终尝试释放，停止任务也不会遗留按下态');
<<<<<<< HEAD
ck(EXT.includes("const TASK_CLICK_INTERVAL_MS = 350;"),
  '浏览器插件将卡片间隔压缩为短渲染等待');
=======
ck(EXT.includes('const TASK_CLICK_INTERVAL_MS = 10000;') &&
   EXT.includes('const seconds = Number(cfg.cardClickIntervalSec);') &&
   EXT.includes('await taskClickSpacing(token);'),
  '浏览器插件默认 10 秒并读取可调整的卡片点击间隔');
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
ck(EXT_MANIFEST.permissions.includes('debugger'),
  '浏览器插件保留 CDP debugger 权限');

const aim = block(MAIN, 'function taskAimIndexedSrc(entry) {', '\n/* CDP 原生输入事件');
ck(aim.includes('elementFromPoint') && aim.includes('indexed-card-covered'),
  '桌面版点击前检查目标点是否被遮挡');
ck(aim.includes('scrollIntoView') && aim.includes('getBoundingClientRect'),
  '桌面版点击前滚入视口并重新读取实时坐标');
ck(aim.includes('norm(text).includes(norm(expectedTitle))') && aim.includes('pointsOf(el,text)'),
  '桌面版按索引校验目标标题和积分，避免错点相似卡片');
ck(!aim.includes('.click('),
  '桌面版定位脚本不调用 HTMLElement.click()');

const dispatch = block(MAIN, 'async function dispatchTaskMouseClick(debuggerSession, x, y) {',
  '\n/* 监听下一次主 frame 导航');
ck(dispatch.includes('Input.dispatchMouseEvent') &&
   dispatch.includes("type: 'mousePressed'") &&
   dispatch.includes("type: 'mouseReleased'"),
  '桌面版发送 mouseMoved / mousePressed / mouseReleased 三段 CDP 输入');
ck(dispatch.includes('if (!released)') && dispatch.includes('mouseReleased'),
  '桌面版即使中途异常也会尝试释放鼠标按键');

const taskHandler = block(MAIN, "ipcMain.handle('chrome:task:clickAll', async (_event, clickIndex, options) => {",
  "\nipcMain.handle('chrome:panel:hide'");
ck(taskHandler.includes("if (!sideVisible) showSidePanel(null, 'run', false)"),
  '桌面版点击前确保任务侧栏具有可见视口且不抢焦点');
ck(taskHandler.includes('dispatchTaskMouseClick(dbg, aim.x, aim.y)'),
  '桌面版任务循环调用 CDP 鼠标点击');
ck(!taskHandler.includes('taskClickSrc') && !taskHandler.includes('el.click('),
  '桌面版任务循环没有 DOM click 降级');
ck(taskHandler.includes('taskResultLoadPromise') && taskHandler.includes('loadTaskPage(tv, pageDef.url)'),
  '桌面版等待任务页加载并在同页导航后恢复任务列表');
ck(taskHandler.includes("method: 'sync-index + CDP Input.dispatchMouseEvent'"),
  '桌面版返回结果明确标记 CDP 鼠标输入方式');

const wrapper = block(DESK_BG, 'const uploadCompletePendingTaskCards = completePendingTaskCards;',
  '\n/* 桌面运行静默');
ck(!wrapper.includes('return uploadCompletePendingTaskCards('),
  '桌面版 CDP 失败时不回退到旧版合成点击');
ck(wrapper.includes('stat.realMouse = Number(r.clicked)') &&
   wrapper.includes('stat.degraded = 0'),
  '桌面版只把 CDP 实际点击计入真鼠标统计');

ck(PKG.version === '1.3.8', '桌面应用版本升级为 1.3.8');
ck(PKG.scripts.verify.includes('verify-task-click-v135.js') && PKG.scripts.verify.includes('verify-task-index-v137.js'),
  '默认回归测试包含鼠标点击和同步定位索引专项');

(async () => {
  const context = { setTimeout, clearTimeout, Promise };
  vm.createContext(context);
  vm.runInContext(dispatch + '\nthis.__dispatch = dispatchTaskMouseClick;', context);
  const calls = [];
  const dbg = {
    isAttached: () => true,
    sendCommand: async (method, params) => { calls.push({ method, params }); return {}; }
  };
  await context.__dispatch(dbg, 120, 240);
  ck(calls.length === 3, 'CDP 鼠标点击恰好发送三条输入命令');
  ck(calls.every(x => x.method === 'Input.dispatchMouseEvent'),
    '三条命令均来自 Input.dispatchMouseEvent');
  ck(calls.map(x => x.params.type).join(',') === 'mouseMoved,mousePressed,mouseReleased',
    'CDP 输入顺序为移动 → 按下 → 释放');
  ck(calls[1].params.button === 'left' && calls[1].params.buttons === 1 &&
     calls[2].params.buttons === 0,
    '鼠标左键按下与释放状态正确');

  console.log('\n共 ' + pass + ' 项，通过 ' + pass + ' 项，失败 0 项');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
