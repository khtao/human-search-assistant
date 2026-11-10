/* ============================================================================
 * Human Search Assistant · 共享核心（单一真源）
 *
 * 这里只放「两端行为完全一致」的纯逻辑与配置，不引用任何宿主 API
 * （chrome.* / Electron / DOM 均不出现）。加载方式：
 *   · 浏览器扩展 Service Worker：importScripts('shared/hsa-core.js') → globalThis.HSA_CORE
 *   · 扩展 / 桌面 popup 页面：<script src=".../shared/hsa-core.js"> → window.HSA_CORE
 *   · 桌面主进程（CommonJS）：require('./shared/hsa-core.js')
 *
 * 决策依据：docs 的《插件版 / 桌面版差异选择题》已勾选答案（见 decisions.json）。
 * 本文件由 scripts/sync-shared.js 复制到两端运行时目录，禁止直接改副本。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.HSA_CORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 27 个差异项的最终选择（U01=C 是按决策保留的平台差异，不是遗漏）。 */
  var DECISIONS = {
    T01: 'D', T02: 'A', T03: 'B', T04: 'A', T05: 'D', T06: 'D', T07: 'D',
    T08: 'A', T09: 'D',
    D01: 'A', D02: 'D', D03: 'B', D04: 'B', D05: 'D', D06: 'D',
    S01: 'B', S02: 'D',
    U01: 'C', U02: 'A', U03: 'B', U04: 'A', U05: 'A', U06: 'B', U07: 'B',
    U08: 'D', U09: 'A', U10: 'B'
  };

  var DEFAULTS = {
    /* T07 · 默认 10 秒，等待页面稳定后才允许下一次动作；保留 1~60 秒设置范围 */
    cardClickIntervalSec: 10,
    cardClickIntervalSecMin: 1,
    cardClickIntervalSecMax: 60,
    pageStableWaitMs: 3000,
    /* T02 · 主动滚动分段，但有次数上限，防止懒加载容器无限滚动 */
    scanScrollSteps: 8,
    scanScrollSegmentPx: 420,
    scanRetryMs: 700,
    /* D06 · 短期页面缓存；强制刷新 / 开始 / 收尾一律不用缓存 */
    htmlCacheTtlMs: 120000,
    htmlCacheMaxEntries: 4,
    htmlCacheMaxBytes: 600 * 1024,
    /* T05 · 点击无反馈时只重定位一次，之后给手动链接并标未确认 */
    clickRelocateRetries: 1,
    /* S02 · 启动超时检查一次，只有确定卡住才启动限时重试 */
    stuckTimeoutMs: 3500,
    stuckMaxRetries: 3,
    stuckRetryMs: 1000
  };

  /* T06 · 三个独立状态，任何状态都不得冒充另一个。 */
  var RESULT_STATES = Object.freeze([
    'clickSent', 'pageOpened', 'officialConfirmed', 'unconfirmed', 'failed'
  ]);

  /* T03 · 侧栏不可用时的备用任务来源（两版一致）。 */
  var FALLBACK_PAGES = Object.freeze(['/dashboard', '/earn']);

  var TEXT = Object.freeze({
    allDone: '已完成，无需动作',
    allDoneEn: 'All tasks done — nothing to do',
    historyLabel: '上次记录',
    historyLabelEn: 'Last recorded',
    pageData: '页面数据',
    pageDataEn: 'Page data',
    officialData: '官网实时',
    officialDataEn: 'Official live data',
    manualLinks: '张任务卡未确认，可手动打开：',
    manualLinksEn: 'unconfirmed cards, open manually: ',
    triggerCdp: 'CDP 真鼠标',
    triggerDom: '页面真实交互',
    triggerFallback: 'CDP 不可用，降级页面交互'
  });

  /* U02/U03/... · 界面统一配置；U01 明确保留平台差异。 */
  var UI = Object.freeze({
    loginBadgeInteractive: 'platform-specific', // U01 = C
    brandIconPlate: false,                      // U02 = A
    languageOrder: ['zh', 'en', 'system'],       // U03 = B
    englishLabel: 'English',                    // U04 = A
    calendarAfterAutoGroup: true,               // U05 = A
    calendarDefaultOpen: true,                  // U06 = B
    calendarLegend: true,                       // U07 = B
    hoverTipWrap: true,                         // U08 = D
    autoDisabledHint: true,                     // U09 = A
    headerButtonsCustomTip: true                // U10 = B
  });

  var norm = function (v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
  };
  var normUrl = function (v) {
    return String(v == null ? '' : v).split('#')[0].trim().slice(0, 220).toLowerCase();
  };
  var num = function (v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  /* T04 · A：侧栏收集结果以「索引 → 标题 → 链接」中第一个可用值作去重键。
     两端所有任务卡身份判断都必须经过这里，避免各写一份不同的 keyOf。 */
  function taskCardKey(card) {
    var c = card || {};
    var idx = c.idx != null ? c.idx : c.index;
    if (idx != null && String(idx).trim() !== '') return 'idx:' + String(idx).trim().slice(0, 120);
    var title = norm(c.title || c.name || c.text || '');
    if (title) return 'title:' + title.slice(0, 160);
    var href = normUrl(c.href || c.url || c.targetUrl || '');
    if (href) return 'href:' + href;
    return '';
  }

  /* T06 · D：结果计数只认这五个字段。 */
  function newClickResult() {
    return {
      clickSent: 0, pageOpened: 0, officialConfirmed: 0,
      unconfirmed: 0, failed: 0, manualLinks: [], triggerMethods: []
    };
  }
  function recordClick(result, state, n) {
    if (!result || RESULT_STATES.indexOf(state) < 0) return result;
    result[state] += Number.isFinite(n) ? n : 1;
    return result;
  }

  /* T01 · D：宿主能力决定主触发方式；不可用才降级，并且必须记录实际方式。 */
  function triggerPlan(cdpAvailable) {
    return {
      primary: cdpAvailable ? 'cdp' : 'page-interaction',
      fallback: cdpAvailable ? 'page-interaction' : null,
      recordMethod: true,
      label: cdpAvailable ? TEXT.triggerCdp : TEXT.triggerDom
    };
  }
  function recordTrigger(result, method, reason) {
    if (!result) return result;
    result.triggerMethods = result.triggerMethods || [];
    if (result.triggerMethods.length < 64) {
      result.triggerMethods.push({ method: String(method || 'unknown'), reason: String(reason || '') });
    }
    return result;
  }

  /* T02 · A：主动滚动外层与内部滚动容器，分段收集，有上限。 */
  function scanPlan() {
    return {
      scrollEnabled: true,
      maxSteps: DEFAULTS.scanScrollSteps,
      segmentPx: DEFAULTS.scanScrollSegmentPx,
      retryMs: DEFAULTS.scanRetryMs,
      dedupeAfterCollect: true
    };
  }

  function fallbackPages() { return FALLBACK_PAGES.slice(); }

  /* T05 · D：不自动打开链接代替卡片点击，最多重定位一次，之后只给手动入口。 */
  function followupPolicy() {
    return {
      relocateRetries: DEFAULTS.clickRelocateRetries,
      autoOpenUrl: false,
      markUnconfirmed: true,
      showManualLink: true
    };
  }

  /* T07 · D：默认值与合法范围。 */
  function clampIntervalSec(v) {
    var n = Math.round(num(v));
    if (!n) n = DEFAULTS.cardClickIntervalSec;
    return Math.min(DEFAULTS.cardClickIntervalSecMax,
      Math.max(DEFAULTS.cardClickIntervalSecMin, n));
  }

  /* T08 · A：非估算、至少 3 项、存在且完成搜索项、总进度 100%、逐项完成。 */
  function isAllDone(summary, ctx) {
    var s = summary || {};
    if (s.signedOut || s.approx) return false;
    var items = Array.isArray(s.items) ? s.items : [];
    if (items.length < 3) return false;
    var searchItem = items.find(function (i) {
      return i && (i.section === 'search' || /搜索|search/i.test(String(i.name || i.title || '')));
    });
    if (!searchItem) return false;
    if (!(searchItem.completed || num(searchItem.earned) >= num(searchItem.points))) return false;
    if (num(s.percent) < 100) return false;
    if (!items.every(function (i) {
      return i && (i.completed || num(i.earned) >= num(i.points));
    })) return false;
    /* 估算数据、缺失配额、来源过期都不作自动跳过依据 */
    var c = ctx || {};
    if (c.estimated || c.quotaMissing || c.stale) return false;
    return true;
  }

  /* T09 · D：无需运行是成功的幂等结果，不能伪装成失败。 */
  function allDoneResult(extra) {
    return Object.assign({
      ok: true, skipped: true, reason: 'allDone',
      clicked: 0, searches: 0,
      message: TEXT.allDone, messageEn: TEXT.allDoneEn
    }, extra || {});
  }

  /* D01 · A：优先「最新官网原始网络数据」，解析不足才读同账号已渲染页面。 */
  function dataSourcePriority() {
    return Object.freeze(['official-network', 'fresh-page-snapshot', 'rendered-view']);
  }

  /* D02 · D：新鲜快照可以补缺，但官网本次已确认的卡片状态优先，旧快照不覆盖。 */
  function isFreshSnapshot(snap, now) {
    if (!snap || typeof snap !== 'object') return false;
    var at = Number(snap.at || snap.updatedAt || 0);
    if (!Number.isFinite(at) || at <= 0) return false;
    var t = Number.isFinite(now) ? now : Date.now();
    if (t - at > DEFAULTS.htmlCacheTtlMs || at - t > 60000) return false;
    var url = String(snap.url || '');
    if (url && !/rewards\.bing\.com/i.test(url)) return false;
    if (snap.signedOut === true) return false;
    return true;
  }
  function mergeSnapshotCards(officialCards, snapshotCards, opts) {
    var official = Array.isArray(officialCards) ? officialCards.slice() : [];
    var o = opts || {};
    var added = [];
    if (!isFreshSnapshot({ at: o.snapshotAt, url: o.snapshotUrl, signedOut: o.snapshotSignedOut },
      o.now)) {
      return { cards: official, added: 0, snapshotApplied: false };
    }
    var seen = new Set();
    for (var i = 0; i < official.length; i++) {
      var k = taskCardKey(official[i]);
      if (k) seen.add(k);
      var nk = norm(official[i] && (official[i].name || official[i].title));
      if (nk) seen.add('name:' + nk);
    }
    var list = Array.isArray(snapshotCards) ? snapshotCards : [];
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      if (!c) continue;
      var key = taskCardKey(c);
      var nameKey = 'name:' + norm(c.name || c.title);
      if ((key && seen.has(key)) || seen.has(nameKey)) continue;
      if (key) seen.add(key);
      seen.add(nameKey);
      added.push(Object.assign({}, c, { source: 'fresh-page-snapshot' }));
    }
    return {
      cards: official.concat(added),
      added: added.length,
      snapshotApplied: true
    };
  }

  /* D03 · B：两页失败但当前账号的新鲜可见页面有数据时允许降级同步，标注来源。 */
  function degradedSync(snapshot, ctx) {
    var c = ctx || {};
    var ok = !!c.pagesReachable || isFreshSnapshot(snapshot, c.now);
    return {
      ok: ok,
      degraded: !c.pagesReachable && isFreshSnapshot(snapshot, c.now),
      label: (!c.pagesReachable && isFreshSnapshot(snapshot, c.now))
        ? TEXT.pageData : TEXT.officialData,
      labelEn: (!c.pagesReachable && isFreshSnapshot(snapshot, c.now))
        ? TEXT.pageDataEn : TEXT.officialDataEn
    };
  }

  /* D04 · B：三态登录判断；页面文案单独出现不作登出结论。 */
  function loginStateFromEvidence(evidence) {
    var e = evidence || {};
    if (Number.isFinite(e.available) && e.available >= 0) return 'in';
    if (e.panelSignedIn === true) return 'in';
    if (e.explicitLogout === true) return 'out';
    if (e.panelSignedOut === true && e.pageTextSignedOut === true && !e.hasFreshData) return 'out';
    /* 临时加载页 / 旧缓存 / 只有文案 → 暂未确认，不闪烁、不清空 */
    return 'unknown';
  }
  function isConfirmedLogout(evidence) {
    var e = evidence || {};
    if (Number.isFinite(e.available) && e.available >= 0) return false;
    if (e.explicitLogout === true) return true;
    return e.pageTextSignedOut === true && e.panelSignedIn !== true &&
      e.panelSignedOut !== false && e.shellSignedOut === true;
  }

  /* D05 · D：确认登出后隐藏当前余额，保留历史/今日值并标为「上次记录」。 */
  function logoutPresentation(prev, now) {
    var t = Number.isFinite(now) ? now : Date.now();
    var ps = Object.assign({}, prev || {}, {
      available: null, signedOut: true, displayLabel: TEXT.historyLabel,
      displayLabelEn: TEXT.historyLabelEn, updatedAt: t
    });
    return {
      pointsSummary: ps, loginStatus: 'out',
      keepHistory: true, keepTodayTasks: true,
      restoreRealtimeLabelOnSignIn: true
    };
  }

  /* D06 · D：后台展示允许短期缓存；刷新 / 开始 / 收尾一律要新数据。 */
  var FRESH_REASONS = new Set([
    'refreshTasks', 'refreshPoints', 'refreshToday', 'manual-refresh', 'user-refresh',
    'start', 'finish', 'points', 'run-start', 'run-finish', 'refresh'
  ]);
  function isFreshRequired(reason) {
    return FRESH_REASONS.has(String(reason || ''));
  }
  function syncCachePolicy(reason) {
    var fresh = isFreshRequired(reason);
    return {
      fresh: fresh,
      cacheAllowed: !fresh,
      ttlMs: DEFAULTS.htmlCacheTtlMs,
      showCollectedAt: true,
      reason: String(reason || '')
    };
  }

  /* S01 · B：状态行显示运行详情（当前步骤 / 动态倒计时），全文可悬停查看。 */
  function formatActivityLine(detail, lang, now) {
    var t = Number.isFinite(now) ? now : Date.now();
    var a = detail || {};
    if (!a.at) return null;
    if (a.active === false && t - a.at > 12000) return null;
    var tpl = String((lang === 'en' ? a.en : a.zh) || '');
    if (!tpl) return null;
    var green = a.state === 'synced' || a.state === 'allDone' || a.state === 'done';
    var until = a.state === 'waiting' && Number(a.until) > t ? Number(a.until) : 0;
    var text = tpl.split('{s}').join(String(
      until ? Math.max(0, Math.ceil((until - t) / 1000)) : 0));
    return { text: text, template: tpl, until: until, green: green, detail: a };
  }

  function manualLinkNotice(count, lang) {
    return String(count) + (lang === 'en' ? TEXT.manualLinksEn : TEXT.manualLinks);
  }

  return {
    VERSION: '2.0.0',
    DECISIONS: DECISIONS,
    DEFAULTS: DEFAULTS,
    RESULT_STATES: RESULT_STATES,
    TEXT: TEXT,
    UI: UI,
    taskCardKey: taskCardKey,
    newClickResult: newClickResult,
    recordClick: recordClick,
    recordTrigger: recordTrigger,
    triggerPlan: triggerPlan,
    scanPlan: scanPlan,
    fallbackPages: fallbackPages,
    followupPolicy: followupPolicy,
    clampIntervalSec: clampIntervalSec,
    isAllDone: isAllDone,
    allDoneResult: allDoneResult,
    dataSourcePriority: dataSourcePriority,
    isFreshSnapshot: isFreshSnapshot,
    mergeSnapshotCards: mergeSnapshotCards,
    degradedSync: degradedSync,
    loginStateFromEvidence: loginStateFromEvidence,
    isConfirmedLogout: isConfirmedLogout,
    logoutPresentation: logoutPresentation,
    isFreshRequired: isFreshRequired,
    syncCachePolicy: syncCachePolicy,
    formatActivityLine: formatActivityLine,
    manualLinkNotice: manualLinkNotice
  };
});
