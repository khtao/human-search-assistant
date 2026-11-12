'use strict';
/* ============================================================================
 * v4.1 · 「今日 Bing 搜索」不是可点击任务卡片 / 空计划不打开侧栏
 *   node --test tests/v41-no-clickable-cards.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const C = require(path.join(ROOT, 'shared', 'hsa-core.js'));
const EB = read('edge-extension/background.js');
const DB = read('desktop-app/src/background.js');
const DM = read('desktop-app/main.js');

const SEARCH_ZH = { name: '今日 Bing 搜索', completed: false, points: 60, section: 'search', url: '' };
const SEARCH_EN = { name: 'Bing search today', completed: false, points: 60 };
const DONE = { name: '迪拜沙漠舒适宜人', completed: true, points: 10 };
const LIVE_A = { name: '古代创新', completed: false, points: 10 };
const LIVE_B = { name: '将推荐转化为奖励', completed: false, points: 10 };

test('v4.1 · 搜索进度项被识别为「非卡片」，普通卡片一律保留', () => {
  assert.equal(C.isNonClickableTaskItem(SEARCH_ZH), true);
  assert.equal(C.isNonClickableTaskItem(SEARCH_EN), true);
  assert.equal(C.isNonClickableTaskItem({ name: '今日 搜索', section: 'search' }), true);
  assert.equal(C.isNonClickableTaskItem({ name: 'Bing Search Today' }), true);
  assert.equal(C.isNonClickableTaskItem({ name: '古代创新', section: 'daily' }), false);
  assert.equal(C.isNonClickableTaskItem({ name: '将推荐转化为奖励', points: 10 }), false);
  assert.equal(C.isNonClickableTaskItem({ name: '今日 Bing 搜索', url: 'https://rewards.bing.com/x' }),
    false, '有真实链接的同名项仍按可点击卡片处理');
  assert.equal(C.isNonClickableTaskItem(null), true);
  assert.equal(C.isNonClickableTaskItem({}), true);
  assert.ok(C.SEARCH_PROGRESS_NAMES.includes('今日bing搜索'));
  assert.ok(C.SEARCH_PROGRESS_NAMES.includes('bingsearchtoday'));
});

test('v4.1 · pendingTaskItems 只删「非卡片 + 已完成」，顺序与重复项不变', () => {
  const items = [SEARCH_ZH, DONE, LIVE_A, LIVE_B, LIVE_A, SEARCH_EN];
  assert.deepEqual(C.pendingTaskItems(items).map(x => x.name),
    ['古代创新', '将推荐转化为奖励', '古代创新']);
  assert.deepEqual(C.pendingTaskItems([SEARCH_ZH]).map(x => x.name), []);
  assert.deepEqual(C.pendingTaskItems([DONE]).map(x => x.name), []);
  assert.deepEqual(C.pendingTaskItems([]), []);
  assert.deepEqual(C.taskPlanNames(items, null),
    ['古代创新', '将推荐转化为奖励', '古代创新']);
  const plan = C.buildTaskPlan(items, [], null);
  assert.deepEqual(plan.map(x => x.name), ['古代创新', '将推荐转化为奖励', '古代创新']);
  assert.ok(plan.every(x => x.completed === false));
});

test('v4.1 · hasClickableCards：只剩搜索项 / 只剩已完成 → false', () => {
  assert.equal(C.hasClickableCards([SEARCH_ZH], [SEARCH_ZH], null), false);
  assert.equal(C.hasClickableCards([SEARCH_EN], [SEARCH_EN], null), false);
  assert.equal(C.hasClickableCards([DONE], [DONE], null), false);
  assert.equal(C.hasClickableCards([SEARCH_ZH, DONE], [SEARCH_ZH, DONE], null), false);
  assert.equal(C.hasClickableCards([], [], null), false);
  assert.equal(C.hasClickableCards([LIVE_A], [], null), true);
  assert.equal(C.hasClickableCards([], [LIVE_A], null), true,
    '点击索引为空但主界面仍有未完成卡时，不误短路');
  assert.equal(C.hasClickableCards([SEARCH_ZH], [LIVE_B], null), true);
  /* 主界面完成态覆盖：索引里未标完成，但 UI 已标完成 → 也短路 */
  const summary = { items: [SEARCH_ZH, DONE] };
  assert.equal(C.hasClickableCards([{ name: '迪拜沙漠舒适宜人', completed: false }], [], summary),
    false, 'applyTaskCompletion 必须继续生效');
});

