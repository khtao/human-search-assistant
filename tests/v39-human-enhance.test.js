'use strict';
/* ============================================================================
 * v3.9 · 拟人增强档（默认开启，严格档可切回）—— 两端同源动态回归
 *   node --test tests/v39-human-enhance.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const H = require(path.join(ROOT, 'shared', 'hsa-human.js'));
const G = require(path.join(ROOT, 'shared', 'hsa-geo.js'));
const FP = require(path.join(ROOT, 'shared', 'hsa-fingerprint.js'));
const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));

const EB = read('edge-extension/background.js');
const DB = read('desktop-app/src/background.js');
const DM = read('desktop-app/main.js');
const EH = read('edge-extension/popup.html');
const DH = read('desktop-app/src/popup.html');

test('v3.9 · 三个新共享模块自检全部通过', () => {
  for (const [name, mod] of [['human', H], ['geo', G], ['fingerprint', FP]]) {
    const r = mod.selftest();
    assert.equal(r.ok, true, name + ' selftest 失败：' + JSON.stringify(r).slice(0, 300));
    assert.equal(mod.VERSION, '1.0.0');
  }
  assert.equal(H.selftest().cases.every(c => c.ok), true);
});

test('v3.9 · 默认拟人增强档，strict 可完整切回固定节奏', () => {
  assert.equal(H.DEFAULT_SETTINGS.runMode, 'human');
  assert.equal(H.isEnabled(H.DEFAULT_SETTINGS), true);
  assert.equal(H.isEnabled({ runMode: 'strict' }), false);
  assert.equal(H.normalizeSettings({ runMode: 'strict' }).runMode, 'strict');
  assert.equal(H.normalizeSettings({ runMode: 'bad' }).runMode, 'human');
  assert.deepEqual(H.MODES, ['strict', 'human']);
  assert.equal(H.levelFromValue(1).key, 'low');
  assert.equal(H.levelFromValue(2).key, 'mid');
  assert.equal(H.levelFromValue(3).key, 'high');
  assert.equal(H.levelFromValue('high').key, 'high');
  /* v3.7 严格策略本身一行不动 */
  const s = CORE.strictRunPolicy();
  assert.equal(s.fixedNapMs, 600);
  assert.equal(s.pageStableWaitMs, 3000);
  assert.equal(s.fixedRoundIntervalMs, 10000);
  assert.equal(s.fixedRoundWaitMs, 3000);
  assert.equal(s.randomDelay, false);
  assert.equal(s.humanVariation, false);
  assert.equal(s.scroll, false);
  assert.equal(s.clickResult, false);
  assert.equal(CORE.strictRunPolicy({ humanEnhance: true }).humanEnhance, undefined,
    '严格策略不接受 v3.9 的独立开关，档位只由 runMode 决定');
});

test('v3.9 · 会话画像确定性：同 seed 同轨迹 / 同词序 / 同节奏', () => {
  const words = ['五个字的热词甲', '六个字的热搜乙', '七个字的新闻丙',
    '八个字的大事件丁', '九个字今日热搜戊', '十个字的头条己'];
  const a = H.createProfile({ humanLevel: 2 }, 12345);
  const b = H.createProfile({ humanLevel: 2 }, 12345);
  const c = H.createProfile({ humanLevel: 2 }, 12346);
  assert.equal(a.seed, b.seed);
  assert.equal(a.tempoBias, b.tempoBias);
  assert.deepEqual(H.wordOrder(words, a), H.wordOrder(words, b));
  assert.deepEqual(H.bezierPath([10, 20], [400, 300], a.rng, { bend: a.bezierBend }).points,
    H.bezierPath([10, 20], [400, 300], b.rng, { bend: b.bezierBend }).points);
  assert.notDeepEqual(H.bezierPath([10, 20], [400, 300], a.rng, { bend: a.bezierBend }).points,
    H.bezierPath([10, 20], [400, 300], c.rng, { bend: c.bezierBend }).points);
  assert.equal(H.hashSeed('same'), H.hashSeed('same'));
  const r1 = H.mulberry32(7), r2 = H.mulberry32(7);
  for (let i = 0; i < 20; i++) assert.equal(r1(), r2());
});

