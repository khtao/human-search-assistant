'use strict';
/* ============================================================================
 * v3.7 · 桌面版跳过已完成（根因复现）/ 拟人搜索间隔 / 标准 Chrome 标识
 *   node --test tests/v37-completion-intervals-chrome.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------------------------------------------------------------- 1. 根因 */
test('v3.7 · 桌面版根因复现：HTML 索引完成态缺失时，用主界面任务列表跳过已完成', () => {
  /* 截图场景：taskClickIndex.items 由 SPA HTML 解析，completed 全 false；
     todayTasks.items（主界面显示「已完成」）才是权威。 */
  const clickIndex = { schemaVersion: 1, updatedAt: Date.now(), items: [
    { name: '将推荐转化为奖励', points: 10, completed: false, page: '/dashboard' },
    { name: '迪拜沙漠舒适宜人', points: 10, completed: false, page: '/dashboard' },
    { name: '古代创新', points: 10, completed: false, page: '/earn' },
    { name: '探险火星', points: 15, completed: false, page: '/earn' },
    { name: '完成此拼图', points: 5, completed: false, page: '/earn' },
    { name: '将推荐转化为奖励', points: 10, completed: false, page: '/dashboard' }
  ] };
  const todayTasks = { items: [
    { name: '将推荐转化为奖励', points: 10, earned: 0 },
    { name: '迪拜沙漠舒适宜人', points: 10, completed: true },
    { name: '古代创新', points: 10, earned: 10 },
    { name: '探险火星', points: 15, completed: true },
    { name: '完成此拼图', points: 5, earned: 0 }
  ] };

  /* 修复前：直接 pendingTaskItems(clickIndex.items) → 6 张全点（截图 11/17） */
  assert.equal(CORE.pendingTaskItems(clickIndex.items).length, 6,
    '复现旧行为：HTML 索引完成态缺失时一张都不跳过');

  /* 修复后：同步阶段 applyTaskCompletion + 运行时 buildTaskPlan */
  const fixed = CORE.applyTaskCompletion(clickIndex.items, todayTasks);
  assert.deepEqual(fixed.map(i => i.name + ':' + i.completed), [
    '将推荐转化为奖励:false', '迪拜沙漠舒适宜人:true', '古代创新:true',
    '探险火星:true', '完成此拼图:false', '将推荐转化为奖励:false'
  ]);
  const dom = [{ idx: 7, name: '将推荐转化为奖励', kind: 'referral' }, { idx: 9, name: '完成此拼图' }];
  const plan = CORE.buildTaskPlan(clickIndex.items, dom, todayTasks);
  assert.deepEqual(plan.map(c => c.name),
    ['将推荐转化为奖励', '完成此拼图', '将推荐转化为奖励'],
    '只跳过主界面标记已完成的 3 张；重复项 / 有积分的推荐卡仍保留');
  assert.equal(plan[0].idx, 7, 'DOM 扫描只补定位');
  assert.deepEqual(CORE.taskPlanNames(clickIndex.items, todayTasks), plan.map(c => c.name),
    '状态行 m 与实际计划同源，不再出现 9/17 式不一致');
  /* 主界面状态缺失时不臆造完成态 */
  assert.equal(CORE.buildTaskPlan([{ name: 'A', completed: true }], [], null).length, 0);
  assert.equal(CORE.buildTaskPlan([{ name: 'A', completed: false }], [], null).length, 1);
  /* 同名多项：全部完成才算完成（避免误跳过待完成项） */
  const mixed = CORE.buildTaskPlan(
    [{ name: '拼图' }, { name: '拼图' }], [],
    { items: [{ name: '拼图', completed: true }, { name: '拼图', completed: false }] });
  assert.equal(mixed.length, 2);
});

