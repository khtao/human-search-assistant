'use strict';
/* ============================================================================
 * v4.2 · 三组强度预设 + 搜索词当日不重复（两端同构动态回归）
 *   node --test tests/v42-presets-dedupe.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const H = require(path.join(ROOT, 'shared', 'hsa-human.js'));
const C = require(path.join(ROOT, 'shared', 'hsa-core.js'));
const S = require(path.join(ROOT, 'shared', 'hsa-stealth.js'));
const EB = read('edge-extension/background.js');
const DB = read('desktop-app/src/background.js');
const EH = read('edge-extension/popup.html');
const DH = read('desktop-app/src/popup.html');
const EP = read('edge-extension/popup.js');
const DP = read('desktop-app/src/popup.js');
const CSS = read('shared/hsa-shared.css');

const KEYS = ['singleRunCapPct', 'scheduleJitterMin', 'cardClickIntervalSec',
  'actionGapSec', 'pageStableSec', 'roundGapSec', 'roundWaitSec'];

test('v4.2 · 三组预设：3 组 7 项、三档齐全、强度单向变化', () => {
  assert.deepEqual(H.PRESET_GROUPS.map(g => g.key), ['quota', 'action', 'page']);
  assert.equal(H.PRESET_GROUPS.reduce((a, g) => a + g.keys.length, 0), 7);
  assert.deepEqual(H.PRESET_GROUPS.flatMap(g => g.keys).sort(), [...KEYS].sort());
  for (const lv of ['low', 'mid', 'high']) {
    for (const k of KEYS) assert.ok(Number.isFinite(H.RUN_PRESETS[lv][k]), lv + '/' + k);
  }
  const [l, m, h] = ['low', 'mid', 'high'].map(k => H.RUN_PRESETS[k]);
  assert.ok(l.singleRunCapPct > m.singleRunCapPct && m.singleRunCapPct > h.singleRunCapPct);
  assert.ok(l.scheduleJitterMin < m.scheduleJitterMin && m.scheduleJitterMin < h.scheduleJitterMin);
  for (const k of ['cardClickIntervalSec', 'actionGapSec', 'pageStableSec',
                   'roundGapSec', 'roundWaitSec']) {
    assert.ok(l[k] < m[k] && m[k] < h[k], k + ' 应随强度递增');
  }
  assert.equal(H.selftest().ok, true, JSON.stringify(H.selftest()));
  assert.equal(S.selftest().ok, true);
});

test('v4.2 · 切档即整组套用，旧存档里的手动值不再生效；严格档一字不覆盖', () => {
  for (const [lv, n] of [[1, 'low'], [2, 'mid'], [3, 'high']]) {
    const raw = { runMode: 'human', humanLevel: lv,
      roundGapSec: 999, singleRunCapPct: 999, cardClickIntervalSec: 999 };
    const out = H.applyRunPreset(raw);
    for (const k of KEYS) assert.equal(out[k], H.RUN_PRESETS[n][k], n + '/' + k);
    assert.equal(out.runPresetLevel, n);
    assert.equal(out.runPresetMinutes, H.LEVELS[n].targetMinutes);
    const pv = H.presetValues(lv, 'human');
    assert.equal(pv.level, n);
    assert.equal(pv.groups.length, 3);
    assert.deepEqual(Object.keys(pv.values).sort(), [...KEYS].sort());
  }
  const strict = { runMode: 'strict', humanLevel: 'high', roundGapSec: 42,
    singleRunCapPct: 77, actionGapSec: 1.7 };
  assert.deepEqual(H.applyRunPreset(strict), strict);
  assert.equal(H.presetFor('high', 'strict'), null);
  assert.equal(H.presetValues('high', 'strict'), null);
  const policy = C.strictRunPolicy();
  assert.equal(policy.fixedNapMs, 600);
  assert.equal(policy.pageStableWaitMs, 3000);
  assert.equal(policy.fixedRoundIntervalMs, 10000);
  assert.equal(policy.randomDelay, false);
});

test('v4.2 · 两端后台 getSettings 同源套用，共享副本逐字节一致', () => {
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    assert.match(src, /HSA_HUMAN\.applyRunPreset\(/, name);
    assert.match(src, /Object\.assign\(\{\}, DEFAULT_SETTINGS, settings \|\| \{\}\)/, name);
    assert.match(src, /async function getSettings\(\)/, name);
  }
  const masterH = read('shared/hsa-human.js');
  const masterC = read('shared/hsa-core.js');
  for (const d of ['edge-extension/shared/hsa-human.js', 'desktop-app/shared/hsa-human.js']) {
    assert.equal(read(d).replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), masterH.trim() + '\n');
  }
  for (const d of ['edge-extension/shared/hsa-core.js', 'desktop-app/shared/hsa-core.js']) {
    assert.equal(read(d).replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), masterC.trim() + '\n');
  }
});

test('v4.2 · 设置页：7 个专业输入框全部移除，三组只读摘要两端逐字一致', () => {
  const gone = ['set-card-interval', 'set-action-gap', 'set-page-stable',
    'set-round-gap', 'set-round-wait', 'set-stealth-cap', 'set-stealth-jitter'];
  for (const [name, html] of [['plugin', EH], ['desktop', DH]]) {
    const a = html.indexOf('id="run-group"'), b = html.indexOf('id="auto-group"', a);
    const run = html.slice(a, b);
    for (const id of gone) assert.ok(!run.includes('id="' + id + '"'), name + ' 仍有 ' + id);
    assert.ok(run.includes('id="run-preset-groups"'), name + ' 缺预设容器');
    assert.ok(run.includes('id="run-preset-strict"'), name + ' 缺严格档说明');
    assert.equal((run.match(/data-group="(quota|action|page)"/g) || []).length, 3);
    for (const k of KEYS) {
      assert.ok(run.includes('data-preset="' + k + '"'), name + ' 缺 ' + k);
      assert.equal((run.match(new RegExp('data-preset="' + k + '"', 'g')) || []).length, 1);
    }
    assert.equal((run.match(/<input type="number"/g) || []).length, 0,
      name + ' 运行设置不应再有数值输入框');
  }
  const block = s => {
    const a = s.indexOf('id="run-preset-groups"');
    return s.slice(a, s.indexOf('id="run-preset-strict"', a));
  };
  assert.equal(block(EH), block(DH));
  /* 共有设置 DOM 仍逐字一致（去掉桌面专有组） */
  const body = s => {
    const a = s.indexOf('<div class="settings-body">');
    return s.slice(a, s.indexOf('</section>', a));
  };
  const d = body(DH);
  const ds = d.indexOf('<!-- v1.3.8 · 桌面版专有功能');
  const de = d.indexOf('id="set-reset"', ds);
  assert.equal(body(EH).trim(), (d.slice(0, ds) + d.slice(d.lastIndexOf('\n', de) + 1)).trim());
  assert.match(CSS, /\.preset-groups/);
  assert.match(CSS, /\.preset-groups\[hidden\]/);
  for (const f of ['edge-extension/shared/hsa-shared.css', 'desktop-app/shared/hsa-shared.css']) {
    assert.equal(read(f).replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), CSS);
  }
});

