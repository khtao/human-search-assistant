/* v3.0 专项：打开主界面同步一次（运行期例外）+ 桌面静默内存治理
   node --test tests/v30-sync-quiet.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CORE = require('../shared/hsa-core.js');
const { MemoryGovernor } = require('../desktop-app/lib/memory-governor.js');

const EP = read('edge-extension/popup.js');
const DP = read('desktop-app/src/popup.js');
const EB = read('edge-extension/background.js');
const DB = read('desktop-app/src/background.js');
const DM = read('desktop-app/main.js');
const PRE = read('desktop-app/preload.js');
const GOV = read('desktop-app/lib/memory-governor.js');

test('v3.2 · 共享判定：运行中例外、30 分钟冷却、强制新数据、严格白名单兜底', () => {
  assert.equal(CORE.SYNC_ON_OPEN.messageType, 'syncOnOpen');
  assert.equal(CORE.SYNC_ON_OPEN.reason, 'ui-open');
  assert.equal(CORE.SYNC_ON_OPEN.minGapMs, 30 * 60 * 1000);
  assert.equal(CORE.SYNC_ON_OPEN.storageKey, 'syncOnOpenAt');
  assert.equal(CORE.syncOnOpenAllowed(false, null, 1000000), true);
  assert.equal(CORE.syncOnOpenAllowed(false, 0, 1000000), true);
  assert.equal(CORE.syncOnOpenAllowed(true, null, 1000000), false, '运行中一律例外');
  assert.equal(CORE.syncOnOpenAllowed(true, 1, 1000000), false);
  assert.equal(CORE.syncOnOpenAllowed(false, 400000, 1000000), false, '10 分钟内重复打开被拦');
  assert.equal(CORE.syncOnOpenAllowed(false, -800000, 1000000), true, '正好 30 分钟放行');
  assert.equal(CORE.syncOnOpenAllowed(false, -800001, 1000000), true, '超过 30 分钟放行');
  assert.equal(CORE.syncOnOpenAllowed(false, null, 1000000, 5000), true, '可注入最小间隔');
  assert.equal(CORE.SYNC_GATE.manualGapMs, 10 * 1000);
  assert.equal(CORE.SYNC_GATE.internalGapMs, 2 * 1000);
  assert.equal(CORE.syncCachePolicy('ui-open').fresh, true);
  assert.equal(CORE.strictBlockedMessage('syncOnOpen', true), true);
  assert.equal(CORE.strictBlockedMessage('syncOnOpen', false), false);
});

test('v3.0 · 两端 popup 同一套 requestSyncOnOpen，桌面额外监听窗口打开广播', () => {
  for (const [name, src] of [['插件', EP], ['桌面', DP]]) {
    assert.match(src, /async function requestSyncOnOpen\(\)/, name);
    assert.match(src, /chrome\.storage\.local\.get\(\['running', HSA_CORE\.SYNC_ON_OPEN\.storageKey\]\)/, name);
    assert.match(src, /HSA_CORE\.syncOnOpenAllowed\(running, lastAt, now\)/, name);
    assert.match(src, /send\(HSA_CORE\.SYNC_ON_OPEN\.messageType/, name);
    assert.match(src, /requestSyncOnOpen\(\);/, name);
    const fn = src.slice(src.indexOf('async function requestSyncOnOpen'),
      src.indexOf('async function requestSyncOnOpen') + 900);
    assert.doesNotMatch(fn, /setInterval|setTimeout/, name + ' 不得引入常驻轮询');
  }
  assert.match(DP, /chrome\.runtime\.onUiOpened\.addListener\(\(\) => requestSyncOnOpen\(\)\)/);
  assert.doesNotMatch(EP, /onUiOpened/);
  assert.match(PRE, /onUiOpened: makeEvent\('ui:opened'\)/);
  assert.match(DM, /broadcast\('ui:opened', \[\{ at: Date\.now\(\) \}\]\)/);
  assert.match(DM, /for \(const ev of \['show', 'restore'\]\)/);
});

test('v3.2 · 两端后台 syncOnOpen 分支：统一闸门 + syncNotice，严格期由白名单拦截', () => {
  for (const [name, src] of [['插件', EB], ['桌面', DB]]) {
    assert.match(src, /msg\.type === HSA_CORE\.SYNC_ON_OPEN\.messageType/, name);
    assert.match(src, /reason: HSA_CORE\.SYNC_ON_OPEN\.reason/, name);
    assert.match(src, /const syncGate = HSA_CORE\.createSyncGate\(\{/, name);
    assert.match(src, /syncGate\.request\(\{ reason: HSA_CORE\.SYNC_ON_OPEN\.reason \}\)/, name);
    assert.match(src, /strictRunActive && HSA_CORE\.strictBlockedMessage\(msg\.type, true\)/,
      name + ' 严格运行期拦截必须在新分支之前');
    const guard = src.indexOf('strictRunActive && HSA_CORE.strictBlockedMessage');
    const branch = src.indexOf('msg.type === HSA_CORE.SYNC_ON_OPEN.messageType');
    assert.ok(guard >= 0 && guard < branch, name + ' 拦截应先于同步分支');
  }
  assert.match(EB, /sync: opts => syncRewardsUnified\(opts\)/);
  assert.match(DB, /sync: opts => desktopSyncRewards\(opts\)/);
  const coreSrc = read('shared/hsa-core.js');
  assert.match(coreSrc, /syncNotice: notice/);
  assert.match(coreSrc, /createSyncGate: createSyncGate/);
});

test('v3.0 · 侧栏不再创建即预加载 Bing SPA，只在展开/恢复时加载', () => {
  assert.match(DM, /function loadSideViewDefault\(url\)/);
  assert.match(DM, /if \(!url\) loadSideViewDefault\(\)/);
  assert.match(DM, /sideView\.webContents\.loadURL\(DEFAULT_BROWSER_HOME\)/);
  const start = DM.indexOf('function ensureSideView(initialUrl)');
  const ensure = DM.slice(start, start + 700);
  assert.doesNotMatch(ensure, /loadURL\(DEFAULT_BROWSER_HOME\)/, '创建时不得预加载');
  assert.match(ensure, /if \(initialUrl\)/, '恢复时按原 URL 重建');
  assert.match(DM, /创建时不预加载/);
});

test('v3.0 · 静默期无条件释放侧栏并记现场，退出静默按需恢复', () => {
  assert.match(DM, /let sideViewRestore = null;/);
  assert.match(DM, /sideViewRestore = \{/);
  assert.match(DM, /visible: !!sideVisible/);
  assert.match(DM, /function restoreSideViewIfNeeded\(\)/);
  assert.match(DM, /if \(!r \|\| !r\.visible\) return 0;/);
  assert.match(DM, /ensureSideView\(r\.url \|\| DEFAULT_BROWSER_HOME\)/);
  assert.match(DM, /if \(sideViewRestore\) sideViewRestore\.visible = false;/);
  assert.doesNotMatch(DM, /侧栏只在面板收起时释放/);
  /* 释放函数仍带运行中护栏 */
  const rel = DM.slice(DM.indexOf('function releaseIdleViews()'),
    DM.indexOf('function releaseIdleViews()') + 1800);
  assert.match(rel, /if \(desktopQuietRun\(\) \|\| taskClickRunning\) return 0;/);
  assert.match(rel, /sideView = null; sideTabId = null;/);
});

