'use strict';
/* ============================================================================
 * v3.3 · 积分日历统一 / 设置项移除 / 冲突逻辑核验（动态 + 静态）
 *   node --test tests/v33-calendar.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CAL = require(path.join(ROOT, 'shared', 'hsa-calendar.js'));
const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const NOW = new Date(2026, 10, 11);   // 2026-11-11
const HIST = {
  '2026-11-03': { today: 90 },
  '2026-10-05': 15,
  '2026-10-06': 20,
  '2026-09-01': 5,
  '2026-12-31': 999   // 未来，必须被过滤
};

/* ---------------------------------------------------------------- 纯模型 */
test('v3.3 · normalize：未来 / 0 分 / 非数值记录一律剔除，今天实时积分补入', () => {
  const h = CAL.normalize({
    '2026-11-03': 90, '2026-11-20': 999, '2026-10-01': 0,
    '2026-10-02': 'x', '2026-10-03': { points: 12 }
  }, { today: 33 }, NOW);
  assert.deepEqual(h, {
    '2026-10-03': 12, '2026-11-03': 90, '2026-11-11': 33
  });
});

test('v3.3 · 日视图只渲染有积分的日期，绝不铺 42 格空白', () => {
  const m = CAL.buildModel({ hist: HIST, mode: 'day', cursor: new Date(2026, 10, 1), now: NOW });
  assert.equal(m.cells.length, 1);
  assert.equal(m.cells[0].label, '11/3');
  assert.equal(m.cells[0].value, 90);
  assert.equal(m.empty, false);
  assert.equal(m.total, 90);
  assert.equal(m.earningDays, 1);
  assert.equal(m.cells.some(c => /blank|past-empty/.test(c.cls)), false);
});

test('v3.3 · 周视图裁剪到当月边界，绝不跨月', () => {
  const m = CAL.buildModel({ hist: HIST, mode: 'week', cursor: new Date(2026, 10, 1), now: NOW });
  assert.ok(m.cells.length >= 1);
  for (const c of m.cells) {
    assert.ok(c.daily.length >= 1 && c.daily.length <= 7,
      '周内点数按当月裁剪后的实际天数，最多 7 个');
    for (const d of c.daily) {
      assert.ok(!/^10月/.test(d.label), '不得出现上月日期：' + d.label);
      assert.ok(!/^12月/.test(d.label), '不得出现下月日期：' + d.label);
      assert.ok(/^11月/.test(d.label), '周内日期必须属于当月：' + d.label);
    }
  }
  /* 11/1 是周日且当天无积分，首周不生成卡片；首个有积分的周仍全在 11 月 */
  assert.ok(/^11月/.test(m.cells[0].daily[0].label));
  assert.equal(m.cells[0].daily.some(d => /^10月|^12月/.test(d.label)), false);
});

test('v3.3 · 月视图只列有积分的月，未来月与无积分月都不出现', () => {
  const m = CAL.buildModel({ hist: HIST, mode: 'month', cursor: new Date(2026, 0, 1), now: NOW });
  assert.deepEqual(m.cells.map(c => c.label), ['2026/09', '2026/10', '2026/11']);
  assert.equal(m.cells.some(c => /2026\/12/.test(c.label)), false);
});

test('v3.3 · 无积分月生成空模型（零空白格），复位自动定位最近有积分月', () => {
  const m = CAL.buildModel({ hist: HIST, mode: 'day', cursor: new Date(2026, 7, 1), now: NOW });
  assert.equal(m.empty, true);
  assert.equal(m.hasAny, true);
  const r = CAL.resetCursor(HIST, {}, new Date(2026, 11, 20));
  assert.equal(r.mode, 'day');
  assert.equal(r.cursor.getFullYear() + '-' + CAL.pad2(r.cursor.getMonth() + 1), '2026-11');
  const r2 = CAL.resetCursor(HIST, {}, NOW);
  assert.equal(r2.cursor.getFullYear() + '-' + CAL.pad2(r2.cursor.getMonth() + 1), '2026-11');
});

