/* v3.2 专项：日志暴露的重复同步问题 + 统一同步闸门 + 短状态文案
   node --test tests/v32-sync-gate.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CORE = require('../shared/hsa-core.js');

const EB = read('edge-extension/background.js');
const DB = read('desktop-app/src/background.js');
const EP = read('edge-extension/popup.js');
const DP = read('desktop-app/src/popup.js');

function harness(opts) {
  const o = opts || {};
  const db = {};
  const t0 = Number(o.t0) || Date.parse('2026-11-11T15:00:00+08:00');
  let t = t0, syncCalls = 0, stopAll = 0;
  const logs = [], activities = [];
  const result = Object.assign({
    ok: true, changed: ['pointsSummary'],
    pointsSummary: { available: 495, today: 90, updatedAt: 1 },
    todayTasks: { items: [{ id: 'a', done: 1, total: 1 }] },
    todaySearch: { progress: 2, max: 30 }, loginStatus: 'in'
  }, o.result || {});
  const gate = CORE.createSyncGate({
    now: () => t,
    load: keys => {
      const out = {};
      for (const k of keys) if (k in db) out[k] = db[k];
      return Promise.resolve(out);
    },
    store: patch => { Object.assign(db, patch); return Promise.resolve(); },
    sync: () => {
      syncCalls++;
      return o.delay
        ? new Promise(r => setTimeout(() => r(result), o.delay))
        : Promise.resolve(result);
    },
    log: (e, i) => logs.push({ e, i }),
    activity: p => activities.push(p),
    onStopAll: () => { stopAll++; }
  });
  return {
    gate, db, logs, activities,
    setNow: v => { t = v; },
    advance: ms => { t += ms; },
    get now() { return t; },
    get syncCalls() { return syncCalls; },
    get stopAll() { return stopAll; }
  };
}

test('v3.2 · 状态文案：全部 ≤15 中文显示宽度，详细全文另存悬浮/读屏', () => {
  const ctx = { today: 12345, available: 987654, n: 99, m: 100,
    s: 60, clicked: 12, searches: 30, at: Date.now(), reason: 'ui-open',
    waitMs: 1800000, durationMs: 12345 };
  assert.equal(CORE.STATUS_MAX_WIDTH, 15);
  for (const st of Object.keys(CORE.STATUS_LINES)) {
    for (const lang of ['zh', 'en']) {
      const t = CORE.statusText(st, ctx, lang);
      assert.ok(CORE.displayWidth(t) <= 15,
        st + '/' + lang + ' 超宽: ' + t + ' = ' + CORE.displayWidth(t));
    }
  }
  assert.equal(CORE.statusText('synced', { today: 90, available: 495 }, 'zh'),
    '同步完成 90/495');
  assert.equal(CORE.statusText('synced', { today: 90, available: 495 }, 'en'),
    'Synced 90/495');
  assert.equal(CORE.statusText('allDone', {}, 'zh'), '今日已满·停止任务');
  const long = '正在同步 · /dashboard + /earn 读取积分并准备点击全部任务卡片';
  const short = CORE.clampStatus(long);
  assert.ok(CORE.displayWidth(short) <= 15, '任意长文本都压到 15 以内');
  const full = CORE.statusFull('synced', { today: 90, available: 495,
    durationMs: 1700 }, 'zh');
  assert.match(full, /今日 90 分 \/ 可用 495 分/);
  assert.match(full, /耗时 1700 毫秒/);
  assert.match(full, /\+08:00/);
  assert.ok(CORE.displayWidth(full) > 15);
  const act = CORE.syncActivity('syncFresh', ctx);
  assert.ok(CORE.displayWidth(act.zh) <= 15);
  assert.ok(CORE.displayWidth(act.en) <= 15);
  assert.equal(act.green, true);
  assert.match(act.fullZh, /与上次一致/);
  /* 两端 popup 统一 */
  for (const [name, src] of [['插件', EP], ['桌面', DP]]) {
    assert.match(src, /const short = HSA_CORE\.clampStatus/, name);
    assert.match(src, /HSA_CORE\.statusFull\('synced'/, name);
    assert.match(src, /HSA_CORE\.statusText\('synced'/, name);
    assert.match(src, /fullEn : a\.fullZh/, name);
    assert.match(src, /setAttribute\('aria-label', full \|\| short\)/, name);
  }
  assert.doesNotMatch(EB, /正在读取官网 \/dashboard 与 \/earn/);
  assert.doesNotMatch(DB, /正在同步 · \/dashboard \+ \/earn 读取积分/);
});

