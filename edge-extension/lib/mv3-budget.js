/* ============================================================================
 * mv3-budget.js · 插件版专用内存/效率预算（仅 edge-extension，桌面版不使用）
 *
 * MV3 service worker 空闲即被回收，常驻大对象毫无意义且每次唤醒都要重建：
 *   · 官网 HTML 缓存从 4×600KB 收紧到 1×96KB、TTL 45s；
 *   · 运行日志从每来一条就 load+store 一次，改为有界队列批量合并写入；
 *   · 持久化日志上限 180 条、历史词上限 120 条，减少 storage JSON 体积；
 *   · 页面 outerHTML 快照上限 256KB，避免每次同步分配 600KB 字符串。
 *
 * 纯逻辑、零 chrome / DOM 依赖，可在 Node 单测里直接 require。
 * service worker 通过 importScripts('lib/mv3-budget.js') 加载。
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HSA_MV3_BUDGET = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var POLICY = Object.freeze({
    htmlCacheMaxEntries: 1,          // 原 4（v2.9 保留）
    /* v3.1 · 这是「单条缓存准入门槛」，绝不是官网响应体截断上限。
       v2.9 误把它压到 96KB 并直接 slice(res.text())，导致 /dashboard 与
       /earn 后半段内嵌数据丢失、同步降级打开可见 rewards 标签页。
       恢复到 applet 版的 600KB；配合条目 1 / TTL 45s，常驻内存最多
       600KB（applet 版 4×600KB ≈ 2.4MB，仍优化 4 倍）。 */
    htmlCacheMaxBytes: 600 * 1024,
    htmlCacheTtlMs: 45 * 1000,       // 原 120s
    capturedHtmlBytes: 256 * 1024,   // 原 600KB
    runLogEntries: 180,              // 原 600
    usedWordsMax: 120,               // 原 1000
    logFlushMs: 250,
    logBatchMax: 16
  });

  /** 官网响应体构造：html 原样保留，绝不截断（解析器需要完整页面）。 */
  function officialPageValue(res, html, now) {
    return {
      ok: !!res.ok, status: Number(res.status) || 0,
      url: res.url || '', html: html,
      collectedAt: Number.isFinite(now) ? now : Date.now(),
      source: 'official-network'
    };
  }

  /** 只有不超过单条上限的完整页面才允许进缓存；超限页面本次照常解析。 */
  function cacheableHtml(html) {
    return typeof html === 'string' && html.length > 800 &&
      html.length <= POLICY.htmlCacheMaxBytes;
  }

  /** 清掉过期/超量的 HTML 缓存条目，原地修改 Map。 */
  function trimCache(map, now) {
    if (!map || typeof map.delete !== 'function') return 0;
    var t = Number(now) || Date.now();
    var cut = 0;
    for (var pair of map) {
      var k = pair[0], v = pair[1];
      if (!v || t - Number(v.at || 0) > POLICY.htmlCacheTtlMs) {
        map.delete(k); cut++;
      }
    }
    while (typeof map.size === 'number' && map.size > POLICY.htmlCacheMaxEntries) {
      var oldest = map.keys().next().value;
      if (oldest == null) break;
      map.delete(oldest); cut++;
    }
    return cut;
  }

  /** 持久化前先把日志裁到本版本预算，避免 append 之后又涨回 600 条。 */
  function trimLog(list) {
    return Array.isArray(list) ? list.slice(-(POLICY.runLogEntries - 1)) : [];
  }

  function trimUsedWords(list) {
    return Array.isArray(list) ? list.slice(-POLICY.usedWordsMax) : [];
  }

  /**
   * 运行日志批量写入器：把 N 次 load+store 合并成一次。
   * io = { load(), store(value), append(list, entry, now), schedule(fn, ms), cancel(id) }
   * 返回 { add(entry), flush(), size(), pending() }。
   */
  function makeLogBatcher(io) {
    var queue = [], timer = null, writing = null;
    function schedule() {
      if (timer || !queue.length) return;
      timer = io.schedule(flush, POLICY.logFlushMs);
    }
    function flush() {
      if (timer != null) { io.cancel(timer); timer = null; }
      if (!queue.length) return Promise.resolve();
      var batch = queue.splice(0, queue.length);
      writing = Promise.resolve()
        .then(function () { return io.load(); })
        .then(function (s) {
          var list = trimLog(s && s.runLog);
          for (var i = 0; i < batch.length; i++) {
            list = io.append(list, batch[i], batch[i].at);
          }
          return io.store({ runLog: list });
        })
        .catch(function () {})
        .then(function () {
          writing = null;
          if (queue.length) schedule();
        });
      return writing;
    }
    function add(entry) {
      queue.push(entry);
      if (queue.length >= POLICY.logBatchMax) return flush();
      schedule();
      return Promise.resolve();
    }
    return Object.freeze({
      add: add,
      flush: flush,
      size: function () { return queue.length; },
      pending: function () { return timer != null || !!writing; }
    });
  }

  return Object.freeze({
    VERSION: '1.0.0',
    POLICY: POLICY,
    officialPageValue: officialPageValue,
    cacheableHtml: cacheableHtml,
    trimCache: trimCache,
    trimLog: trimLog,
    trimUsedWords: trimUsedWords,
    makeLogBatcher: makeLogBatcher
  });
});