test('v4.2 · 设置页字典零缺失、强度/模式切换会刷新只读摘要', () => {
  for (const [name, js, html] of [['plugin', EP, EH], ['desktop', DP, DH]]) {
    assert.match(js, /function renderRunPreset\(\)/, name);
    assert.match(js, /HSA_HUMAN\.presetValues\(settings\.humanLevel, settings\.runMode\)/, name);
    assert.match(js, /renderRunPreset\(\);/, name);
    assert.match(js, /box\.hidden = !pre/, name);
    for (const key of ['run.presetDesc', 'run.groupQuota', 'run.groupAction',
                       'run.groupPage', 'run.presetStrictNote']) {
      assert.ok(js.includes("'" + key + "':"), name + ' 缺字典键 ' + key);
    }
    const keys = [...html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)].map(m => m[1]);
    for (const key of new Set(keys)) {
      assert.ok(js.includes("'" + key + "':"), name + ' HTML 键缺字典 ' + key);
    }
    assert.match(js, /onSegment\('set-auto-level'/, name);
    assert.match(js, /onSegment\('set-run-mode'/, name);
  }
});

test('v4.2 · 当日已用词：UTC+8 日界、跨日失效、结构异常降级', () => {
  const now = Date.UTC(2026, 10, 12, 4, 0, 0);
  assert.equal(C.hotDayKey(now), '2026-11-12');
  const words = ['六个字的热搜词', '今日十个字的头条新闻词'];
  const st = C.todayUsedState({ day: C.hotDayKey(now), words }, now);
  assert.deepEqual(st.words, words);
  assert.deepEqual(C.todayUsedState({ day: '2026-11-11', words }, now).words, []);
  assert.deepEqual(C.todayUsedState({ day: C.hotDayKey(now) }, now).words, []);
  assert.deepEqual(C.todayUsedState({ day: C.hotDayKey(now), words: 'bad' }, now).words, []);
  assert.deepEqual(C.todayUsedState(null, now).words, []);
  const prev = Date.UTC(2026, 10, 11, 20, 0, 0);
  assert.equal(C.hotDayKey(prev), '2026-11-12', 'UTC 20:00 = 北京时间次日');
});

test('v4.2 · 合并/过滤/累加：顺序不变、不补词、重复不再累加', () => {
  const pool = ['六个字的热搜词', '今日十个字的头条新闻词',
    '第五个合规词甲乙丙', '另一个当日热搜词条'];
  assert.ok(pool.every(w => C.isStrictKeyword(w)));
  assert.deepEqual(C.mergeUsedWords([['甲', '甲'], ['乙']]), ['甲', '乙']);
  assert.deepEqual(C.mergeUsedWords(['甲', ' 甲 ', '乙']), ['甲', '乙']);
  assert.deepEqual(C.dropUsedWords(pool, ['六个字的热搜词', '第五个合规词甲乙丙']),
    ['今日十个字的头条新闻词', '另一个当日热搜词条']);
  assert.deepEqual(C.dropUsedWords(pool, []), pool);
  const st = { day: '2026-11-12', words: ['六个字的热搜词'] };
  const next = C.todayUsedPush(st, pool.slice(0, 2));
  assert.deepEqual(next.words, ['六个字的热搜词', '今日十个字的头条新闻词']);
  assert.deepEqual(C.todayUsedPush(next, pool).words,
    ['六个字的热搜词', '今日十个字的头条新闻词', '第五个合规词甲乙丙', '另一个当日热搜词条']);
  const huge = Array.from({ length: 400 }, (_, i) => '热搜词条编号' + String(1000 + i));
  assert.equal(C.todayUsedPush({ day: 'd', words: [] }, huge).words.length, C.USED_WORDS_MAX);
});

test('v4.2 · 用户场景：同一天连续 3 次运行，选出的词绝不重复', () => {
  const now = Date.UTC(2026, 10, 12, 4, 0, 0);
  const day = C.hotDayKey(now);
  const pool = Array.from({ length: 9 }, (_, i) =>
    '当日热搜词条' + String.fromCharCode(0x7532 + i) + '内容');
  assert.ok(pool.every(w => C.isStrictKeyword(w)));
  let state = C.todayUsedState(null, now);
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const items = pool.map(text => ({ text, at: now }));
    /* 与两端 buildQueries 同构：整池取合规词 → 剔除当日已用 → 取本次条数 */
    const built = C.strictQueries(items.length, items, now);
    const usedAll = C.mergeUsedWords([state.words]);
    const fresh = C.dropUsedWords(built.queries, usedAll).slice(0, 3);
    assert.equal(fresh.length, 3, '第 ' + (i + 1) + ' 次运行应有 3 个新词');
    state = C.todayUsedPush(state, fresh);
    runs.push(fresh);
  }
  const all = runs.flat();
  assert.equal(new Set(all.map(w => C.usedWordKey(w))).size, 9, '9 个词互不重复');
  assert.equal(state.day, day);
  assert.equal(state.words.length, 9);
  /* 第 4 次：当日合规词已全部用完 */
  const built4 = C.strictQueries(pool.length, pool.map(text => ({ text, at: now })), now);
  assert.deepEqual(C.dropUsedWords(built4.queries, state.words), [],
    '词用完如实返回空，不补词 / 不编词 / 不复用');
  /* 换日后重新可用 */
  const tomorrow = now + 24 * 3600000;
  assert.deepEqual(C.todayUsedState(state, tomorrow).words, []);
});

