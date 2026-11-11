/* 严格运行模式单测：node --test tests/strict-run.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const CORE = require('../shared/hsa-core.js');

const NOW = Date.UTC(2026, 10, 11, 4, 0, 0); // 北京时间 2026-11-11 12:00
const TODAY = Date.UTC(2026, 10, 11, 0, 0, 0); // 北京 11-11 08:00，同一天
const YESTERDAY = Date.UTC(2026, 10, 10, 0, 0, 0); // 北京 11-10 08:00，跨天

test('严格模式 · 少于 5 个字的单调词一律拒绝', () => {
  assert.equal(CORE.STRICT_RUN.minKeywordChars, 5);
  assert.equal(CORE.isStrictKeyword('天气'), false);          // 2 字
  assert.equal(CORE.isStrictKeyword('热搜词'), false);        // 3 字
  assert.equal(CORE.isStrictKeyword('今日热点'), false);      // 4 字
  assert.equal(CORE.isStrictKeyword('abcd'), false);          // 4 字母
  assert.equal(CORE.isStrictKeyword('今日热搜榜单'), true);    // 6 字
  assert.equal(CORE.isStrictKeyword('abcde'), true);          // 5 字母
  assert.equal(CORE.isStrictKeyword('A'.repeat(31)), false);  // 超过 30 字
  assert.equal(CORE.isStrictKeyword('😀😀😀😀😀'), false);   // 无可检索字符
  assert.equal(CORE.isStrictKeyword(null), false);
  assert.equal(CORE.isStrictKeyword(undefined), false);
});

test('严格模式 · 当日按 UTC+8 日界判定，两端口径一致', () => {
  assert.equal(CORE.hotDayKey(TODAY), '2026-11-11');
  assert.equal(CORE.hotDayKey(YESTERDAY), '2026-11-10');
  assert.equal(CORE.isSameDayHot(TODAY, NOW), true);
  assert.equal(CORE.isSameDayHot(YESTERDAY, NOW), false);
  assert.equal(CORE.isSameDayHot(0, NOW), false);
  assert.equal(CORE.hotDayKey(NaN), '');
});

test('严格模式 · 只取当日热搜原文，短词 / 跨天词 / 重复词都丢弃', () => {
  const pool = [
    { text: '今日热搜榜单', source: 'baidu', at: TODAY },
    { text: '四字词', source: 'weibo', at: TODAY },         // 4 字，丢弃
    { text: '昨日热点新闻', source: 'zhihu', at: YESTERDAY }, // 跨天，丢弃
    { text: '今日热搜榜单', source: 'toutiao', at: TODAY },  // 重复，丢弃
    { text: 'Bing daily trending', source: 'bing', at: TODAY },
    { text: '无时间戳词条', source: 'sina' }                  // 无 at，丢弃
  ];
  const r = CORE.strictQueries(4, pool, NOW);
  assert.deepEqual(r.queries, ['今日热搜榜单', 'Bing daily trending']);
  assert.equal(r.requested, 4);
  assert.equal(r.droppedShort, 1);
  assert.equal(r.droppedStale, 2);   // 跨天 + 无时间戳
  assert.equal(r.droppedDuplicate, 1);
  assert.equal(r.complete, false);
  assert.equal(r.dayKey, '2026-11-11');
});

test('严格模式 · 词不够就少跑几轮：不补词、不拼接、不复用、不重复', () => {
  const pool = [
    { text: '第一条热搜词', at: TODAY },
    { text: '第二条热搜词', at: TODAY }
  ];
  const r = CORE.strictQueries(10, pool, NOW);
  assert.equal(r.queries.length, 2);
  assert.equal(r.complete, false);
  assert.equal(new Set(r.queries).size, 2);
  assert.ok(r.queries.every(q => pool.some(p => p.text === q)));
  assert.deepEqual(CORE.strictQueries(2, [], NOW).queries, []);
});

test('严格模式 · 运行期禁用清单与保留护栏', () => {
  const S = CORE.STRICT_RUN;
  assert.equal(S.requireSameDayHot, true);
  assert.equal(S.allowFallbackWords, false);
  assert.equal(S.allowRepeatWords, false);
  for (const f of ['related-rewrite', 'autosuggest', 'local-word-list',
    'used-words-reuse', 'go-home', 'random-enter', 'human-click-plan',
    'human-scroll', 'click-result', 'random-delay', 'reminder',
    'scheduled-reentry', 'runtime-refresh', 'runtime-sync',
    'watchdog-resume', 'runtime-settings-change', 'preview-topic']) {
    assert.equal(CORE.strictRuntimeFeatureAllowed(f, true), false, f + ' 运行期应禁用');
    assert.equal(CORE.strictRuntimeFeatureAllowed(f, false), true, f + ' 空闲时应允许');
  }
  assert.deepEqual(S.keptGuardrails,
    ['stop', 'timeout', 'max-failures', 'page-stable-wait', 'result-counting']);
  const p = CORE.strictRunPolicy();
  assert.equal(p.minKeywordChars, 5);
  assert.equal(p.pageStableWaitMs, CORE.DEFAULTS.pageStableWaitMs);
  assert.equal(p.goHome, false);
  assert.equal(p.relatedRewrite, false);
  assert.equal(p.humanVariation, false);
  assert.equal(p.randomDelay, false);
  assert.equal(p.scroll, false);
  assert.equal(p.clickResult, false);
});

test('严格模式 · 运行期消息与闹钟拦截，stop 与 cooldownEnd 保留', () => {
  for (const t of ['refreshTasks', 'refreshPoints', 'refreshToday', 'syncNow',
    'start', 'autoComplete', 'saveSettings', 'saveAutoTasks']) {
    assert.equal(CORE.strictBlockedMessage(t, true), true, t + ' 运行期应拦截');
    assert.equal(CORE.strictBlockedMessage(t, false), false, t + ' 空闲时应放行');
  }
  assert.equal(CORE.strictBlockedMessage('stop', true), false);
  assert.equal(CORE.strictBlockedMessage('panelState', true), false);
  for (const a of ['watchdog', 'reminderTick', 'autoTaskTick', 'cleanUsedWords',
    'scheduledRun', 'autoDailySet', 'hsaScheduledRun']) {
    assert.equal(CORE.strictAlarmAllowed(a, true), false, a + ' 运行期应禁用');
    assert.equal(CORE.strictAlarmAllowed(a, false), true, a + ' 空闲时应允许');
  }
  assert.equal(CORE.strictAlarmAllowed('cooldownEnd', true), true);
});

test('严格模式 · 双语文案同源，不出现「编词 / 本地词库」放行口径', () => {
  assert.match(CORE.TEXT.strictNoWords, /5 字以上/);
  assert.match(CORE.TEXT.strictNoWords, /不补词/);
  assert.match(CORE.TEXT.strictNoWordsEn, /no fallback words/i);
  assert.match(CORE.TEXT.strictRunBlocked, /严格模式/);
  assert.match(CORE.TEXT.strictRunBlockedEn, /disabled while running/i);
});
