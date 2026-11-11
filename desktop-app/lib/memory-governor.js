#!/usr/bin/env node
/* ============================================================================
 * 托盘静默 / 内存治理状态机
 *
 * 目标：应用长期驻留托盘时，把常驻渲染进程数量与 V8 堆压到最低；用户回到
 * 界面或任务开始运行时立即恢复保活，不改动任何业务流程。
 *
 * 设计原则：
 *   · 纯逻辑、零 Electron 依赖，便于离线验证（scripts/verify-memory.js）。
 *   · 状态完全由宿主通过 hooks 注入判断，本模块不读窗口、不读 storage。
 *   · 事件驱动；唯一定时器是「延迟进入静默」与「静默期低频巡检」，都 unref。
 *   · 进入静默前必须确认 isBusy() 为假，任务运行中绝不释放视图。
 *   · 幂等：重复 schedule / enter / exit 都不会重复释放或重建。
 * ========================================================================== */
'use strict';

const SNAPSHOT_HTML_LIMIT = 600 * 1024;  // state 中整页 HTML 快照的硬上限
const DEFAULTS = {
  idleDelayMs: 4000,        // 窗口隐藏后多久才进入静默，避免短暂切窗
  /* v3.0：静默期巡检从 10 分钟缩到 2 分钟。定时器 unref 且只做纯判断，
     开销可忽略，但能及时回收静默期间被定时任务重新拉起的内嵌视图。 */
  sweepIntervalMs: 2 * 60 * 1000,
  maxHtmlChars: SNAPSHOT_HTML_LIMIT
};

class MemoryGovernor {
  /**
   * @param {object} opts
   * @param {object} opts.hooks 宿主注入的能力
   *   isBusy()            -> boolean  是否有任务正在运行（同步/点击/搜索）
   *   isWindowHidden()    -> boolean  主窗口是否已隐藏到托盘
   *   releaseIdleViews()  -> number   销毁空闲视图（数据视图/任务视图/侧栏），返回销毁数
   *   setThrottling(bool) -> void     true=允许 Chromium 对隐藏渲染进程节流/冻结
   *   trimState()         -> number   裁剪 storage 中的大 HTML 快照，返回裁剪字节数
   *   gc()                -> void     可选：触发一次 V8 GC（宿主无能力时为空函数）
   *   onLog(scope,msg,data) -> void  可选日志
   */
  constructor(opts) {
    const o = opts || {};
    this.hooks = o.hooks || {};
    this.cfg = Object.assign({}, DEFAULTS, o.config || {});
    this.quiet = false;
    this._idleTimer = null;
    this._sweepTimer = null;
    this.disposed = false;
    this.stats = {
      entered: 0, exited: 0, releasedViews: 0,
      trimmedChars: 0, gcCalls: 0, lastEnterAt: 0, lastReason: ''
    };
    this._call = (name, ...args) => {
      const fn = this.hooks[name];
      if (typeof fn !== 'function') return name === 'isBusy' || name === 'isWindowHidden' ? false : 0;
      try { return fn(...args); } catch (err) {
        this._log('governor', 'hook 执行失败: ' + name, { error: String(err && err.message || err) });
        return name === 'isBusy' || name === 'isWindowHidden' ? false : 0;
      }
    };
  }

  _log(scope, msg, data) {
    const fn = this.hooks.onLog;
    if (typeof fn === 'function') { try { fn(scope, msg, data); } catch {} }
  }

