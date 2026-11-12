'use strict';
/* ============================================================================
 * v4.3 · 无用/冲突设置项清理 + 当日运行护栏（两端同构动态回归）
 *   node --test tests/v43-cleanup-guard.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const C = require(path.join(ROOT, 'shared', 'hsa-core.js'));
const H = require(path.join(ROOT, 'shared', 'hsa-human.js'));
const S = require(path.join(ROOT, 'shared', 'hsa-stealth.js'));
const EH = read('edge-extension/popup.html');
const DH = read('desktop-app/src/popup.html');
const EP = read('edge-extension/popup.js');
const DP = read('desktop-app/src/popup.js');
const EB = read('edge-extension/background.js');
const DB = read('desktop-app/src/background.js');

const GONE_HTML = ['set-auto-count', 'set-auto-count-chips', 'data-i18n="auto.count"',
  'data-i18n-title="auto.countHint"', 'aria-label="自定义搜索次数"'];
const GONE_JS = ['countInput', 'defaultCount:', 'AUTO_DEFAULTS.count',
  "saveAutoTasks({ count", "saveAutoTasks({ level", 'clampCount()',
  "'a11y.customCount'", "'auto.countHint'"];
const GONE_BG = ['defaultCount: 30', "pace: 'normal'", 'autoStop: true', 'holdRange(',
  'AUTO_DEFAULTS.count', 'AUTO_DEFAULTS.level', 'tasks.count', 'tasks.level',
  'o.cap', 'cap: msg.count', '&form=QBLH'];

test('v4.3 · 设置页：冲突的「搜索次数上限」整行移除，两端共有 DOM 仍逐字一致', () => {
  for (const [name, html] of [['plugin', EH], ['desktop', DH]]) {
    for (const gone of GONE_HTML) {
      assert.ok(!html.includes(gone), name + ' 仍残留 ' + gone);
    }
    assert.ok(html.includes('data-i18n="auto.countNote"'), name + ' 缺次数说明');
    assert.equal((html.match(/data-preset="/g) || []).length, 7, name + ' v4.2 预设被破坏');
    assert.equal((html.match(/data-group="(quota|action|page)"/g) || []).length, 3);
  }
  const body = s => {
    const a = s.indexOf('<div class="settings-body">');
    return s.slice(a, s.indexOf('</section>', a));
  };
  const d = body(DH);
  const ds = d.indexOf('<!-- v1.3.8 · 桌面版专有功能');
  const de = d.indexOf('id="set-reset"', ds);
  assert.equal(body(EH).trim(), (d.slice(0, ds) + d.slice(d.lastIndexOf('\n', de) + 1)).trim());
  /* 全量 i18n 键零缺失 */
  for (const [name, html, js] of [['plugin', EH, EP], ['desktop', DH, DP]]) {
    const keys = [...html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)].map(m => m[1]);
    for (const key of new Set(keys)) {
      assert.ok(js.includes("'" + key + "':"), name + ' 缺字典键 ' + key);
    }
  }
});