test('v3.7 · 两端源码：完成态合并与计划入口完全同构', () => {
  const eb = read('edge-extension/background.js');
  const db = read('desktop-app/src/background.js');
  const dm = read('desktop-app/main.js');
  assert.match(db, /taskClickIndex\.items = HSA_CORE\.applyTaskCompletion\(taskClickIndex\.items, todayTasks\)/);
  assert.match(eb, /const taskStates = HSA_CORE\.applyTaskCompletion\(mappedStates, sync\.todayTasks\)/);
  assert.match(dm, /HSA_CORE\.buildTaskPlan\(presetItems, domCards, syncSummary\)/);
  assert.match(eb, /HSA_CORE\.buildTaskPlan\(taskStates, cards, \{ items: taskStates \}\)/);
  assert.match(eb, /HSA_CORE\.buildTaskPlan\(taskStates, merged, \{ items: taskStates \}\)/);
  assert.match(db, /HSA_CORE\.taskPlanNames\(idxItems, snap\.todayTasks\)/);
  assert.match(eb, /HSA_CORE\.taskPlanNames\(taskStates, \{ items: taskStates \}\)/);
  /* 唯一过滤仍在共享 pendingTaskItems */
  assert.match(read('shared/hsa-core.js'), /return !\(it\.completed === true \|\| it\.done === true\)/);
});

/* ------------------------------------------------------------ 2. 间隔设置 */
test('v3.7 · 拟人搜索间隔：默认值、夹取与固定节奏（不引入随机）', () => {
  const d = CORE.strictRunPolicy();
  assert.equal(d.fixedNapMs, 600);
  assert.equal(d.pageStableWaitMs, 3000);
  assert.equal(d.fixedRoundIntervalMs, 10000);
  assert.equal(d.fixedRoundWaitMs, 3000);
  assert.equal(d.randomDelay, false);
  assert.equal(d.humanVariation, false);
  assert.equal(d.scroll, false);
  assert.equal(d.clickResult, false);

  const cfg = { actionGapSec: 1.2, pageStableSec: 4, roundGapSec: 20,
    roundWaitSec: 2, cardClickIntervalSec: 15 };
  const p = CORE.strictRunPolicy(cfg);
  assert.equal(p.fixedNapMs, 1200);
  assert.equal(p.pageStableWaitMs, 4000);
  assert.equal(p.fixedRoundIntervalMs, 20000);
  assert.equal(p.fixedRoundWaitMs, 2000);
  assert.equal(p.cardClickIntervalSec, 15);
  assert.equal(p.randomDelay, false, '可配置的是固定间隔，不恢复随机延时');

  /* 越界 / 非法值一律夹回合法区间或默认 */
  assert.equal(CORE.clampIntervalMs('actionGapMs', 99), 5000);
  assert.equal(CORE.clampIntervalMs('actionGapMs', 0.01), 100);
  assert.equal(CORE.clampIntervalMs('actionGapMs', -1), 600);
  assert.equal(CORE.clampIntervalMs('actionGapMs', 'abc'), 600);
  assert.equal(CORE.clampIntervalMs('roundGapMs', 999), 60000);
  const norm = CORE.normalizeIntervals({});
  assert.deepEqual(norm.actionGapMs, 600);
  assert.equal(norm.cardClickIntervalSec, 10);
  /* 默认秒值与后台/UI 默认值一致 */
  assert.equal(CORE.intervalDefaultSec('actionGapMs'), 0.6);
  assert.equal(CORE.intervalDefaultSec('pageStableWaitMs'), 3);
  assert.equal(CORE.intervalDefaultSec('roundGapMs'), 10);
});

