/* AUTO-GENERATED from shared/ — do not edit; run node scripts/sync-shared.js */
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
    /* v3.2 · 两端同步链路共用文案（可见短文案见 STATUS_LINES，这里是读屏/日志全文） */
    syncPagesZh: '官网 /dashboard 与 /earn',
    syncPagesEn: 'official /dashboard and /earn',
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
    triggerFallback: 'CDP 不可用，降级页面交互',
    strictRunBlocked: '自动运行中：严格模式已禁用该功能',
    strictRunBlockedEn: 'Strict run active — this feature is disabled while running',
    strictNoWords: '当日热搜中没有满足 5 字以上的搜索词，已停止（不补词、不编词、不使用本地词库）',
    strictNoWordsEn: 'No 5+ character trending keyword today — stopped (no fallback words)'
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

  /* ======================================================================
   * 严格运行模式（新增需求，两版一致）
   *   · 搜索词只能来自「本次运行抓取的当日热搜原文」，且不少于 5 个字；
   *   · 不足 5 字的单调词、本地词库、历史缓存词、相关延伸 / autosuggest
   *     改词一律禁用；词不够就少跑几轮，绝不补词、拼接或复用。
   *   · 自动运行期间禁用一切会改变运行行为的可选功能（拟人随机、改词、
   *     回首页、滚动、点结果、提醒、定时重入、运行期刷新 / 同步、
   *     watchdog 续跑、运行期改设置），只保留停止 / 超时 / 失败上限 /
   *     页面稳定等待等安全护栏。
   * ==================================================================== */
  var STRICT_RUN = Object.freeze({
    minKeywordChars: 5,
    maxKeywordChars: 30,
    requireSameDayHot: true,
    timezoneOffsetHours: 8,      // 「当日」按北京时间 UTC+8 的日界判定
    fixedNapMs: 600,
    fixedRoundWaitMs: 3000,
    fixedRoundIntervalMs: 10000,
    allowFallbackWords: false,
    allowRepeatWords: false,
    disabledFeatures: Object.freeze([
      'related-rewrite', 'autosuggest', 'local-word-list', 'used-words-reuse',
      'go-home', 'random-enter', 'human-click-plan', 'human-scroll',
      'click-result', 'random-delay', 'human-profile', 'reminder',
      'scheduled-reentry', 'runtime-refresh', 'runtime-sync',
      'watchdog-resume', 'runtime-settings-change', 'preview-topic',
      'key-page-capture'
    ]),
    /* 已知会影响运行的消息清单（文档与回归依据）；运行期实际按白名单放行。 */
    blockedMessages: Object.freeze([
      'refreshTasks', 'refreshPoints', 'refreshToday', 'syncNow', 'syncRewards',
      'start', 'runNow', 'autoComplete', 'testSearch', 'previewReminder',
      'openEarn', 'openOfficial', 'hidePanel', 'togglePanel',
      'dumpSidebar', 'dumpTaskList', 'dumpClickProbe', 'captureKeyPages',
      'saveSettings', 'saveAutoTasks'
    ]),
    /* 自动运行期放行：停止、只读面板状态、只读日志导出（不触发抓取、不改运行）。
       实时抓取关键网页属运行期禁用功能：日常运行只写运行日志。 */
    /* 自动运行期放行：停止、只读面板状态、只读日志导出、日志写入。
       logUserAction 只追加日志条目，不改变任何运行状态；抓取网页仍禁用。 */
    allowedMessages: Object.freeze(['stop', 'panelState', 'exportRunLog', 'logUserAction']),
    keptGuardrails: Object.freeze([
      'stop', 'timeout', 'max-failures', 'page-stable-wait', 'result-counting'
    ])
  });

  /* UTC+8 日键：两端用同一套「当日」口径，避免时区差异。 */
  function hotDayKey(t) {
    var ms = Number(t);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    return new Date(ms + STRICT_RUN.timezoneOffsetHours * 3600 * 1000)
      .toISOString().slice(0, 10);
  }
  function isSameDayHot(at, now) {
    var a = hotDayKey(at);
    var b = hotDayKey(Number.isFinite(now) ? now : Date.now());
    return !!a && a === b;
  }
  /* ≥5 个 Unicode 字符（中文按字、英文按字母），且含可检索字符。 */
  function isStrictKeyword(text) {
    var s = String(text == null ? '' : text).trim();
    var n = Array.from(s).length;
    if (n < STRICT_RUN.minKeywordChars || n > STRICT_RUN.maxKeywordChars) return false;
    return /[a-zA-Z0-9\u3400-\u9fff]/.test(s);
  }
  /* 从当日热搜池挑选合规词：不补词、不拼接、不复用、不重复。 */
  function strictQueries(count, poolItems, now) {
    var t = Number.isFinite(now) ? now : Date.now();
    var want = Math.max(0, Math.round(num(count)));
    var queries = [], droppedShort = 0, droppedStale = 0, droppedDuplicate = 0;
    var seen = new Set();
    var list = Array.isArray(poolItems) ? poolItems : [];
    for (var i = 0; i < list.length && queries.length < want; i++) {
      var it = list[i];
      var text = typeof it === 'string' ? it : (it && it.text);
      if (!isStrictKeyword(text)) { droppedShort++; continue; }
      var at = (it && typeof it === 'object') ? (it.at || it.updatedAt || 0) : 0;
      if (STRICT_RUN.requireSameDayHot && !isSameDayHot(at, t)) { droppedStale++; continue; }
      var key = norm(text);
      if (!key || seen.has(key)) { droppedDuplicate++; continue; }
      seen.add(key);
      queries.push(String(text).trim().slice(0, STRICT_RUN.maxKeywordChars));
    }
    return {
      queries: queries,
      requested: want,
      droppedShort: droppedShort,
      droppedStale: droppedStale,
      droppedDuplicate: droppedDuplicate,
      complete: queries.length >= want,
      dayKey: hotDayKey(t)
    };
  }
  function strictRuntimeFeatureAllowed(feature, running) {
    if (!running) return true;
    return STRICT_RUN.disabledFeatures.indexOf(String(feature || '')) < 0;
  }
  function strictBlockedMessage(type, running) {
    if (!running) return false;
    var t = String(type || '');
    if (STRICT_RUN.allowedMessages.indexOf(t) >= 0) return false;
    return true;   /* 严格运行期：除白名单外，其它消息一律禁用 */
  }
  /* 运行期闹钟：watchdog 续跑 / 提醒 / 定时重入 / 词缓存清理一律禁用；
     cooldownEnd 属于运行链路本身，保留。 */
  function strictAlarmAllowed(name, running) {
    if (!running) return true;
    var map = {
      watchdog: 'watchdog-resume',
      reminderTick: 'reminder',
      autoTaskTick: 'scheduled-reentry',
      cleanUsedWords: 'used-words-reuse',
      scheduledRun: 'scheduled-reentry',
      autoDailySet: 'scheduled-reentry',
      hsaScheduledRun: 'scheduled-reentry',
      cooldownEnd: 'cooldown-end'
    };
    var n = String(name || '');
    var feature = map[n] || n;
    return STRICT_RUN.disabledFeatures.indexOf(feature) < 0;
  }
  /* ======================================================================
   * v3.7 · 拟人搜索间隔（两端同源，可在设置里调整）
   *   · 只是把「严格运行模式」里原本写死的固定间隔暴露成设置项；
   *     不恢复随机延时 / 拟人轨迹 / 滚动 / 点结果，运行节奏仍是确定的。
   *   · 设置项用「秒」（可 1 位小数），共享层统一换算成毫秒并夹到合法区间，
   *     保证 UA / 提示 / 后台读取不会因单位或越界值打架。
   *   · 设置在一次运行开始时读取一次，运行期禁止改设置（既有严格守卫）。
   * ==================================================================== */
  var INTERVAL_SETTING_KEYS = Object.freeze({
    actionGapMs: 'actionGapSec',          /* 每次键鼠动作后的短间隔 */
    pageStableWaitMs: 'pageStableSec',    /* 结果页稳定等待 */
    roundGapMs: 'roundGapSec',            /* 两轮搜索之间 */
    roundWaitMs: 'roundWaitSec'           /* 单轮搜索后的等待 */
  });
  var INTERVALS = Object.freeze({
    actionGapMs:      { def: 600,  min: 100,  max: 5000,  step: 100,  sec: 0.6, minSec: 0.1, maxSec: 5,  stepSec: 0.1, zh: '键鼠动作间隔', en: 'Action gap' },
    pageStableWaitMs: { def: 3000, min: 500,  max: 15000, step: 500,  sec: 3,   minSec: 0.5, maxSec: 15, stepSec: 0.5, zh: '页面稳定等待', en: 'Page settle' },
    roundGapMs:       { def: 10000,min: 1000, max: 60000, step: 1000, sec: 10,  minSec: 1,   maxSec: 60, stepSec: 1,   zh: '搜索轮间间隔', en: 'Round gap' },
    roundWaitMs:      { def: 3000, min: 500,  max: 15000, step: 500,  sec: 3,   minSec: 0.5, maxSec: 15, stepSec: 0.5, zh: '单轮等待',     en: 'Round wait' }
  });
  function intervalDefaultSec(key) {
    var spec = INTERVALS[key];
    return spec ? spec.sec : 0;
  }
  /** 把设置里的秒值换算成毫秒并夹到该参数的 [min,max]，按 step 对齐。 */
  function clampIntervalMs(key, sec) {
    var spec = INTERVALS[key];
    if (!spec) return 0;
    var v = Number(sec);
    var ms = Number.isFinite(v) && v > 0 ? v * 1000 : spec.def;
    ms = Math.min(spec.max, Math.max(spec.min, ms));
    return Math.round(ms / spec.step) * spec.step;
  }
  /** 归一化整组间隔设置：返回 { actionGapMs, pageStableWaitMs, ... , cardClickIntervalSec }。 */
  function normalizeIntervals(settings) {
    var st = settings || {}, out = {};
    Object.keys(INTERVALS).forEach(function (key) {
      out[key] = clampIntervalMs(key, st[INTERVAL_SETTING_KEYS[key]]);
    });
    out.cardClickIntervalSec = clampIntervalSec(st.cardClickIntervalSec);
    return out;
  }

  /** 严格运行策略；传入 settings 时用设置里的间隔覆盖写死的固定值。 */
  function strictRunPolicy(overrides) {
    var iv = normalizeIntervals(overrides);
    return Object.freeze({
      minKeywordChars: STRICT_RUN.minKeywordChars,
      maxKeywordChars: STRICT_RUN.maxKeywordChars,
      fixedNapMs: iv.actionGapMs,
      fixedRoundWaitMs: iv.roundWaitMs,
      pageStableWaitMs: iv.pageStableWaitMs,
      fixedRoundIntervalMs: iv.roundGapMs,
      cardClickIntervalSec: iv.cardClickIntervalSec,
      goHome: false,
      relatedRewrite: false,
      humanVariation: false,
      randomDelay: false,
      scroll: false,
      clickResult: false,
      disabledFeatures: STRICT_RUN.disabledFeatures.slice()
    });
  }

  var VERSION = '2.4.0';

  /* ======================================================================
   * 诊断数据（新增需求，两版一致）
   *   · 日常运行只有运行日志：只记轻量运行事件，绝不把网页 HTML / 快照 /
   *     积分明细写进日志；环形上限防止 storage 膨胀。
   *   · 关键网页按需实时抓取：设置里手动触发，强制 fresh、cache:no-store，
   *     不复用 120 秒 HTML 缓存、不读可见快照 / 面板 / 隐藏数据视图，
   *     来源一律标 live-network；抓取结果只随本次导出，不落进日常日志。
   * ==================================================================== */
  var RUNLOG = Object.freeze({
    maxEntries: 600,
    maxTextChars: 240,
    maxDetailChars: 1200,
    /* 详细运行日志：系统时间、用户操作、运行过程、运行结果、错误信息。
       网页 HTML / 快照 / 积分明细等大对象仍一律不进日志。 */
    allowedFields: Object.freeze([
      'at', 'ts', 'iso', 'platform', 'event', 'level', 'actor', 'category',
      'detail', 'result', 'error', 'state', 'zh', 'en', 'page', 'card',
      'query', 'next', 'delayMs', 'ok', 'reason', 'count', 'name', 'url',
      'status', 'durationMs', 'order', 'section'
    ])
  });
  var KEY_CAPTURE = Object.freeze({
    /* 三页：/dashboard、/earn 以及 Bing 侧边栏（panelflyout）。
       导出为 HTML 的 zip 包，不复用缓存 / 快照 / 面板 / 隐藏数据视图。 */
    pages: Object.freeze([
      Object.freeze({ name: 'dashboard', path: '/dashboard',
        url: 'https://rewards.bing.com/dashboard', file: 'dashboard.html' }),
      Object.freeze({ name: 'earn', path: '/earn',
        url: 'https://rewards.bing.com/earn', file: 'earn.html' }),
      Object.freeze({ name: 'bing-sidebar', path: '/rewards/panelflyout',
        url: 'https://cn.bing.com/rewards/panelflyout?channel=bingflyout&partnerId=BingRewards',
        file: 'bing-sidebar.html' })
    ]),
    origin: 'https://rewards.bing.com',
    fresh: true,
    cacheAllowed: false,
    snapshotAllowed: false,
    panelAllowed: false,
    dataViewAllowed: false,
    timeoutMs: 12000,
    source: 'live-network',
    maxBytes: DEFAULTS.htmlCacheMaxBytes
  });

  /* 北京时间 UTC+8 的时间戳，用于导出文件名（两端口径一致）。 */
  function stamp(now) {
    var ms = Number.isFinite(now) ? now : Date.now();
    return new Date(ms + STRICT_RUN.timezoneOffsetHours * 3600 * 1000)
      .toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})(\d{6})$/, '$1-$2');
  }
  function runLogFileName(now) {
    return 'hsa-runlog-' + stamp(now) + '.json';
  }
  function keyPageFileName(now) {
    return 'hsa-keypages-' + stamp(now) + '.zip';
  }
  /* 系统时间：本机时区可读时间（含 UTC 偏移）+ ISO 8601，两端一致。 */
  function systemTime(ms) {
    var d = new Date(Number.isFinite(ms) ? ms : Date.now());
    var p = function (n) { return String(n).padStart(2, '0'); };
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
      + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.'
      + String(d.getMilliseconds()).padStart(3, '0') + ' ' + sign + p(oh) + ':' + p(om);
  }
  /* 任务卡严格按页面 DOM 顺序（截图里的任务列表顺序）执行：
     只认 domOrder / order / idx，绝不按分组、积分、完成态或同步索引重排。 */
  function domIndex(c, fallback) {
    var keys = ['domOrder', 'order', 'idx'];
    for (var i = 0; i < keys.length; i++) {
      var raw = c && c[keys[i]];
      if (raw != null && raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
    }
    return fallback;
  }
  function taskListOrder(cards) {
    var list = Array.isArray(cards) ? cards.slice() : [];
    return list.map(function (c, i) { return { c: c, i: i, d: domIndex(c, i) }; })
      .sort(function (a, b) { return (a.d - b.d) || (a.i - b.i); })
      .map(function (x) { return x.c; });
  }
  function taskListNames(cards) {
    return taskListOrder(cards).map(function (c) {
      return String((c && (c.name || c.title)) || '').slice(0, 40);
    });
  }
  /* 每次打开设置页面，积分日历自动复位到当日 / 日视图（两版一致）。 */
  function calendarReset(now) {
    var t = Number.isFinite(now) ? now : Date.now();
    return { cursor: new Date(t), mode: 'day' };
  }
  /* 日历：目标周期「完全没有积分记录」时禁止跳转（两端口径一致）。 */
  function calendarNavAllowed(hist, mode, y, m, step, todayKey) {
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    var base = mode === 'month' ? new Date(y + step, 0, 1) : new Date(y, m + step, 1);
    var prefix = mode === 'month'
      ? String(base.getFullYear())
      : base.getFullYear() + '-' + p2(base.getMonth() + 1);
    var keys = Object.keys(hist || {});
    var today = String(todayKey || '');
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.slice(0, prefix.length) !== prefix || (today && k > today)) continue;
      var v = hist[k];
      var pts = (v && typeof v === 'object')
        ? num(v.today != null ? v.today : (v.points != null ? v.points : v.total))
        : num(v);
      if (pts > 0) return true;
    }
    return false;
  }
  /* 白名单字段裁剪：html / snapshot / points 等大对象一律不进日志。
     每条自动补齐系统时间 ts / iso、平台、操作者、类别。 */
  function runLogAppend(list, entry, now) {
    var e = entry && typeof entry === 'object' ? entry : {};
    var at = Number.isFinite(Number(e.at)) ? Math.round(Number(e.at))
      : (Number.isFinite(now) ? Math.round(now) : Date.now());
    var clean = {
      at: at,
      ts: systemTime(at),
      iso: new Date(at).toISOString(),
      platform: String(e.platform || '').slice(0, 40),
      event: String(e.event || 'activity').slice(0, 40),
      level: String(e.level || 'info').slice(0, 12),
      actor: String(e.actor || 'system').slice(0, 20),
      category: String(e.category || 'run-step').slice(0, 24)
    };
    for (var i = 0; i < RUNLOG.allowedFields.length; i++) {
      var k = RUNLOG.allowedFields[i];
      if (k in clean || !(k in e)) continue;
      var v = e[k];
      if (v == null) continue;
      if (k === 'detail' || k === 'result' || k === 'error') {
        clean[k] = String(v).slice(0, RUNLOG.maxDetailChars);
      } else if (k === 'zh' || k === 'en' || k === 'query' || k === 'page'
          || k === 'card' || k === 'next' || k === 'state' || k === 'reason'
          || k === 'name' || k === 'url' || k === 'section' || k === 'order') {
        clean[k] = String(v).slice(0, RUNLOG.maxTextChars);
      } else if (k === 'delayMs' || k === 'count' || k === 'durationMs'
          || k === 'status' || k === 'order') {
        clean[k] = Math.max(0, Math.round(num(v)));
      } else if (k === 'ok') {
        clean[k] = !!v;
      } else if (k === 'iso' || k === 'ts') {
        clean[k] = String(v).slice(0, 40);
      }
    }
    var out = Array.isArray(list) ? list.slice(-(RUNLOG.maxEntries - 1)) : [];
    out.push(clean);
    return out;
  }
  function runLogExport(entries, meta) {
    var m = meta && typeof meta === 'object' ? meta : {};
    var list = Array.isArray(entries) ? entries : [];
    var now = Number.isFinite(m.now) ? m.now : Date.now();
    return JSON.stringify({
      schema: 'hsa-runlog/2',
      version: VERSION,
      exportedAt: now,
      exportedAtSystemTime: systemTime(now),
      platform: String(m.platform || ''),
      count: list.length,
      fields: ['系统时间 ts', '用户操作 actor=user', '运行过程 category=run-step',
               '运行结果 category=result', '错误信息 category=error'],
      note: 'Detailed run log with system time; no web page HTML or snapshots are stored.',
      entries: list
    }, null, 2);
  }
  function keyPagePolicy() {
    return {
      pages: KEY_CAPTURE.pages.map(function (p) {
        return { name: p.name, path: p.path, url: p.url, file: p.file };
      }),
      origin: KEY_CAPTURE.origin,
      fresh: true,
      cacheAllowed: false,
      snapshotAllowed: false,
      panelAllowed: false,
      dataViewAllowed: false,
      timeoutMs: KEY_CAPTURE.timeoutMs,
      source: KEY_CAPTURE.source,
      maxBytes: KEY_CAPTURE.maxBytes,
      format: 'zip/html'
    };
  }
  /* zip 包内容：manifest.json + 三个 HTML 文件（失败页也保留占位说明）。 */
  function keyPageZipFiles(pages, now, meta) {
    var m = meta && typeof meta === 'object' ? meta : {};
    var t = Number.isFinite(now) ? now : Date.now();
    var list = Array.isArray(pages) ? pages : [];
    var manifest = {
      schema: 'hsa-keypages/2',
      version: VERSION,
      format: 'zip/html',
      capturedAt: t,
      capturedAtSystemTime: systemTime(t),
      platform: String(m.platform || ''),
      fresh: true,
      source: KEY_CAPTURE.source,
      note: 'Live network fetch only; no HTML cache, visible snapshot, panel or data view was reused.',
      pages: list.map(function (p) {
        var x = p && typeof p === 'object' ? p : {};
        return {
          name: String(x.name || ''), path: String(x.path || ''),
          url: String(x.url || ''), file: String(x.file || ''),
          ok: !!x.ok, status: Math.max(0, Math.round(num(x.status))),
          bytes: Math.max(0, Math.round(num(x.bytes))),
          collectedAt: Math.round(num(x.collectedAt)),
          collectedAtSystemTime: systemTime(num(x.collectedAt) || t),
          source: String(x.source || KEY_CAPTURE.source),
          fresh: true,
          error: String(x.error || '')
        };
      })
    };
    var files = [{ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }];
    for (var i = 0; i < KEY_CAPTURE.pages.length; i++) {
      var def = KEY_CAPTURE.pages[i];
      var got = null;
      for (var j = 0; j < list.length; j++) {
        if (list[j] && String(list[j].name || '') === def.name) { got = list[j]; break; }
      }
      var html = got ? String(got.html || '') : '';
      if (!html) {
        html = '<!doctype html><html><head><meta charset="utf-8"><title>'
          + def.name + ' capture failed</title></head><body><h1>' + def.name
          + '</h1><p>Live capture failed: '
          + String((got && got.error) || 'no response').replace(/[<>&]/g, '')
          + '</p><p>Source URL: ' + def.url + '</p></body></html>';
      }
      files.push({ name: def.file, data: html });
    }
    return { files: files, manifest: manifest };
  }
  /* 兼容保留：JSON 摘要导出（不用于 zip 包下载）。 */
  function keyPageExport(pages, now, meta) {
    var m = meta && typeof meta === 'object' ? meta : {};
    var t = Number.isFinite(now) ? now : Date.now();
    var list = Array.isArray(pages) ? pages : [];
    return JSON.stringify({
      schema: 'hsa-keypages/2',
      version: VERSION,
      format: 'zip/html',
      capturedAt: t,
      platform: String(m.platform || ''),
      fresh: true,
      source: KEY_CAPTURE.source,
      note: 'Live network fetch only; exported as HTML zip.',
      pages: list.map(function (p) {
        var x = p && typeof p === 'object' ? p : {};
        return {
          name: String(x.name || ''), path: String(x.path || ''),
          url: String(x.url || ''), file: String(x.file || ''),
          ok: !!x.ok, status: Math.max(0, Math.round(num(x.status))),
          bytes: Math.max(0, Math.round(num(x.bytes))),
          collectedAt: Math.round(num(x.collectedAt)),
          source: String(x.source || KEY_CAPTURE.source),
          fresh: true,
          error: String(x.error || '')
        };
      })
    }, null, 2);
  }

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
    'start', 'finish', 'points', 'run-start', 'run-finish', 'refresh', 'ui-open'
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

  /* ======================================================================
   * v3.2 · 状态文案：可见文本每次 ≤15 个中文字符（英文按等显示长度计），
   * 详细全文放 aria-label / title / 运行日志，兼顾「简洁」与「详细」。
   * 显示宽度：中文与全角标点 = 1，ASCII = 0.5。
   * ==================================================================== */
  var STATUS_MAX_WIDTH = 15;
  var STATUS_LINES = Object.freeze({
    syncing:     ['同步中·官网两页',      'Syncing · 2 pages'],
    synced:      ['同步完成 {t}/{a}',     'Synced {t}/{a}'],
    syncFresh:   ['已是最新·无变化',      'Fresh · no change'],
    syncFailed:  ['同步失败·留旧值',      'Sync failed · kept'],
    skipRecent:  ['刚同步过·已跳过',      'Recent sync · skip'],
    skipRunning: ['运行中·跳过同步',      'Running · skip'],
    skipMerged:  ['合并同步·不重复',      'Merged · no repeat'],
    allDone:     ['今日已满·停止任务',    'All done · stopped'],
    cards:       ['点卡 {n}/{m}',         'Cards {n}/{m}'],
    searching:   ['搜索 {n}/{m}',         'Search {n}/{m}'],
    waiting:     ['等待 {s} 秒',          'Wait {s}s'],
    autoStart:   ['自动任务·已开始',      'Auto-run · started'],
    done:        ['完成·卡{c}搜{q}',      'Done · {c}C/{q}S'],
    stopped:     ['已停止·无动作',        'Stopped · no action'],
    error:       ['错误·稍后重试',        'Error · retry later'],
    login:       ['请先登录官网',          'Sign in to Rewards'],
    idle:        ['就绪',                  'Ready']
  });
  var STATUS_GREEN = Object.freeze({
    synced: true, syncFresh: true, allDone: true, done: true
  });

  /* ======================================================================
   * v3.5 · 运行提示词（两端唯一真源）
   *
   * 用户反馈：日志「已按列表顺序点击 9/17 张卡片 · 下一步：按剩余分数搜索」
   * 与实际点击不一致，且桌面版各写一套长文案、插件版几乎没有运行期提示。
   * 这里把全部运行过程文案收成一张表：
   *   · 只描述「当前动作」，不出现「下一步 / Next / 之后 / then」；
   *   · 可见文本与同步状态同口径，≤15 个中文字符显示宽度；
   *   · 卡片名 / 页面 / 积分 / 顺序 / 完整列表 / 系统时间进详细全文，
   *     供 aria-label、悬浮提示与运行日志，不占可见长度。
   * 两端 desktopActivityWrite / desktopActivityPush / hsaActivityPush
   * 都只传 (state, ctx)，由 runActivity 生成完全相同的 payload。
   * ==================================================================== */
  var RUN_LINES = Object.freeze({
    taskList:  ['任务列表 {m} 张',      'Task list {m}'],
    clicking:  ['点卡 {n}/{m}',         'Cards {n}/{m}'],
    cardsDone: ['点卡完成 {n}/{m}',     'Cards done {n}/{m}'],
    opening:   ['打开页面',              'Opening page'],
    pageDone:  ['本页点卡 {n}',          'Page cards {n}'],
    scanning:  ['读取任务列表',           'Reading task list'],
    searching: ['搜索 {n}/{m}',         'Search {n}/{m}'],
    waiting:   ['等待 {s} 秒',           'Wait {s}s'],
    synced:    ['同步完成',              'Synced'],
    autoStart: ['自动任务·已开始',        'Auto-run · started'],
    done:      ['完成·卡{c}搜{q}',       'Done · {c}C/{q}S'],
    allDone:   ['今日已满·停止任务',      'All done · stopped'],
    stopped:   ['已停止·无动作',          'Stopped · no action'],
    error:     ['错误·稍后重试',          'Error · retry later'],
    idle:      ['就绪',                   'Ready']
  });

  function runFill(tpl, c, keepSec) {
    /* waiting 必须把 {s} 原样留给 popup 的倒计时替换，不能提前填成静态数字。 */
    return String(tpl)
      .split('{n}').join(String(numOrZero(c.n)))
      .split('{m}').join(String(numOrZero(c.m)))
      .split('{c}').join(String(numOrZero(c.clicked)))
      .split('{q}').join(String(numOrZero(c.searches)))
      .split('{s}').join(keepSec ? '{s}'
        : String(numOrZero(c.sec != null ? c.sec : c.s)));
  }

  /** 一次运行提示的完整载荷：可见短文案 + 详细全文，两端逐字相同。 */
  function runActivity(state, ctx) {
    var st = String(state || 'idle'), c = ctx || {};
    var lines = RUN_LINES[st] || RUN_LINES.idle;
    var isWait = st === 'waiting';
    var rawZh = runFill(lines[0], c, isWait), rawEn = runFill(lines[1], c, isWait);
    var zh = clampStatus(rawZh), en = clampStatus(rawEn);
    var at = Number(c.at) || Date.now();
    var delayMs = Math.max(0, Math.round(Number(c.delayMs) || 0));
    function full(isEn) {
      var bits = [];
      if (c.card) bits.push(isEn ? 'Card: ' + String(c.card) : '卡片：' + String(c.card));
      if (c.page) bits.push(isEn ? 'Page: ' + String(c.page) : '页面：' + String(c.page));
      if (Number(c.points) > 0)
        bits.push(isEn ? '+' + numOrZero(c.points) + ' pts' : '+' + numOrZero(c.points) + ' 分');
      if (c.query) bits.push(isEn ? 'Query: ' + String(c.query) : '关键词：' + String(c.query));
      if (c.order) bits.push(isEn ? 'Order: ' + String(c.order) : '执行顺序：' + String(c.order));
      if (c.list) bits.push(isEn ? 'Task list: ' + String(c.list) : '任务列表：' + String(c.list));
      if (c.reason) bits.push(isEn ? 'Reason: ' + String(c.reason) : '原因：' + String(c.reason));
      var head = isEn ? 'Human Search Assistant · ' : '拟人搜索助手 · ';
      return head + String(isEn ? rawEn : rawZh)
        + (bits.length ? ' · ' + bits.join(' · ') : '')
        + ' · ' + systemTime(at);
    }
    return Object.freeze({
      at: at, until: delayMs ? at + delayMs : 0,
      state: st, zh: zh, en: en,
      fullZh: full(false), fullEn: full(true),
      green: !!STATUS_GREEN[st],
      page: String(c.page || ''), card: String(c.card || ''),
      query: String(c.query || ''), next: '',
      order: String(c.order || ''), list: String(c.list || ''),
      points: numOrZero(c.points), reason: String(c.reason || ''),
      delayMs: delayMs
    });
  }

  /* ======================================================================
   * v3.6 · 点击计划只以任务列表为准（两端唯一真源）
   *
   * 用户口径：桌面版和插件版都以任务列表为准，自动跳过已完成的任务卡片，
   * 不要使用其他判别方式。因此：
   *   · 计划 = 任务列表本身（同步阶段 taskClickIndex.items / runTaskStates）；
   *   · **唯一过滤条件** = 任务列表项自带的完成标记（completed / done）；
   *     这个标记来自同步结果，不是侧栏 DOM、不是积分徽章、不是卡片类型；
   *   · 其余一律不删、不合并、不重排：0 分 / referral / redeem / promo /
   *     scored / syncMatched / DOM 完成标记都不参与「是否点击」；
   *   · 页面 DOM 扫描只补齐定位（idx / href / target），匹配不到也保留该项
   *     （matched=false，点击时记失败/未确认）。
   * 「将推荐转化为奖励」这类有积分但被旧逻辑误判为推荐卡的项，只要任务列表
   * 里标为未完成，就会保留在计划里并被点击。
   * ==================================================================== */
  /* ====================================================================
   * v4.1 · 「今日 Bing 搜索」不是可点击的任务卡片
   *
   * 同步结果里主界面任务列表的第一条是搜索进度项（section/kind/source
   * = 'search'，名称「今日 Bing 搜索」/「Bing search today」，没有目标链接），
   * 它只用于展示搜索积分进度，不是侧栏里能点开的活动卡。
   * 旧逻辑把它当成一条待点任务，于是「任务列表只剩今日 Bing 搜索」时
   * 仍然打开 Bing 侧栏去找一张根本不存在的卡。
   *
   * 判定只回答「这项是不是卡片」，不回答「要不要跳过这张卡」：
   *   · 结构字段明确是 search 进度项 → 非卡片；
   *   · 名称与搜索进度条目一致且没有真实 http(s) 链接 → 非卡片；
   *   · 有真实链接的同名项仍按可点击卡片处理，避免误伤。
   * 除此之外一律不删、不合并、不重排；0 分 / kind / scored / 侧栏 DOM /
   * 匹配状态仍然完全不参与判别。唯一过滤仍是「已完成」+「非卡片」。
   * ==================================================================== */
  var SEARCH_PROGRESS_NAMES = [
    '今日bing搜索', 'bingsearchtoday', '今日搜索', '每日搜索',
    'todaybingsearch', '当天bing搜索', '今日pc搜索', '今日移动搜索'
  ];
  function taskItemNorm(v) {
    return String(v == null ? '' : v).replace(/[\s\u3000]+/g, '').toLowerCase();
  }
  function isNonClickableTaskItem(it) {
    if (!it) return true;
    var section = String(it.section || it.kind || it.source || '').toLowerCase();
    if (section === 'search' || section === 'dailysearch') return true;
    var href = String(it.href || it.url || it.targetUrl || it.target || '');
    if (/^https?:\/\//i.test(href)) return false;   /* 有真实链接 = 可点卡片 */
    var key = taskItemNorm(it.name || it.title || it.text);
    if (!key) return true;   /* 既无链接又无名称的项不是可点卡片 */
    return SEARCH_PROGRESS_NAMES.indexOf(key) >= 0;
  }
  /** 只按「非卡片」与「已完成」过滤；不改变顺序、不去重。 */
  function pendingTaskItems(items) {
    var list = Array.isArray(items) ? items : [];
    return list.filter(function (it) {
      if (!it) return false;
      if (isNonClickableTaskItem(it)) return false;
      /* 完成状态只取任务列表（同步结果）自带的字段；不看页面 DOM。 */
      return !(it.completed === true || it.done === true);
    });
  }

  function planTaskClicks(items, domCards) {
    var list = taskListOrder(pendingTaskItems(items));
    var dom = Array.isArray(domCards) ? domCards : [];
    var norm = function (v) {
      return String(v == null ? '' : v).replace(/[\s\u3000]+/g, '').toLowerCase();
    };
    var nameOf = function (x) {
      return String((x && (x.name || x.title || x.text)) || '');
    };
    var hrefOf = function (x) {
      return String((x && (x.href || x.targetUrl || x.url)) || '');
    };
    return list.map(function (it, i) {
      var name = nameOf(it), key = norm(name), href = hrefOf(it);
      var hit = null;
      if (key) {
        for (var j = 0; j < dom.length; j++) {
          if (dom[j] && norm(nameOf(dom[j])) === key) { hit = dom[j]; break; }
        }
      }
      if (!hit && key) {
        for (var k = 0; k < dom.length; k++) {
          var dn = norm(nameOf(dom[k]));
          if (dn && (dn.indexOf(key) >= 0 || key.indexOf(dn) >= 0)) { hit = dom[k]; break; }
        }
      }
      if (!hit && href) {
        for (var m = 0; m < dom.length; m++) {
          if (dom[m] && hrefOf(dom[m]) === href) { hit = dom[m]; break; }
        }
      }
      return {
        domOrder: i,
        idx: hit && hit.idx != null ? hit.idx : -1,
        name: name,
        points: Number(it && it.points) || 0,
        completed: !!(it && it.completed),
        href: hit ? hrefOf(hit) : href,
        target: hit ? String(hit.target || '') : String((it && it.target) || ''),
        page: String((it && it.page) || ''),
        kind: (hit && hit.kind) || 'task',
        matched: !!hit
      };
    });
  }

  /* ======================================================================
   * v3.7 · 完成态唯一权威 = 主界面任务列表（todayTasks.items）
   *
   * 问题：桌面版同步时会生成两份列表 ——
   *   · todayTasks.items：主界面「今日任务/每日活动/日常任务」，用户看到的
   *     「已完成 / 待完成」就是它（解析 + 注入 + 快照合并，最完整）；
   *   · taskClickIndex.items：从抓取的 /dashboard /earn HTML 解析出的点击索引，
   *     完成态靠 isCompleted / "已完成" 字样，SPA 抓取时常缺失 → 大量 false。
   * 旧运行时计划只取后者，于是已完成的卡也照点（截图「点卡 11/17」）。
   *
   * 修复：把主界面任务状态的完成态按名称覆盖到点击列表项，再交给
   * pendingTaskItems 做唯一过滤。两端都走同一个 buildTaskPlan()，同步逻辑相同。
   *   · 只认名称匹配（精确 + 双向包含兜底），不看侧栏 DOM / 积分徽章 / kind；
   *   · 匹配不到主界面状态的项保留原完成态，不臆造；
   *   · 同名多项：全部已完成才算已完成，避免误跳过待完成项。
   * ==================================================================== */
  function taskCompletionNorm(v) {
    return String(v == null ? '' : v).replace(/[\s\u3000]+/g, '').toLowerCase();
  }
  function applyTaskCompletion(items, summary) {
    var list = Array.isArray(items) ? items : [];
    var states = summary && Array.isArray(summary.items) ? summary.items : [];
    if (!states.length) return list.slice();
    var doneByName = Object.create(null);
    states.forEach(function (it) {
      if (!it) return;
      var key = taskCompletionNorm(it.name || it.title);
      if (!key) return;
      var pts = Number(it.points) || 0;
      var done = !!(it.completed === true || it.done === true ||
        (pts > 0 && Number(it.earned) >= pts));
      if (!(key in doneByName)) doneByName[key] = done;
      else doneByName[key] = doneByName[key] && done;
    });
    var lookup = function (key) {
      if (!key) return null;
      if (key in doneByName) return doneByName[key];
      for (var k in doneByName) {
        if (k.length >= 4 && key.length >= 4 &&
            (k.indexOf(key) >= 0 || key.indexOf(k) >= 0)) return doneByName[k];
      }
      return null;
    };
    return list.map(function (it) {
      if (!it) return it;
      var key = taskCompletionNorm(it.name || it.title);
      var hit = lookup(key);
      if (hit == null) return it;
      return Object.assign({}, it, { completed: hit });
    });
  }
  /** 两端运行时唯一计划入口：主界面完成态 → 跳过已完成 → DOM 只补定位。 */
  function buildTaskPlan(items, domCards, summary) {
    return planTaskClicks(applyTaskCompletion(items, summary), domCards);
  }
  /** 状态行 / 日志的待点列表：与 buildTaskPlan 同源，m 不会和实际计划打架。 */
  function taskPlanNames(items, summary) {
    return taskListNames(pendingTaskItems(applyTaskCompletion(items, summary)));
  }
  /** v4.1 · 两端共用的「是否还有可点击卡片」判定：
   *  primary = 点击索引 / 运行态任务列表；secondary = 主界面任务列表。
   *  两个来源都没有待点卡片时才短路，避免同步失败误跳过真实卡片。 */
  function hasClickableCards(primary, secondary, summary) {
    return buildTaskPlan(primary, [], summary).length > 0
      || buildTaskPlan(secondary, [], summary).length > 0;
  }

  /* ======================================================================
   * v4.2 · 搜索词「一天之内不能重复」
   *
   * 旧实现 buildQueries(count, usedList) 只把 usedList 记进 usedWords，
   * 但 strictQueries() 从不读它 —— 同一天多次运行仍会挑出同一批热搜词；
   * 且 usedWords 依赖 24h 闹钟清理（插件侧闹钟已被严格白名单禁用）。
   *
   * 现在按 UTC+8 日键持久化 { day, words }，跨运行 / 跨宿主重启都生效；
   * 换日自动失效，不依赖任何定时器。词用完就如实少跑或停止 ——
   * 不补词、不编词、不拼接、不复用历史词、不循环重复。
   * ==================================================================== */
  var USED_WORDS_MAX = 320;
  function usedWordKey(v) { return taskCompletionNorm(v); }
  function todayUsedState(saved, now) {
    var day = hotDayKey(Number.isFinite(now) ? now : Date.now());
    var ok = saved && typeof saved === 'object' && saved.day === day
      && Array.isArray(saved.words);
    return { day: day, words: ok ? saved.words.slice(-USED_WORDS_MAX) : [] };
  }
  /** 合并多个来源（兼容旧 usedWords 纯数组），归一化去重。 */
  function mergeUsedWords(lists) {
    var nested = Array.isArray(lists) && Array.isArray(lists[0]);
    var arr = Array.isArray(lists) ? (nested ? lists : [lists]) : [];
    var out = [], seen = Object.create(null);
    for (var i = 0; i < arr.length; i++) {
      var l = Array.isArray(arr[i]) ? arr[i] : [];
      for (var j = 0; j < l.length; j++) {
        var w = String(l[j] == null ? '' : l[j]).trim();
        var k = usedWordKey(w);
        if (!k || k in seen) continue;
        seen[k] = 1;
        out.push(w.slice(0, STRICT_RUN.maxKeywordChars));
      }
    }
    return out.slice(-USED_WORDS_MAX);
  }
  /** 从本次候选词里剔除当日已用词；顺序不变、不补词。 */
  function dropUsedWords(queries, usedList) {
    var used = Object.create(null);
    mergeUsedWords(usedList).forEach(function (w) { used[usedWordKey(w)] = 1; });
    var list = Array.isArray(queries) ? queries : [];
    return list.filter(function (q) {
      var k = usedWordKey(q);
      return !!k && !(k in used);
    });
  }
  /** 把本次选中的词计入当日已用（「已排期」即占用，保证绝不重复）。 */
  function todayUsedPush(state, queries) {
    var st = state || { day: hotDayKey(Date.now()), words: [] };
    return { day: st.day,
      words: mergeUsedWords([st.words || [], queries || []]).slice(-USED_WORDS_MAX) };
  }

  function displayWidth(str) {
    var t = String(str == null ? '' : str), w = 0;
    for (var i = 0; i < t.length; i++) {
      var code = t.charCodeAt(i);
      w += (code < 0x80) ? 0.5 : 1;
    }
    return w;
  }
  /** 把任意状态文本压到 STATUS_MAX_WIDTH 显示宽度内，超出用省略号。 */
  function clampStatus(str) {
    var t = String(str == null ? '' : str);
    if (displayWidth(t) <= STATUS_MAX_WIDTH) return t;
    var out = '', w = 0;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i), cw = ch.charCodeAt(0) < 0x80 ? 0.5 : 1;
      if (w + cw > STATUS_MAX_WIDTH - 1) break;
      out += ch; w += cw;
    }
    return out + '…';
  }
  function numOrZero(v) {
    var n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }
  /** 可见短状态文案：state + 动态数值，两端完全相同。 */
  function statusText(state, ctx, lang) {
    var lines = STATUS_LINES[String(state || 'idle')] || STATUS_LINES.idle;
    var t = String(lang === 'en' ? lines[1] : lines[0]);
    var c = ctx || {};
    t = t.split('{t}').join(String(numOrZero(c.today)))
      .split('{a}').join(String(numOrZero(c.available)))
      .split('{n}').join(String(numOrZero(c.n)))
      .split('{m}').join(String(numOrZero(c.m)))
      .split('{s}').join(String(numOrZero(c.sec != null ? c.sec : c.s)))
      .split('{q}').join(String(numOrZero(c.searches)))
      .split('{c}').join(String(numOrZero(c.clicked)));
    return clampStatus(t);
  }
  /** 详细全文：给 aria-label / title / 日志 detail，不受 15 字限制。 */
  function statusFull(state, ctx, lang) {
    var c = ctx || {}, en = lang === 'en';
    var ts = systemTime(Number(c.at) || Date.now());
    var head = en ? 'Human Search Assistant · ' : '拟人搜索助手 · ';
    var st = String(state || 'idle');
    var body;
    if (st === 'syncing') {
      body = en ? 'Syncing · reading ' + TEXT.syncPagesEn + ' · reason ' + String(c.reason || '')
        : '正在同步 · 读取' + TEXT.syncPagesZh + ' · 触发原因 ' + String(c.reason || '');
    } else if (st === 'synced' || st === 'syncFresh') {
      body = en
        ? 'Synced · today ' + numOrZero(c.today) + ' / ' + numOrZero(c.available) +
          ' pts available · ' + String(c.source || 'official live') +
          (st === 'syncFresh' ? ' · no change since last sync' : '') +
          ' · ' + numOrZero(c.durationMs) + 'ms'
        : '同步完成 · 今日 ' + numOrZero(c.today) + ' 分 / 可用 ' + numOrZero(c.available) +
          ' 分 · 来源' + String(c.source || '官网实时') +
          (st === 'syncFresh' ? ' · 与上次一致，未写业务字段' : '') +
          ' · 耗时 ' + numOrZero(c.durationMs) + ' 毫秒';
    } else if (st === 'syncFailed') {
      body = en ? 'Sync failed · kept last points and tasks · ' + String(c.reason || '')
        : '同步未完成 · 保留上次积分与任务数据 · 原因 ' + String(c.reason || '');
    } else if (st === 'skipRecent' || st === 'skipRunning' || st === 'skipMerged') {
      body = en
        ? 'Sync skipped · ' + String(c.code || st) + ' · last sync ' +
          numOrZero(c.elapsedSec) + 's ago · wait ' + numOrZero(c.waitMs) + 'ms · no request sent'
        : '跳过本次同步 · ' + String(c.code || st) + ' · 距上次成功同步 ' +
          numOrZero(c.elapsedSec) + ' 秒 · 还需等待 ' + numOrZero(c.waitMs) +
          ' 毫秒 · 不发起官网请求';
    } else if (st === 'allDone') {
      body = en ? 'All daily tasks complete · stopped all tasks and scheduled sync · resumes next day'
        : '今日任务已全部完成 · 已停止所有任务与定时同步 · 次日（UTC+8）自动恢复';
    } else if (st === 'done') {
      body = en ? 'Run finished · ' + numOrZero(c.clicked) + ' cards / ' +
        numOrZero(c.searches) + ' searches'
        : '任务完成 · 点击 ' + numOrZero(c.clicked) + ' 张卡片 / 搜索 ' +
          numOrZero(c.searches) + ' 次';
    } else if (st === 'cards' || st === 'searching' || st === 'waiting') {
      body = en ? st + ' · ' + numOrZero(c.n) + '/' + numOrZero(c.m)
        : st + ' · ' + numOrZero(c.n) + '/' + numOrZero(c.m);
    } else {
      body = statusText(st, c, en ? 'en' : 'zh');
    }
    return head + body + ' · ' + String(ts);
  }
  /** 一次状态变化的完整载荷：短文案 + 详细全文，两端共用。 */
  function syncActivity(state, ctx) {
    var st = String(state || 'idle'), c = ctx || {};
    return Object.freeze({
      state: st,
      zh: statusText(st, c, 'zh'),
      en: statusText(st, c, 'en'),
      fullZh: statusFull(st, c, 'zh'),
      fullEn: statusFull(st, c, 'en'),
      green: !!STATUS_GREEN[st]
    });
  }

  /* ======================================================================
   * v3.2 · 统一同步闸门（两端共用同一份实现）
   *
   * 日志诊断（桌面 15:13–17:08 十次相同「90/495」同步、插件 7 秒内 4 次
   * 全量同步）指向三个缺口：打开界面只读 60 秒冷却、并发同步无合并、
   * 任务全部完成后仍持续触发。这里一次补齐：
   *   · passive 30 分钟 / manual 10 秒 / internal 2 秒分档冷却；
   *   · single-flight 合并并发请求；
   *   · allDone 当日停止全部任务与被动同步，跨 UTC+8 日界自动解除；
   *   · 业务指纹一致时标「已是最新」，不重复写业务字段；
   *   · 每次决策都写两端同构的日志与短状态。
   * ==================================================================== */
  var SYNC_ON_OPEN = Object.freeze({
    messageType: 'syncOnOpen',
    reason: 'ui-open',
    /* v3.2 · 用户要求「同步 30 分钟内不触发打开主界面主动同步」。 */
    minGapMs: 30 * 60 * 1000,
    storageKey: 'syncOnOpenAt'
  });
  var SYNC_GATE = Object.freeze({
    uiOpenGapMs: 30 * 60 * 1000,
    manualGapMs: 10 * 1000,
    internalGapMs: 2 * 1000,
    allDoneGapMs: 30 * 60 * 1000,
    stateKey: 'hsaSyncState',
    allDoneKey: 'allDoneAt',
    reasonClass: Object.freeze({
      'ui-open': 'passive', 'login-return': 'passive',
      'syncRewards': 'passive', 'scheduledRun': 'passive',
      'autoTaskTick': 'passive', 'watchdog': 'passive', 'reminderTick': 'passive',
      'manual-refresh': 'manual', 'refreshTasks': 'manual',
      'refreshPoints': 'manual', 'refreshToday': 'manual', 'user-refresh': 'manual',
      'start': 'internal', 'finish': 'internal', 'points': 'internal',
      'run-start': 'internal', 'run-finish': 'internal', 'refresh': 'internal'
    })
  });
  function syncReasonClass(reason) {
    return SYNC_GATE.reasonClass[String(reason || '')] || 'passive';
  }
  /** 当日全部完成 → 停止所有任务；跨日自动解除。force 为显式强制例外。 */
  function tasksStopped(allDoneAt, now, force) {
    if (force === true) return false;
    var t = Number(allDoneAt);
    if (!Number.isFinite(t) || t <= 0) return false;
    var n = Number.isFinite(now) ? now : Date.now();
    if (n < t) return false;
    return hotDayKey(t) === hotDayKey(n);
  }
  /** 统一同步决策：allow / code(ok|forced|running|allDone|cooldown) / waitMs。 */
  function syncDecision(ctx) {
    var c = ctx || {};
    var now = Number.isFinite(c.now) ? c.now : Date.now();
    var cls = syncReasonClass(c.reason);
    var gap = cls === 'manual' ? SYNC_GATE.manualGapMs
      : cls === 'internal' ? SYNC_GATE.internalGapMs : SYNC_GATE.uiOpenGapMs;
    if (c.force === true) {
      return { allow: true, code: 'forced', cls: cls, gapMs: 0, waitMs: 0 };
    }
    if (c.running === true && cls !== 'internal') {
      return { allow: false, code: 'running', cls: cls, gapMs: gap, waitMs: 0 };
    }
    var stopped = tasksStopped(c.allDoneAt, now, false);
    if (stopped && cls === 'passive') {
      return { allow: false, code: 'allDone', cls: cls, gapMs: gap, waitMs: 0 };
    }
    if (stopped && cls === 'manual') gap = Math.max(gap, SYNC_GATE.allDoneGapMs);
    var last = Number(c.state && c.state.at) || 0;
    var elapsed = last > 0 ? now - last : Infinity;
    if (Number.isFinite(elapsed) && elapsed < gap) {
      return { allow: false, code: 'cooldown', cls: cls, gapMs: gap,
               waitMs: Math.max(0, gap - elapsed), elapsedMs: Math.max(0, elapsed) };
    }
    return { allow: true, code: 'ok', cls: cls, gapMs: gap, waitMs: 0,
             elapsedMs: Number.isFinite(elapsed) ? elapsed : 0 };
  }
  /** 业务指纹：只看会改变界面的字段，排除 updatedAt / collectedAt 时间戳。 */
  function syncFingerprint(result) {
    var r = result || {};
    var ps = r.pointsSummary || {};
    var ts = r.todaySearch || {};
    var items = (r.todayTasks && Array.isArray(r.todayTasks.items))
      ? r.todayTasks.items : [];
    var cards = items.map(function (it) {
      return [String(it.id || it.name || ''), Number(it.done) || 0,
        Number(it.total) || 0, !!it.completed];
    });
    try {
      return JSON.stringify({
        available: Number(ps.available) || 0,
        today: Number(ps.today) || 0,
        claimable: Number(ps.claimable) || 0,
        login: String(r.loginStatus || ''),
        progress: Number(ts.progress) || 0,
        max: Number(ts.max) || 0,
        cards: cards
      });
    } catch (err) { return ''; }
  }
  /** 跳过时返回的业务快照：只保留界面与任务链路需要的小字段。 */
  function syncSummary(result) {
    var r = result || {};
    var ps = r.pointsSummary || {};
    var tt = r.todayTasks || {};
    var ts = r.todaySearch || {};
    return {
      ok: true,
      pointsSummary: { available: Number(ps.available) || 0,
        today: Number(ps.today) || 0, claimable: Number(ps.claimable) || 0,
        signedOut: !!ps.signedOut, updatedAt: Number(ps.updatedAt) || 0 },
      todayTasks: { items: Array.isArray(tt.items) ? tt.items.slice(0, 20) : [],
        approx: !!tt.approx },
      todaySearch: { progress: Number(ts.progress) || 0, max: Number(ts.max) || 0 },
      loginStatus: String(r.loginStatus || ''),
      todayActivities: Array.isArray(r.todayActivities) ? r.todayActivities.slice(0, 20) : []
    };
  }

  /**
   * 创建同步闸门。adapter 注入宿主能力，逻辑本身两端零差异：
   *   sync(opts) / load(keys) / store(patch) / log(event, info) /
   *   activity(payload) / now() / onStopAll()
   */
  function createSyncGate(adapter) {
    var a = adapter || {};
    var inflight = null;
    function now() { return a.now ? a.now() : Date.now(); }
    function log(event, info) {
      try { if (a.log) a.log(event, info); } catch (err) {}
    }
    function activity(state, ctx) {
      try { if (a.activity) a.activity(syncActivity(state, ctx)); } catch (err) {}
    }
    function loadState() {
      return Promise.resolve(a.load
        ? a.load([SYNC_GATE.stateKey, SYNC_GATE.allDoneKey, 'running']) : {})
        .then(function (v) { return v || {}; })
        .catch(function () { return {}; });
    }
    function saveState(patch) {
      return Promise.resolve(a.store ? a.store(patch) : null)
        .catch(function () {});
    }
    function skipPayload(d, prev, reason) {
      var st = d.code === 'allDone' ? 'allDone'
        : d.code === 'running' ? 'skipRunning' : 'skipRecent';
      var ctx = {
        reason: reason, code: d.code, waitMs: d.waitMs, gapMs: d.gapMs,
        elapsedSec: Math.round((d.elapsedMs || 0) / 1000)
      };
      activity(st, ctx);
      log('sync-skipped', {
        level: 'info', category: 'result', actor: 'system',
        event: 'sync-skipped', result: 'skipped', ok: true,
        reason: String(reason || ''), code: d.code,
        detail: statusFull(st, ctx, 'zh'),
        zh: syncActivity(st, ctx).zh, en: syncActivity(st, ctx).en,
        state: st, durationMs: d.waitMs
      });
      return Object.assign({}, prev.summary || {}, {
        ok: true, skipped: true, fromGate: true, reason: d.code,
        cooldownMs: d.gapMs, waitMs: d.waitMs
      });
    }
    function request(opts) {
      var o = opts || {}, reason = String(o.reason || '');
      return loadState().then(function (snap) {
        var t = now();
        var prev = snap[SYNC_GATE.stateKey] || {};
        var d = syncDecision({
          reason: reason, now: t, running: snap.running === true,
          state: prev, allDoneAt: snap[SYNC_GATE.allDoneKey], force: !!o.force
        });
        if (!d.allow) return skipPayload(d, prev, reason);
        if (inflight) {
          log('sync-merged', {
            level: 'info', category: 'result', actor: 'system',
            event: 'sync-merged', result: 'merged', ok: true,
            reason: reason, detail: statusFull('skipMerged', { reason: reason }, 'zh'),
            zh: syncActivity('skipMerged', {}).zh,
            en: syncActivity('skipMerged', {}).en, state: 'skipMerged'
          });
          return inflight;
        }
        var started = now();
        activity('syncing', { reason: reason });
        log('sync-start', {
          level: 'info', category: 'run-step', actor: 'system',
          event: 'sync-start', reason: reason, state: 'syncing', ok: true,
          detail: statusFull('syncing', { reason: reason, at: started }, 'zh'),
          zh: syncActivity('syncing', {}).zh, en: syncActivity('syncing', {}).en
        });
        var p;
        try {
          p = Promise.resolve(a.sync
            ? a.sync(Object.assign({}, o, { fresh: true, noTabs: true }))
            : { ok: false, error: 'no sync adapter' });
        } catch (err) {
          p = Promise.resolve({ ok: false, error: String(err && err.message || err) });
        }
        inflight = p.then(function (raw) {
          var r = raw || {}, t2 = now(), ok = !!r.ok;
          var fp = syncFingerprint(r);
          var unchanged = !!fp && fp === String(prev.fingerprint || '');
          var ps = r.pointsSummary || {};
          var ctx = {
            today: ps.today, available: ps.available, reason: reason,
            source: r.dataSourceLabel || '官网实时', durationMs: t2 - started,
            at: t2
          };
          var st = ok ? (unchanged ? 'syncFresh' : 'synced') : 'syncFailed';
          activity(st, ctx);
          log(ok ? 'sync-done' : 'sync-error', {
            level: ok ? 'info' : 'error', category: ok ? 'result' : 'error',
            actor: 'system', event: ok ? 'sync-done' : 'sync-error',
            state: st, ok: ok, result: ok ? (unchanged ? 'unchanged' : 'synced') : 'failed',
            reason: reason, detail: statusFull(st, ctx, 'zh'),
            zh: syncActivity(st, ctx).zh, en: syncActivity(st, ctx).en,
            durationMs: t2 - started, count: (r.changed || []).length
          });
          var notice = {
            at: t2, reason: reason, ok: ok,
            unchanged: !!unchanged, changed: (r.changed || []).length
          };
          if (ok) {
            var next = {
              at: t2, ok: true, reason: reason, fingerprint: fp,
              summary: syncSummary(r)
            };
            return saveState({ [SYNC_GATE.stateKey]: next, syncNotice: notice })
              .then(function () { return r; });
          }
          return saveState({ syncNotice: notice }).then(function () { return r; });
        }).catch(function (err) {
          var msg = String(err && err.message || err);
          activity('syncFailed', { reason: reason, error: msg });
          log('sync-error', {
            level: 'error', category: 'error', actor: 'system',
            event: 'sync-error', state: 'syncFailed', ok: false,
            reason: reason, error: msg,
            detail: statusFull('syncFailed', { reason: msg }, 'zh'),
            zh: syncActivity('syncFailed', {}).zh,
            en: syncActivity('syncFailed', {}).en
          });
          return { ok: false, reason: 'error', error: msg };
        }).then(function (r) { inflight = null; return r; },
                function (e) { inflight = null; throw e; });
        return inflight;
      });
    }
    function noteAllDone(reason) {
      var t = now();
      activity('allDone', { reason: String(reason || ''), at: t });
      log('tasks-stopped', {
        level: 'info', category: 'result', actor: 'system',
        event: 'tasks-stopped', result: 'stopped', ok: true, state: 'allDone',
        reason: String(reason || ''), detail: statusFull('allDone', { at: t }, 'zh'),
        zh: syncActivity('allDone', {}).zh, en: syncActivity('allDone', {}).en
      });
      return saveState({
        [SYNC_GATE.allDoneKey]: t, running: false, phase: 'completed',
        stopRequested: false, lastActivity: t
      }).then(function () {
        try { if (a.onStopAll) a.onStopAll(); } catch (err) {}
        return t;
      });
    }
    function guardTaskStart() {
      return loadState().then(function (snap) {
        var t = now();
        if (!tasksStopped(snap[SYNC_GATE.allDoneKey], t, false)) return null;
        activity('allDone', { reason: 'task-start', at: t });
        log('tasks-stopped', {
          level: 'info', category: 'result', actor: 'system',
          event: 'tasks-stopped', result: 'blocked', ok: true, state: 'allDone',
          reason: 'task-start', detail: statusFull('allDone', { at: t }, 'zh'),
          zh: syncActivity('allDone', {}).zh, en: syncActivity('allDone', {}).en
        });
        return allDoneResult({ source: 'sync-gate', stopped: true });
      });
    }
    function isStopped() {
      return loadState().then(function (snap) {
        return tasksStopped(snap[SYNC_GATE.allDoneKey], now(), false);
      });
    }
    function snapshot() {
      return { inflight: !!inflight, stateKey: SYNC_GATE.stateKey,
        allDoneKey: SYNC_GATE.allDoneKey };
    }
    return {
      request: request, noteAllDone: noteAllDone, guardTaskStart: guardTaskStart,
      isStopped: isStopped, activity: activity, snapshot: snapshot
    };
  }

  /** 打开主界面同步判定（popup 端第一道闸；后台 syncGate 再按全局
      同步状态兜 30 分钟冷却与「当日全部完成」停止态）。 */
  function syncOnOpenAllowed(running, lastAt, now, minGapMs) {
    if (running === true) return false;
    var t = Number.isFinite(now) ? now : Date.now();
    var gap = Number.isFinite(minGapMs) && minGapMs > 0 ? minGapMs : SYNC_ON_OPEN.minGapMs;
    var last = Number(lastAt);
    if (Number.isFinite(last) && last > 0 && t - last < gap) return false;
    return true;
  }


  /* S01 · B：状态行显示运行详情（当前步骤 / 动态倒计时），全文可悬停查看。 */
  function formatActivityLine(detail, lang, now) {
    var t = Number.isFinite(now) ? now : Date.now();
    var a = detail || {};
    if (!a.at) return null;
    if (a.active === false && t - a.at > 12000) return null;
    var tpl = String((lang === 'en' ? a.en : a.zh) || '');
    if (!tpl) return null;
    var green = !!STATUS_GREEN[String(a.state)];
    var until = a.state === 'waiting' && Number(a.until) > t ? Number(a.until) : 0;
    var text = tpl.split('{s}').join(String(
      until ? Math.max(0, Math.ceil((until - t) / 1000)) : 0));
    return { text: text, template: tpl, until: until, green: green, detail: a };
  }

  function manualLinkNotice(count, lang) {
    return String(count) + (lang === 'en' ? TEXT.manualLinksEn : TEXT.manualLinks);
  }

  return {
    VERSION: VERSION,
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
    manualLinkNotice: manualLinkNotice,
    STRICT_RUN: STRICT_RUN,
    hotDayKey: hotDayKey,
    isSameDayHot: isSameDayHot,
    isStrictKeyword: isStrictKeyword,
    strictQueries: strictQueries,
    USED_WORDS_MAX: USED_WORDS_MAX,
    usedWordKey: usedWordKey,
    todayUsedState: todayUsedState,
    mergeUsedWords: mergeUsedWords,
    dropUsedWords: dropUsedWords,
    todayUsedPush: todayUsedPush,
    strictRuntimeFeatureAllowed: strictRuntimeFeatureAllowed,
    strictBlockedMessage: strictBlockedMessage,
    strictAlarmAllowed: strictAlarmAllowed,
    strictRunPolicy: strictRunPolicy,
    RUNLOG: RUNLOG,
    KEY_CAPTURE: KEY_CAPTURE,
    stamp: stamp,
    runLogFileName: runLogFileName,
    keyPageFileName: keyPageFileName,
    runLogAppend: runLogAppend,
    runLogExport: runLogExport,
    keyPagePolicy: keyPagePolicy,
    keyPageExport: keyPageExport,
    systemTime: systemTime,
    domIndex: domIndex,
    taskListOrder: taskListOrder,
    taskListNames: taskListNames,
    calendarNavAllowed: calendarNavAllowed,
    calendarReset: calendarReset,
    keyPageZipFiles: keyPageZipFiles,
    SYNC_ON_OPEN: SYNC_ON_OPEN,
    syncOnOpenAllowed: syncOnOpenAllowed,
    STATUS_MAX_WIDTH: STATUS_MAX_WIDTH,
    STATUS_LINES: STATUS_LINES,
    RUN_LINES: RUN_LINES,
    runActivity: runActivity,
    planTaskClicks: planTaskClicks,
    pendingTaskItems: pendingTaskItems,
    isNonClickableTaskItem: isNonClickableTaskItem,
    SEARCH_PROGRESS_NAMES: SEARCH_PROGRESS_NAMES,
    hasClickableCards: hasClickableCards,
    applyTaskCompletion: applyTaskCompletion,
    buildTaskPlan: buildTaskPlan,
    taskPlanNames: taskPlanNames,
    INTERVALS: INTERVALS,
    INTERVAL_SETTING_KEYS: INTERVAL_SETTING_KEYS,
    intervalDefaultSec: intervalDefaultSec,
    clampIntervalMs: clampIntervalMs,
    normalizeIntervals: normalizeIntervals,
    displayWidth: displayWidth,
    clampStatus: clampStatus,
    statusText: statusText,
    statusFull: statusFull,
    syncActivity: syncActivity,
    SYNC_GATE: SYNC_GATE,
    syncReasonClass: syncReasonClass,
    syncDecision: syncDecision,
    syncFingerprint: syncFingerprint,
    syncSummary: syncSummary,
    createSyncGate: createSyncGate,
    tasksStopped: tasksStopped
  };
});