test('v4.1 · 用户场景复现：任务列表只剩「今日 Bing 搜索」时计划为空', () => {
  const uiItems = [SEARCH_ZH];
  const pluginStates = uiItems.map(it => ({
    name: it.name, completed: !!it.completed || Number(it.earned) >= Number(it.points),
    points: it.points
  }));
  const desktopIndex = [];   /* buildTaskClickIndex 已排除 section==='search' */
  /* 插件：runTaskStates + todayTasks 两个来源 */
  assert.equal(C.hasClickableCards(pluginStates, uiItems, { items: uiItems }), false);
  /* 桌面：taskClickIndex.items + todayTasks.items 两个来源 */
  assert.equal(C.hasClickableCards(desktopIndex, uiItems, { items: uiItems }), false);
  /* 状态行 m=0，不再出现「点卡 1/1」 */
  assert.deepEqual(C.taskPlanNames(pluginStates, { items: pluginStates }), []);
  /* 但仍要继续搜索：搜索项未满时 isAllDone 为 false */
  const summary = { items: uiItems, percent: 40, earned: 24, total: 60 };
  assert.equal(C.isAllDone(summary, { searchDone: false }), false);
});

test('v4.1 · 两端 hasPendingClickableCards / skipCardPhaseIfEmpty 逐字同构', () => {
  const take = src => {
    const a = src.indexOf('async function hasPendingClickableCards()');
    const b = src.indexOf('async function goBackSearch', a);
    return src.slice(a, b);
  };
  const e = take(EB), d = take(DB);
  assert.ok(e.length > 500 && d.length > 500);
  assert.equal(e.trim(), d.trim(), '两端 gate helper 必须逐字一致');
  for (const h of [e, d]) {
    assert.ok(h.includes("load(['taskClickIndex', 'todayTasks', 'runTaskStates'])"));
    assert.ok(h.includes('HSA_CORE.hasClickableCards(primary, secondary, summary)'));
    assert.ok(h.includes("hsaRunLog('no-clickable-cards'"));
    assert.ok(h.includes("stat.reason = 'no-clickable-cards'"));
    assert.ok(h.includes("zh: '无可点击任务卡，跳过侧栏'"));
    assert.ok(h.includes("en: 'No clickable cards, sidebar skipped'"));
  }
});

test('v4.1 · vm 实跑 gate helper：只剩搜索项 → true，有未完成卡 → false', async () => {
  const helper = EB.slice(EB.indexOf('async function hasPendingClickableCards()'),
    EB.indexOf('async function goBackSearch'));
  async function run(store) {
    const logs = [];
    const sandbox = {
      load: async () => store,
      HSA_CORE: C,
      hsaRunLog: async (ev, info) => { logs.push({ ev, info }); },
      console: { info: () => {} },
      Array, Number, String, Object, Promise, Math
    };
    vm.createContext(sandbox);
    vm.runInContext(helper + '\nglobalThis.__gate = hasPendingClickableCards;\n'
      + 'globalThis.__skip = skipCardPhaseIfEmpty;', sandbox);
    const stat = { clicked: 0, skipped: 0 };
    const skipped = await sandbox.__skip(stat);
    return { skipped, stat, logs };
  }
  const onlySearch = await run({ todayTasks: { items: [SEARCH_ZH] },
    runTaskStates: [{ name: '今日 Bing 搜索', completed: false, points: 60 }],
    taskClickIndex: { items: [] } });
  assert.equal(onlySearch.skipped, true);
  assert.equal(onlySearch.stat.reason, 'no-clickable-cards');
  assert.equal(onlySearch.stat.clicked, 0);
  assert.equal(onlySearch.logs.length, 1);
  assert.equal(onlySearch.logs[0].ev, 'no-clickable-cards');
  assert.equal(onlySearch.logs[0].info.result, 'skipped');
  assert.match(onlySearch.logs[0].info.detail, /搜索进度项与已完成卡已排除/);

  const onlyDone = await run({ todayTasks: { items: [DONE] },
    runTaskStates: [DONE], taskClickIndex: { items: [DONE] } });
  assert.equal(onlyDone.skipped, true);

  const hasCard = await run({ todayTasks: { items: [SEARCH_ZH, LIVE_A] },
    runTaskStates: [SEARCH_ZH, LIVE_A], taskClickIndex: { items: [LIVE_A] } });
  assert.equal(hasCard.skipped, false);
  assert.equal(hasCard.logs.length, 0, '有卡片时不应写跳过日志');
  assert.deepEqual(hasCard.stat, { clicked: 0, skipped: 0 });

  const indexEmptyButUiHasCard = await run({ todayTasks: { items: [LIVE_B] },
    runTaskStates: [], taskClickIndex: { items: [] } });
  assert.equal(indexEmptyButUiHasCard.skipped, false,
    '索引空但主界面有未完成卡时不短路');
});