test('v3.7 · 两端设置项与后台读取逐项同源', () => {
  const eh = read('edge-extension/popup.html');
  const dh = read('desktop-app/src/popup.html');
  /* v4.2 · 4 项间隔已收进三组预设摘要，不再有可编辑输入框 */
  const keys = ['actionGapSec', 'pageStableSec', 'roundGapSec', 'roundWaitSec'];
  for (const key of keys) {
    assert.ok(eh.includes('data-preset="' + key + '"')
      && dh.includes('data-preset="' + key + '"'), key + ' 两端都要有只读摘要');
    assert.ok(!eh.includes('id="set-' + key + '"'), key + ' 不应再是输入框');
  }
  const block = s => {
    const a = s.indexOf('id="run-preset-groups"');
    const b = s.indexOf('id="run-preset-strict"', a);
    return s.slice(a, b);
  };
  assert.equal(block(eh), block(dh), '两端三组预设摘要必须逐字一致');

  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    const s = read(p);
    for (const key of ['auto.actionGap', 'auto.pageStable', 'auto.roundGap', 'auto.roundWait']) {
      assert.ok(s.includes("'" + key + "'"), p + ' 缺字典键 ' + key);
    }
    /* v4.2 · 后台按强度整组套用；popup 只做只读渲染 */
    assert.match(s, /function renderRunPreset\(\)/);
    assert.match(s, /HSA_HUMAN\.presetValues\(/);
    assert.match(s, /strictRunGuard\('saveSettings'\)/, p + ' 运行期改设置仍被拦截');
  }
  for (const p of ['edge-extension/background.js', 'desktop-app/src/background.js']) {
    const s = read(p);
    assert.match(s, /let STRICT = HSA_CORE\.strictRunPolicy\(\)/);
    assert.match(s, /STRICT = HSA_CORE\.strictRunPolicy\(RUN_SETTINGS\)/);
    assert.match(s, /actionGapSec: HSA_CORE\.intervalDefaultSec\('actionGapMs'\)/);
    assert.match(s, /const STRICT_POLICY = STRICT;/);
  }
  /* 插件版仍无浏览器伪装（只改桌面版） */
  assert.doesNotMatch(read('edge-extension/background.js'), /CHROME_UA|userAgentFallback/);
});

/* ------------------------------------------------------ 3. 桌面 Chrome 标识 */
function chromeSandbox(platform, chromeVersion) {
  const src = read('desktop-app/main.js');
  const start = src.indexOf('const CHROME_BUILD_VERSION');
  const end = src.indexOf('const DEFAULT_BROWSER_HOME');
  assert.ok(start > 0 && end > start, '找不到 Chrome 标识块');
  const appended = [];
  let headerCallback = null;
  const mockSession = {
    webRequest: {
      onBeforeSendHeaders: (filter, cb) => { headerCallback = cb; }
    }
  };
  const ctx = {
    process: { versions: { chrome: chromeVersion }, platform },
    console, URL, Object, Array, String, Number, JSON, RegExp, Promise,
    app: { on: (ch, fn) => appended.push([ch, fn]) },
    getAppSession: () => mockSession
  };
  vm.runInNewContext(src.slice(start, end) +
    '\nglobalThis.__api = { CHROME_UA, CHROME_CH_UA, CHROME_UA_PLATFORM,' +
    ' CHROME_BUILD_VERSION, CHROME_MAJOR, CHROME_IDENTITY_SCRIPT,' +
    ' applyChromeIdentityHeaders, attachChromeIdentity, CHROME_TARGET_HOST };', ctx);
  return { api: ctx.__api, appended, getHeaderCallback: () => headerCallback, ctx };
}

test('v3.7 · 桌面 UA / sec-ch-ua / navigator 同源去 Electron', () => {
  for (const [platform, ver, token, uaPlatform] of [
    ['linux', '140.0.7339.81', 'X11; Linux x86_64', 'Linux'],
    ['win32', '140.0.7339.81', 'Windows NT 10.0; Win64; x64', 'Windows']
  ]) {
    const { api } = chromeSandbox(platform, ver);
    assert.ok(api.CHROME_UA.includes('Chrome/' + ver), 'UA 用真实 Chromium 版本');
    assert.ok(api.CHROME_UA.includes(token), 'UA 平台与真实 OS 一致');
    assert.ok(!/Electron/i.test(api.CHROME_UA), 'UA 不含 Electron');
    assert.ok(api.CHROME_CH_UA.includes('"Chromium";v="140"')
      && api.CHROME_CH_UA.includes('"Google Chrome";v="140"'), 'CH 品牌与 UA 大版本一致');
    assert.ok(!/Electron/i.test(api.CHROME_CH_UA));
    assert.equal(api.CHROME_UA_PLATFORM, uaPlatform);
    assert.equal(api.CHROME_MAJOR, '140');
    assert.ok(!/Electron/i.test(api.CHROME_IDENTITY_SCRIPT), 'navigator 脚本不含 Electron');
    assert.ok(api.CHROME_IDENTITY_SCRIPT.includes('Google Chrome'));
    /* 不过度伪造 */
    for (const bad of ['WEBGL_debug_renderer_info', 'WebGLRenderingContext',
                       'defineProperty(screen', 'devicePixelRatio =', 'navigator.plugins =']) {
      assert.ok(!api.CHROME_IDENTITY_SCRIPT.includes(bad), '不应伪造 ' + bad);
    }
    /* 真实执行注入脚本，确认 navigator.userAgentData 对齐 */
    const pageCtx = { navigator: {}, window: {}, Object, Array, String, JSON, Promise };
    vm.runInNewContext(api.CHROME_IDENTITY_SCRIPT, pageCtx);
    const d = pageCtx.navigator.userAgentData;
    assert.equal(d.platform, uaPlatform);
    assert.equal(d.mobile, false);
    assert.ok(d.brands.some(b => b.brand === 'Google Chrome' && b.version === '140'));
    assert.ok(!JSON.stringify(d).includes('Electron'));
  }
});

