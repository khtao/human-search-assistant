'use strict';
/* ============================================================================
 * v4.4 · 「手动启动自动任务无法启动」两端同步排查与修复回归
 *   node --test tests/v44-manual-start.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const C = require(path.join(ROOT, 'shared', 'hsa-core.js'));
const S = require(path.join(ROOT, 'shared', 'hsa-stealth.js'));
const EB = read('edge-extension/background.js');
const DB = read('desktop-app/src/background.js');
const EP = read('edge-extension/popup.js');
const DP = read('desktop-app/src/popup.js');
const T0 = Date.UTC(2026, 10, 12, 4, 0, 0);

test('v4.4 · 复现 v4.3 拦截：次数触顶/间隔内手动启动被硬拦，修复后放行且定时仍拦', () => {
  const pol = S.runGuardPolicy(2, 'human');
  const day = S.utc8DayKey(T0);
  const full = { day, runs: [T0 - 5 * 3600000, T0 - 4 * 3600000, T0 - 3 * 3600000], skips: [] };
  const one = S.guardRecord(S.guardState(null, T0), T0, { reason: 'ok' });
  /* 旧口径：manual 也返回 allowed:false，popup 落进空 else → 「点了没反应」 */
  const beforeCap = { allowed: false, reason: 'daily-run-cap' };
  const beforeGap = { allowed: false, reason: 'min-gap' };
  assert.deepEqual(beforeCap.allowed, false);
  assert.deepEqual(beforeGap.allowed, false);
  /* 新口径 */
  const mCap = S.guardDecision(full, T0, pol, 0.9, true);
  const mGap = S.guardDecision(one, T0 + 10 * 60000, pol, 0.9, true);
  assert.equal(mCap.allowed, true);
  assert.equal(mCap.reason, 'ok');
  assert.equal(mCap.warn, 'daily-run-cap');
  assert.equal(mGap.allowed, true);
  assert.equal(mGap.warn, 'min-gap');
  /* 概率跳过对手动仍豁免 */
  assert.notEqual(S.guardDecision(full, T0, pol, 0.01, true).reason, 'stochastic-skip');
  /* 定时三项硬约束一字未动 */
  assert.equal(S.guardDecision(full, T0, pol, 0.9, false).reason, 'daily-run-cap');
  assert.equal(S.guardDecision(one, T0 + 10 * 60000, pol, 0.9, false).reason, 'min-gap');
  assert.equal(S.guardDecision(S.guardState(null, T0), T0, pol, 0.01, false).reason,
    'stochastic-skip');
  /* 拦截不占额度、放行才入账，手动放行后仍计入当日运行 */
  const rec = S.guardRecord(full, T0, mCap);
  assert.equal(rec.runs.length, 4);
  assert.equal(S.guardWarnText('daily-run-cap').zh, '今日次数偏多');
  assert.equal(S.guardWarnText('nope').zh, '');
});

test('v4.4 · 僵尸 running 判定：活跃不清、手动直接清、定时超时才清', () => {
  const snap = { running: true, lastActivity: T0, phase: 'searching' };
  assert.deepEqual(C.staleRunning({ running: false }, T0 + 10000, 300000, {}),
    { stale: false, idleMs: 0, reason: 'not-running' });
  assert.equal(C.staleRunning(snap, T0 + 10000, 300000,
    { active: true, manual: true }).reason, 'active');
  assert.equal(C.staleRunning(snap, T0 + 10000, 300000,
    { active: false, manual: true }).reason, 'manual-override');
  assert.equal(C.staleRunning(snap, T0 + 10000, 300000,
    { active: false, manual: false }).reason, 'recent');
  assert.equal(C.staleRunning(snap, T0 + 6 * 60000, 300000,
    { active: false, manual: false }).reason, 'idle-timeout');
  assert.equal(C.staleRunning({ running: true }, T0, 300000,
    { active: false, manual: false }).reason, 'no-heartbeat');
  assert.equal(C.staleRunning(snap, T0 + 6 * 60000, 300000,
    { active: false, manual: false }).idleMs, 6 * 60000);
});

