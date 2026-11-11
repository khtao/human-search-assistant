/* v3.1 专项：修复 applet 版之后插件版「同步时弹出 rewards 官网」
   node --test tests/v31-fix-sync-popup.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MV3 = require('../edge-extension/lib/mv3-budget.js');
const CORE = require('../shared/hsa-core.js');

const EB = read('edge-extension/background.js');
const DB = read('desktop-app/src/background.js');
const EH = read('edge-extension/popup.html');
const EP = read('edge-extension/popup.js');

test('v3.1 · 响应体完整：700KB 官网 HTML 不被缓存上限截断', () => {
  const big = '<html>' + 'x'.repeat(700000) + '</html>';
  const v = MV3.officialPageValue(
    { ok: true, status: 200, url: 'https://rewards.bing.com/earn' }, big, 123);
  assert.equal(v.html.length, big.length, '必须把完整 HTML 交给解析器');
  assert.equal(v.ok, true);
  assert.equal(v.status, 200);
  assert.equal(v.url, 'https://rewards.bing.com/earn');
  assert.equal(v.source, 'official-network');
  assert.equal(v.collectedAt, 123);
  assert.equal(MV3.cacheableHtml(big), false, '超限页面不进缓存');
  assert.equal(MV3.cacheableHtml('<html>' + 'y'.repeat(500000) + '</html>'), true,
    '≤600KB 的完整页面可缓存');
  assert.equal(MV3.cacheableHtml(''), false);
  assert.equal(MV3.cacheableHtml(null), false);
  assert.equal(MV3.POLICY.htmlCacheMaxBytes, CORE.DEFAULTS.htmlCacheMaxBytes,
    '恢复为 applet 版的 600KB 口径');
  assert.equal(MV3.POLICY.htmlCacheMaxEntries, 1, '常驻内存仍比 applet 版 4 条低 4 倍');
  assert.equal(MV3.POLICY.htmlCacheTtlMs, 45000);
});

test('v3.1 · 源码级：res.text() 结果不再被 slice 截断，缓存只收完整页面', () => {
  assert.match(EB, /const html = await res\.text\(\);/);
  assert.match(EB, /const value = MV3\.officialPageValue\(res, html, Date\.now\(\)\)/);
  assert.match(EB, /if \(res\.ok && MV3\.cacheableHtml\(html\)\)/);
  assert.doesNotMatch(EB, /res\.text\(\)\)\.slice\(0, MV3\.POLICY/,
    '回归防护：v2.9 的 (await res.text()).slice(96KB) 不得再现');
  assert.match(EB, /return value;/, '返回值在缓存 if 之外，超限页面本次照常解析');
  assert.match(DB, /htmlCacheMaxBytes: 600 \* 1024/);
  assert.match(DB, /slice\(0, DESKTOP_MEM\.htmlCacheMaxBytes\)/);
  assert.doesNotMatch(DB, /htmlCacheMaxBytes: 256 \* 1024/);
});

test('v3.1 · 同步绝不打开 rewards 标签页：全部同步入口带 noTabs', () => {
  assert.match(EB,
    /if \(!cards\.length && pages\.reachable && !\(o\.skipInjection\) && !o\.noTabs\)/);
  const calls = EB.match(/syncRewardsUnified\(\{[^}]*\}\)/g) || [];
  assert.ok(calls.length >= 6, '应覆盖全部同步入口，实际 ' + calls.length);
  for (const c of calls) assert.match(c, /noTabs: true/, '同步入口漏了 noTabs: ' + c);
  /* 打开主界面 / 手动刷新 / 下拉刷新 */
  assert.match(EB, /msg\.type === HSA_CORE\.SYNC_ON_OPEN\.messageType/);
  assert.match(EB, /syncRewardsUnified\(\{ fresh: true, noTabs: true, reason: reason \}\)/);
  assert.match(EP, /await send\('refreshTasks'\)/);
  /* 自动运行的积分读取 / 搜索点击仍可用 openOrNavigate */
  assert.match(EB, /async function readRewardsPage\(/);
  assert.ok((EB.match(/await readRewardsPage\(/g) || []).length >= 2);
  assert.match(EB, /async function openOrNavigate\(/);
});

test('v3.1 · 桌面版同样护栏：跳过隐藏取数视图，透传 noTabs', () => {
  assert.match(DB, /if \(opts && opts\.noTabs\)/);
  assert.match(DB, /error: 'no-tabs sync'/);
  assert.match(DB, /noTabs: o\.noTabs/);
  assert.match(DB, /desktopSyncRewards\(\{ fresh: true, noTabs: true,/);
  assert.match(DB, /desktopSyncRewards\(\{ fresh: true, noTabs: true, reason: reason \}\)/);
  /* 面板 / 快照等只读降级保留 */
  assert.match(DB, /desktopFetchFromPanel\(path\)/);
  assert.match(DB, /desktopFetchFromSnapshot\(path\)/);
});

test('v3.1 · 对话中后续改动完整落在插件版，applet 基线功能未破坏', () => {
  /* applet 下拉刷新（minirefresh applet 主题：三点 ball-beat / 内容 translate） */
  assert.match(EH, /hsa-pull-refresh\.js/);
  assert.match(read('shared/hsa-shared.css'), /hsa-ball-beat/);
  assert.match(read('shared/hsa-pull-refresh.js'), /applet/);
  /* 关键页 ZIP 导出、悬浮提示最上层、日历复位 */
  assert.match(EH, /hsa-zip\.js/);
  assert.match(EH, /hsa-hover-tip\.js/);
  assert.match(read('edge-extension/popup.css'), /2147483647/);
  assert.match(EP, /calendarReset\(\)/);
  /* 严格运行 / 日志导出 / 打开同步 / 插件专用内存预算 */
  assert.match(EB, /importScripts\('lib\/mv3-budget\.js'\)/);
  assert.match(EB, /exportRunLog/);
  assert.match(EB, /msg\.type === HSA_CORE\.SYNC_ON_OPEN\.messageType/);
  assert.match(EP, /async function requestSyncOnOpen\(\)/);
  assert.equal(CORE.SYNC_ON_OPEN.reason, 'ui-open');
  /* 共享副本（去掉自动生成头）与单一真源一致 */
  const a = read('shared/hsa-core.js');
  const b = read('edge-extension/shared/hsa-core.js');
  const stripHead = t => t.replace(/^\/\* AUTO-GENERATED[^\n]*\n/, '');
  assert.equal(stripHead(b), a);
});

test('v3.1 · 缓存状态机：超限页面不进缓存，但 trimCache 仍只留 1 条', () => {
  const M = require('../edge-extension/lib/mv3-budget.js');
  const now = Date.now();
  const map = new Map([
    ['stale', { at: now - 60000 }],
    ['fresh1', { at: now }],
    ['fresh2', { at: now }]
  ]);
  assert.ok(M.trimCache(map, now) >= 2);
  assert.equal(map.size, 1);
  /* 缓存里存的 value.html 仍是完整页面（≤600KB 才准入） */
  const html = '<html>' + 'z'.repeat(500000) + '</html>';
  const value = M.officialPageValue({ ok: true, status: 200, url: 'u' }, html, now);
  assert.equal(M.cacheableHtml(value.html), true);
  assert.equal(value.html.length, html.length);
});