test('v3.7 · 请求头改写只作用于目标域，且清除旧 UA/CH', () => {
  const { api, appended, getHeaderCallback } = chromeSandbox('linux', '140.0.7339.81');
  api.applyChromeIdentityHeaders();
  const cb = getHeaderCallback();
  assert.ok(typeof cb === 'function', '注册了 onBeforeSendHeaders');
  assert.ok(appended.some(([ch]) => ch === 'web-contents-created'), '注册了视图钩子');

  const run = (url, oldHeaders) => {
    let out = null;
    cb({ url, requestHeaders: Object.assign({}, oldHeaders) },
       r => { out = r.requestHeaders; });
    return out;
  };
  const target = run('https://rewards.bing.com/dashboard', {
    'User-Agent': 'Mozilla/5.0 ... Electron/45.0.0 Chrome/140.0.0.0',
    'sec-ch-ua': '"Electron";v="45"',
    'Accept': 'text/html', 'Cookie': 'x=1'
  });
  assert.equal(target['User-Agent'], api.CHROME_UA);
  assert.equal(target['sec-ch-ua'], api.CHROME_CH_UA);
  assert.equal(target['sec-ch-ua-platform'], '"Linux"');
  assert.equal(target['sec-ch-ua-mobile'], '?0');
  assert.equal(target['Accept'], 'text/html', '其它请求头保留');
  assert.equal(target['Cookie'], 'x=1');
  assert.ok(!Object.keys(target).some(k => /Electron/i.test(String(target[k]))));

  const other = run('https://example.com/api', { 'User-Agent': 'keep-me', 'X': '1' });
  assert.equal(other['User-Agent'], 'keep-me', '非目标域保持原样');
  assert.equal(other['sec-ch-ua'], undefined);
});

test('v3.7 · navigator 对齐只在外部网页 dom-ready 执行，且短小不常驻', () => {
  const { api, appended } = chromeSandbox('linux', '140.0.7339.81');
  const hook = appended.find(([ch]) => ch === 'web-contents-created')[1];
  const executed = [];
  const wc = {
    handlers: {},
    on: (ev, fn) => { wc.handlers[ev] = fn; },
    getURL: () => 'https://rewards.bing.com/earn',
    executeJavaScript: async src => { executed.push(src); return true; }
  };
  hook(null, wc);
  assert.ok(typeof wc.handlers['dom-ready'] === 'function');
  wc.handlers['dom-ready']();
  assert.equal(executed.length, 1, '外部网页注入一次');
  assert.ok(!/Electron/i.test(executed[0]));
  assert.ok(executed[0].length < 2000, '脚本很短，不驻留大闭包');

  /* 本地 UI 页面（file:// / about:blank）不注入 */
  const local = {
    handlers: {}, on: (ev, fn) => { local.handlers[ev] = fn; },
    getURL: () => 'about:blank',
    executeJavaScript: async src => { executed.push(src); return true; }
  };
  hook(null, local);
  local.handlers['dom-ready']();
  assert.equal(executed.length, 1, 'about:blank 不注入');
});