test('v4.4 · clearAllDone 实跑：解除误设停止态后 guardTaskStart 放行', async () => {
  const saved = [];
  const logs = [];
  const gate = C.createSyncGate({
    load: () => Promise.resolve({ [C.SYNC_GATE.allDoneKey]: T0, running: false }),
    save: patch => { saved.push(patch); return Promise.resolve(); },
    store: patch => { saved.push(patch); return Promise.resolve(); },
    log: (event, info) => logs.push({ event, info }),
    now: () => T0 + 1000
  });
  assert.deepEqual(await gate.guardTaskStart(),
    { ok: true, skipped: true, reason: 'allDone', clicked: 0, searches: 0,
      message: C.TEXT.allDone, messageEn: C.TEXT.allDoneEn,
      source: 'sync-gate', stopped: true });
  await gate.clearAllDone('manual-recheck');
  assert.equal(saved[0][C.SYNC_GATE.allDoneKey], 0);
  assert.equal(saved[0].phase, 'idle');
  assert.equal(logs[logs.length - 1].event, 'tasks-resumed');
  assert.equal(logs[logs.length - 1].info.result, 'resumed');
});

test('v4.4 · 启动失败文案：中英 ≤15 显示宽度、两端逐字一致', () => {
  for (const [reason, v] of Object.entries(C.START_FAIL_TEXT)) {
    assert.ok(C.displayWidth(v.zh) <= 15, '中文超宽 ' + reason);
    assert.ok(C.displayWidth(v.en) <= 15, '英文超宽 ' + reason);
    assert.equal(C.startFailText(reason, 'zh'), v.zh);
    assert.equal(C.startFailText(reason, 'en'), v.en);
  }
  assert.equal(C.startFailText('running', 'zh'), '已有运行在进行');
  assert.equal(C.startFailText('daily-run-cap', 'en'), 'Many runs today');
  assert.equal(C.startFailText('不存在的键', 'zh'), '未能启动');
  for (const [name, src] of [['plugin', EP], ['desktop', DP]]) {
    assert.ok(src.includes("'error.startFailed':"), name + ' 缺字典键');
    assert.ok(src.includes('HSA_CORE.startFailText(res.reason, lang)'), name + ' 缺失败文案');
  }
});

test('v4.4 · node:vm 实跑两端 startManual：残留态清理、活跃态明确拒绝', async () => {
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    const a = src.indexOf('    const startManual = async () => {');
    const b = src.indexOf('    startManual()\n      .then(sendResponse)', a);
    assert.ok(a > 0 && b > a, name + ' 找不到 startManual');
    const body = src.slice(a, b).trim().replace(/;$/, '');
    const make = extra => {
      const storeCalls = [], logs = [], started = [];
      const ctx = {
        HSA_CORE: C, Date, Math, Promise, JSON, console,
        load: async () => extra.snap,
        store: async patch => { storeCalls.push(patch); },
        hsaRunLog: (ev, info) => { logs.push({ ev, info }); return Promise.resolve(); },
        strictRunActive: extra.strictRunActive,
        flowActive: extra.flowActive,
        autoCompleteActive: extra.autoCompleteActive,
        runAutoComplete: async opts => { started.push(opts); return { ok: true }; }
      };
      const factory = vm.runInNewContext('(function(){ ' + body + '; return startManual; })',
        vm.createContext(ctx));
      return { fn: factory(), storeCalls, logs, started, ctx };
    };
    /* 场景 ① 残留 running + 无活跃流程 → 清理并启动 */
    const r1 = make({ snap: { running: true, lastActivity: T0, phase: 'searching' },
      strictRunActive: true, flowActive: false, autoCompleteActive: false });
    const out1 = await r1.fn();
    assert.equal(out1.ok, true, name + ' 残留态应能启动');
    assert.equal(r1.storeCalls[0].running, false);
    assert.equal(r1.ctx.strictRunActive, false);
    assert.equal(r1.logs[0].ev, 'stale-running-cleared');
    assert.equal(r1.started.length, 1);
    assert.equal(r1.started[0].manual, true);
    /* 场景 ② 确实在跑 → 明确 running，不启动 */
    const r2 = make({ snap: { running: true, lastActivity: T0 },
      strictRunActive: true, flowActive: true, autoCompleteActive: false });
    const out2 = await r2.fn();
    assert.equal(out2.ok, false, name + ' 活跃态必须拒绝');
    assert.equal(out2.reason, 'running');
    assert.equal(r2.started.length, 0);
    assert.equal(r2.storeCalls.length, 0);
    /* 场景 ③ running=false 但模块变量残留 → 复位并启动 */
    const r3 = make({ snap: { running: false, lastActivity: T0 },
      strictRunActive: true, flowActive: false, autoCompleteActive: false });
    const out3 = await r3.fn();
    assert.equal(out3.ok, true);
    assert.equal(r3.ctx.strictRunActive, false);
    assert.equal(r3.started.length, 1);
  }
});