test('v3.9 · 强度预算：低/中/高 20 轮 ≈ 15/30/60 分钟，分段低方差', () => {
  for (const [level, target] of [['low', 15], ['mid', 30], ['high', 60]]) {
    const p = H.createProfile({ humanLevel: level }, 999);
    let total = 0;
    for (let i = 0; i < H.SEARCHES; i++) total += H.roundBudget(p, 1);
    const minutes = total / 60000;
    assert.ok(Math.abs(minutes - target) < target * 0.15,
      level + ' 总时长 ' + minutes.toFixed(1) + ' 分钟偏离 ' + target);
    const split = H.splitRound(H.roundBudget(p, 1), p);
    assert.equal(split.sum, H.roundBudget(p, 1));
    for (const k of H.ROUND_SEGMENTS) {
      assert.ok(split.segments[k] > 0, k + ' 段必须为正');
      /* 运行链路按 *Ms 取值，别名必须存在且等值（修复轮间等待被吞） */
      assert.equal(split.segments[k + 'Ms'], split.segments[k], k + 'Ms 别名缺失');
    }
    const ratio = split.max / split.min;
    assert.ok(ratio < 1.8, '分段方差过大：' + ratio.toFixed(2));
    assert.ok(split.segments.gapMs > 1000, '轮间等待必须是有效时长');
  }
  /* 抖动有界 */
  const rng = H.mulberry32(3);
  for (let i = 0; i < 500; i++) {
    const v = H.jitter(3000, 0.2, rng);
    assert.ok(v >= 2400 && v <= 3600, 'jitter 越界 ' + v);
  }
  assert.equal(H.jitter(3000, 0, () => 0), 3000);
});

test('v3.9 · 词策略：只重排当日合规原文，不增 / 不改 / 不重复 / 不补词', () => {
  const words = ['五个字的热词甲', '六个字的热搜乙', '七个字的新闻丙',
    '八个字的大事件丁', '九个字今日热搜戊', '十个字的头条己'];
  const p = H.createProfile({ humanSession: true, humanLevel: 3 }, 2026);
  const out = H.wordOrder(words, p);
  assert.equal(out.length, words.length);
  assert.deepEqual(out.slice().sort(), words.slice().sort(), 'multiset 必须相同');
  assert.equal(new Set(out).size, words.length, '不得重复');
  for (const w of out) {
    assert.ok(words.includes(w), '不得编词：' + w);
    assert.ok(CORE.isStrictKeyword(w), '不得引入 <5 字短词');
  }
  /* 关闭会话画像 → 原序逐字不变 */
  const off = H.createProfile({ humanSession: false }, 2026);
  assert.deepEqual(H.wordOrder(words, off), words);
  /* 关闭拟人档（strict）时两端仍走 strictQueries，不调用 wordOrder */
  assert.match(EB, /HSA_CORE\.strictQueries\(/);
  assert.match(DB, /HSA_CORE\.strictQueries\(/);
});

test('v3.9 · 贝塞尔轨迹 / 过冲 / 浏览计划 / 卡片间隔', () => {
  const p = H.createProfile({ humanLevel: 3, humanNoise: true, humanBrowse: true }, 77);
  const pathPlan = H.bezierPath([100, 100], [900, 600], p.rng, { bend: p.bezierBend });
  assert.ok(pathPlan.points.length >= 10, '轨迹点过少');
  assert.deepEqual(pathPlan.center, [900, 600]);
  assert.ok(pathPlan.beforeMs > 0 && pathPlan.downMs > 0);
  for (const pt of pathPlan.points) {
    assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y) && pt.dt > 0);
  }
  /* 过冲回正：末端出现先冲出再拉回的两点 */
  const last = pathPlan.points.slice(-2);
  assert.ok(Math.hypot(last[0].x - 900, last[0].y - 600) > 0
    || Math.hypot(last[1].x - 900, last[1].y - 600) < 6);
  const bp = H.browsePlan(p, p.rng);
  assert.ok(Array.isArray(bp.scrolls));
  assert.equal(typeof bp.openResult, 'boolean');
  assert.ok(bp.returnMs > 0 && bp.mouseMoves > 0);
  const ex = H.extraActions(p.rng, 1);
  assert.ok(ex.length >= 1);
  assert.ok(ex.every(a => H.EXTRA_ACTIONS.includes(a.action) && a.ms > 0));
  const cs = H.cardSpacing(p, p.rng, 10000, 1);
  assert.ok(cs.delayMs > 0 && cs.baseMs === 10000);
  const night = H.cardSpacing(p, H.mulberry32(1), 10000, 2.4);
  const day = H.cardSpacing(p, H.mulberry32(1), 10000, 1);
  assert.ok(night.delayMs > day.delayMs, '深夜作息应拉长间隔');
});

