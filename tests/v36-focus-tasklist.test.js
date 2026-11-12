'use strict';
/* ============================================================================
 * v3.6 · 后台静默运行（不抢焦点 / CDP 保活）+ 任务列表为唯一点击依据
 *   node --test tests/v36-focus-tasklist.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BG = read('edge-extension/background.js');

/** 从源码里按大括号配对截取一个顶层 async function 的完整定义。 */
function sliceFn(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  assert.ok(start >= 0, '找不到函数 ' + name);
  const open = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > open, '函数体未闭合 ' + name);
  return src.slice(start, end);
}

function makeSandbox(overrides) {
  const calls = [];
  const chrome = {
    tabs: {
      get: async id => ({ id: Number(id), active: false, windowId: 7, status: 'complete' }),
      update: async (id, patch) => { calls.push(['tabs.update', Number(id), patch]); return {}; },
      create: async opts => { calls.push(['tabs.create', opts]); return { id: 42 }; },
      query: async () => []
    },
    windows: {
      update: async (id, patch) => { calls.push(['windows.update', Number(id), patch]); }
    },
    debugger: {
      sendCommand: async (target, method, params) => {
        calls.push(['cdp', method, params, target]);
      }
    }
  };
  const ctx = Object.assign({
    chrome, console,
    QUIET_BACKGROUND: true, FOCUS_WINDOW_TOO: false,
    RESTORE_FOCUS_ON_FINISH: false, KEEP_SEARCH_TAB_FOCUSED: true,
    cdpAttached: new Set([42]),
    load: async () => ({}),
    store: async () => {},
    getTab: async () => null,
    Number, Math, Date, Promise, Set, String, Object, Array, RegExp, Error, Boolean
  }, overrides || {});
  const fns = [
    'cdpEmulateFocus', 'cdpKeepActive', 'cdpBringToFront',
    'keepSearchTabAwake', 'ensureTabActive', 'restoreUserFocus', 'openOrNavigate'
  ].map(n => sliceFn(BG, n)).join('\n\n');
  vm.runInNewContext(fns + '\nglobalThis.__api = {' +
    ['ensureTabActive', 'keepSearchTabAwake', 'restoreUserFocus', 'openOrNavigate',
     'cdpKeepActive', 'cdpBringToFront'].join(',') + '};', ctx);
  return { api: ctx.__api, calls, ctx };
}

/* ---------------------------------------------------------------- 焦点 */
test('v3.6 · ensureTabActive 不切换活动标签、不聚焦窗口，只关自动丢弃', async () => {
  const { api, calls } = makeSandbox();
  const ok = await api.ensureTabActive(42);
  assert.equal(ok, true);
  assert.equal(JSON.stringify(calls),
    JSON.stringify([['tabs.update', 42, { autoDiscardable: false }]]));
  assert.ok(!calls.some(c => c[0] === 'windows.update'));
  assert.ok(!calls.some(c => c[0] === 'tabs.update' && c[2] && c[2].active === true));
});

test('v3.6 · keepSearchTabAwake 每轮只发 CDP 保活，不抢焦点', async () => {
  const { api, calls } = makeSandbox();
  const ok = await api.keepSearchTabAwake(42);
  assert.equal(ok, true);
  const cdps = calls.filter(c => c[0] === 'cdp').map(c => c[1]);
  assert.ok(cdps.includes('Emulation.setFocusEmulationEnabled'));
  assert.ok(cdps.includes('Page.setWebLifecycleState'));
  assert.ok(!cdps.includes('Page.bringToFront'), '绝不把页面拉到前台');
  assert.ok(!calls.some(c => c[0] === 'tabs.update' && c[2] && c[2].active === true));
  assert.ok(!calls.some(c => c[0] === 'windows.update'));
  /* 连跑 5 轮（模拟 5 次搜索）也不产生任何焦点切换 */
  const before = calls.length;
  for (let i = 0; i < 5; i++) await api.keepSearchTabAwake(42);
  assert.ok(!calls.slice(before).some(c => c[0] === 'windows.update'
    || (c[0] === 'tabs.update' && c[2] && c[2].active === true)));
});

test('v3.6 · cdpBringToFront 在静默模式直接短路；cdpKeepActive 正常工作', async () => {
  const { api, calls } = makeSandbox();
  assert.equal(await api.cdpBringToFront(42), false);
  assert.equal(calls.length, 0);
  assert.equal(await api.cdpKeepActive(42), true);
  assert.equal(calls[0][1], 'Page.setWebLifecycleState');
  assert.equal(JSON.stringify(calls[0][2]), JSON.stringify({ state: 'active' }));
});

test('v3.6 · openOrNavigate 即使传 active=true 也强制后台创建', async () => {
  const { api, calls } = makeSandbox();
  const id = await api.openOrNavigate('searchTabId', 'https://www.bing.com/', true);
  assert.equal(id, 42);
  const create = calls.find(c => c[0] === 'tabs.create');
  assert.ok(create, '创建了标签');
  assert.equal(create[1].active, false, '后台创建，不激活');
  assert.ok(calls.some(c => c[0] === 'tabs.update'
    && c[2] && c[2].autoDiscardable === false), '关闭自动丢弃保证可靠');
});

