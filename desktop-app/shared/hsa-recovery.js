/* AUTO-GENERATED from shared/ — do not edit; run node scripts/sync-shared.js */
/* ============================================================================
 * S02 · 共享「启动卡住自动纠正」（单一真源，UMD）
 *
 * 决策 D：启动超时检查一次 → 任务状态变化时复检 → 只有确定卡住才启动
 * 限时重试（最多 3 次）；不挂每秒心跳 / 不常驻轮询，用完即释放定时器。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.HSA_RECOVERY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CORE = (typeof globalThis !== 'undefined' && globalThis.HSA_CORE) ||
    (typeof require === 'function' ? (function () {
      try { return require('./hsa-core.js'); } catch (e) { return null; }
    })() : null);
  var CFG = (CORE && CORE.DEFAULTS) || {
    stuckTimeoutMs: 3500, stuckMaxRetries: 3, stuckRetryMs: 1000
  };

  function install(opts) {
    var o = opts || {};
    var g = typeof globalThis !== 'undefined' ? globalThis : {};
    var doc = o.document || g.document;
    var storage = o.storage ||
      (g.chrome && g.chrome.storage && g.chrome.storage.local) || null;
    var onChangeHost = o.onChangeHost || (g.chrome && g.chrome.storage) || null;
    if (!doc || !storage) return { dispose: function () {}, check: function () {} };

    var boot = Date.now();
    var bootTimer = null, retryTimer = null, throttleTimer = null;
    var retriesLeft = 0, disposed = false, lastCheck = 0;
    var listener = null;

    function el(id) { return doc.getElementById(id); }
    function zh() { return String(doc.documentElement.lang || '').indexOf('zh') === 0; }

    function isStuck(s) {
      var running = !!(s && s.running);
      if (running) return false;
      var b = el('btn-action');
      if (b && b.dataset && b.dataset.mode === 'stop') return true;
      var e = el('today-tasks-empty');
      if (e && /正在读取|Loading/.test(e.textContent || '') &&
          !(s && s.todayTasks && s.todayTasks.updatedAt)) return true;
      return false;
    }

    function fix(s) {
      var b = el('btn-action');
      if (b && b.dataset && b.dataset.mode === 'stop') {
        b.dataset.mode = 'start';
        b.disabled = false;
        b.classList.remove('is-stop');
        var l = el('btn-action-label');
        if (l) l.textContent = zh() ? '自动完成任务' : 'Auto-complete Tasks';
        var st = el('status');
        if (st) st.className = 'status stopped';
      }
      var e = el('today-tasks-empty');
      if (e && /正在读取|Loading/.test(e.textContent || '') &&
          !(s && s.todayTasks && s.todayTasks.updatedAt)) {
        e.textContent = zh()
          ? '暂时读不到任务数据，点「刷新」重试'
          : 'Could not load tasks. Tap Refresh to retry.';
      }
    }

    function limitedRetry(s) {
      if (disposed || retriesLeft <= 0) { retriesLeft = 0; return; }
      retriesLeft--;
      retryTimer = setTimeout(function () {
        retryTimer = null;
        check('limited-retry');
      }, CFG.stuckRetryMs);
      fix(s);
    }

    function check(trigger) {
      if (disposed) return;
      var now = Date.now();
      if (trigger === 'state-change' && now - lastCheck < 400) {
        if (!throttleTimer) {
          throttleTimer = setTimeout(function () {
            throttleTimer = null;
            check('state-change-throttled');
          }, 400);
        }
        return;
      }
      lastCheck = now;
      if (now - boot < CFG.stuckTimeoutMs && trigger === 'state-change') return;
      try {
        Promise.resolve(storage.get(['running', 'todayTasks'])).then(function (s) {
          if (disposed) return;
          if (!isStuck(s)) { retriesLeft = 0; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } return; }
          if (retriesLeft === 0) retriesLeft = CFG.stuckMaxRetries;
          limitedRetry(s);
        }).catch(function () {});
      } catch (err) {}
    }

    /* ① 启动超时检查一次 */
    bootTimer = setTimeout(function () {
      bootTimer = null;
      check('startup');
    }, CFG.stuckTimeoutMs);

    /* ② 任务状态变化时复检（事件驱动，不是轮询） */
    if (onChangeHost && onChangeHost.onChanged &&
        typeof onChangeHost.onChanged.addListener === 'function') {
      listener = function (changes) {
        if (!changes) return;
        if (changes.running || changes.todayTasks || changes.phase || changes.autoResult) {
          check('state-change');
        }
      };
      try { onChangeHost.onChanged.addListener(listener); } catch (err) { listener = null; }
    }

    return {
      check: check,
      dispose: function () {
        disposed = true;
        if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
        if (listener && onChangeHost && onChangeHost.onChanged &&
            typeof onChangeHost.onChanged.removeListener === 'function') {
          try { onChangeHost.onChanged.removeListener(listener); } catch (err) {}
        }
        listener = null;
      }
    };
  }

  return { VERSION: '2.0.0', install: install };
});