test('v3.9 · 地理一致性：冲突可检出、夜间放缓、探测失败优雅降级', () => {
  const good = G.fallback('zh-CN', 'Asia/Shanghai', Date.UTC(2026, 10, 12, 4, 0, 0));
  const day = G.scheduleFactor(Date.UTC(2026, 10, 12, 4, 0, 0), good).factor;   // 北京 12:00
  const night = G.scheduleFactor(Date.UTC(2026, 10, 11, 19, 0, 0), good).factor; // 北京 03:00
  assert.equal(day, 1);
  assert.ok(night > day);
  assert.ok(G.withMarket('https://www.bing.com/search?q=x', good).includes('mkt='));
  /* 故意错配：美国 IP + 上海时区 + zh-CN 市场 */
  const broken = G.derive({ country_code: 'US', timezone: 'America/New_York',
    city: 'New York', success: true }, good, Date.now());
  const check = G.crossCheck(Object.assign({}, broken, { mkt: 'zh-CN', locale: 'zh-CN' }), Date.now());
  assert.equal(check.ok, false);
  assert.ok(check.conflicts.length >= 1);
  /* 无 fetch 实现时优雅降级，不抛错、不让运行起不来 */
  return G.probe(null, good, Date.now()).then(r => {
    assert.equal(r.source, 'system');
    assert.equal(r.geo.degraded, true);
  });
});

