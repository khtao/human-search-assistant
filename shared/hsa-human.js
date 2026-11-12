/* ============================================================================
 * hsa-human.js · v3.9 拟人增强引擎（两端同源，纯函数，无浏览器依赖）
 *
 *   · 保留严格档：strictRunPolicy() 完全不动；本模块只在 runMode='human' 时生效。
 *   · 强度低/中/高 → 完成 20 次自动搜索 ≈ 15 / 30 / 60 分钟。
 *   · 所有间隔随机，但按「每项动作大致均匀分配」拆段（低方差抖动 + 总量守恒）。
 *   · 噪声：时间抖动、三次贝塞尔鼠标轨迹（含轻微过冲回正）、偶发多余动作。
 *   · 会话画像：一次运行固定一套节奏/词序偏好；词只重排、不补词/编词/复用。
 *   · 卡片点击：随机间隔一个一个开，接近人手动点开的情形。
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HSA_HUMAN = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SEARCHES = 20;                 /* 强度定义的基准搜索次数 */
  var LEVELS = Object.freeze({
    low:  Object.freeze({ key: 'low',  n: 1, zh: '低', en: 'Low',    targetMinutes: 15, perRoundMs: 45000 }),
    mid:  Object.freeze({ key: 'mid',  n: 2, zh: '中', en: 'Medium', targetMinutes: 30, perRoundMs: 90000 }),
    high: Object.freeze({ key: 'high', n: 3, zh: '高', en: 'High',   targetMinutes: 60, perRoundMs: 180000 })
  });
  var MODES = Object.freeze(['strict', 'human']);
  var ROUND_SEGMENTS = Object.freeze(['move', 'type', 'submit', 'settle', 'browse', 'gap']);
  var EXTRA_ACTIONS = Object.freeze(['pause', 'hover', 'microMove', 'backScroll', 'doubleCheck']);

  var DEFAULT_SETTINGS = Object.freeze({
    runMode: 'human',          /* 默认拟人增强；'strict' 仍是完整保留的固定节奏档 */
    humanLevel: 'mid',
    humanNoise: true,          /* 时间抖动 + 贝塞尔轨迹 + 偶发多余动作 */
    humanBrowse: true,         /* 结果页正常浏览：适度滚动 / 偶尔点开结果再返回 */
    humanSession: true,        /* 会话画像 + 更自然的词序 */
    fingerprintCheck: true,    /* 环境指纹交叉一致性自检 */
    geoConsistency: true       /* 出口 IP / 时区 / 语言 / 市场 / 作息自洽 */
  });

  function normalizeSettings(s) {
    var o = {}, t = s || {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      var v = t[k];
      o[k] = (typeof DEFAULT_SETTINGS[k] === 'boolean')
        ? (typeof v === 'boolean' ? v : DEFAULT_SETTINGS[k])
        : v;
    });
    o.runMode = MODES.indexOf(o.runMode) >= 0 ? o.runMode : DEFAULT_SETTINGS.runMode;
    o.humanLevel = levelFromValue(o.humanLevel).key;
    return o;
  }
  function levelFromValue(v) {
    var n = Number(v);
    if (n === 1) return LEVELS.low;
    if (n === 3) return LEVELS.high;
    if (n === 2) return LEVELS.mid;
    if (v === 'low') return LEVELS.low;
    if (v === 'high') return LEVELS.high;
    return LEVELS.mid;
  }
  function isEnabled(settings) {
    return normalizeSettings(settings).runMode !== 'strict';
  }

  /* 可复现 PRNG：测试与「一次运行固定画像」都靠它，不用 Math.random 直接散落。 */
  /* ======================================================================
   * v4.2 · 三组预设：由「拟人强度」统一管理 7 个专业数值项
   *
   * 设置页不再让用户逐项调「单次配额上限 / 启动抖动上限 / 卡片点击间隔 /
   * 键鼠动作间隔 / 页面稳定等待 / 搜索轮间间隔 / 单轮等待」。全部收进
   * 低 / 中 / 高三档，切档即整组套用；UI 只做只读展示。
   *
   * 三组（语义分组）：
   *   ① quota  配额与启动  → singleRunCapPct / scheduleJitterMin
   *   ② action 动作节奏    → cardClickIntervalSec / actionGapSec
   *   ③ page   页面与轮次  → pageStableSec / roundGapSec / roundWaitSec
   *
   * 强度越高越慢、越分散、越保守；与 LEVELS 的 15/30/60 分钟同向。
   * 严格档返回原 settings，一字不覆盖（逐字回到 v3.7 固定间隔）。
   * ==================================================================== */
  var PRESET_GROUPS = Object.freeze([
    Object.freeze({ key: 'quota', keys: Object.freeze(['singleRunCapPct', 'scheduleJitterMin']) }),
    Object.freeze({ key: 'action', keys: Object.freeze(['cardClickIntervalSec', 'actionGapSec']) }),
    Object.freeze({ key: 'page', keys: Object.freeze(['pageStableSec', 'roundGapSec', 'roundWaitSec']) })
  ]);
  var RUN_PRESETS = Object.freeze({
    low: Object.freeze({
      singleRunCapPct: 80, scheduleJitterMin: 10,
      cardClickIntervalSec: 3, actionGapSec: 0.4,
      pageStableSec: 2, roundGapSec: 6, roundWaitSec: 2
    }),
    mid: Object.freeze({
      singleRunCapPct: 60, scheduleJitterMin: 20,
      cardClickIntervalSec: 5, actionGapSec: 0.6,
      pageStableSec: 3, roundGapSec: 10, roundWaitSec: 3
    }),
    high: Object.freeze({
      singleRunCapPct: 40, scheduleJitterMin: 30,
      cardClickIntervalSec: 8, actionGapSec: 1.0,
      pageStableSec: 5, roundGapSec: 16, roundWaitSec: 5
    })
  });
  function presetFor(level, runMode) {
    if (String(runMode) === 'strict') return null;
    var lv = levelFromValue(level);
    return { key: lv.key, n: lv.n, targetMinutes: lv.targetMinutes,
      values: Object.assign({}, RUN_PRESETS[lv.key]), groups: PRESET_GROUPS };
  }
  /** 后台 getSettings() 用：拟人档整组套用；严格档原样返回。 */
  function applyRunPreset(settings) {
    var t = settings || {};
    var pre = presetFor(t.humanLevel, t.runMode);
    if (!pre) return Object.assign({}, t);
    return Object.assign({}, t, pre.values, {
      runPresetLevel: pre.key, runPresetMinutes: pre.targetMinutes
    });
  }
  /** 设置页只读摘要用；严格档返回 null（UI 显示「固定默认值」）。 */
  function presetValues(level, runMode) {
    var pre = presetFor(level, runMode);
    if (!pre) return null;
    return { level: pre.key, n: pre.n, minutes: pre.targetMinutes,
      groups: PRESET_GROUPS, values: pre.values };
  }

  function mulberry32(seed) {
    var a = (Number(seed) >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(v) {
    var s = String(v == null ? '' : v), h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /** 会话画像：一次运行只建一次，之后整轮节奏/词序/噪声幅度固定。 */
  function createProfile(settings, seed) {
    var cfg = normalizeSettings(settings);
    var lv = levelFromValue(cfg.humanLevel);
    var sd = (seed == null ? Date.now() : Number(seed)) >>> 0;
    var rng = mulberry32(sd);
    return {
      mode: cfg.runMode,
      enabled: cfg.runMode !== 'strict',
      cfg: cfg,
      level: lv.key,
      targetMinutes: lv.targetMinutes,
      perRoundMs: lv.perRoundMs,
      seed: sd,
      rng: rng,
      /* 会话级偏差，幅度很小，保证 20 轮总时长仍贴近标称值 */
      tempoBias: 0.97 + rng() * 0.06,
      jitterAmp: cfg.humanNoise ? 0.16 + rng() * 0.06 : 0,
      bezierBend: 0.18 + rng() * 0.22,
      extraRate: cfg.humanNoise ? 0.22 + rng() * 0.12 : 0,
      wordSwapRate: cfg.humanSession ? 0.10 + rng() * 0.12 : 0,
      browseRate: cfg.humanBrowse ? 0.55 + rng() * 0.25 : 0,
      noise: cfg.humanNoise,
      browse: cfg.humanBrowse,
      session: cfg.humanSession,
      fingerprintCheck: cfg.fingerprintCheck,
      geoConsistency: cfg.geoConsistency
    };
  }

  /** 把总预算随机但「大致均匀」地分给各段：低方差权重 → 夹取 → 补回差值。 */
  function allocateBudget(totalMs, segments, rng, opts) {
    var list = Array.isArray(segments) ? segments.slice() : ROUND_SEGMENTS.slice();
    var total = Math.max(0, Number(totalMs) || 0);
    var n = list.length, out = {}, i;
    if (!n) return { segments: out, sum: 0 };
    var amp = Math.min(0.35, Math.max(0, Number(opts && opts.jitterAmp) || 0));
    var base = total / n;
    var lo = base * (1 - amp * 1.5), hi = base * (1 + amp * 1.5);
    var w = [], sumW = 0;
    for (i = 0; i < n; i++) {
      var v = 1 + amp * (rng() * 2 - 1);   /* 对称低方差抖动 */
      w.push(v); sumW += v;
    }
    var sum = 0;
    for (i = 0; i < n; i++) {
      var raw = total * w[i] / sumW;
      var clamped = Math.max(lo, Math.min(hi, raw));
      out[list[i]] = clamped; sum += clamped;
    }
    /* 总量守恒：把 clamp 造成的差值按权重补回去，仍然围绕各自均值。 */
    var diff = total - sum;
    if (Math.abs(diff) > 0.001) {
      var wsum = 0;
      for (i = 0; i < n; i++) wsum += w[i];
      for (i = 0; i < n; i++) {
        out[list[i]] = Math.max(0, out[list[i]] + diff * w[i] / wsum);
      }
    }
    return { segments: out, sum: total, base: base, min: Math.min.apply(null, list.map(function (k) { return out[k]; })),
      max: Math.max.apply(null, list.map(function (k) { return out[k]; })) };
  }

  /** 单轮预算：强度 × 会话偏差 × 地理作息系数（由 hsa-geo 给出）。 */
  function roundBudget(profile, scheduleFactor) {
    var f = Number(scheduleFactor);
    if (!Number.isFinite(f) || f <= 0) f = 1;
    return Math.round(profile.perRoundMs * profile.tempoBias * f);
  }
  function splitRound(budgetMs, profile) {
    var r = allocateBudget(budgetMs, ROUND_SEGMENTS, profile.rng,
      { jitterAmp: profile.jitterAmp });
    /* 运行链路按 *Ms 取值（gapMs / browseMs / settleMs ...），
       这里一次补齐别名，避免轮间等待被 undefined 吞掉。 */
    ROUND_SEGMENTS.forEach(function (k) { r.segments[k + 'Ms'] = r.segments[k]; });
    return r;
  }
  /** 有界时间抖动：不越 [ms*(1-amp), ms*(1+amp)]。 */
  function jitter(ms, amp, rng) {
    var a = Math.min(0.45, Math.max(0, Number(amp) || 0));
    return Math.max(1, Math.round((Number(ms) || 0) * (1 + a * (rng() * 2 - 1))));
  }

  /** 三次贝塞尔鼠标轨迹：起点→终点，控制点随机侧偏，末端轻微过冲再回正。 */
  function bezierPath(from, to, rng, opts) {
    var f = [Number(from && from[0]) || 0, Number(from && from[1]) || 0];
    var t = [Number(to && to[0]) || 0, Number(to && to[1]) || 0];
    var bend = Number(opts && opts.bend);
    if (!Number.isFinite(bend)) bend = 0.28;
    var dx = t[0] - f[0], dy = t[1] - f[1];
    var len = Math.max(24, Math.sqrt(dx * dx + dy * dy));
    var nx = -dy / len, ny = dx / len;
    var s1 = (rng() * 2 - 1) * bend * len, s2 = (rng() * 2 - 1) * bend * len;
    var c1 = [f[0] + dx * 0.3 + nx * s1, f[1] + dy * 0.3 + ny * s1];
    var c2 = [f[0] + dx * 0.72 + nx * s2, f[1] + dy * 0.72 + ny * s2];
    var steps = 8 + Math.floor(rng() * 6);
    var points = [], i;
    for (i = 0; i <= steps; i++) {
      var u = i / steps, v = 1 - u;
      var x = v * v * v * f[0] + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * t[0];
      var y = v * v * v * f[1] + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * t[1];
      /* 人手动：起止慢、中间快；再叠一点微抖动（噪声） */
      var ease = 0.55 + 0.75 * Math.sin(Math.PI * u);
      points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
        dt: Math.round(12 + 26 * (1 - ease) + rng() * 8) });
    }
    /* 轻微过冲：越过目标一点点再回正，像真人收不住手 */
    if (opts && opts.overshoot !== false) {
      var ox = Math.round((t[0] + (rng() * 2 - 1) * len * 0.035) * 10) / 10;
      var oy = Math.round((t[1] + (rng() * 2 - 1) * len * 0.035) * 10) / 10;
      points.push({ x: ox, y: oy, dt: 28 });
      points.push({ x: t[0], y: t[1], dt: 36 });
    } else {
      points.push({ x: t[0], y: t[1], dt: 36 });
    }
    return {
      points: points, center: [t[0], t[1]],
      beforeMs: 40 + Math.round(rng() * 150),
      downMs: 45 + Math.round(rng() * 70)
    };
  }

  /** 偶发多余动作：0~2 个，带时长；运行期按序插入，不改变任务语义。 */
  function extraActions(rng, rate) {
    var p = Math.max(0, Math.min(1, Number(rate) || 0));
    var out = [], count = rng() < p ? (rng() < 0.25 ? 2 : 1) : 0;
    for (var i = 0; i < count; i++) {
      var a = EXTRA_ACTIONS[Math.floor(rng() * EXTRA_ACTIONS.length)];
      out.push({ action: a, ms: 120 + Math.round(rng() * 900) });
    }
    return out;
  }

  /** 结果页「正常浏览」：适度滚动、鼠标移动、偶尔点开一条结果再返回。 */
  function browsePlan(profile, rng) {
    var rate = profile.browse ? profile.browseRate : 0;
    var scrolls = [], n = rng() < rate ? 1 + Math.floor(rng() * 3) : 0;
    for (var i = 0; i < n; i++) {
      var dy = 180 + Math.round(rng() * 460);
      if (rng() < 0.18) dy = -Math.round(dy * 0.45);
      scrolls.push({ dy: dy, dt: 350 + Math.round(rng() * 900) });
    }
    return {
      scrolls: scrolls,
      openResult: profile.browse && rng() < rate * 0.35,
      returnMs: 900 + Math.round(rng() * 1600),
      mouseMoves: 2 + Math.floor(rng() * 4)
    };
  }

  /** 词策略：只做轻微相邻重排（画像固定 → 词序固定），不增/删/补/复用。 */
  function wordOrder(queries, profile) {
    var list = Array.isArray(queries) ? queries.slice() : [];
    if (!profile.session || profile.wordSwapRate <= 0) return list;
    var r = profile.rng, p = profile.wordSwapRate;
    for (var i = 0; i < list.length - 1; i++) {
      if (r() < p) { var tmp = list[i]; list[i] = list[i + 1]; list[i + 1] = tmp; i++; }
    }
    return list;
  }

  /** 卡片：按随机间隔一个一个开，节奏接近人手动点开；偶发一次长停顿。 */
  function cardSpacing(profile, rng, baseMs, scheduleFactor) {
    var base = Math.max(300, Number(baseMs) || 10000);
    var f = Number(scheduleFactor); if (!Number.isFinite(f) || f <= 0) f = 1;
    var amp = profile.noise ? profile.jitterAmp + 0.14 : 0;
    var v = jitter(base * f, amp, rng);
    var pause = profile.noise && rng() < profile.extraRate * 0.5
      ? 1200 + Math.round(rng() * 3500) : 0;
    return { delayMs: v + pause, baseMs: base, pauseMs: pause, factor: f };
  }

  /** 自检：20 轮总时长贴标称值、各段均匀、随机可复现、轨迹终点正确、词不增删。 */
  function selftest() {
    var out = { ok: true, cases: [] };
    Object.keys(LEVELS).forEach(function (k) {
      var p = createProfile({ runMode: 'human', humanLevel: k }, 12345);
      var total = 0, ratios = [];
      for (var i = 0; i < SEARCHES; i++) {
        var b = roundBudget(p, 1), sp = splitRound(b, p);
        total += b;
        var vals = ROUND_SEGMENTS.map(function (s) { return sp.segments[s]; });
        ratios.push(Math.max.apply(null, vals) / Math.max(1, Math.min.apply(null, vals)));
      }
      var minutes = total / 60000, target = LEVELS[k].targetMinutes;
      var ok = Math.abs(minutes - target) / target < 0.05
        && Math.max.apply(null, ratios) < 1.6;
      out.cases.push({ level: k, minutes: Math.round(minutes * 100) / 100,
        target: target, maxSegmentRatio: Math.round(Math.max.apply(null, ratios) * 100) / 100, ok: ok });
      if (!ok) out.ok = false;
    });
    var a = createProfile({}, 1), b = createProfile({}, 2);
    var sa = splitRound(90000, a).segments.gap, sb = splitRound(90000, b).segments.gap;
    out.random = sa !== sb;
    var c1 = createProfile({}, 7), c2 = createProfile({}, 7);
    out.reproducible = splitRound(90000, c1).segments.gap === splitRound(90000, c2).segments.gap;
    var path = bezierPath([10, 10], [300, 220], mulberry32(9), {});
    out.path = path.points.length >= 9
      && path.points[path.points.length - 1].x === 300
      && path.points[path.points.length - 1].y === 220;
    var words = ['第一天热搜词甲', '第二天热搜词乙', '第三天热搜词丙'];
    var wo = wordOrder(words, createProfile({}, 3));
    out.words = wo.length === words.length
      && words.every(function (w) { return wo.indexOf(w) >= 0; });
    var sp = cardSpacing(createProfile({}, 4), mulberry32(4), 10000, 1);
    out.cardRandom = sp.delayMs > 0;
    /* v4.2 · 三组预设自检 */
    out.presetKeys = ['singleRunCapPct', 'scheduleJitterMin', 'cardClickIntervalSec',
      'actionGapSec', 'pageStableSec', 'roundGapSec', 'roundWaitSec']
      .every(function (x) {
        return ['low', 'mid', 'high'].every(function (k) {
          return Number.isFinite(RUN_PRESETS[k][x]);
        });
      });
    var pl = RUN_PRESETS.low, pm = RUN_PRESETS.mid, ph = RUN_PRESETS.high;
    out.presetMonotonic = pl.singleRunCapPct > pm.singleRunCapPct
      && pm.singleRunCapPct > ph.singleRunCapPct
      && pl.scheduleJitterMin < pm.scheduleJitterMin
      && pm.scheduleJitterMin < ph.scheduleJitterMin
      && pl.cardClickIntervalSec < pm.cardClickIntervalSec
      && pm.cardClickIntervalSec < ph.cardClickIntervalSec
      && pl.roundGapSec < pm.roundGapSec && pm.roundGapSec < ph.roundGapSec
      && PRESET_GROUPS.length === 3
      && PRESET_GROUPS.reduce(function (a, g) { return a + g.keys.length; }, 0) === 7;
    var rawStrict = { runMode: 'strict', humanLevel: 'high', roundGapSec: 42 };
    out.presetStrict = applyRunPreset(rawStrict).roundGapSec === 42
      && presetFor('high', 'strict') === null
      && presetValues('high', 'strict') === null;
    var pa = applyRunPreset({ runMode: 'human', humanLevel: 1, roundGapSec: 999 });
    var pc = applyRunPreset({ runMode: 'human', humanLevel: 'high' });
    out.presetHuman = pa.roundGapSec === 6 && pa.singleRunCapPct === 80
      && pa.runPresetLevel === 'low'
      && pc.roundGapSec === 16 && pc.singleRunCapPct === 40
      && pc.runPresetLevel === 'high';
    out.ok = out.ok && out.presetKeys && out.presetMonotonic
      && out.presetStrict && out.presetHuman
      && out.random && out.reproducible && out.path && out.words && out.cardRandom;
    return out;
  }

  return {
    VERSION: '1.0.0',
    SEARCHES: SEARCHES,
    LEVELS: LEVELS,
    MODES: MODES,
    PRESET_GROUPS: PRESET_GROUPS,
    RUN_PRESETS: RUN_PRESETS,
    presetFor: presetFor,
    applyRunPreset: applyRunPreset,
    presetValues: presetValues,
    ROUND_SEGMENTS: ROUND_SEGMENTS,
    EXTRA_ACTIONS: EXTRA_ACTIONS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeSettings: normalizeSettings,
    levelFromValue: levelFromValue,
    isEnabled: isEnabled,
    mulberry32: mulberry32,
    hashSeed: hashSeed,
    createProfile: createProfile,
    allocateBudget: allocateBudget,
    roundBudget: roundBudget,
    splitRound: splitRound,
    jitter: jitter,
    bezierPath: bezierPath,
    extraActions: extraActions,
    browsePlan: browsePlan,
    wordOrder: wordOrder,
    cardSpacing: cardSpacing,
    selftest: selftest
  };
});