  /** 宿主在窗口显隐、任务起止、storage 变更等时机调用。 */
  schedule(reason) {
    if (this.disposed) return this.quiet;
    const wantQuiet = !this._call('isBusy') && this._call('isWindowHidden');
    if (wantQuiet === this.quiet) {
      /* 已在静默态但条件仍成立：只做一次低频巡检续期，不重复释放 */
      return this.quiet;
    }
    if (wantQuiet) {
      if (this._idleTimer) return this.quiet;  // 已排队，避免重复排队
      const delay = Math.max(0, Number(this.cfg.idleDelayMs) || 0);
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        /* 延迟到期再复核一次，期间用户可能已回到界面或任务已启动 */
        if (!this.disposed && !this._call('isBusy') && this._call('isWindowHidden')) {
          this._enter(reason || 'idle');
        }
      }, delay);
      if (this._idleTimer.unref) this._idleTimer.unref();
    } else {
      if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
      this._exit(reason || 'active');
    }
    return this.quiet;
  }

  _enter(reason) {
    if (this.quiet || this.disposed) return;
    this.quiet = true;
    this.stats.entered++;
    this.stats.lastEnterAt = Date.now();
    this.stats.lastReason = String(reason || '');
    this._call('setThrottling', true);
    const released = Number(this._call('releaseIdleViews')) || 0;
    const trimmed = Number(this._call('trimState')) || 0;
    this._call('gc');
    this.stats.releasedViews += released;
    this.stats.trimmedChars += trimmed;
    this.stats.gcCalls++;
    /* v3.0：进入静默时额外清一次 Chromium HTTP 缓存（不碰 Cookie） */
    this._call('onEnter', reason);
    this._startSweep();
    this._log('governor', '进入托盘静默低占用状态', {
      reason: reason, releasedViews: released, trimmedChars: trimmed
    });
  }

  _exit(reason) {
    if (!this.quiet) return;
    this.quiet = false;
    this.stats.exited++;
    this._stopSweep();
    /* 恢复保活：任务页面不能被 Chromium 降频 */
    this._call('setThrottling', false);
    /* v3.0：按需重建静默期释放的可见侧栏（dispose 不重建） */
    this._call('onExit', reason);
    this._log('governor', '退出托盘静默，恢复页面保活', { reason: reason });
  }

  _startSweep() {
    this._stopSweep();
    const interval = Math.max(100, Number(this.cfg.sweepIntervalMs) || DEFAULTS.sweepIntervalMs);
    /* v3.0 · 静默期低频巡检：裁剪可能重新写入的大快照 + GC，并再次回收
       静默期间被定时任务重新创建的离屏视图。releaseIdleViews 自身带
       isBusy / taskClickRunning 护栏，运行中不会误销毁。 */
    this._sweepTimer = setInterval(() => {
      if (this.disposed || !this.quiet) { this._stopSweep(); return; }
      if (this._call('isBusy')) { this._exit('busy-during-sweep'); return; }
      const released = Number(this._call('releaseIdleViews')) || 0;
      this.stats.releasedViews += released;
      this._call('trimState');
      this._call('gc');
      this.stats.gcCalls++;
    }, interval);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  _stopSweep() {
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
  }

  snapshot() {
    return Object.assign({}, this.stats, { quiet: this.quiet, disposed: this.disposed });
  }

  dispose() {
    this._exit('dispose');
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    this._stopSweep();
    this.disposed = true;
  }
}

/** 把 storage 快照里的整页 HTML 裁到上限，返回被裁掉的字符数。 */
function trimSnapshotHtml(snap, maxChars) {
  const limit = Math.max(0, Number(maxChars) || DEFAULTS.maxHtmlChars);
  let cut = 0;
  if (!snap || typeof snap !== 'object') return cut;
  if (typeof snap.html === 'string' && snap.html.length > limit) {
    cut += snap.html.length - limit;
    snap.html = snap.html.slice(0, limit);
    snap.htmlTruncated = true;
  }
  if (typeof snap.text === 'string' && snap.text.length > 64 * 1024) {
    cut += snap.text.length - 64 * 1024;
    snap.text = snap.text.slice(0, 64 * 1024);
  }
  return cut;
}

module.exports = { MemoryGovernor, trimSnapshotHtml, SNAPSHOT_HTML_LIMIT, DEFAULTS };