test('v4.1 · 两端入口短路必须发生在任何侧栏/官网页面打开之前', () => {
  const eEntry = EB.indexOf('if (await skipCardPhaseIfEmpty(stat)) return stat;');
  assert.ok(eEntry > 0);
  assert.ok(eEntry < EB.indexOf('await runEmbeddedPanelTasks(token, stat)'),
    '插件入口 gate 在内部侧栏之前');
  const eInner = EB.indexOf('if (!(await hasPendingClickableCards()).ok)');
  const eInner2 = EB.indexOf('if (!(await hasPendingClickableCards()).ok)', eInner + 1);
  assert.ok(eInner > 0 && eInner < EB.indexOf("await openOrNavigate('humanTabId', pg.url)"),
    '插件回退 gate 在打开官网页面之前');
  assert.ok(eInner2 > eInner && eInner2 < EB.indexOf('await ensureEmbeddedPanel(token)'),
    '插件内部侧栏 gate 在 ensureEmbeddedPanel 之前');

  const dEntry = DB.indexOf('if (await skipCardPhaseIfEmpty(stat)) return stat;');
  assert.ok(dEntry > 0 && dEntry < DB.indexOf("if (TASK_MODE === 'human')"),
    '桌面入口 gate 在所有任务模式分支之前');
  assert.ok(dEntry < DB.indexOf('await humanClickTasks(token, stat)'),
    '桌面入口 gate 在调用 humanClickTasks（打开 flyout）之前');

  const clickAll = DM.indexOf("'chrome:task:clickAll'");
  const mainGate = DM.indexOf("reason: 'no-clickable-cards'", clickAll);
  assert.ok(clickAll > 0 && mainGate > clickAll);
  assert.ok(mainGate < DM.indexOf("showSidePanel(null, 'run', false)", clickAll),
    '桌面主进程 gate 在 showSidePanel 之前');
  assert.ok(mainGate < DM.indexOf('loadSidebarFlyout(tv, sidebarUrls, true)'),
    '桌面主进程 gate 在加载 panelflyout 之前');
  assert.ok(DM.includes('sidebarOpened: false'));
});

test('v4.1 · 包装层 m=0 不推送「点卡 0/0」，且用同一个权威 gate', () => {
  for (const [name, src, orig] of [['plugin', EB, 'hsaActivityOrigCards'],
                                   ['desktop', DB, 'desktopActivityOrigCards']]) {
    const needle = 'if (!ordered.length && !(await hasPendingClickableCards()).ok)\n'
      + '    return ' + orig + '(level, token);';
    assert.ok(src.includes(needle), name + ' 包装层缺 m=0 分支');
    const pos = src.indexOf(needle);
    assert.ok(pos < src.indexOf("hsaActivityPush('taskList'", pos)
      || pos < src.indexOf("desktopActivityWrite('taskList'", pos),
      name + ' 包装层短路必须在推送 taskList 之前');
  }
});

test('v4.1 · 主界面任务列表 / 搜索配额判定不受影响', () => {
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    assert.ok(src.includes("'今日 Bing 搜索'") || src.includes('Bing search today'),
      name + ' 搜索进度项生成被误删');
    assert.ok(src.includes('HSA_CORE.isAllDone(sync.todayTasks'),
      name + ' 全完成判定仍使用主界面任务列表');
    if (name === 'desktop') assert.ok(src.includes('searchTaskItem('),
      name + ' 搜索项构造函数仍在');
    else assert.ok(src.includes("name: bgLang === 'en' ? 'Bing search today' : '今日 Bing 搜索'"),
      name + ' 搜索进度项构造仍在');
  }
  /* 未完成搜索项 → 不 allDone（仍继续搜索，只是不点卡片） */
  const summary = { items: [SEARCH_ZH, LIVE_A], percent: 40, earned: 24, total: 60 };
  assert.equal(C.isAllDone(summary, { searchDone: false }), false);
  /* 严格档固定节奏、词规则不回退 */
  const st = C.strictRunPolicy();
  assert.equal(st.fixedNapMs, 600);
  assert.equal(st.randomDelay, false);
  const C2 = require(path.join(ROOT, 'shared', 'hsa-core.js'));
  assert.equal(C2.isStrictKeyword('五个字词甲'), true);
  assert.equal(C2.isStrictKeyword('四个字'), false);
});

test('v4.1 · 共享副本两端逐字节一致', () => {
  const master = read('shared/hsa-core.js');
  for (const d of ['edge-extension/shared/hsa-core.js', 'desktop-app/shared/hsa-core.js']) {
    assert.equal(read(d).replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), master.trim() + '\n');
  }
});