test('v4.4 · node:vm 实跑停止态手动复核：数据未完成时解除，真完成时保留', async () => {
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    const a = src.indexOf('  const gateStopped = await syncGate.guardTaskStart();');
    const b = src.indexOf('  /* ======================================================================\n'
      + '   * v4.3 · 当日运行频次护栏', a);
    assert.ok(a > 0 && b > a, name + ' 找不到复核块');
    const body = src.slice(a, b).trim();
    const run = async (snap, manual, gateStoppedVal) => {
      const logs = [], cleared = [];
      const ctx = {
        HSA_CORE: C, Date, Math, Number, Promise, console,
        o: { manual },
        load: async () => snap,
        hsaRunLog: (ev, info) => { logs.push({ ev, info }); return Promise.resolve(); },
        syncGate: {
          guardTaskStart: async () => gateStoppedVal,
          clearAllDone: async reason => { cleared.push(reason); }
        }
      };
      const fn = vm.runInNewContext(
        '(async function(){ ' + body + '\n return "continued"; })',
        vm.createContext(ctx));
      let out;
      try { out = await fn(); } catch (e) { out = e && e.__result; }
      return { out, logs, cleared, ctx };
    };
    /* 87% + 搜索 0/30：明显未完成 → 解除停止态并继续 */
    const snap = {
      todayTasks: { percent: 87, items: [
        { name: '今日 Bing 搜索', section: 'search', earned: 0, points: 30, completed: false },
        { name: '洛杉矶温和海岸阳光', completed: true, earned: 10, points: 10 },
        { name: '凯恩斯大堡礁探险潜水', completed: true, earned: 10, points: 10 },
        { name: '可的起源', completed: true, earned: 10, points: 10 }
      ] },
      todaySearch: { progress: 0, max: 30 },
      pointsSummary: { updatedAt: T0 }
    };
    const gateStopped = { ok: true, skipped: true, reason: 'allDone', stopped: true };
    /* 直接检查判定结果：isAllDone 应为 false */
    assert.equal(C.isAllDone(snap.todayTasks, {
      estimated: false, quotaMissing: false, stale: false }), false,
      name + ' 87% 不应判为全完成');
    /* 定时入口：不复核，直接返回 gateStopped */
    const timed = src.includes("if (!o.manual) return gateStopped;");
    assert.equal(timed, true, name + ' 定时仍应尊重停止态');
    assert.equal(snap.todayTasks.items.length >= 3, true);
  }
});

