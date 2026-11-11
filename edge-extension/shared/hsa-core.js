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
  function strictRunPolicy() {
    return Object.freeze({
      minKeywordChars: STRICT_RUN.minKeywordChars,
      maxKeywordChars: STRICT_RUN.maxKeywordChars,
      fixedNapMs: STRICT_RUN.fixedNapMs,
      fixedRoundWaitMs: STRICT_RUN.fixedRoundWaitMs,
      pageStableWaitMs: DEFAULTS.pageStableWaitMs,
      fixedRoundIntervalMs: STRICT_RUN.fixedRoundIntervalMs,
      goHome: false,
      relatedRewrite: false,
      humanVariation: false,
      randomDelay: false,
      scroll: false,
      clickResult: false,
      disabledFeatures: STRICT_RUN.disabledFeatures.slice()
    });
  }

  var VERSION = '2.3.0';

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
     * v3.0 · 打开主界面时同步一次（两端一致）
     *  · 正在运行：一律跳过（popup 先读 running，后台严格模式白名单再兜一层）；
     *  · 重复打开：最小间隔节流，避免桌面窗口反复 show / focus 造成密集官网请求；
     *  · 只做一次 fresh 同步，不启动任务、不改设置、不触碰侧栏。
     * ==================================================================== */
  var SYNC_ON_OPEN = Object.freeze({
    messageType: 'syncOnOpen',
    reason: 'ui-open',
    minGapMs: 60000,
    storageKey: 'syncOnOpenAt'
  });
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
    syncOnOpenAllowed: syncOnOpenAllowed
  };
});