test('v3.6 · restoreUserFocus 不把用户拉回原标签，只清理历史记录', async () => {
  const cleared = [];
  const { api, calls } = makeSandbox({
    load: async () => ({ userActiveTabId: 99 }),
    store: async patch => { cleared.push(patch); }
  });
  await api.restoreUserFocus();
  assert.equal(calls.length, 0, '不调用任何 tabs.update');
  assert.equal(JSON.stringify(cleared), JSON.stringify([{ userActiveTabId: null }]));
});

/* ------------------------------------------------- 任务列表为唯一依据 */
test('v3.6 · pendingTaskItems 只按任务列表自身完成标记过滤', () => {
  const items = [
    { name: '将推荐转化为奖励', points: 10 },
    { name: '古代创新', completed: true, points: 10 },
    { name: '足球传奇', done: true, points: 5 },
    { name: '完成此拼图', points: 5 },
    { name: '0 分项', points: 0 },
    { name: '推广项', kind: 'promotion', points: 0 },
    { name: '将推荐转化为奖励', points: 10 }
  ];
  const pending = CORE.pendingTaskItems(items);
  assert.deepEqual(pending.map(c => c.name),
    ['将推荐转化为奖励', '完成此拼图', '0 分项', '推广项', '将推荐转化为奖励']);
  assert.equal(pending.length, 5);
});

test('v3.6 · 计划只跳过已完成；DOM 完成标记 / kind / scored / 积分不参与', () => {
  const items = [
    { name: 'A' }, { name: 'B', completed: true }, { name: 'C', points: 0 },
    { name: 'D', kind: 'referral' }, { name: 'A' }
  ];
  const dom = [
    { idx: 1, name: 'A', completed: true, scored: false, kind: 'referral' },
    { idx: 2, name: 'B', completed: false, scored: true },
    { idx: 3, name: 'C', completed: true, scored: false },
    { idx: 4, name: 'D', completed: true, scored: false, kind: 'redeem' }
  ];
  const plan = CORE.planTaskClicks(items, dom);
  assert.deepEqual(plan.map(c => c.name), ['A', 'C', 'D', 'A']);
  assert.ok(plan.every(c => !c.completed));
  assert.equal(plan[0].idx, 1, 'DOM 只补定位');
  /* 全部已完成 → 零动作 */
  assert.equal(CORE.planTaskClicks([{ name: 'X', completed: true }], []).length, 0);
});

test('v3.6 · 运行提示词 m 与待点计划同源，且只报当前动作', () => {
  const items = [
    { name: '将推荐转化为奖励' }, { name: '古代创新', completed: true },
    { name: '完成此拼图' }
  ];
  const plan = CORE.planTaskClicks(items, []);
  const a = CORE.runActivity('taskList', { m: plan.length, list: items.map(i => i.name).join('、') });
  assert.ok(a.zh.includes(String(plan.length)), '可见文案带待点数量');
  assert.ok(!/下一步|Next|之后|then/.test(a.zh));
  assert.equal(a.next, '');
  assert.equal(CORE.runActivity('cardsDone', { n: 2, m: plan.length }).zh, '点卡完成 2/2');
});

test('v3.6 · 两端源码：无业务词判别、无抢焦点运行时参数', () => {
  const files = [
    'desktop-app/src/background.js', 'desktop-app/main.js',
    'edge-extension/background.js', 'edge-extension/flyout-bridge.js'
  ];
  for (const p of files) {
    const s = read(p);
    assert.ok(!/const skipCompletedCards = true;/.test(s), p + ' 残留 skipCompletedCards');
    assert.ok(!/const includeDone = false;/.test(s), p + ' 残留 includeDone=false');
  }
  for (const p of ['desktop-app/src/background.js', 'edge-extension/background.js']) {
    assert.match(read(p), /var bannedText = \/\$\^\/;/, p + ' 扫描不应按业务词排除');
  }
  assert.match(read('edge-extension/background.js'), /var EX_TITLE = \/\$\^\/;/);
  assert.match(read('edge-extension/flyout-bridge.js'), /const EXCLUDE_TITLE_RE = \/\$\^\/;/);
  assert.ok(!read('desktop-app/main.js').includes('pageEntries.push(item)'),
    '回退路径不得用 DOM 扫描结果新增计划项');
  assert.match(read('desktop-app/main.js'), /const hasPaged = entries\.some/);
  /* 两端包装层 m 与计划同源 */
  assert.match(read('desktop-app/src/background.js'),
    /HSA_CORE\.taskPlanNames\(idxItems, snap\.todayTasks\)/);
  assert.match(read('edge-extension/background.js'),
    /HSA_CORE\.taskPlanNames\(taskStates, \{ items: taskStates \}\)/);
});