test('v3.2 · 决策分档：打开界面 30 分钟 / 手动 10 秒 / 内部 2 秒 / force 越过', () => {
  const G = CORE.SYNC_GATE;
  assert.equal(G.uiOpenGapMs, 30 * 60 * 1000);
  assert.equal(G.manualGapMs, 10 * 1000);
  assert.equal(G.internalGapMs, 2 * 1000);
  const last = { at: 1000000 - 10 * 60000 };
  let d = CORE.syncDecision({ reason: 'ui-open', now: 1000000, state: last });
  assert.equal(d.allow, false);
  assert.equal(d.waitMs, 20 * 60000);
  d = CORE.syncDecision({ reason: 'refreshTasks', now: 1000000, state: last });
  assert.equal(d.allow, true, '手动刷新 10 秒冷却，10 分钟前同步过则放行');
  d = CORE.syncDecision({ reason: 'refreshTasks', now: 1000000,
    state: { at: 995000 } });
  assert.equal(d.allow, false);
  d = CORE.syncDecision({ reason: 'start', now: 1000000, state: { at: 999000 } });
  assert.equal(d.allow, false, '内部链路 2 秒冷却，1 秒内仍合并');
  d = CORE.syncDecision({ reason: 'start', now: 1000000, state: { at: 997000 } });
  assert.equal(d.allow, true, '内部链路 3 秒后放行（任务链路另用 force 兜底）');
  d = CORE.syncDecision({ reason: 'ui-open', now: 1000000,
    state: { at: 999999 }, running: true });
  assert.equal(d.code, 'running');
  d = CORE.syncDecision({ reason: 'ui-open', now: 1000000,
    state: { at: 999999 }, force: true });
  assert.equal(d.code, 'forced');
});

test('v3.2 · 业务指纹去重 + 跳过时的业务快照', () => {
  const r1 = { pointsSummary: { available: 495, today: 90, updatedAt: 1 },
    todayTasks: { items: [{ id: 'a', done: 1, total: 1 }] },
    todaySearch: { progress: 2, max: 30 }, loginStatus: 'in' };
  const r2 = JSON.parse(JSON.stringify(r1));
  r2.pointsSummary.updatedAt = 999;
  assert.equal(CORE.syncFingerprint(r1), CORE.syncFingerprint(r2),
    'updatedAt 变化不算数据变化');
  r2.pointsSummary.today = 91;
  assert.notEqual(CORE.syncFingerprint(r1), CORE.syncFingerprint(r2));
  r2.pointsSummary.today = 90;
  r2.todayTasks.items[0].done = 0;
  assert.notEqual(CORE.syncFingerprint(r1), CORE.syncFingerprint(r2));
  const s = CORE.syncSummary(r1);
  assert.equal(s.pointsSummary.available, 495);
  assert.equal(s.todaySearch.max, 30);
  assert.equal(s.todayTasks.items.length, 1);
  assert.ok(!('pages' in s) && !('html' in s), '快照不得携带整页 HTML');
});

test('v3.2 · 闸门动态：首次同步、30 分钟内打开跳过、手动刷新分档、force 放行', async () => {
  const h = harness();
  const r1 = await h.gate.request({ reason: 'ui-open' });
  assert.equal(r1.ok, true);
  assert.equal(h.syncCalls, 1);
  assert.ok(h.db.hsaSyncState.at > 0);
  h.advance(10 * 60 * 1000);
  const r2 = await h.gate.request({ reason: 'ui-open' });
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'cooldown');
  assert.equal(h.syncCalls, 1, '30 分钟内不触发打开主界面主动同步');
  assert.ok(h.logs.some(x => x.e === 'sync-skipped' && x.i.code === 'cooldown'));
  h.advance(20 * 60 * 1000 + 1);
  await h.gate.request({ reason: 'ui-open' });
  assert.equal(h.syncCalls, 2, '超过 30 分钟恢复同步');
  /* 手动刷新 10 秒冷却 */
  const r3 = await h.gate.request({ reason: 'refreshTasks' });
  assert.equal(r3.skipped, true);
  h.advance(11 * 1000);
  await h.gate.request({ reason: 'refreshTasks' });
  assert.equal(h.syncCalls, 3);
  /* 任务链路 force 不受冷却影响，保证拿到最新消息 */
  await h.gate.request({ reason: 'start', force: true });
  await h.gate.request({ reason: 'finish', force: true });
  assert.equal(h.syncCalls, 5);
});

