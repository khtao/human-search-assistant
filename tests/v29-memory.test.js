/* v2.9 专项：全部伪装移除 + 插件/桌面分别的内存与效率优化
   node --test tests/v29-memory.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MV3 = require('../edge-extension/lib/mv3-budget.js');
const RT = require('../desktop-app/lib/runtime-budget.js');

const EB = read('edge-extension/background.js');
const DB = read('desktop-app/src/background.js');
const DM = read('desktop-app/main.js');
const PRE = read('desktop-app/preload.js');
const HOST = read('desktop-app/host.html');
const EH = read('desktop-app/src/popup.html');
const EP = read('desktop-app/src/popup.js');

test('v2.9 · 两端运行时已无任何浏览器伪装', () => {
  const files = { 'edge-extension/background.js': EB,
    'desktop-app/src/background.js': DB, 'desktop-app/main.js': DM,
    'desktop-app/preload.js': PRE, 'desktop-app/host.html': HOST };
  for (const [name, src] of Object.entries(files)) {
    for (const pat of [/userAgentFallback/, /setUserAgent/, /navigatorScript/,
      /EDGE_IDENTITY/, /edge-identity/, /SOURCE_UA/, /HSA_APPLY_EDGE_IDENTITY/,
      /chrome:edge:profile/, /getEdgeProfile/, /applyFetchHeaders/]) {
      assert.doesNotMatch(src, pat, name + ' 仍有 ' + pat);
    }
  }
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    assert.doesNotMatch(src, /'User-Agent':/, name + ' 仍伪造 UA 请求头');
    assert.match(src, /Referer: 'https:\/\/weibo\.com\/'/, name + ' 应保留站点必需 Referer');
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'desktop-app/lib/edge-identity.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'tests/edge-identity.test.js')), false);
  for (const p of ['desktop-app/electron-builder.yml', 'desktop-app/electron-builder.win.yml']) {
    assert.doesNotMatch(read(p), /edge-identity\.js/);
    assert.match(read(p), /lib\/runtime-budget\.js/);
  }
  /* 默认 Bing 是起始页设置，不是伪装 */
  assert.match(DM, /const DEFAULT_BROWSER_HOME = 'https:\/\/www\.bing\.com\/\?mkt=zh-CN'/);
  assert.match(EH, /不做任何身份伪装/);
  assert.match(EP, /'desktop\.edgeValue': '默认主页 · Bing'/);
  assert.match(EP, /'desktop\.edgeValue': 'Home · Bing'/);
});

test('v2.9 · 插件版预算：缓存收紧、日志/历史词裁剪（纯函数）', () => {
  assert.equal(MV3.POLICY.htmlCacheMaxEntries, 1);
  /* v3.1：96KB 误把官网响应体截断导致同步弹官网，恢复为 600KB，
     但只作为「单条缓存准入门槛」，响应体本身永不截断。 */
  assert.equal(MV3.POLICY.htmlCacheMaxBytes, 600 * 1024);
  assert.equal(MV3.POLICY.htmlCacheTtlMs, 45000);
  assert.equal(MV3.POLICY.capturedHtmlBytes, 256 * 1024);
  assert.equal(MV3.POLICY.runLogEntries, 180);
  assert.equal(MV3.POLICY.usedWordsMax, 120);
  /* 与桌面版取值不同，确属分别优化 */
  assert.notEqual(MV3.POLICY.runLogEntries, RT.POLICY.runLogEntries);
  assert.notEqual(MV3.POLICY.usedWordsMax, RT.POLICY.usedWordsMax);

  const now = Date.now();
  const map = new Map([
    ['stale', { at: now - 60000 }], ['fresh1', { at: now }], ['fresh2', { at: now }]
  ]);
  assert.ok(MV3.trimCache(map, now) >= 2);
  assert.equal(map.size, 1);
  assert.ok(map.has('fresh1') || map.has('fresh2'));
  assert.equal(MV3.trimLog(Array.from({ length: 400 }, () => ({}))).length, 179);
  assert.equal(MV3.trimUsedWords(Array.from({ length: 500 }, () => 'w')).length, 120);
  assert.equal(MV3.trimLog(null).length, 0);
});