test('v3.3 · 导航只允许跳到有积分的周期（复用共享 HSA_CORE 口径）', () => {
  const m = CAL.buildModel({ hist: HIST, mode: 'day', cursor: new Date(2026, 10, 1), now: NOW });
  assert.equal(m.navPrev, true, '2026-10 有积分 → 允许上一月');
  assert.equal(m.navNext, false, '2026-12 无合规积分 → 禁止下一月');
  assert.equal(CORE.calendarNavAllowed(HIST, 'day', 2026, 10, -1, '2026-11-11'), true);
  assert.equal(CORE.calendarNavAllowed(HIST, 'day', 2026, 10, 1, '2026-11-11'), false);
});

/* ------------------------------------------------------- DOM 渲染（mock） */
function mockEl(tag) {
  const el = {
    tagName: tag, className: '', textContent: '', title: '', hidden: true,
    children: [], dataset: {}, attrs: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.children.push(c); },
    querySelectorAll() { return []; },
    addEventListener() {},
    focus() {},
    get open() { return this._open !== false; },
    set open(v) { this._open = v; }
  };
  return el;
}

function mockCtx(overrides) {
  const els = {};
  const get = id => (els[id] = els[id] || mockEl('div'));
  const segments = [];
  const actions = [];
  const ctx = {
    doc: { createElement: mockEl, getElementById: get },
    $: get,
    t: (k, a) => {
      const map = { 'calendar.cellTip': '{date} · {points} 分',
                    'calendar.empty': '暂无历史数据',
                    'calendar.summary': '日均 {avg} · 最高 {max} · {n} 天有积分',
                    'calendar.navBlocked': '该周期没有积分记录，不能跳转',
                    'calendar.navEmpty': '该周期暂无积分',
                    'calendar.totalLabel': '本月累计积分',
                    'calendar.yearLabel': '本年累计积分' };
      let s = map[k] || k;
      for (const key of Object.keys(a || {})) s = s.replace('{' + key + '}', a[key]);
      return s;
    },
    getLang: () => 'zh',
    setSegment: (id, v) => segments.push([id, v]),
    onSegment: () => {},
    storage: { get: async () => ({ pointsHistory: HIST, pointsSummary: {} }) },
    logUserAction: (n, d) => actions.push([n, d]),
    navAllowed: (h, mode, y, m, step, todayK) =>
      CORE.calendarNavAllowed(h, mode, y, m, step, todayK),
    resetBase: () => CORE.calendarReset(NOW.getTime()),
    mount: false
  };
  return Object.assign(ctx, { els, segments, actions }, overrides || {});
}

test('v3.3 · 渲染：紧凑容器、只输出有积分卡片、无空白占位格', async () => {
  const c = mockCtx();
  const ctrl = CAL.createController(c);
  ctrl.state.cursor = new Date(2026, 10, 1);
  await ctrl.render();
  const grid = c.els['cal-grid'];
  assert.match(grid.className, /cal-compact/);
  assert.equal(grid.children.length, 1, '日视图只渲染 1 张有积分卡片');
  assert.equal(grid.children[0].children.length >= 2, true);
  assert.equal(grid.children.some(x => /cal-blank|cal-past-empty/.test(x.className)), false);
  assert.equal(c.els['cal-total'].textContent, '90');
  assert.ok(c.segments.some(([id, v]) => id === 'cal-mode' && v === 'day'));
});

test('v3.3 · 打开设置复位：日视图 + 折叠展开 + 最近有积分月', async () => {
  const c = mockCtx();
  const ctrl = CAL.createController(c);
  ctrl.state.mode = 'month';
  ctrl.state.cursor = new Date(2026, 7, 1);
  c.$('calendar-group').open = false;
  await ctrl.reset();
  assert.equal(ctrl.state.mode, 'day');
  assert.equal(ctrl.state.cursor.getFullYear() + '-' + CAL.pad2(ctrl.state.cursor.getMonth() + 1),
    '2026-11');
  assert.equal(c.$('calendar-group').open, true);
});

test('v3.3 · 导航拦截：无积分周期不跳转并留下用户操作日志', async () => {
  const c = mockCtx();
  const ctrl = CAL.createController(c);
  ctrl.state.cursor = new Date(2026, 10, 1);
  await ctrl.render();
  const before = ctrl.state.cursor.getTime();
  await ctrl.move(1);   // 2026-12 无合规积分
  assert.equal(ctrl.state.cursor.getTime(), before, '禁止跳转到无积分周期');
  assert.ok(c.actions.some(([n]) => n === 'calendar-nav-blocked'));
  assert.equal(c.els['cal-nav-msg'].textContent, '该周期没有积分记录，不能跳转');
  await ctrl.move(-1);  // 2026-10 有积分
  assert.equal(ctrl.state.cursor.getMonth(), 9);
});

