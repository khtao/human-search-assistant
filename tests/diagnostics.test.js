/* 诊断数据单测：node --test tests/diagnostics.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CORE = require('../shared/hsa-core.js');

const ROOT = path.join(__dirname, '..');
const NOW = Date.UTC(2026, 10, 11, 4, 0, 0); // 北京时间 2026-11-11 12:00
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('诊断 · 运行日志保留详细字段，绝不写网页 HTML / 快照', () => {
  assert.equal(CORE.RUNLOG.maxEntries, 600);
  const l = CORE.runLogAppend([], {
    event: 'search', zh: '第 1 轮搜索', en: 'Search 1', query: '今日热搜榜单',
    page: 'bing-search', ok: true, count: 3, delayMs: 1234,
    actor: 'user', category: 'user-action', detail: '用户点击开始按钮并提交查询词',
    result: 'query submitted', error: '',
    html: '<html>should not be stored</html>', snapshot: { at: 1 }, points: { a: 1 }
  }, NOW);
  assert.equal(l.length, 1);
  assert.equal(l[0].at, NOW);
  assert.equal(l[0].event, 'search');
  assert.equal(l[0].level, 'info');
  assert.equal(l[0].actor, 'user');
  assert.equal(l[0].category, 'user-action');
  assert.equal(l[0].detail, '用户点击开始按钮并提交查询词');
  assert.equal(l[0].result, 'query submitted');
  assert.ok(l[0].ts && l[0].iso, '每条日志必须带系统时间');
  assert.match(l[0].ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}$/);
  assert.equal(l[0].query, '今日热搜榜单');
  assert.equal(l[0].ok, true);
  assert.equal(l[0].count, 3);
  assert.equal(l[0].delayMs, 1234);
  for (const forbidden of ['html', 'snapshot', 'points']) {
    assert.equal(Object.prototype.hasOwnProperty.call(l[0], forbidden), false,
      forbidden + ' 不应写进运行日志');
  }
  assert.equal(CORE.runLogAppend(null, { zh: 'x' }, NOW)[0].event, 'activity');
  assert.equal(CORE.runLogAppend([], { zh: 'x'.repeat(500) }, NOW)[0].zh.length,
    CORE.RUNLOG.maxTextChars);
  assert.equal(CORE.runLogAppend([], { detail: 'x'.repeat(3000) }, NOW)[0].detail.length,
    CORE.RUNLOG.maxDetailChars);
});

test('诊断 · 运行日志环形上限，导出结构与文件名固定', () => {
  let l = [];
  const n = CORE.RUNLOG.maxEntries + 50;
  for (let i = 0; i < n; i++) {
    l = CORE.runLogAppend(l, { event: 'search', zh: '第 ' + i + ' 轮' }, NOW + i);
  }
  assert.equal(l.length, CORE.RUNLOG.maxEntries);
  assert.equal(l[0].zh, '第 50 轮');
  assert.equal(l[l.length - 1].zh, '第 ' + (n - 1) + ' 轮');
  assert.ok(l.every(e => e.ts && e.iso), '每条都带系统时间');
  const out = JSON.parse(CORE.runLogExport(l, { now: NOW, platform: 'edge-extension' }));
  assert.equal(out.schema, 'hsa-runlog/2');
  assert.equal(out.version, CORE.VERSION);
  assert.equal(out.platform, 'edge-extension');
  assert.equal(out.count, CORE.RUNLOG.maxEntries);
  assert.equal(out.entries.length, CORE.RUNLOG.maxEntries);
  assert.ok(out.exportedAtSystemTime);
  assert.ok(out.fields.some(f => /系统时间/.test(f)));
  assert.match(out.note, /no web page HTML/i);
  assert.equal(JSON.stringify(out).includes('<html>'), false);
  assert.equal(CORE.runLogFileName(NOW), 'hsa-runlog-20261111-120000.json');
  assert.equal(CORE.keyPageFileName(NOW), 'hsa-keypages-20261111-120000.zip');
});

test('诊断 · 关键网页抓取策略：三页实时，禁用缓存 / 快照 / 面板 / 数据视图', () => {
  const p = CORE.keyPagePolicy();
  assert.equal(p.fresh, true);
  assert.equal(p.cacheAllowed, false);
  assert.equal(p.snapshotAllowed, false);
  assert.equal(p.panelAllowed, false);
  assert.equal(p.dataViewAllowed, false);
  assert.equal(p.source, 'live-network');
  assert.equal(p.origin, 'https://rewards.bing.com');
  assert.equal(p.format, 'zip/html');
  assert.deepEqual(p.pages.map(x => x.name),
    ['dashboard', 'earn', 'bing-sidebar']);
  assert.deepEqual(p.pages.map(x => x.file),
    ['dashboard.html', 'earn.html', 'bing-sidebar.html']);
  assert.match(p.pages[2].url, /panelflyout/);
  assert.equal(CORE.KEY_CAPTURE.cacheAllowed, false);
  assert.equal(CORE.KEY_CAPTURE.snapshotAllowed, false);
  assert.equal(CORE.strictRuntimeFeatureAllowed('key-page-capture', true), false);
});

test('诊断 · 关键网页导出：JSON 摘要 + HTML zip 包文件清单', () => {
  const pages = [
    { name: 'dashboard', file: 'dashboard.html', path: '/dashboard',
      url: 'https://rewards.bing.com/dashboard', ok: true, status: 200,
      bytes: 16, html: '<html>live</html>', collectedAt: NOW },
    { name: 'earn', file: 'earn.html', path: '/earn',
      url: 'https://rewards.bing.com/earn', ok: false, status: 0,
      bytes: 0, html: '', collectedAt: NOW, error: 'timed out' },
    { name: 'bing-sidebar', file: 'bing-sidebar.html', path: '/rewards/panelflyout',
      url: 'https://cn.bing.com/rewards/panelflyout', ok: true, status: 200,
      bytes: 20, html: '<html>sidebar</html>', collectedAt: NOW }
  ];
  const out = JSON.parse(CORE.keyPageExport(pages, NOW, { platform: 'desktop-app' }));
  assert.equal(out.schema, 'hsa-keypages/2');
  assert.equal(out.format, 'zip/html');
  assert.equal(out.fresh, true);
  assert.equal(out.source, 'live-network');
  assert.equal(out.platform, 'desktop-app');
  assert.equal(out.pages.length, 3);
  assert.equal(out.pages[1].ok, false);
  assert.equal(out.pages[1].error, 'timed out');
  assert.equal(Object.prototype.hasOwnProperty.call(out.pages[0], 'html'), false,
    'JSON 摘要不内联 HTML，HTML 只放进 zip');

  const built = CORE.keyPageZipFiles(pages, NOW, { platform: 'desktop-app' });
  assert.deepEqual(built.files.map(f => f.name),
    ['manifest.json', 'dashboard.html', 'earn.html', 'bing-sidebar.html']);
  assert.equal(built.files[1].data, '<html>live</html>');
  assert.equal(built.files[3].data, '<html>sidebar</html>');
  assert.match(built.files[2].data, /capture failed/i);
  assert.equal(built.manifest.schema, 'hsa-keypages/2');
  assert.equal(built.manifest.pages.length, 3);
  assert.ok(built.manifest.capturedAtSystemTime);
});

test('诊断 · 运行期消息白名单：日志导出 / 日志写入放行，抓取网页被拦截', () => {
  assert.equal(CORE.strictBlockedMessage('exportRunLog', true), false);
  assert.equal(CORE.strictBlockedMessage('logUserAction', true), false);
  assert.equal(CORE.strictBlockedMessage('captureKeyPages', true), true);
  assert.equal(CORE.strictBlockedMessage('exportRunLog', false), false);
  assert.equal(CORE.strictBlockedMessage('captureKeyPages', false), false);
  assert.ok(CORE.STRICT_RUN.allowedMessages.includes('exportRunLog'));
  assert.ok(CORE.STRICT_RUN.allowedMessages.includes('logUserAction'));
  assert.ok(CORE.STRICT_RUN.blockedMessages.includes('captureKeyPages'));
  assert.ok(CORE.STRICT_RUN.disabledFeatures.includes('key-page-capture'));
});

test('诊断 · 两端设置页、后台与共享样式均已接线', () => {
  for (const h of ['edge-extension/popup.html', 'desktop-app/src/popup.html']) {
    const s = read(h);
    for (const id of ['diag-group', 'set-run-log', 'btn-export-runlog',
      'btn-capture-keypages', 'diag-status', 'cal-nav-msg']) {
      assert.ok(s.includes('id="' + id + '"'), h + ' 缺少 ' + id);
    }
    assert.match(s, /data-i18n="diag\.title"/);
    assert.match(s, /data-i18n="diag\.note"/);
    assert.match(s, /hsa-zip\.js/);
    assert.match(s, /hsa-hover-tip\.js/);
  }
  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    const s = read(p);
    for (const k of ["'diag.title'", "'diag.exportLog'", "'diag.capturePages'",
      "'diag.captureOk'", "'diag.empty'", "'calendar.navBlocked'"]) {
      assert.ok(s.includes(k), p + ' 缺少字典键 ' + k);
    }
    assert.match(s, /runLogEnabled: true/);
    assert.match(s, /saveSettings\(\{ runLogEnabled: e\.target\.checked \}\)/);
    assert.match(s, /function exportDiagFile/);
    assert.match(s, /function runDiagAction/);
    assert.match(s, /runDiagAction\('exportRunLog'/);
    assert.match(s, /runDiagAction\('captureKeyPages'/);
    assert.match(s, /strictRunGuard\('captureKeyPages'\)/);
    assert.match(s, /function logUserAction\(/);
    assert.match(s, /HSA_CORE\.calendarReset\(\)/);
    assert.match(s, /HSA_CORE\.calendarNavAllowed\(/);
    assert.match(s, /btn\.disabled = empty/);
  }
  for (const b of ['edge-extension/background.js', 'desktop-app/src/background.js']) {
    const s = read(b);
    assert.match(s, /function hsaRunLog\(/);
    assert.match(s, /async function hsaCaptureKeyPages\(/);
    assert.match(s, /msg\.type === 'exportRunLog'/);
    assert.match(s, /msg\.type === 'captureKeyPages'/);
    assert.match(s, /msg\.type === 'logUserAction'/);
    assert.match(s, /credentials: 'include', cache: 'no-store', signal: ctrl\.signal/);
    assert.match(s, /HSA_CORE\.runLogAppend/);
    assert.match(s, /HSA_CORE\.keyPageZipFiles/);
    assert.match(s, /hsaRunLog\('search'/);
    assert.match(s, /hsaRunLog\('error'/);
    assert.match(s, /runLogEnabled = v !== false/);
  }
  assert.match(read('desktop-app/preload.js'), /saveExport:/);
  assert.match(read('desktop-app/main.js'), /ipcMain\.handle\('chrome:diag:export'/);
  const css = read('shared/hsa-shared.css');
  assert.match(css, /\.diag-actions/);
  assert.match(css, /\.diag-note/);
  assert.match(css, /z-index: 2147483647 !important/);
});