test('v2.9 · 插件版日志批量器：16 条或 250ms 合并成 1 次写入', async () => {
  const stores = [];
  let scheduled = null, cancelled = 0;
  const io = {
    load: () => Promise.resolve({ runLog: [{ old: true }] }),
    store: v => { stores.push(v); return Promise.resolve(); },
    append: (list, e) => list.concat([e]),
    schedule: fn => { scheduled = fn; return 42; },
    cancel: () => { cancelled++; scheduled = null; }
  };
  const b = MV3.makeLogBatcher(io);
  for (let i = 0; i < 5; i++) b.add({ at: i, event: 'e' + i });
  assert.equal(b.size(), 5);
  assert.ok(scheduled, '应排队尾随写');
  await b.flush();
  assert.equal(stores.length, 1, '5 条日志只写 1 次 storage');
  assert.equal(stores[0].runLog.length, 6, '含预处理后保留的旧日志裁剪结果');
  assert.equal(cancelled, 1);
  assert.equal(b.size(), 0);
  assert.equal(b.pending(), false);

  /* 达到批量阈值立即冲刷，不再排队 */
  const io2 = Object.assign({}, io, { store: v => { stores.push(v); return Promise.resolve(); } });
  const b2 = MV3.makeLogBatcher(io2);
  for (let i = 0; i < MV3.POLICY.logBatchMax; i++) b2.add({ at: i, event: 'x' });
  await Promise.resolve();
  assert.equal(b2.size(), 0, '达到阈值应立刻冲刷队列');

  /* 插件后台接线 */
  assert.match(EB, /importScripts\('lib\/mv3-budget\.js'\)/);
  assert.match(EB, /const runLogBatcher = MV3\.makeLogBatcher/);
  assert.match(EB, /await flushRunLog\(\)/);
  assert.match(EB, /MV3\.cacheableHtml\(html\)/);
  assert.match(EB, /MV3\.officialPageValue\(res, html, Date\.now\(\)\)/);
  assert.match(EB, /MV3\.POLICY\.capturedHtmlBytes/);
  assert.match(EB, /MV3\.trimUsedWords/);
  assert.doesNotMatch(DB, /makeLogBatcher|runLogBatcher/);
});

test('v2.9 · 桌面版写盘节流：前导立即写、高频合并、退出强刷', () => {
  let clock = 1000, writes = 0, trailing = null;
  const t = RT.makeWriteThrottle({
    now: () => clock,
    write: () => { writes++; },
    schedule: fn => { trailing = fn; return 9; },
    cancel: () => { trailing = null; }
  });
  t.save();
  assert.equal(writes, 1, '首次立即写（启动校验读文件依赖）');
  t.save(); t.save(); t.save();
  assert.equal(writes, 1, '高频连续写被合并');
  assert.ok(trailing, '应有尾随写排队');
  trailing();
  assert.equal(writes, 2);
  clock = 5000;
  t.save();
  assert.equal(writes, 3, '超过合并窗口后再次立即写');
  t.flush();
  assert.equal(writes, 4);
  assert.equal(t.stats().pending, false);
});

test('v2.9 · 桌面版落盘副本裁剪，内存态保持完整', () => {
  const state = {
    pointsSummary: { points: 100 },
    visibleRewardsSnapshot: { html: 'a'.repeat(700000), text: 'b'.repeat(90000), url: 'x' },
    visibleRewardsEarnSnapshot: { html: 'c'.repeat(300000), text: 'ok' },
    runLog: Array.from({ length: 700 }, (_, i) => ({ i }))
  };
  const disk = RT.diskState(state);
  assert.equal(disk.pointsSummary.points, 100);
  assert.equal(disk.visibleRewardsSnapshot.html.length, RT.POLICY.diskSnapshotHtmlBytes);
  assert.equal(disk.visibleRewardsSnapshot.htmlTruncated, true);
  assert.equal(disk.visibleRewardsSnapshot.text.length, RT.POLICY.diskSnapshotTextBytes);
  assert.equal(disk.visibleRewardsSnapshot.url, 'x');
  assert.equal(disk.visibleRewardsEarnSnapshot.html.length, 256 * 1024);
  assert.equal(disk.visibleRewardsEarnSnapshot.text, 'ok');
  assert.equal(disk.runLog.length, 240);
  assert.equal(state.visibleRewardsSnapshot.html.length, 700000, '内存态不得被裁');
  assert.equal(state.runLog.length, 700);
  assert.equal(RT.trimUsedWords(Array.from({ length: 400 }, () => 'x')).length, 160);
  assert.equal(RT.trimLog(Array.from({ length: 500 }, () => ({}))).length, 239);
});

