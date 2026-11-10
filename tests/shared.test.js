/* 共享核心纯逻辑单测：node --test tests/shared.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const CORE = require('../shared/hsa-core.js');
const RECOVERY = require('../shared/hsa-recovery.js');
const decisions = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'shared', 'decisions.json'), 'utf8'));

test('27 项决策与文档勾选一致，且 core 内常量同源', () => {
  assert.equal(Object.keys(decisions.choices).length, 27);
  assert.deepEqual(CORE.DECISIONS, decisions.choices);
  assert.equal(decisions.choices.U01, 'C', 'U01 按决策保留差异');
});

test('T04 · 任务卡去重键优先索引、标题、链接的可用值', () => {
  assert.equal(CORE.taskCardKey({ idx: 3, title: 'A', href: 'https://x/1' }), 'idx:3');
  assert.equal(CORE.taskCardKey({ title: ' 每日  活动 ', href: '' }), 'title:每日 活动');
  assert.equal(CORE.taskCardKey({ href: 'https://x/1#frag' }), 'href:https://x/1');
  assert.equal(CORE.taskCardKey({}), '');
  assert.equal(CORE.taskCardKey({ title: 'A', href: 'u' }),
    CORE.taskCardKey({ title: 'a ', href: 'v' }));
});

test('T06 · 三态计数互不冒充', () => {
  const r = CORE.newClickResult();
  CORE.recordClick(r, 'clickSent', 3);
  CORE.recordClick(r, 'pageOpened', 2);
  CORE.recordClick(r, 'officialConfirmed', 1);
  CORE.recordClick(r, 'unconfirmed', 1);
  assert.equal(r.clickSent, 3);
  assert.equal(r.pageOpened, 2);
  assert.equal(r.officialConfirmed, 1);
  assert.equal(r.unconfirmed, 1);
  assert.equal(r.clickSent, r.pageOpened + r.unconfirmed);
  assert.equal(CORE.recordClick(r, 'clicked', 9), r); // 非三态字段拒绝写入
  assert.equal(r.clicked, undefined);
});

test('T01/T02/T03/T05 · 触发、扫描、回退、补救策略', () => {
  assert.equal(CORE.triggerPlan(true).primary, 'cdp');
  assert.equal(CORE.triggerPlan(false).primary, 'page-interaction');
  assert.equal(CORE.triggerPlan(true).fallback, 'page-interaction');
  assert.ok(CORE.scanPlan().scrollEnabled && CORE.scanPlan().maxSteps > 0);
  assert.deepEqual(CORE.fallbackPages(), ['/dashboard', '/earn']);
  const p = CORE.followupPolicy();
  assert.equal(p.autoOpenUrl, false);
  assert.equal(p.relocateRetries, 1);
  assert.equal(p.showManualLink, true);
});

test('T07 · 默认 10 秒，范围 1~60 秒', () => {
  assert.equal(CORE.DEFAULTS.cardClickIntervalSec, 10);
  assert.equal(CORE.clampIntervalSec(undefined), 10);
  assert.equal(CORE.clampIntervalSec(0), 10);
  assert.equal(CORE.clampIntervalSec(999), 60);
  assert.equal(CORE.clampIntervalSec(-4), 1);
  assert.equal(CORE.clampIntervalSec('7'), 7);
});

const summary = (over) => Object.assign({
  signedOut: false, approx: false, percent: 100,
  items: [
    { section: 'search', name: '搜索', points: 30, earned: 30, completed: true },
    { section: 'daily', name: 'A', points: 10, earned: 10, completed: true },
    { section: 'daily', name: 'B', points: 5, earned: 5, completed: true }
  ]
}, over || {});

test('T08 · 严格完成条件：估算 / 缺项 / 搜索未完成 / 过期都不算完成', () => {
  assert.equal(CORE.isAllDone(summary()), true);
  assert.equal(CORE.isAllDone(summary({ approx: true })), false);
  assert.equal(CORE.isAllDone(summary({ items: summary().items.slice(0, 2) })), false);
  assert.equal(CORE.isAllDone(summary({ percent: 99 })), false);
  assert.equal(CORE.isAllDone(summary(), { estimated: true }), false);
  assert.equal(CORE.isAllDone(summary(), { quotaMissing: true }), false);
  assert.equal(CORE.isAllDone(summary(), { stale: true }), false);
  const bad = summary();
  bad.items[1].earned = 0; bad.items[1].completed = false;
  assert.equal(CORE.isAllDone(bad), false);
});

test('T09 · 零动作返回成功幂等结果', () => {
  const r = CORE.allDoneResult({ level: 3, preset: true });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'allDone');
  assert.equal(r.clicked, 0);
  assert.equal(r.searches, 0);
  assert.match(r.message, /已完成/);
});

test('D01/D02 · 官网优先；只补新鲜快照且不覆盖官网已确认状态', () => {
  assert.deepEqual(CORE.dataSourcePriority(), ['official-network', 'fresh-page-snapshot', 'rendered-view']);
  const now = 1700000000000;
  const official = [{ name: 'A', points: 10, earned: 10, completed: true }];
  const snapshot = [
    { name: 'A', points: 10, earned: 0, completed: false }, // 旧状态不得覆盖
    { name: 'B', points: 5, earned: 0, completed: false }   // 允许补缺
  ];
  const fresh = CORE.mergeSnapshotCards(official, snapshot,
    { now, snapshotAt: now - 1000, snapshotUrl: 'https://rewards.bing.com/earn' });
  assert.equal(fresh.added, 1);
  assert.equal(fresh.cards.length, 2);
  assert.equal(fresh.cards[0].completed, true);
  assert.equal(fresh.cards[1].source, 'fresh-page-snapshot');
  const stale = CORE.mergeSnapshotCards(official, snapshot,
    { now, snapshotAt: now - 300000, snapshotUrl: 'https://rewards.bing.com/earn' });
  assert.equal(stale.added, 0);
  assert.equal(stale.snapshotApplied, false);
});

test('D03 · 仅当前账号、地址正确、足够新的快照允许降级同步', () => {
  const now = 1700000000000;
  const good = { at: now - 1000, url: 'https://rewards.bing.com/dashboard', signedOut: false };
  assert.equal(CORE.isFreshSnapshot(good, now), true);
  assert.equal(CORE.isFreshSnapshot({ ...good, at: now - 300000 }, now), false);
  assert.equal(CORE.isFreshSnapshot({ ...good, url: 'https://login.live.com/x' }, now), false);
  assert.equal(CORE.isFreshSnapshot({ ...good, signedOut: true }, now), false);
  const deg = CORE.degradedSync(good, { pagesReachable: false, now });
  assert.equal(deg.ok, true);
  assert.equal(deg.degraded, true);
  assert.equal(deg.label, '页面数据');
  assert.equal(CORE.degradedSync(null, { pagesReachable: false, now }).ok, false);
});

test('D04 · 登录三态：文案单独出现不判登出', () => {
  assert.equal(CORE.loginStateFromEvidence({ available: 20192 }), 'in');
  assert.equal(CORE.loginStateFromEvidence({ panelSignedIn: true }), 'in');
  assert.equal(CORE.loginStateFromEvidence({ explicitLogout: true }), 'out');
  assert.equal(CORE.loginStateFromEvidence({ pageTextSignedOut: true }), 'unknown');
  assert.equal(CORE.loginStateFromEvidence({ panelSignedOut: true, pageTextSignedOut: true }), 'out');
  assert.equal(CORE.isConfirmedLogout({ available: 20192, shellSignedOut: true }), false);
  assert.equal(CORE.isConfirmedLogout({ shellSignedOut: true, pageTextSignedOut: true }), true);
});

test('D05 · 确认登出隐藏当前余额，保留历史并标「上次记录」', () => {
  const out = CORE.logoutPresentation({ available: 20192, today: 30, claimable: 5 }, 1700000000000);
  assert.equal(out.pointsSummary.available, null);
  assert.equal(out.pointsSummary.today, 30);
  assert.equal(out.pointsSummary.claimable, 5);
  assert.equal(out.pointsSummary.displayLabel, '上次记录');
  assert.equal(out.loginStatus, 'out');
  assert.equal(out.keepHistory, true);
});

test('D06 · 刷新 / 开始 / 收尾强制新数据，后台展示允许短期缓存', () => {
  for (const r of ['refreshTasks', 'refreshPoints', 'start', 'finish', 'user-refresh']) {
    assert.equal(CORE.syncCachePolicy(r).fresh, true, r);
  }
  for (const r of ['panel-loaded', 'login-return', 'ui-tick', 'background']) {
    assert.equal(CORE.syncCachePolicy(r).fresh, false, r);
    assert.equal(CORE.syncCachePolicy(r).cacheAllowed, true);
  }
  assert.equal(CORE.syncCachePolicy('start').showCollectedAt, true);
});

test('S01 · 状态行详情与倒计时', () => {
  const now = 1700000000000;
  const a = { at: now, state: 'waiting', zh: '等待 {s} 秒', en: 'Wait {s}s', until: now + 9000 };
  const line = CORE.formatActivityLine(a, 'zh', now);
  assert.equal(line.text, '等待 9 秒');
  assert.equal(line.until, now + 9000);
  assert.equal(CORE.formatActivityLine(null, 'zh', now), null);
});

test('S02 · 恢复器只做一次性检查与限时重试，不常驻轮询', () => {
  assert.equal(typeof RECOVERY.install, 'function');
  assert.equal(CORE.DEFAULTS.stuckMaxRetries, 3);
  const listeners = [];
  const storage = {
    get: () => Promise.resolve({ running: false, todayTasks: null }),
    onChanged: { addListener: cb => listeners.push(cb), removeListener: () => {} }
  };
  const nodes = {
    'btn-action': { dataset: { mode: 'stop' }, disabled: true,
      classList: { remove() {} } },
    'today-tasks-empty': { textContent: '正在读取今日任务…' },
    'btn-action-label': { textContent: '' },
    status: { className: '' }
  };
  const doc = {
    documentElement: { lang: 'zh-CN' },
    getElementById: id => nodes[id] || null
  };
  const timers = [];
  const origSet = global.setTimeout, origClear = global.clearTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => {};
  try {
    const r = RECOVERY.install({ document: doc, storage, onChangeHost: storage });
    assert.equal(listeners.length, 1, '状态变化复检由事件驱动');
    assert.ok(timers.some(t => t.ms === CORE.DEFAULTS.stuckTimeoutMs), '启动超时只检查一次');
    assert.ok(!timers.some(t => t.ms === 1000 && t.ms < 100), '没有每秒心跳');
    r.dispose();
  } finally {
    global.setTimeout = origSet;
    global.clearTimeout = origClear;
  }
});

test('UI 配置与决策一致（U01 保留差异）', () => {
  assert.equal(CORE.UI.brandIconPlate, false);              // U02 A
  assert.deepEqual(CORE.UI.languageOrder, ['zh', 'en', 'system']); // U03 B
  assert.equal(CORE.UI.englishLabel, 'English');           // U04 A
  assert.equal(CORE.UI.calendarAfterAutoGroup, true);      // U05 A
  assert.equal(CORE.UI.calendarDefaultOpen, true);         // U06 B
  assert.equal(CORE.UI.calendarLegend, true);              // U07 B
  assert.equal(CORE.UI.hoverTipWrap, true);                // U08 D
  assert.equal(CORE.UI.autoDisabledHint, true);            // U09 A
  assert.equal(CORE.UI.headerButtonsCustomTip, true);      // U10 B
  assert.equal(CORE.UI.loginBadgeInteractive, 'platform-specific'); // U01 C
});
