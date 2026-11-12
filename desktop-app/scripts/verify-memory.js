#!/usr/bin/env node
/* ============================================================================
 * 内存治理专项验证
 *
 * 静态：main.js 的托盘静默接线、视图释放、请求中止、快照上限、打包清单，
 *       以及主进程不存在无界定时器/缓冲。
 * 动态：用 mock hooks 驱动 MemoryGovernor 状态机，验证「隐藏才静默、
 *       任务运行绝不释放、幂等、退出即恢复、dispose 清定时器」。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { MemoryGovernor, trimSnapshotHtml, SNAPSHOT_HTML_LIMIT } =
  require(path.join(ROOT, 'lib', 'memory-governor'));

let pass = 0;
function ck(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }
function section(t) { console.log('\n' + t); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MAIN = read('main.js');
const GOV = read('lib/memory-governor.js');
const DBG = read('lib/debug-capture.js');
const YML_LINUX = read('electron-builder.yml');
const YML_WIN = read('electron-builder.win.yml');
const PKG = JSON.parse(read('package.json'));

function harness(overrides) {
  const calls = { busy: false, hidden: false, released: 0, throttling: [],
    trimmed: 0, gc: 0, logs: [] };
  const g = new MemoryGovernor(Object.assign({
    config: { idleDelayMs: 15, sweepIntervalMs: 120 },
    hooks: {
      isBusy: () => calls.busy,
      isWindowHidden: () => calls.hidden,
      releaseIdleViews: () => { calls.released++; return 5; },
      setThrottling: v => calls.throttling.push(!!v),
      trimState: () => { calls.trimmed++; return 1024; },
      gc: () => { calls.gc++; },
      onLog: (s, m, d) => calls.logs.push({ s, m, d })
    }
  }, overrides || {}));
  return { g, calls };
}

async function main() {
  console.log('\n拟人搜索助手 · 内存治理专项验证\n');

  section('1. 托盘静默接线（静态）');
  ck(MAIN.includes("require('./lib/memory-governor')"), '主进程引入内存治理模块');
  ck(MAIN.includes('const memoryGovernor = new MemoryGovernor('), '实例化治理状态机');
  ck(MAIN.includes('function releaseIdleViews()') && MAIN.includes('function destroyEmbeddedView('),
    '提供空闲视图销毁能力');
  ck(MAIN.includes('for (const [key, d] of [...dataViews])') &&
     MAIN.includes('taskView = null; taskTabId = null;') &&
     MAIN.includes('taskResultView = null;') && MAIN.includes('sideView = null; sideTabId = null;'),
    '静默时释放 2 个取数视图 + 任务视图 + 结果视图 + 侧栏视图，共 5 个 renderer');
  ck(MAIN.includes('attachedViews.delete(view)'), '销毁视图时同步清理 attachedViews（修复累积泄漏）');
  ck(MAIN.includes('tabs.delete(tabId)') && MAIN.includes('loginTabIds.delete(tabId)'),
    '销毁视图时清理 tabs / loginTabIds 登记');
  ck(MAIN.includes('cancelViewSnapshot(wc)') && MAIN.includes('const snapshotTimers = new WeakMap()'),
    '可取消的延时快照定时器，不再按导航次数堆积闭包');
  ck(MAIN.includes('function setAllThrottling(allow)') && MAIN.includes('setBackgroundThrottling(on)'),
    '静默时允许 Chromium 对隐藏 renderer 节流');
  ck(MAIN.includes('function trimStateSnapshots()') && MAIN.includes('trimSnapshotHtml(s, SNAPSHOT_HTML_LIMIT)'),
    '静默时裁剪 storage 中的大 HTML 快照');
  ck(MAIN.includes('function gcIfPossible()'), '静默时尽力触发一次 V8 GC');
  ck(MAIN.includes("appendSwitch('js-flags', '--max-old-space-size=384 --expose-gc')"),
    'V8 堆设置上限，长期运行更积极回收');
  ck(MAIN.includes('isBusy: () => !!(state && (state.running === true || desktopQuietRun() || taskClickRunning))'),
    '任务运行期间 isBusy 恒为真');
  ck(MAIN.includes('isWindowHidden: () => !!(popupWin && !popupWin.isDestroyed() && !popupWin.isVisible())'),
    '只有主窗口真的隐藏到托盘才判定静默');
  ck(MAIN.includes("for (const ev of ['hide', 'minimize'])") &&
     MAIN.includes("for (const ev of ['show', 'restore'])"),
    '窗口 hide / minimize / show / restore 全部驱动状态机');
  ck(MAIN.includes("governMemory('running:' + patch.running)"), '任务起止通过 running 变化即时驱动');
  ck(MAIN.includes("governMemory('app:activate')"), '从托盘恢复时驱动状态机');
  ck(MAIN.includes('memoryGovernor.dispose()'), '退出时释放全部治理定时器');
  ck(MAIN.includes("ipcMain.handle('chrome:memory:stats'"), '暴露治理状态供诊断');

  section('2. 长期运行泄漏修复（静态）');
  ck(MAIN.includes('typeof AbortController === \'function\' ? new AbortController()') &&
     MAIN.includes('if (controller) opts.signal = controller.signal'),
    'fetch 请求携带 AbortSignal');
  ck(MAIN.includes('if (ctl.aborted) { try { controller && controller.abort(); } catch {} }') &&
     MAIN.includes('fetchControllers.delete(id)'),
    '超时 / 取消时真正中止底层请求并注销控制器，不再悬挂响应体');
  ck(MAIN.includes('fetchControllers.clear()'), '退出时清空所有请求控制器');
  ck(MAIN.includes("html: String(r.html || '').slice(0, SNAPSHOT_HTML_LIMIT)"),
    '写入 storage 的整页 HTML 有硬上限');
  ck(/SNAPSHOT_HTML_LIMIT\s*=\s*600 \* 1024/.test(GOV), '上限常量为 600KB');
  ck(DBG.includes('pushBounded(this._pendingLogs,') && DBG.includes('this.entries.length = 0'),
    '调试缓冲全部有界，关闭时释放');
  ck(!/setInterval\s*\(\s*\(\)\s*=>\s*\{\s*[^}]*refreshTodayTasks/.test(MAIN),
    '主进程没有常驻轮询刷新定时器');
  ck(GOV.includes('unref()'), '治理定时器均 unref，不阻止进程退出');

  section('3. 打包清单（防止再次出现 Cannot find module）');
  for (const [name, yml] of [['electron-builder.yml', YML_LINUX], ['electron-builder.win.yml', YML_WIN]]) {
    ck(yml.includes('- lib/memory-governor.js'), name + ' 已包含内存治理模块');
    ck(yml.includes('- lib/sidebar-task-cards.js'), name + ' 仍包含侧栏识别模块');
  }
  ck(/verify-memory\.js/.test(PKG.scripts.verify || '') &&
     /verify-memory\.js/.test(PKG.scripts['verify:desktop'] || ''),
    '默认回归链包含内存治理专项');

  section('4. 快照裁剪纯函数');
  const snap = { html: 'x'.repeat(700 * 1024), text: 't'.repeat(80 * 1024), points: { today: 12 } };
  const cut = trimSnapshotHtml(snap, SNAPSHOT_HTML_LIMIT);
  ck(cut > 0 && snap.html.length === SNAPSHOT_HTML_LIMIT && snap.htmlTruncated === true,
    '超大 HTML 被裁到 600KB 并打上截断标记');
  ck(snap.text.length === 64 * 1024 && snap.points.today === 12,
    'text 裁到 64KB，业务字段保持不变');
  ck(trimSnapshotHtml({ html: 'small' }, SNAPSHOT_HTML_LIMIT) === 0,
    '未超限快照不改动、不产生写盘');

  section('5. 状态机动态行为');
  {
    const { g, calls } = harness();
    ck(!g.quiet, '初始为活跃态');
    calls.hidden = true;
    g.schedule('hide');
    ck(!g.quiet, '窗口刚隐藏不会立即释放（有延迟，避免短暂切窗）');
    await sleep(60);
    ck(g.quiet, '隐藏超过延迟后进入托盘静默');
    ck(calls.released === 1 && calls.trimmed === 1 && calls.gc === 1,
      '进入时各执行一次：释放视图 / 裁剪 / GC');
    ck(calls.throttling[0] === true, '进入时允许后台节流');
    /* 低频巡检会周期性再次回收视图；此处先停巡检，
       隔离出「schedule 本身不重复释放」的幂等语义，避免 60+60ms 撞上 120ms 周期。 */
    g._stopSweep();
    g.schedule('hide'); g.schedule('storage'); await sleep(60);
    ck(calls.released === 1, '重复 schedule 幂等，不重复释放视图');
    g._startSweep();

    calls.busy = true;
    g.schedule('running:true');
    ck(!g.quiet, '任务启动立即退出静默（无延迟）');
    ck(calls.throttling.includes(false), '退出时恢复页面保活');
    await sleep(60);
    ck(!g.quiet && calls.released === 1, '任务运行中即使窗口隐藏也不进入静默');

    calls.busy = false; calls.hidden = false;
    g.schedule('show');
    await sleep(60);
    ck(!g.quiet, '窗口显示后保持活跃');

    calls.hidden = true;
    g.schedule('hide');
    await sleep(60);
    ck(g.quiet && g.stats.entered === 2, '再次隐藏可重新进入静默');
    const before = calls.gc;
    await sleep(180);
    ck(calls.gc > before, '静默期低频巡检会再次触发 GC');
    g.dispose();
    ck(g.disposed && !g.quiet && g._sweepTimer === null && g._idleTimer === null,
      'dispose 释放全部定时器并回到活跃态');
  }
  {
    /* hook 抛异常时状态机不能崩，也不能误判为 busy */
    const g = new MemoryGovernor({ config: { idleDelayMs: 5 },
      hooks: { isBusy: () => { throw new Error('boom'); },
               isWindowHidden: () => true,
               releaseIdleViews: () => { throw new Error('boom'); },
               setThrottling: () => {}, trimState: () => 0, gc: () => {} } });
    g.schedule('x');
    await sleep(20);
    ck(g.quiet && g.stats.entered === 1, '单个 hook 异常被隔离，状态机继续工作');
    g.dispose();
  }

  console.log('\n共 ' + pass + ' 项，通过 ' + pass + ' 项，失败 0 项');
}

main().catch(err => {
  console.error('\n验证失败：' + (err && err.stack || err));
  process.exit(1);
});