test('v2.9 · 桌面版空闲视图回收判定与后台脚本分别收紧', () => {
  assert.equal(RT.shouldReleaseIdleView(0, 91000, false), true);
  assert.equal(RT.shouldReleaseIdleView(0, 89999, false), false);
  assert.equal(RT.shouldReleaseIdleView(0, 999999, true), false, '运行中绝不释放');
  assert.equal(RT.shouldReleaseIdleView(null, 999999, false), false);
  assert.match(DB, /const DESKTOP_MEM = Object\.freeze/);
  assert.match(DB, /runLogEntries: 240/);
  assert.match(DB, /usedWordsMax: 160/);
  assert.match(DB, /htmlCacheMaxBytes: 600 \* 1024/);
  assert.match(DB, /HSA_CORE\.runLogAppend\(desktopTrimLog\(/);
  assert.doesNotMatch(EB, /DESKTOP_MEM|makeWriteThrottle|diskState/);
});

test('v2.9 · 主进程接线：节流 / 调试期零整页 HTML / 空闲巡检 / 退出强刷', () => {
  assert.match(DM, /const RUNTIME_BUDGET = require\('\.\/lib\/runtime-budget\.js'\)/);
  assert.match(DM, /const stateWrites = RUNTIME_BUDGET\.makeWriteThrottle/);
  assert.match(DM, /RUNTIME_BUDGET\.diskState\(state\)/);
  assert.match(DM, /function flushStateSync\(\)/);
  assert.match(DM, /flushStateSync\(\);   \/\/ v2\.9/);
  assert.doesNotMatch(DM, /JSON\.stringify\(state, null, 2\)/);
  assert.match(DM, /if \(DBG\.enabled\) \{/);
  assert.match(DM, /if \(!DBG\.enabled\) return;   \/\/ v2\.9/);
  assert.match(DM, /function startDataViewSweep\(\)/);
  assert.match(DM, /function stopDataViewSweep\(\)/);
  assert.match(DM, /RUNTIME_BUDGET\.shouldReleaseIdleView\(d\.lastUsed, now, false\)/);
  assert.match(DM, /d\.lastUsed = now;/);
  assert.match(DM, /function newEmbeddedView\(prefs\)/);
  assert.equal((DM.match(/newEmbeddedView\(embeddedViewPrefs\(\)\)/g) || []).length, 4);
  assert.equal((DM.match(/new ViewClass\(/g) || []).length, 1);
  assert.doesNotMatch(DM, /newEdgeView|edgeViews|applyEdgeProfile/);
});

test('v2.9 · 默认 Bing 与官网链路不变，共享清单仍 7 个文件', () => {
  assert.match(DM, /win\.loadURL\(url && url !== 'about:blank' \? url : DEFAULT_BROWSER_HOME\)/);
  assert.match(DM, /openInSidePanel\('https:\/\/rewards\.bing\.com\/dashboard', 'user'\)/);
  for (const p of ['edge-extension/background.js', 'desktop-app/src/background.js']) {
    const s = read(p);
    assert.match(s, /const DASHBOARD_URL = 'https:\/\/rewards\.bing\.com\/dashboard'/);
    assert.match(s, /const EARN_URL = 'https:\/\/rewards\.bing\.com\/earn'/);
  }
  const sync = read('scripts/sync-shared.js');
  assert.doesNotMatch(sync, /edge-profile|mv3-budget|runtime-budget/);
  assert.equal((sync.match(/const FILES = \[([\s\S]*?)\];/)[1]
    .match(/\.js'|\.css'|\.json'/g) || []).length, 7);
});