test('v3.2 · 闸门动态：并发合并为一次、指纹相同标 already-latest', async () => {
  const h = harness({ delay: 15 });
  const [a, b] = await Promise.all([
    h.gate.request({ reason: 'start', force: true }),
    h.gate.request({ reason: 'finish', force: true })
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(h.syncCalls, 1, 'single-flight 合并并发同步');
  assert.ok(h.logs.some(x => x.e === 'sync-merged'));
  /* 第二次同数据 → unchanged */
  await h.gate.request({ reason: 'start', force: true });
  const done = h.logs.filter(x => x.e === 'sync-done');
  assert.equal(done.length, 2);
  assert.equal(done[1].i.result, 'unchanged');
  assert.ok(h.activities.some(a => a.state === 'syncFresh'));
});

test('v3.2 · 完成所有任务后停止所有任务，跨 UTC+8 日界自动恢复', async () => {
  const day1 = Date.parse('2026-11-11T10:00:00+08:00');
  const day1Later = Date.parse('2026-11-11T20:00:00+08:00');
  const day2 = Date.parse('2026-11-12T09:00:00+08:00');
  assert.equal(CORE.tasksStopped(day1, day1Later), true);
  assert.equal(CORE.tasksStopped(day1, day2), false);
  const h = harness({ t0: day1 });
  await h.gate.request({ reason: 'ui-open' });
  await h.gate.noteAllDone('all-tasks-done');
  assert.equal(h.stopAll, 1, '清 watchdog / 定时重入闹钟');
  assert.equal(h.db.allDoneAt, day1);
  assert.equal(h.db.running, false);
  assert.equal(h.db.phase, 'completed');
  h.setNow(day1Later);
  const r = await h.gate.request({ reason: 'ui-open' });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'allDone');
  const started = await h.gate.guardTaskStart();
  assert.equal(started.skipped, true);
  assert.equal(started.reason, 'allDone');
  assert.equal(h.syncCalls, 1, '停止后不再发起任何同步');
  h.setNow(day2);
  assert.equal(await h.gate.guardTaskStart(), null, '次日自动恢复');
  const r2 = await h.gate.request({ reason: 'ui-open' });
  assert.equal(r2.skipped, undefined);
  assert.equal(h.syncCalls, 2);
});

test('v3.2 · 复现用户日志场景：10 次相同同步被压到少量必要同步', async () => {
  /* 桌面日志 15:13 / 15:44 / 16:05 / 16:07 / 16:08 / 16:09 / 16:14 /
     16:22 / 16:47 / 17:08 十次「90/495」同步，其中多次仅因打开界面触发。 */
  const h = harness({ t0: Date.parse('2026-11-11T15:13:00+08:00') });
  const times = ['15:13', '15:44', '16:05', '16:07', '16:08', '16:09',
    '16:14', '16:22', '16:47', '17:08'];
  for (const hm of times) {
    const [hh, mm] = hm.split(':').map(Number);
    h.setNow(Date.parse('2026-11-11T' + hm + ':00+08:00'));
    await h.gate.request({ reason: 'ui-open' });
  }
  assert.ok(h.syncCalls <= 4,
    '30 分钟冷却后 10 次打开最多触发 4 次同步，实际 ' + h.syncCalls);
  assert.ok(h.logs.some(x => x.e === 'sync-skipped'), '跳过必须留日志');
});

test('v3.2 · 两端同步逻辑同构、日志字段对齐、状态文案同源', () => {
  for (const [name, src] of [['插件', EB], ['桌面', DB]]) {
    assert.match(src, /const syncGate = HSA_CORE\.createSyncGate\(\{/, name);
    assert.match(src, /function hsaSyncActivity\(payload\)/, name);
    assert.match(src, /sync: opts => (?:syncRewardsUnified|desktopSyncRewards)\(opts\)/, name);
    assert.match(src, /load: keys => load\(keys\)\.catch\(\(\) => \(\{\}\)\)/, name);
    assert.match(src, /store: patch => store\(patch\)/, name);
    assert.match(src, /log: \(event, info\) => hsaRunLog\(event, info\)/, name);
    assert.match(src, /activity: payload => hsaSyncActivity\(payload\)/, name);
    assert.match(src, /now: \(\) => Date\.now\(\)/, name);
    assert.match(src, /onStopAll: \(\) => \{/, name);
    assert.match(src, /syncGate\.guardTaskStart\(\)/, name);
    assert.match(src, /syncGate\.isStopped\(\)/, name);
    assert.match(src, /syncGate\.noteAllDone\('all-tasks-done'\)/, name);
    assert.match(src, /fullZh: payload\.fullZh, fullEn: payload\.fullEn/, name);
  }
  assert.match(DB, /platform: HSA_PLATFORM/, '桌面日志不再写出空 platform');
  assert.match(DB, /actor: 'system', category: 'run-step'/);
  /* 两端 popup 下拉刷新只留一条用户日志 */
  for (const [name, src] of [['插件', EP], ['桌面', DP]]) {
    assert.doesNotMatch(src, /logUserAction\('pull-refresh'/, name);
    assert.doesNotMatch(src, /logUserAction\('pull-refresh-trigger'/, name);
  }
});

test('v3.2 · 同步链路统一短文案：两端 activityDetail 由同一份 STATUS_LINES 生成', () => {
  const zh = CORE.statusText('syncing', {}, 'zh');
  const en = CORE.statusText('syncing', {}, 'en');
  assert.equal(zh, '同步中·官网两页');
  assert.equal(en, 'Syncing · 2 pages');
  assert.equal(CORE.statusText('skipRecent', {}, 'zh'), '刚同步过·已跳过');
  assert.equal(CORE.statusText('skipRunning', {}, 'zh'), '运行中·跳过同步');
  assert.equal(CORE.statusText('syncFailed', {}, 'zh'), '同步失败·留旧值');
  assert.equal(CORE.statusText('done', { clicked: 3, searches: 12 }, 'zh'), '完成·卡3搜12');
  assert.equal(CORE.statusText('searching', { n: 12, m: 30 }, 'zh'), '搜索 12/30');
  for (const t of [zh, en, CORE.statusText('done', { clicked: 3, searches: 12 }, 'en')]) {
    assert.ok(CORE.displayWidth(t) <= 15);
  }
});