test('v3.0 · 静默期大快照从内存移除、停止隐藏渲染、清 HTTP 缓存', () => {
  assert.match(DM, /delete s\.html;/);
  assert.match(DM, /s\.htmlQuietTrimmed = true;/);
  assert.match(DM, /trimSnapshotHtml\(s, SNAPSHOT_HTML_LIMIT\)/);
  assert.match(DM, /RUNTIME_BUDGET\.POLICY\.runLogEntries/);
  assert.match(DM, /if \(on\) \{ try \{ if \(typeof wc\.stop === 'function'\) wc\.stop\(\); \} catch \{\} \}/);
  assert.match(DM, /s\.clearCache\(\)/);
  assert.match(DM, /onEnter: \(\) => \{/);
  assert.match(DM, /onExit: reason => \{/);
  assert.match(DM, /if \(reason === 'dispose' \|\| quitting\) return;/);
  assert.match(GOV, /sweepIntervalMs: 2 \* 60 \* 1000/);
  assert.match(GOV, /this\._call\('onEnter', reason\)/);
  assert.match(GOV, /this\._call\('onExit', reason\)/);
  assert.match(GOV, /const released = Number\(this\._call\('releaseIdleViews'\)\) \|\| 0;/);
});

test('v3.0 · 状态机动态：进入静默触发 onEnter，退出触发 onExit，dispose 不重建', async () => {
  const calls = { busy: false, hidden: false, released: 0, trimmed: 0,
    throttling: [], enter: 0, exit: [], logs: [] };
  const g = new MemoryGovernor({
    config: { idleDelayMs: 10, sweepIntervalMs: 60 },
    hooks: {
      isBusy: () => calls.busy,
      isWindowHidden: () => calls.hidden,
      releaseIdleViews: () => { calls.released++; return 5; },
      setThrottling: v => calls.throttling.push(!!v),
      trimState: () => { calls.trimmed++; return 0; },
      gc: () => {},
      onEnter: () => { calls.enter++; },
      onExit: reason => calls.exit.push(reason),
      onLog: () => {}
    }
  });
  calls.hidden = true;
  g.schedule('window:hide');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(g.quiet, true);
  assert.equal(calls.enter, 1, '进入静默应触发一次 onEnter（清缓存）');
  assert.equal(calls.released, 1, '进入静默释放全部内嵌视图');
  assert.equal(calls.throttling[0], true);

  calls.busy = true;
  g.schedule('running:true');
  assert.equal(g.quiet, false);
  assert.ok(calls.exit.includes('running:true'), '退出静默应触发 onExit 恢复侧栏');
  assert.ok(calls.throttling.includes(false));

  /* 静默期巡检会再次回收视图 */
  calls.busy = false; calls.hidden = true;
  g.schedule('window:hide');
  await new Promise(r => setTimeout(r, 40));
  const before = calls.released;
  await new Promise(r => setTimeout(r, 90));
  assert.ok(calls.released > before, '2 分钟巡检（测试 60ms）会重复回收静默期新建视图');

  g.dispose();
  assert.ok(calls.exit.includes('dispose'), 'dispose 也应调 onExit（宿主据 reason 跳过重建）');
  assert.equal(g._sweepTimer, null);
  assert.equal(g._idleTimer, null);
});