test('v4.3 · popup.js：虚拟输入框与死键全清，强度只写一个真源', () => {
  for (const [name, js] of [['plugin', EP], ['desktop', DP]]) {
    for (const gone of GONE_JS) assert.ok(!js.includes(gone), name + ' 仍残留 ' + gone);
    assert.match(js, /const AUTO_DEFAULTS = \{ enabled: false, times: \[\] \}/);
    assert.match(js, /onSegment\('set-auto-level', v => saveSettings\(\{ humanLevel: Number\(v\) \}\)/);
    assert.match(js, /return \{ enabled: !!src\.enabled, times \}/);
    assert.match(js, /'auto\.countNote':/);
    assert.match(js, /function renderRunPreset\(\)/, name + ' v4.2 渲染被破坏');
  }
});

test('v4.3 · 后台：死键/双源/第二层封顶全清，次数只剩配额 × 强度预设', () => {
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    for (const gone of GONE_BG) assert.ok(!src.includes(gone), name + ' 仍残留 ' + gone);
    assert.match(src, /async function presetSearchCount\((counter|pages)\) \{/);
    assert.match(src, /HSA_STEALTH\.capSearches\(need, need, STEALTH\.singleRunCapPct/);
    assert.match(src, /const sync = await syncStart\(token\);/);
    assert.match(src, /HSA_HUMAN\.levelFromValue\(runSettings\.humanLevel\)\.n/);
    assert.match(src, /const payload = \{\s*manual: !!o\.manual,/);
    assert.ok(!/form=QBLH/.test(src));
  }
  /* directSearchUrl 只保留 q，不再伪造首页表单来源 */
  for (const src of [EB, DB]) {
    const a = src.indexOf('function directSearchUrl(query)');
    const seg = src.slice(a, a + 500);
    assert.match(seg, /www\.bing\.com\/search\?q=/);
    assert.ok(!seg.includes('form='), '兜底导航仍带 form 参数');
  }
});

test('v4.3 · 冲突复现：旧逻辑「填 30 实跑 18」不再存在', () => {
  const need = 20;
  const cfg = H.applyRunPreset({ runMode: 'human', humanLevel: 2 });
  const oldResult = S.capSearches(need, 30, cfg.singleRunCapPct, 'human');
  const newResult = S.capSearches(need, need, cfg.singleRunCapPct, 'human');
  assert.equal(oldResult, 12, '旧逻辑：min(20,30)=20 → 60% = 12');
  assert.equal(newResult, 12, '本例配额更少，新逻辑结果相同');
  /* 换一个配额更大的例子，旧上限会截掉，新逻辑不会 */
  const bigNeed = 50;
  const oldCapped = S.capSearches(bigNeed, 30, cfg.singleRunCapPct, 'human');
  const newCapped = S.capSearches(bigNeed, bigNeed, cfg.singleRunCapPct, 'human');
  assert.equal(oldCapped, 18, '旧逻辑：用户填 30 但实跑 18');
  assert.equal(newCapped, 30, '新逻辑：只由配额 50 × 60% = 30 决定');
  for (const lv of [1, 2, 3]) {
    const c = H.applyRunPreset({ runMode: 'human', humanLevel: lv });
    assert.equal(S.capSearches(bigNeed, bigNeed, c.singleRunCapPct, 'human'),
      Math.round(bigNeed * c.singleRunCapPct / 100));
  }
  assert.equal(S.capSearches(bigNeed, bigNeed, 60, 'strict'), bigNeed);
});

test('v4.3 · 强度单一真源：autoTasks 不再持有 level，切档即全局生效', () => {
  for (const lv of [1, 2, 3]) {
    const settings = { runMode: 'human', humanLevel: lv };
    const profile = H.createProfile(settings, 42);
    assert.equal(profile.level, H.levelFromValue(lv).key);
    const preset = H.applyRunPreset(settings);
    assert.equal(preset.runPresetLevel, H.levelFromValue(lv).key);
    assert.equal(preset.runPresetMinutes, H.LEVELS[H.levelFromValue(lv).key].targetMinutes);
  }
  assert.equal(H.levelFromValue('high').n, 3);
  assert.equal(H.levelFromValue(undefined).n, 2, '缺省中档');
});

test('v4.3 · 共享护栏：三档收敛、严格档恒关、日键与 hsa-core 一致', () => {
  assert.equal(S.selftest().ok, true, JSON.stringify(S.selftest().checks.filter(x => !x.ok)));
  const t0 = Date.UTC(2026, 10, 12, 4, 0, 0);
  assert.equal(S.utc8DayKey(t0), C.hotDayKey(t0));
  assert.equal(S.utc8DayKey(Date.UTC(2026, 10, 11, 20, 0, 0)), '2026-11-12');
  const [l, m, h] = [1, 2, 3].map(n => S.runGuardPolicy(n, 'human'));
  assert.ok(l.maxRuns > m.maxRuns && m.maxRuns > h.maxRuns);
  assert.ok(l.minGapMin < m.minGapMin && m.minGapMin < h.minGapMin);
  assert.ok(l.skipRate < m.skipRate && m.skipRate < h.skipRate);
  assert.equal(S.runGuardPolicy(3, 'strict').enabled, false);
  assert.equal(S.guardDecision(null, t0, S.runGuardPolicy(3, 'strict'), 0, false).allowed, true);
  assert.deepEqual(S.RUN_GUARD.mid, { maxRuns: 3, minGapMin: 45, skipRate: 0.12 });
});

test('v4.3 · 护栏状态：跨日自动失效、异常降级、上限裁剪', () => {
  const t0 = Date.UTC(2026, 10, 12, 4, 0, 0);
  const day = S.utc8DayKey(t0);
  const st = S.guardState({ day, runs: [t0], skips: [t0 - 1000] }, t0);
  assert.equal(st.day, day);
  assert.deepEqual(st.runs, [t0]);
  assert.deepEqual(S.guardState({ day: '2026-11-11', runs: [t0], skips: [] }, t0).runs, []);
  assert.deepEqual(S.guardState({ day }, t0).runs, []);
  assert.deepEqual(S.guardState(null, t0).runs, []);
  const huge = { day, runs: Array.from({ length: 100 }, (_, i) => t0 - i * 1000), skips: [] };
  assert.equal(S.guardState(huge, t0).runs.length, 32);
  const tomorrow = t0 + 24 * 3600000;
  assert.deepEqual(S.guardState(st, tomorrow).runs, []);
  assert.equal(S.guardDecision(st, tomorrow, S.runGuardPolicy(2, 'human'), 0.9, false).allowed, true);
});

test('v4.3 · 护栏决策：上限 / 最小间隔 / 概率跳过 / 手动不跳过', () => {
  const t0 = Date.UTC(2026, 10, 12, 4, 0, 0);
  const day = S.utc8DayKey(t0);
  const pol = S.runGuardPolicy(2, 'human');
  const empty = S.guardState(null, t0);
  const soon = S.guardDecision(S.guardRecord(empty, t0, { reason: 'ok' }),
    t0 + 10 * 60000, pol, 0.9, false);
  assert.equal(soon.reason, 'min-gap');
  assert.equal(soon.waitMs, 35 * 60000);
  const later = S.guardDecision(S.guardRecord(empty, t0, { reason: 'ok' }),
    t0 + 46 * 60000, pol, 0.9, false);
  assert.equal(later.allowed, true);
  const full = { day, runs: [t0 - 5 * 3600000, t0 - 4 * 3600000, t0 - 3 * 3600000], skips: [] };
  const capped = S.guardDecision(full, t0, pol, 0.9, false);
  assert.equal(capped.reason, 'daily-run-cap');
  assert.equal(capped.used, 3);
  const skip = S.guardDecision(empty, t0, pol, 0.01, false);
  assert.equal(skip.reason, 'stochastic-skip');
  assert.equal(skip.skip, true);
  assert.equal(S.guardDecision(empty, t0, pol, 0.01, true).allowed, true, '手动不跳过');
  const rec = S.guardRecord(empty, t0, skip);
  assert.equal(rec.runs.length, 0);
  assert.equal(rec.skips.length, 1);
  assert.equal(S.guardReasonText('min-gap').zh, '距上次运行过近');
});

test('v4.3 · 用户场景：一天内多次定时/手动触发，按护栏收敛且不补跑', () => {
  /* 北京时间 08:00 起，每 3 小时一次，全部落在同一个 UTC+8 日内 */
  const t0 = Date.UTC(2026, 10, 12, 0, 0, 0);
  const day = S.utc8DayKey(t0);
  const pol = S.runGuardPolicy(2, 'human');
  let state = S.guardState(null, t0);
  const started = [], skipped = [];
  const times = ['08:00', '11:00', '14:00', '17:00', '20:00'];
  times.forEach((time, i) => {
    const now = t0 + i * 3 * 3600000;
    const roll = S.mulberry32(S.hashSeed(day + '|' + time + '|schedule'))();
    const d = S.guardDecision(state, now, pol, roll, false);
    state = S.guardRecord(state, now, d);
    (d.allowed ? started : skipped).push({ time, reason: d.reason, roll });
  });
  assert.ok(started.length <= pol.maxRuns, '实际启动不得超过当日上限');
  assert.ok(skipped.length > 0, '应至少触发一次跳过/间隔拦截');
  assert.equal(state.runs.length, started.length);
  assert.equal(state.runs.length + state.skips.length,
    started.length + skipped.filter(x => x.reason === 'stochastic-skip').length,
    '间隔/上限拦截不占额度，只有实际运行与概率跳过入账');
  /* 确定性 roll：同一时间点当天重复模拟不会靠随机数绕过 */
  const r1 = S.mulberry32(S.hashSeed(day + '|08:00|schedule'))();
  const r2 = S.mulberry32(S.hashSeed(day + '|08:00|schedule'))();
  assert.equal(r1, r2);
  /* 换日恢复 */
  const nextDay = t0 + 24 * 3600000;
  assert.equal(S.guardDecision(state, nextDay, pol, 0.9, false).allowed, true);
});

test('v4.3 · 两端护栏接线逐字同构，且在所有运行分支之前', () => {
  const blockOf = t => {
    const a = t.indexOf('   * v4.3 · 当日运行频次护栏');
    const b = t.indexOf('      guard: guardVerdict };', a);
    assert.ok(a > 0 && b > a, '护栏块缺失或位置不对');
    return t.slice(a, b + '      guard: guardVerdict };'.length);
  };
  const e = blockOf(EB), d = blockOf(DB);
  assert.equal(e, d, '两端护栏接线必须逐字一致');
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    for (const needle of ['HSA_STEALTH.runGuardPolicy(', 'HSA_STEALTH.guardState(',
      'HSA_STEALTH.guardDecision(', 'HSA_STEALTH.guardRecord(',
      "store({ runGuard:", "hsaRunLog('run-guard'", 'HSA_STEALTH.guardReasonText(',
      'guardVerdict.allowed', 'HSA_STEALTH.mulberry32(HSA_STEALTH.hashSeed(']) {
      assert.ok(src.includes(needle), name + ' 缺 ' + needle);
    }
    const g = src.indexOf('   * v4.3 · 当日运行频次护栏');
    assert.ok(g < src.indexOf('RUN_SETTINGS = await getSettings()', g),
      name + ' 护栏应在读取运行设置之前');
    assert.ok(g < src.indexOf('const sync = await syncStart(token)', g),
      name + ' 护栏应在开始同步之前');
  }
});

test('v4.3 · 不回退：严格档、词规则、v4.0/4.1/4.2 能力', () => {
  const strict = C.strictRunPolicy();
  assert.equal(strict.fixedNapMs, 600);
  assert.equal(strict.randomDelay, false);
  assert.equal(C.isStrictKeyword('四个字'), false);
  assert.equal(C.isStrictKeyword('五个字词甲'), true);
  assert.equal(C.isNonClickableTaskItem({ name: '今日 Bing 搜索', section: 'search' }), true);
  assert.equal(C.hasClickableCards([{ name: '今日 Bing 搜索', section: 'search' }],
    [{ name: '今日 Bing 搜索', section: 'search' }], null), false);
  const st = C.todayUsedState({ day: C.hotDayKey(Date.now()), words: ['六个字的热搜词'] }, Date.now());
  assert.deepEqual(C.dropUsedWords(['六个字的热搜词', '另一个合规词条甲乙'], st.words),
    ['另一个合规词条甲乙']);
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    for (const needle of ['HSA_STEALTH.normalize(RUN_SETTINGS)', 'skipCardPhaseIfEmpty',
      'HSA_HUMAN.applyRunPreset(', 'HSA_CORE.todayUsedState(saved, now)',
      'HSA_CORE.dropUsedWords(built.queries, usedAll)']) {
      assert.ok(src.includes(needle), name + ' 回退了 ' + needle);
    }
  }
  const master = read('shared/hsa-stealth.js');
  for (const f of ['edge-extension/shared/hsa-stealth.js', 'desktop-app/shared/hsa-stealth.js']) {
    assert.equal(read(f).replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), master.trim() + '\n');
  }
});