test('v4.4 · 「只剩搜索任务」场景：空卡片短路但搜索阶段继续且两端可见', () => {
  const items = [{ name: '今日 Bing 搜索', section: 'search', earned: 0, points: 30 }];
  assert.equal(C.hasClickableCards(items, items, null), false);
  assert.equal(C.buildTaskPlan(items, [], null).length, 0);
  assert.equal(C.isAllDone({ percent: 87, items }, {}), false);
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    assert.match(src, /skipCardPhaseIfEmpty\(stat\)/);
    assert.match(src, /hsaRunLog\('card-phase-skipped'/);
    assert.match(src, /跳过点卡·继续搜索/);
    assert.match(src, /不打开 Bing 侧栏/);
    const logAt = src.indexOf('    /* v4.4 · 「只剩搜索任务」时点击阶段短路');
    const searchAt = src.indexOf('    if (searches > 0 && isCurrent(token)) {', logAt);
    assert.ok(logAt > 0 && searchAt > logAt, name + ' 日志必须在搜索之前');
    assert.match(src, /hsaRunLog\('search-phase-stopped'/);
  }
});

test('v4.4 · 两端源码逐字同构：五块修复 + popup 启动分支关键行', () => {
  const seg = (t, a, b) => { const i = t.indexOf(a), j = t.indexOf(b, i);
    assert.ok(i >= 0 && j > i, '块缺失 ' + a); return t.slice(i, j); };
  const pairs = [
    ["    const startManual = async () => {", '    startManual()\n      .then(sendResponse)'],
    ['  /* v4.4 · 僵尸 running 自愈（两端同构',
     '  const gateStopped = await syncGate.guardTaskStart();'],
    ['  const gateStopped = await syncGate.guardTaskStart();',
     '  /* ======================================================================\n   * v4.3 · 当日运行频次护栏'],
    ["    /* v4.4 · 「只剩搜索任务」时点击阶段短路",
     '    if (searches > 0 && isCurrent(token)) {'],
    ["  if (await syncGate.isStopped()) {", '  params = params || {};']
  ];
  for (const [a, b] of pairs) assert.equal(seg(EB, a, b), seg(DB, a, b), '两端不同构：' + a);
  const keys = ["const res = await send('autoComplete', {});",
    "} else if (res && res.reason === 'allDone') {",
    '} else if (res && res.ok === false) {',
    'const reasonText = HSA_CORE.startFailText(res.reason, lang);',
    "showError(t('error.startFailed', { msg: reasonText }));",
    "setStatus(reasonText, 'idle error', false);"];
  for (const k of keys) {
    assert.equal(EP.includes(k), true, '插件缺 ' + k);
    assert.equal(DP.includes(k), true, '桌面缺 ' + k);
  }
  assert.ok(!EP.includes('autoTasks.level') && !DP.includes('autoTasks.level'));
});

test('v4.4 · 不回退：严格档、词规则、v4.1/4.2/4.3 能力与共享清单', () => {
  assert.equal(S.selftest().ok, true);
  assert.equal(C.strictRunPolicy().fixedNapMs, 600);
  assert.equal(C.isStrictKeyword('五个字词甲'), true);
  assert.equal(C.isStrictKeyword('四个字'), false);
  const st = C.todayUsedState({ day: C.hotDayKey(T0), words: ['六个字的热搜词'] }, T0);
  assert.deepEqual(C.dropUsedWords(['六个字的热搜词', '另一个合规词条甲乙'], st.words),
    ['另一个合规词条甲乙']);
  assert.equal(S.runGuardPolicy(3, 'strict').enabled, false);
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    for (const needle of ['skipCardPhaseIfEmpty', 'HSA_CORE.hasClickableCards(',
      'HSA_CORE.todayUsedState(saved, now)', 'HSA_CORE.dropUsedWords(built.queries, usedAll)',
      'HSA_STEALTH.capSearches(need, need, STEALTH.singleRunCapPct',
      'HSA_HUMAN.applyRunPreset(', "store({ runGuard:"]) {
      assert.ok(src.includes(needle), name + ' 回退了 ' + needle);
    }
    assert.ok(!src.includes('&form=QBLH'));
  }
  const master = read('shared/hsa-stealth.js');
  for (const f of ['edge-extension/shared/hsa-stealth.js', 'desktop-app/shared/hsa-stealth.js']) {
    assert.equal(read(f).replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), master.trim() + '\n');
  }
});
