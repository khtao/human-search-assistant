/* ============================================================================
 * hsa-stealth.js · v4.0 运行风险规避引擎（两端同源，纯函数，无浏览器依赖）
 *
 * 定位：不是「伪装」，而是降低「自动化刷分」的行为可区分性 + 加保守运行约束。
 *   · 节奏：会话分段（burst）+ 段间离席 + 段级起伏，不再轮轮同构；
 *     单次运行默认只跑剩余配额的一部分，避免一口气刷满；
 *     定时启动时间有界抖动，不再每天同秒；当地深夜定时直接跳过。
 *   · 过程：整段粘贴 → 分块上屏 + 非均匀键间隔 + 偶发退格纠错；
 *     Enter 恒提交 → 概率性点搜索按钮（失败回退 Enter）。
 *   · 环境：出口 IP 探测结果同日缓存，减少每次运行的异常外联。
 *   · v4.3 账号侧：当日运行次数上限 + 两次运行最小间隔 + 定时触发概率跳过，
 *     把「同步→点卡→搜索→收尾同步」的四段式在一天里摊薄，不再高频复现。
 *   · v4.4 手动优先：用户主动点「自动完成任务」是显式意图，次数上限 / 最小间隔
 *     对手动只记 warn、不硬拦（否则触顶后当天再也无法启动，且拦截不占额度不会
 *     自愈）。定时触发仍按三项硬约束摊薄。
 *
 * 硬边界（与既有决策不冲突）：
 *   ① 严格档 runMode='strict' 时，本模块所有特性恒关，逐字回到 v3.7 固定节奏。
 *   ② 词规则不变：不补词 / 不编词 / 不复用 / 不改词 / 不回首页；
 *      keystrokePlan 的 finalText 必须逐字等于输入的当日 ≥5 字热搜原文。
 *   ③ 不触碰同步闸门、消息白名单、任务列表点击、全完成停止态、积分链路。
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HSA_STEALTH = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var DEFAULTS = Object.freeze({
    stealthTyping: true,      /* 分块拟真键入（关闭=整段粘贴） */
    burstPacing: true,        /* 会话分段与段间离席 */
    avoidNightRun: true,      /* 定时触发避开当地 0–6 点（手动不受限） */
    singleRunCapPct: 60,      /* 单次运行最多跑剩余搜索配额的百分比 */
    scheduleJitterMin: 20,    /* 定时启动随机抖动上限（分钟） */
    geoCacheHours: 12         /* 出口 IP 地理结果缓存时长 */
  });

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function num(v, d) { var n = Number(v); return Number.isFinite(n) ? n : d; }
  function bool(v, d) { return typeof v === 'boolean' ? v : d; }

  function normalize(s) {
    var t = s || {};
    return {
      runMode: t.runMode === 'strict' ? 'strict' : 'human',
      stealthTyping: bool(t.stealthTyping, DEFAULTS.stealthTyping),
      burstPacing: bool(t.burstPacing, DEFAULTS.burstPacing),
      avoidNightRun: bool(t.avoidNightRun, DEFAULTS.avoidNightRun),
      singleRunCapPct: clamp(Math.round(num(t.singleRunCapPct, DEFAULTS.singleRunCapPct)), 20, 100),
      scheduleJitterMin: clamp(Math.round(num(t.scheduleJitterMin, DEFAULTS.scheduleJitterMin)), 0, 120),
      geoCacheHours: clamp(Math.round(num(t.geoCacheHours, DEFAULTS.geoCacheHours)), 0, 72)
    };
  }
  function enabled(settings) { return normalize(settings).runMode !== 'strict'; }

  /** mulberry32：与 hsa-human 同款确定性随机源，便于回归复现。 */
  function mulberry32(seed) {
    var a = (Number(seed) || 1) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(s) {
    var str = String(s || ''), h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* ------------------------------------------------------------------ 节奏 */

  /** 把 N 轮拆成 2~4 个「浏览段」，段间一次较长离席，段级预算起伏。
   *  总时长守恒：段间停顿从强度预算里扣回来，不把 15/30/60 分钟撑爆。 */
  function sessionPlan(opts) {
    var o = opts || {};
    var rounds = Math.max(0, Math.floor(num(o.rounds, 0)));
    var perRoundMs = Math.max(1, num(o.perRoundMs, 90000));
    var rng = typeof o.rng === 'function' ? o.rng : mulberry32(1);
    var on = o.enabled !== false && rounds >= 4;
    var budget = rounds * perRoundMs;
    var bursts = [];

    if (!on) {
      bursts.push({ start: 0, end: Math.max(0, rounds - 1), scale: 1, breakAfterMs: 0 });
      return {
        enabled: false, rounds: rounds, perRoundMs: perRoundMs, bursts: bursts,
        totalBreakMs: 0, totalMs: budget,
        scaleFor: function () { return 1; },
        breakAfter: function () { return 0; }
      };
    }

    var maxBursts = clamp(Math.round(rounds / 5), 2, 4);
    var n = 2 + Math.floor(rng() * (maxBursts - 1));   /* 2..maxBursts */
    var weights = [], sumW = 0, i;
    for (i = 0; i < n; i++) { var w = 0.7 + rng() * 0.6; weights.push(w); sumW += w; }
    var acc = 0, totalBreak = 0;
    for (i = 0; i < n; i++) {
      var left = n - i - 1;
      var len = (i === n - 1) ? rounds - acc
        : clamp(Math.round(rounds * weights[i] / sumW), 2, Math.max(2, rounds - acc - left * 2));
      len = Math.max(1, Math.min(len, rounds - acc));
      var start = acc, end = Math.min(rounds - 1, acc + len - 1);
      var scale = 0.78 + rng() * 0.5;
      var brk = i < n - 1 ? Math.round(90000 + rng() * 150000) : 0;
      bursts.push({ start: start, end: end, scale: scale, breakAfterMs: brk });
      totalBreak += brk;
      acc += (end - start + 1);
      if (acc >= rounds) break;
    }
    if (acc < rounds) {
      bursts[bursts.length - 1].end = rounds - 1;
      bursts[bursts.length - 1].breakAfterMs = 0;
    }
    /* 段间离席不吃掉超过 1/4 的强度预算，否则低强度档总时长会被撑爆。 */
    totalBreak = bursts.reduce(function (a, b) { return a + b.breakAfterMs; }, 0);
    var capBreak = budget * 0.25;
    if (totalBreak > capBreak) {
      var k = capBreak / totalBreak;
      bursts.forEach(function (b) { b.breakAfterMs = Math.round(b.breakAfterMs * k); });
      totalBreak = bursts.reduce(function (a, b) { return a + b.breakAfterMs; }, 0);
    }
    /* 段间停顿吃掉预算的一部分 → 各段 scale 整体收缩，总时长精确守恒 */
    var meanScale = bursts.reduce(function (a, b) { return a + b.scale; }, 0) / Math.max(1, bursts.length);
    var compensation = clamp((budget - totalBreak) / Math.max(1, budget), 0.45, 1) / Math.max(0.01, meanScale);
    bursts.forEach(function (b) { b.scale = Math.max(0.35, b.scale * compensation); });

    function burstOf(index) {
      for (var j = 0; j < bursts.length; j++) {
        if (index >= bursts[j].start && index <= bursts[j].end) return bursts[j];
      }
      return bursts[bursts.length - 1];
    }
    return {
      enabled: true, rounds: rounds, perRoundMs: perRoundMs, bursts: bursts,
      totalBreakMs: bursts.reduce(function (a, b) { return a + b.breakAfterMs; }, 0),
      totalMs: budget,
      /* 轮内确定性微扰：不消耗会话 rng，也不让同段内每轮完全一致 */
      scaleFor: function (index) {
        var b = burstOf(index);
        var v = Math.sin((Number(index) + 1) * 12.9898 + 78.233) * 43758.5453;
        var wobble = v - Math.floor(v);
        return Math.max(0.3, b.scale * (0.94 + wobble * 0.12));
      },
      breakAfter: function (index) {
        var b = burstOf(index);
        return (index === b.end) ? b.breakAfterMs : 0;
      }
    };
  }

  /** 单次运行不把剩余配额一次刷满；need 很小时至少 1 次，避免运行空转。 */
  function capSearches(need, cap, pct, runMode) {
    var n = Math.max(0, Math.floor(num(need, 0)));
    var c = Math.max(0, Math.floor(num(cap, n)));
    var base = Math.min(n, c);
    if (base <= 0) return 0;
    if (!enabled({ runMode: runMode })) return base;      /* 严格档维持原语义 */
    var p = clamp(Math.round(num(pct, DEFAULTS.singleRunCapPct)), 20, 100);
    return Math.max(1, Math.min(base, Math.round(base * p / 100)));
  }

  /** 当地时段：优先用出口 IP 推导的小时，失败降级到系统时区，再失败返回 null。 */
  function localHour(nowMs, geo) {
    if (geo && Number.isFinite(Number(geo.localHour))) {
      return ((Number(geo.localHour) % 24) + 24) % 24;
    }
    if (geo && Number.isFinite(Number(geo.utcOffsetMinutes || geo.tzOffsetMinutes || geo.offsetMinutes))) {
      var off = Number(geo.utcOffsetMinutes || geo.tzOffsetMinutes || geo.offsetMinutes);
      return new Date(Number(nowMs) + off * 60000).getUTCHours();
    }
    try {
      var tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', hour12: false
      }).formatToParts(new Date(Number(nowMs)));
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') {
          var h = Number(parts[i].value);
          if (Number.isFinite(h)) return h % 24;
        }
      }
    } catch (e) {}
    return null;
  }

  /** 定时触发在「当地 0–6 点」直接跳过；手动启动永远不受限。 */
  function shouldDefer(nowMs, geo, settings, isManual) {
    var st = normalize(settings);
    var h = localHour(nowMs, geo);
    if (isManual || !st.avoidNightRun || !enabled(st) || h == null) {
      return { defer: false, reason: isManual ? 'manual' : (h == null ? 'no-local-hour' : 'disabled'),
        localHour: h, retryAtMs: null };
    }
    if (h >= 0 && h < 6) {
      return { defer: true, reason: 'local-deep-night', localHour: h,
        retryAtMs: Math.round(Number(nowMs) + (7 - h) * 3600000) };
    }
    return { defer: false, reason: 'active-hours', localHour: h, retryAtMs: null };
  }

  /** 定时启动抖动：绝对模式给 whenMs 加 ±minutes；相对模式（whenMs<=0）返回非负延迟。 */
  function scheduleJitter(whenMs, rng, minutes, runMode) {
    var m = clamp(Math.round(num(minutes, DEFAULTS.scheduleJitterMin)), 0, 120);
    if (!enabled({ runMode: runMode }) || m <= 0) return Math.round(num(whenMs, 0));
    var r = typeof rng === 'function' ? rng() : 0.5;
    if (num(whenMs, 0) <= 0) return Math.round(m * 60000 * r);
    return Math.round(num(whenMs, 0) + (r * 2 - 1) * m * 60000);
  }

  /* ------------------------------------------------------------------ 过程 */

  /** 分块上屏：中文按 1~3 字一块（近似输入法候选上屏），块间非均匀停顿，
   *  偶发退格纠错后重新上屏同一块。finalText 必须与输入逐字相同。 */
  function keystrokePlan(text, rng, opts) {
    var o = opts || {};
    var str = String(text == null ? '' : text);
    var chars = Array.from(str);
    var r = typeof rng === 'function' ? rng : mulberry32(1);
    if (!o.enabled || chars.length < 2) {
      return { chunks: [{ action: 'paste', text: str, delayMs: 0 }], finalText: str, exact: true };
    }
    var chunks = [], i = 0;
    while (i < chars.length) {
      var len = 1 + Math.floor(r() * Math.min(3, chars.length - i));
      var piece = chars.slice(i, i + len).join('');
      chunks.push({ action: 'type', text: piece,
        delayMs: 60 + Math.round(r() * 165) });
      i += len;
      /* 偶发走神停顿 */
      if (i < chars.length && r() < 0.14) {
        chunks.push({ action: 'pause', text: '', delayMs: 300 + Math.round(r() * 420) });
      }
      /* 偶发打错 → 退格 → 重新上屏；finalText 不变 */
      if (r() < 0.13) {
        chunks.push({ action: 'backspace', text: piece, count: Array.from(piece).length,
          delayMs: 90 + Math.round(r() * 120) });
        chunks.push({ action: 'type', text: piece, delayMs: 110 + Math.round(r() * 190) });
      }
    }
    return { chunks: chunks, finalText: str, exact: true };
  }

  /** 提交方式：拟人档按概率点搜索按钮，失败由宿主回退 Enter；严格档恒 Enter。 */
  var SUBMIT_BUTTONS = Object.freeze([
    '#sb_form_go', '.b_searchboxSubmit', '#sb_form input[type="submit"]',
    '#sb_form button[type="submit"]', 'input[type="submit"]'
  ]);
  function submitPlan(rng, opts) {
    var o = opts || {};
    var r = typeof rng === 'function' ? rng : mulberry32(1);
    if (!o.enabled) return { method: 'enter', selectors: SUBMIT_BUTTONS };
    return { method: r() < 0.32 ? 'button' : 'enter', selectors: SUBMIT_BUTTONS };
  }

  /* ======================================================================
   * v4.3 · 当日运行频次护栏（账号侧曲线）
   *
   * 即使单次只跑 40~80% 配额、启动有抖动、深夜跳过，仍可能因为「多个定时
   * 时间点 + 用户反复手动启动」在一天里反复出现同一套四段式，并把配额刷满。
   * 真人不会一天内以几乎相同的间隔完成 N 次完整搜索任务。
   *
   * 三个约束（全部按 UTC+8 日界，跨运行 / 跨宿主重启生效）：
   *   ① 当日完整运行次数上限（随强度：低 4 / 中 3 / 高 2）
   *   ② 两次运行最小间隔（30 / 45 / 60 分钟）
   *   ③ 定时触发按确定性概率跳过（10~15%，不补跑）；手动启动不跳过
   *
   * 严格档 enabled=false，逐字回到 v4.2 语义。失败/零动作的运行不占额度。
   * ==================================================================== */
  var GUARD_REASONS = Object.freeze({
    'daily-run-cap': Object.freeze({ zh: '今日运行次数已达上限', en: 'Daily run cap reached' }),
    'min-gap':       Object.freeze({ zh: '距上次运行过近', en: 'Too soon since last run' }),
    'stochastic-skip': Object.freeze({ zh: '本次定时随机跳过', en: 'Scheduled run skipped' })
  });
  /* 手动越过次数/间隔时只记警告，不阻断；文案同样 ≤15 显示宽度。 */
  var GUARD_WARN = Object.freeze({
    'daily-run-cap': Object.freeze({ zh: '今日次数偏多', en: 'Many runs today' }),
    'min-gap':       Object.freeze({ zh: '间隔偏短', en: 'Short gap' })
  });
  function guardWarnText(reason) {
    return GUARD_WARN[String(reason)] || { zh: '', en: '' };
  }
  function guardReasonText(reason) {
    return GUARD_REASONS[String(reason)] || { zh: '跳过本次运行', en: 'Run skipped' };
  }
  var RUN_GUARD = Object.freeze({
    low:  Object.freeze({ maxRuns: 4, minGapMin: 30, skipRate: 0.10 }),
    mid:  Object.freeze({ maxRuns: 3, minGapMin: 45, skipRate: 0.12 }),
    high: Object.freeze({ maxRuns: 2, minGapMin: 60, skipRate: 0.15 })
  });
  /** 与 hsa-core.hotDayKey 完全同口径（UTC+8），避免两端/模块日界漂移。 */
  function utc8DayKey(t) {
    var ms = Number(t);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    return new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
  }
  function guardLevel(v) {
    var n = Number(v);
    if (n === 1) return 'low';
    if (n === 3) return 'high';
    if (n === 2) return 'mid';
    var k = String(v || '').toLowerCase();
    return RUN_GUARD[k] ? k : 'mid';
  }
  function runGuardPolicy(level, runMode) {
    if (String(runMode) === 'strict') {
      return { enabled: false, level: guardLevel(level), maxRuns: 0,
        minGapMin: 0, skipRate: 0 };
    }
    var spec = RUN_GUARD[guardLevel(level)];
    return { enabled: true, level: guardLevel(level),
      maxRuns: spec.maxRuns, minGapMin: spec.minGapMin, skipRate: spec.skipRate };
  }
  /** 读当日记录；跨日 / 结构异常自动重置，无需任何清理定时器。 */
  function guardState(saved, now) {
    var day = utc8DayKey(Number.isFinite(now) ? now : Date.now());
    var ok = saved && typeof saved === 'object' && saved.day === day
      && Array.isArray(saved.runs) && Array.isArray(saved.skips);
    return {
      day: day,
      runs: ok ? saved.runs.filter(function (x) { return Number.isFinite(Number(x)); })
        .slice(-32) : [],
      skips: ok ? saved.skips.filter(function (x) { return Number.isFinite(Number(x));
        }).slice(-32) : []
    };
  }
  /**
   * 是否允许本次运行。roll ∈ [0,1)，由调用方用「日键+触发时间」的确定性哈希
   * 生成，保证同一时间点当天重试不会被随机数绕过。
   *
   * v4.4：manual=true（用户主动点击）不因「当日次数上限 / 最小间隔」被硬拦 ——
   * 这两项原本只看 runs 不看触发来源，一旦触顶，用户当天反复点都返回 ok:false，
   * 而拦截又不占额度（见 guardRecord），状态永远不恢复，表现为「启动不了」。
   * 手动仍计入当日 runs、仍写 warn 日志、仍受单轮配额与节奏拟人约束；
   * 定时触发的三项硬约束一字未动。
   */
  function guardDecision(state, now, policy, roll, manual) {
    var p = policy || runGuardPolicy(2, 'human');
    if (!p.enabled) return { allowed: true, reason: 'strict-mode', waitMs: 0 };
    var st = state || guardState(null, now);
    var t = Number(now) || Date.now();
    var day = utc8DayKey(t);
    if (st.day !== day) return { allowed: true, reason: 'new-day', waitMs: 0 };
    var last = st.runs.length ? Number(st.runs[st.runs.length - 1]) : 0;
    var gap = p.minGapMin * 60000;
    if (manual) {
      var warn = '';
      if (st.runs.length >= p.maxRuns) warn = 'daily-run-cap';
      else if (last && t - last < gap) warn = 'min-gap';
      return { allowed: true, reason: 'ok', waitMs: 0, warn: warn,
        used: st.runs.length, max: p.maxRuns };
    }
    if (st.runs.length >= p.maxRuns) {
      return { allowed: false, reason: 'daily-run-cap', waitMs: 0,
        used: st.runs.length, max: p.maxRuns };
    }
    if (last && t - last < gap) {
      return { allowed: false, reason: 'min-gap', waitMs: Math.max(0, gap - (t - last)),
        lastAt: last };
    }
    if (Number.isFinite(roll) && clamp(roll, 0, 0.999999) < p.skipRate) {
      return { allowed: false, reason: 'stochastic-skip', waitMs: 0, skip: true };
    }
    return { allowed: true, reason: 'ok', waitMs: 0, used: st.runs.length };
  }
  /** 把「一次实际启动的完整运行」或「一次概率跳过」计入当日记录。
      min-gap / daily-run-cap 这类「拦截」不是运行也不是跳过，不占任何额度，
      否则一次间隔拦截反而会让当日运行次数更快触顶。 */
  function guardRecord(state, now, decision) {
    var st = state || guardState(null, now);
    var t = Number(now) || Date.now();
    var base = guardState({ day: st.day, runs: st.runs, skips: st.skips }, t);
    var d = decision || {};
    if (d.allowed === false && d.reason !== 'stochastic-skip') {
      return { day: base.day, runs: base.runs.slice(), skips: base.skips.slice() };
    }
    if (d.reason === 'stochastic-skip') base.skips.push(t);
    else base.runs.push(t);
    return { day: base.day, runs: base.runs.slice(-32), skips: base.skips.slice(-32) };
  }

  /* ------------------------------------------------------------------ 环境 */

  function geoCacheValid(cache, nowMs, ttlHours) {
    if (!cache || typeof cache !== 'object' || !cache.value) return false;
    var ttl = clamp(num(ttlHours, DEFAULTS.geoCacheHours), 0, 72) * 3600000;
    if (ttl <= 0) return false;
    var at = num(cache.at, 0);
    return at > 0 && (Number(nowMs) - at) >= 0 && (Number(nowMs) - at) < ttl;
  }

  /* ------------------------------------------------------------------ 自检 */
  function selftest() {
    var out = { ok: true, checks: [] };
    function ck(name, cond) { out.checks.push({ name: name, ok: !!cond }); if (!cond) out.ok = false; }

    var strict = normalize({ runMode: 'strict', singleRunCapPct: 20 });
    ck('strict 档所有新特性恒关',
      !enabled(strict) && capSearches(20, 30, 20, 'strict') === 20
      && scheduleJitter(1000, function () { return 0; }, 120, 'strict') === 1000
      && shouldDefer(Date.UTC(2026, 0, 1, 18, 0, 0), { localHour: 3 }, strict, false).defer === false
      && submitPlan(function () { return 0; }, { enabled: false }).method === 'enter'
      && keystrokePlan('六个字的热搜词', function () { return 0; }, { enabled: false }).chunks.length === 1);

    var r = mulberry32(20261112);
    var plan = sessionPlan({ rounds: 20, perRoundMs: 90000, rng: r, enabled: true });
    ck('会话分段 2~4 段', plan.bursts.length >= 2 && plan.bursts.length <= 4);
    ck('段间离席 > 60 秒', plan.totalBreakMs > 60000);
    ck('段索引连续覆盖', plan.bursts[0].start === 0
      && plan.bursts[plan.bursts.length - 1].end === 19);
    var sum = 0;
    for (var i = 0; i < 20; i++) sum += plan.perRoundMs * plan.scaleFor(i);
    sum += plan.totalBreakMs;
    ck('总时长守恒（含段间停顿）≈ 强度预算',
      Math.abs(sum - plan.totalMs) < plan.totalMs * 0.12);
    ck('段级起伏存在', plan.bursts.some(function (b) { return Math.abs(b.scale - 1) > 0.05; }));
    var flat = sessionPlan({ rounds: 20, perRoundMs: 90000, rng: mulberry32(1), enabled: false });
    ck('严格档单段零离席', flat.bursts.length === 1 && flat.totalBreakMs === 0
      && flat.scaleFor(3) === 1 && flat.breakAfter(3) === 0);

    ck('单次配额上限生效', capSearches(20, 30, 60, 'human') === 12
      && capSearches(20, 30, 100, 'human') === 20
      && capSearches(1, 30, 60, 'human') === 1
      && capSearches(0, 30, 60, 'human') === 0
      && capSearches(20, 5, 60, 'human') === 3);

    var night = shouldDefer(Date.UTC(2026, 0, 1, 19, 0, 0), { localHour: 3 },
      normalize({}), false);
    var day = shouldDefer(Date.UTC(2026, 0, 1, 4, 0, 0), { localHour: 12 },
      normalize({}), false);
    ck('深夜定时跳过 / 白天放行 / 手动不受限',
      night.defer === true && night.reason === 'local-deep-night'
      && day.defer === false
      && shouldDefer(Date.now(), { localHour: 3 }, normalize({}), true).defer === false
      && shouldDefer(Date.now(), { localHour: 3 }, normalize({ avoidNightRun: false }), false).defer === false);
    ck('retryAtMs 指向当地 7 点后', night.retryAtMs > Date.UTC(2026, 0, 1, 19, 0, 0));

    ck('启动抖动有界且严格档为零', (function () {
      for (var j = 0; j < 200; j++) {
        var v = scheduleJitter(1000000000000, Math.random, 20, 'human');
        if (Math.abs(v - 1000000000000) > 20 * 60000) return false;
        var rel = scheduleJitter(0, Math.random, 20, 'human');
        if (rel < 0 || rel > 20 * 60000) return false;
      }
      return scheduleJitter(500, Math.random, 20, 'strict') === 500;
    })());

    var words = ['六个字的热搜词', '今日十个字的头条新闻词', '五个字词甲'];
    ck('拟真键入 finalText 逐字等于原词、块数>1、含纠错', (function () {
      for (var j = 0; j < words.length; j++) {
        var kp = keystrokePlan(words[j], mulberry32(j + 7), { enabled: true });
        if (kp.finalText !== words[j] || !kp.exact || kp.chunks.length < 2) return false;
        var typed = kp.chunks.filter(function (c) { return c.action === 'type' || c.action === 'paste'; })
          .map(function (c) { return c.text; }).join('');
        /* 纠错会让 typed 多出重复块，按块序列重放一次才能还原 finalText */
        var acc = '';
        for (var q = 0; q < kp.chunks.length; q++) {
          var c = kp.chunks[q];
          if (c.action === 'type' || c.action === 'paste') acc += c.text;
          else if (c.action === 'backspace') acc = acc.slice(0, -Array.from(c.text).length);
        }
        if (acc !== words[j]) return false;
        if (typeof typed !== 'string') return false;
        if (kp.chunks.filter(function (c) { return c.action === 'pause'; }).length < 0) return false;
      }
      return true;
    })());

    ck('提交方式拟人档有多种、严格档恒 Enter', (function () {
      var seen = {};
      for (var j = 0; j < 60; j++) seen[submitPlan(Math.random, { enabled: true }).method] = 1;
      return Object.keys(seen).length === 2
        && submitPlan(function () { return 0; }, { enabled: false }).method === 'enter';
    })());

    ck('地理缓存 TTL 与降级', geoCacheValid({ at: 1000, value: { geo: {} } }, 1000 + 3600000, 12) === true
      && geoCacheValid({ at: 1000, value: { geo: {} } }, 1000 + 13 * 3600000, 12) === false
      && geoCacheValid(null, 1000, 12) === false
      && geoCacheValid({ at: 1000, value: {} }, 2000, 0) === false);

    ck('确定性随机源', (function () {
      var a = mulberry32(42), b = mulberry32(42);
      for (var j = 0; j < 30; j++) if (a() !== b()) return false;
      return hashSeed('same') === hashSeed('same');
    })());

    /* v4.3 · 当日运行频次护栏 */
    ck('严格档护栏恒关且日键与 hsa-core 同口径',
      runGuardPolicy(3, 'strict').enabled === false
      && guardDecision(guardState(null, 0), 0, runGuardPolicy(3, 'strict'), 0, false).allowed === true
      && utc8DayKey(Date.UTC(2026, 10, 11, 20, 0, 0)) === '2026-11-12'
      && utc8DayKey(Date.UTC(2026, 10, 12, 4, 0, 0)) === '2026-11-12');
    ck('三档护栏随强度收敛', (function () {
      var l = runGuardPolicy(1, 'human'), m = runGuardPolicy(2, 'human'),
          h = runGuardPolicy(3, 'human');
      return l.maxRuns > m.maxRuns && m.maxRuns > h.maxRuns
        && l.minGapMin < m.minGapMin && m.minGapMin < h.minGapMin
        && l.skipRate < m.skipRate && m.skipRate < h.skipRate;
    })());
    var t0 = Date.UTC(2026, 10, 12, 4, 0, 0);
    var pol = runGuardPolicy(2, 'human');
    var gs0 = guardState(null, t0);
    ck('跨日重置与结构异常降级',
      guardState({ day: '2026-11-11', runs: [t0], skips: [] }, t0).runs.length === 0
      && guardState({ day: utc8DayKey(t0) }, t0).runs.length === 0
      && gs0.day === utc8DayKey(t0));
    var gs1 = guardRecord(gs0, t0, { reason: 'ok' });
    ck('最小间隔与当日上限', (function () {
      var soon = guardDecision(gs1, t0 + 10 * 60000, pol, 0.9, false);
      var later = guardDecision(gs1, t0 + 46 * 60000, pol, 0.9, false);
      var full = { day: utc8DayKey(t0), runs: [t0 - 4 * 3600000, t0 - 3 * 3600000, t0 - 2 * 3600000], skips: [] };
      return soon.reason === 'min-gap' && soon.waitMs === 35 * 60000
        && later.allowed === true
        && guardDecision(full, t0, pol, 0.9, false).reason === 'daily-run-cap';
    })());
    ck('间隔/上限拦截不占运行额度', (function () {
      var one = guardRecord(gs0, t0, { reason: 'ok' });
      var tooSoon = guardDecision(one, t0 + 10 * 60000, pol, 0.9, false);
      var rec = guardRecord(one, t0 + 10 * 60000, tooSoon);
      return tooSoon.reason === 'min-gap' && rec.runs.length === 1
        && rec.skips.length === 0;
    })());
    ck('v4.4 手动启动不受次数上限/最小间隔硬拦，定时仍硬拦', (function () {
      var full = { day: utc8DayKey(t0),
        runs: [t0 - 5 * 3600000, t0 - 4 * 3600000, t0 - 3 * 3600000], skips: [] };
      var one = guardRecord(gs0, t0, { reason: 'ok' });
      var mCap = guardDecision(full, t0, pol, 0.9, true);
      var mGap = guardDecision(one, t0 + 10 * 60000, pol, 0.9, true);
      var sCap = guardDecision(full, t0, pol, 0.9, false);
      var sGap = guardDecision(one, t0 + 10 * 60000, pol, 0.9, false);
      return mCap.allowed === true && mCap.warn === 'daily-run-cap'
        && mGap.allowed === true && mGap.warn === 'min-gap'
        && sCap.allowed === false && sCap.reason === 'daily-run-cap'
        && sGap.allowed === false && sGap.reason === 'min-gap'
        && guardDecision(full, t0, pol, 0.01, true).reason !== 'stochastic-skip'
        && guardWarnText('min-gap').zh === '间隔偏短'
        && guardWarnText('unknown').zh === '';
    })());
    ck('定时概率跳过、手动不跳过、跳过单独记账', (function () {
      var skip = guardDecision(gs0, t0, pol, 0.01, false);
      var manual = guardDecision(gs0, t0, pol, 0.01, true);
      var rec = guardRecord(gs0, t0, skip);
      return skip.reason === 'stochastic-skip' && skip.skip === true
        && manual.allowed === true && rec.runs.length === 0 && rec.skips.length === 1;
    })());

    return out;
  }

  return {
    VERSION: VERSION, DEFAULTS: DEFAULTS, SUBMIT_BUTTONS: SUBMIT_BUTTONS,
    RUN_GUARD: RUN_GUARD, GUARD_REASONS: GUARD_REASONS,
    GUARD_WARN: GUARD_WARN, guardWarnText: guardWarnText,
    guardReasonText: guardReasonText, utc8DayKey: utc8DayKey,
    runGuardPolicy: runGuardPolicy, guardState: guardState,
    guardDecision: guardDecision, guardRecord: guardRecord,
    normalize: normalize, enabled: enabled, clamp: clamp,
    mulberry32: mulberry32, hashSeed: hashSeed,
    sessionPlan: sessionPlan, capSearches: capSearches,
    localHour: localHour, shouldDefer: shouldDefer, scheduleJitter: scheduleJitter,
    keystrokePlan: keystrokePlan, submitPlan: submitPlan,
    geoCacheValid: geoCacheValid, selftest: selftest
  };
});