/* ------------------------------------------------------------ 静态一致性 */
test('v3.3 · 两端日历 DOM 逐字一致、共享清单含 hsa-calendar.js', () => {
  const block = s => {
    const i = s.indexOf('<details class="set-group cal-fold" id="calendar-group"');
    const j = s.indexOf('</details>', i);
    return s.slice(i, j + '</details>'.length);
  };
  const eh = read('edge-extension/popup.html');
  const dh = read('desktop-app/src/popup.html');
  assert.equal(block(eh), block(dh));
  for (const h of [eh, dh]) assert.match(h, /shared\/hsa-calendar\.js/);
  const sync = read('scripts/sync-shared.js');
  assert.match(sync, /hsa-calendar\.js/);
  assert.equal((sync.match(/const FILES = \[([\s\S]*?)\];/)[1]
    .match(/\.js'|\.css'|\.json'/g) || []).length, 12);
});

test('v3.3 · 「不跳过已完成」设置项与代码全端清零，全完成零动作无例外', () => {
  const files = [
    'edge-extension/background.js', 'edge-extension/popup.js', 'edge-extension/popup.html',
    'desktop-app/src/background.js', 'desktop-app/src/popup.js',
    'desktop-app/src/popup.html', 'desktop-app/main.js'
  ];
  for (const p of files) {
    const s = read(p);
    for (const k of ['dontSkipCompleted', 'notSkipCompleted', 'set-dont-skip',
                     'set-not-skip', '不跳过已完成任务卡']) {
      assert.ok(!s.includes(k), p + ' 残留 ' + k);
    }
  }
  /* v3.6 · 没有 includeDone / skipCompletedCards 参数；跳过已完成由共享
     pendingTaskItems 统一处理，是唯一过滤条件 */
  assert.doesNotMatch(read('edge-extension/background.js'), /const includeDone = false;/);
  assert.doesNotMatch(read('desktop-app/src/background.js'), /const skipCompletedCards = true;/);
  assert.doesNotMatch(read('desktop-app/main.js'), /const skipCompletedCards = true;/);
  assert.match(read('desktop-app/main.js'), /HSA_CORE\.buildTaskPlan\(/);
  assert.match(read('edge-extension/background.js'), /HSA_CORE\.buildTaskPlan\(/);
  assert.match(read('shared/hsa-core.js'), /function pendingTaskItems\(/);
  assert.match(read('desktop-app/src/background.js'),
    /HSA_CORE\.taskPlanNames\(idxItems, snap\.todayTasks\)/);
  assert.match(read('edge-extension/background.js'),
    /HSA_CORE\.taskPlanNames\(taskStates, \{ items: taskStates \}\)/);
  for (const p of ['edge-extension/background.js', 'desktop-app/src/background.js']) {
    const s = read(p);
    assert.match(s, /if \(sync\.allDone\) \{/);
    assert.match(s, /syncGate\.noteAllDone\('all-tasks-done'\)/);
  }
  assert.doesNotMatch(read('desktop-app/src/background.js'), /!o\.force/);
});

test('v3.3 · 共享 CSS 是日历样式单一真源，两端 UI 组序号一致', () => {
  const css = read('shared/hsa-shared.css');
  assert.match(css, /v3\.3 · 积分日历/);
  assert.match(css, /\.cal-fold > summary/);
  assert.match(css, /\.cal-grid\.cal-compact/);
  assert.match(css, /flex-wrap: wrap/);
  for (const p of ['edge-extension/popup.html', 'desktop-app/src/popup.html']) {
    const s = read(p);
    assert.match(s, /id="auto-group" style="--g:1"/);
    assert.match(s, /id="calendar-group" style="--g:2"/);
    assert.match(s, /id="diag-group" style="--g:3"/);
    assert.match(s, /data-i18n="lang\.zh"/);
  }
  assert.match(read('desktop-app/src/popup.html'), /id="desktop-group" style="--g:5"/);
});