test('v3.9 · 环境指纹：只去自动化标记、补缺失对象，绝不改写 UA / 屏幕 / 硬件值', () => {
  const src = read('shared/hsa-fingerprint.js');
  assert.doesNotMatch(src, /defineProperty\(navigator, 'userAgent'/);
  assert.match(src, /'navigator\.userAgent'/);
  const ctx = {
    navigator: { webdriver: true, userAgent: 'UA-ORIGINAL', language: 'zh-CN',
      hardwareConcurrency: 8, platform: 'Linux x86_64' },
    window: { __nightmare: true, chrome: {}, innerWidth: 1280, innerHeight: 800 },
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    Object, Array, String, Number, Boolean, Promise, JSON, Math, RegExp
  };
  ctx.window.window = ctx.window;
  const api = {};
  vm.runInNewContext(src + '\nglobalThis.__FP = module.exports;', { module: { exports: api }, globalThis: ctx, ...ctx });
  const FPVM = ctx.__FP;
  const patched = FPVM.patcher();
  assert.ok(patched.cleaned.includes('navigator.webdriver'), '应清理 webdriver 标记');
  assert.ok(patched.cleaned.includes('__nightmare'), '应清理自动化全局标记');
  assert.equal(ctx.navigator.userAgent, 'UA-ORIGINAL', 'UA 绝不改写');
  assert.equal(ctx.navigator.hardwareConcurrency, 8, 'CPU 核数绝不改写');
  assert.equal(ctx.screen.width, 1920, '屏幕绝不改写');
  assert.equal(ctx.devicePixelRatio, 1, 'DPR 绝不改写');
  assert.equal(ctx.navigator.webdriver, false);
  assert.ok(patched.untouched.includes('navigator.userAgent'));
  assert.equal(FPVM.selftest().ok, true);
});

test('v3.9 · 两端运行接线同构、桌面主进程也走拟人档', () => {
  const needles = [
    'let HUMAN = null, GEO = null, RUN_SETTINGS = null;',
    'runMode: HSA_HUMAN.DEFAULT_SETTINGS.runMode,',
    'RUN_SETTINGS = await getSettings();',
    'STRICT = HSA_CORE.strictRunPolicy(RUN_SETTINGS)',
    'HUMAN = HSA_HUMAN.isEnabled(RUN_SETTINGS)',
    'HSA_GEO.probe(geoFetch',
    'HSA_HUMAN.roundBudget(HUMAN,',
    'HSA_HUMAN.splitRound(HUMAN_BUDGET, HUMAN).segments',
    'HSA_HUMAN.bezierPath(lastXY, clickCenter',
    'HSA_HUMAN.wordOrder(built.queries, HUMAN)',
    'HSA_HUMAN.cardSpacing(HUMAN, HUMAN.rng,',
    'HSA_FINGERPRINT.collect',
    'HSA_FINGERPRINT.patcher',
    'async function hsaHumanMouse(',
    'async function hsaHumanBrowse(',
    'await nap(HUMAN && HUMAN_TIMING ? HUMAN_TIMING.gapMs : STRICT.fixedRoundIntervalMs, token)',
    'strictClickPlan('
  ];
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    for (const n of needles) assert.ok(src.includes(n), name + ' 缺 ' + n);
    const a = src.indexOf('async function searchLoop');
    const b = src.indexOf('function waitForTab', a);
    const loop = src.slice(a, b);
    assert.ok(!/suggestRelated\(|GO_HOME_RATE|RELATED_RATE/.test(loop),
      name + ' 搜索循环不得恢复改词 / 回首页');
  }
  assert.match(DM, /HSA_HUMAN\.cardSpacing\(humanCard/);
  assert.match(DM, /HSA_HUMAN\.bezierPath\(lastCardXY/);
  assert.match(DB, /runMode: RUN_SETTINGS && RUN_SETTINGS\.runMode/);
  /* 严格档 fallback 仍在 */
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    assert.match(src, /else if \(realInput\) await cdpClickAt\(tabId, clickCenter\[0\], clickCenter\[1\]\)/);
  }
});

test('v3.9 · 设置页默认拟人档、控件两端一致、字典零缺失、共享清单 12 文件', () => {
  for (const [name, html] of [['plugin', EH], ['desktop', DH]]) {
    for (const id of ['set-run-mode', 'set-auto-level', 'set-human-noise',
      'set-human-browse', 'set-human-session', 'set-fingerprint', 'set-geo']) {
      assert.ok(html.includes('id="' + id + '"'), name + ' 缺 ' + id);
    }
    assert.match(html, /data-value="human" data-i18n="run\.modeHuman"/);
    assert.match(html, /data-value="strict" data-i18n="run\.modeStrict"/);
    assert.match(html, /class="set-feature-grid"/);
    assert.match(html, /<script src="[^"]*shared\/hsa-human\.js"/);
  }
  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    const js = read(p);
    assert.match(js, /runMode: 'human', humanLevel: 2,/);
    assert.match(js, /fingerprintCheck: true, geoConsistency: true,/);
    assert.match(js, /onSegment\('set-run-mode', v => saveSettings\(\{ runMode: v \}\)/);
    const html = p.includes('edge-') ? EH : DH;
    const keys = [...html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)].map(m => m[1]);
    for (const k of new Set(keys)) {
      assert.ok(js.includes("'" + k + "':"), p + ' 缺字典键 ' + k);
    }
  }
  const sharedFiles = read('scripts/sync-shared.js');
  for (const f of ['hsa-human.js', 'hsa-fingerprint.js', 'hsa-geo.js']) {
    assert.ok(sharedFiles.includes("'" + f + "'"), '同步清单缺 ' + f);
  }
  const master = read('shared/hsa-human.js');
  for (const d of ['edge-extension/shared/hsa-human.js', 'desktop-app/shared/hsa-human.js']) {
    assert.equal(read(d).replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), master.trim() + '\n');
  }
});