test('v4.2 · 两端 buildQueries 接线同构且词规则不回退', () => {
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    for (const needle of ["load(['todayUsedWords'])",
      'HSA_CORE.todayUsedState(saved, now)', 'HSA_CORE.mergeUsedWords(',
      'HSA_CORE.dropUsedWords(built.queries, usedAll)',
      'HSA_CORE.todayUsedPush(usedState, queries)',
      "store({ todayUsedWords: nextState })",
      '当日合规词已全部用完', 'droppedUsed', 'todayUsedWords: nextState']) {
      assert.ok(src.includes(needle), name + ' 缺 ' + needle);
    }
    assert.match(src, /HSA_CORE\.strictQueries\(pool\.items\.length, pool\.items, now\)/, name);
    assert.match(src, /HSA_CORE\.isStrictKeyword\(/, name);
    assert.match(src, /queries: queries,/, name);
    /* 没有恢复改词 / 回首页 / 本地词库 */
    const a = src.indexOf('async function buildQueries');
    const b = src.indexOf('async function suggestRelated', a);
    const seg = src.slice(a, b > a ? b : a + 3000);
    assert.ok(!/suggestRelated\(|GO_HOME_RATE|RELATED_RATE|localWords/.test(seg),
      name + ' buildQueries 恢复改词');
  }
});

test('v4.2 · 严格档、v4.0 风险规避、v4.1 非卡片跳过均不回退', () => {
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    for (const needle of ['HSA_STEALTH.normalize(RUN_SETTINGS)', 'HSA_STEALTH.capSearches(',
      'skipCardPhaseIfEmpty', 'HSA_CORE.hasClickableCards(', 'no-clickable-cards']) {
      assert.ok(src.includes(needle), name + ' 缺 ' + needle);
    }
  }
  assert.equal(C.isNonClickableTaskItem({ name: '今日 Bing 搜索', section: 'search' }), true);
  assert.equal(C.hasClickableCards([{ name: '今日 Bing 搜索', section: 'search' }],
    [{ name: '今日 Bing 搜索', section: 'search' }], null), false);
  assert.equal(C.isStrictKeyword('四个字'), false);
  assert.equal(C.isStrictKeyword('五个字词甲'), true);
});
