'use strict';
/* ============================================================================
 * v3.9 · 全维度拟人增强（两端同步）专项动态测试
 *   node --test tests/v39-human-enhanced.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const H = require(path.join(ROOT, 'shared', 'hsa-human.js'));
const FP = require(path.join(ROOT, 'shared', 'hsa-fingerprint.js'));
const GEO = require(path.join(ROOT, 'shared', 'hsa-geo.js'));
const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));

test('v3.9 · 三模块 selftest 全部通过', () => {
  assert.equal(H.selftest().ok, true);
  assert.equal(FP.selftest().ok, true);
  assert.equal(GEO.selftest().ok, true);
});

test('v3.9 · 低/中/高 = 20 次搜索 15/30/60 分钟，间隔随机但大致均匀', () => {
  for (const [lv, target] of [['low', 15], ['mid', 30], ['high', 60]]) {
    assert.equal(H.levelFromValue(lv).targetMinutes, target);
    const p = H.createProfile({ runMode: 'human', humanLevel: lv }, 20261112);
    let total = 0, worst = 1, gaps = [];
    for (let i = 0; i < H.SEARCHES; i++) {
      const budget = H.roundBudget(p, 1);
      const sp = H.splitRound(budget, p);
      total += budget;
      const vals = H.ROUND_SEGMENTS.map(k => sp.segments[k]);
      assert.ok(Math.abs(vals.reduce((a, b) => a + b, 0) - budget) < 1,
        '分段总和不等于预算');
      worst = Math.max(worst, Math.max(...vals) / Math.max(1, Math.min(...vals)));
      gaps.push(sp.segments.gap);
    }
    assert.ok(Math.abs(total / 60000 - target) / target < 0.05,
      lv + ' 20 轮总时长 ' + total / 60000 + ' 分钟偏离 ' + target);
    assert.ok(worst < 1.6, lv + ' 段间最大/最小比 ' + worst + ' 过大（不均匀）');
    assert.ok(new Set(gaps).size > 1, lv + ' 间隔必须是随机的');
  }
  /* 数字 1/2/3 与字符串 low/mid/high 等价 */
  assert.equal(H.levelFromValue(1).key, 'low');
  assert.equal(H.levelFromValue(2).key, 'mid');
  assert.equal(H.levelFromValue(3).key, 'high');
});

test('v3.9 · 会话画像可复现、噪声有界、贝塞尔轨迹终点与过冲正确', () => {
  const a = H.createProfile({ runMode: 'human', humanLevel: 'mid' }, 777);
  const b = H.createProfile({ runMode: 'human', humanLevel: 'mid' }, 777);
  assert.equal(H.splitRound(90000, a).segments.gap,
    H.splitRound(90000, b).segments.gap, '同一 seed 画像可复现');
  const c = H.createProfile({ runMode: 'human', humanLevel: 'mid' }, 778);
  assert.notEqual(H.splitRound(90000, a).segments.gap,
    H.splitRound(90000, c).segments.gap, '不同 seed 应不同');
  /* 抖动有界 */
  const r = H.mulberry32(42);
  for (const ms of [600, 3000, 10000, 45000]) {
    const v = H.jitter(ms, 0.2, r);
    assert.ok(v >= ms * 0.8 - 1 && v <= ms * 1.2 + 1, '抖动越界: ' + v);
  }
  /* 贝塞尔：起点→终点、含过冲回正、点数合理、每点带 dt */
  const p = H.bezierPath([10, 10], [300, 220], H.mulberry32(9), { bend: 0.3 });
  assert.ok(p.points.length >= 9);
  assert.equal(p.points[p.points.length - 1].x, 300);
  assert.equal(p.points[p.points.length - 1].y, 220);
  assert.ok(p.points.every(q => Number.isFinite(q.x) && Number.isFinite(q.y) && q.dt > 0));
  const pen = p.points[p.points.length - 2];
  assert.ok(pen.x !== 300 || pen.y !== 220, '过冲点应偏离终点');
  /* 偶发多余动作：0~2 个、来自白名单、带时长 */
  const acts = H.extraActions(H.mulberry32(3), 1);
  assert.ok(acts.length <= 2);
  assert.ok(acts.every(x => H.EXTRA_ACTIONS.includes(x.action) && x.ms > 0));
  /* 结果页浏览计划 */
  const prof = H.createProfile({}, 5);
  const bp = H.browsePlan(prof, prof.rng);
  assert.ok(Array.isArray(bp.scrolls));
  assert.ok(typeof bp.openResult === 'boolean');
  assert.ok(bp.mouseMoves >= 2);
});

test('v3.9 · 词策略只重排当日热搜原文，不补词/编词/复用；卡片随机间隔', () => {
  const words = Array.from({ length: 12 }, (_, i) => '当日热搜词条' + i);
  const p = H.createProfile({}, 88);
  const out = H.wordOrder(words, p);
  assert.equal(out.length, words.length);
  assert.deepEqual([...out].sort(), [...words].sort(), '词集合不变');
  assert.ok(out.join('|') !== words.join('|') || p.wordSwapRate === 0, '应有轻微重排');
  /* 会话关闭时完全不重排 */
  const off = H.createProfile({ humanSession: false }, 88);
  assert.deepEqual(H.wordOrder(words, off), words);
  /* 卡片：随机间隔 + 偶发长停顿 + 作息系数 */
  const r = H.mulberry32(12);
  const gaps = Array.from({ length: 12 }, () => H.cardSpacing(p, r, 10000, 1).delayMs);
  assert.ok(new Set(gaps).size > 5, '卡片间隔必须随机');
  assert.ok(gaps.every(v => v > 3000 && v < 40000), '卡片间隔应在合理范围');
  const night = H.cardSpacing(p, r, 10000, 2.4).factor;
  assert.equal(night, 2.4);
  /* 严格档保持固定节奏（历史约束不回退） */
  const strict = CORE.strictRunPolicy();
  assert.equal(strict.randomDelay, false);
  assert.equal(strict.humanVariation, false);
  assert.equal(H.isEnabled({ runMode: 'strict' }), false);
  assert.equal(H.isEnabled({ runMode: 'human' }), true);
});

test('v3.9 · 环境指纹：一致性优先，不硬编码硬件值，补丁只去标记/补对象', () => {
  const r = FP.selftest();
  assert.equal(r.ok, true);
  assert.equal(r.consistent.ok, true);
  assert.ok(r.brokenCodes.includes('screen-vs-inner'));
  assert.ok(r.brokenCodes.includes('tz-lang-region'));
  assert.ok(r.brokenCodes.includes('ua-brands-version'));
  assert.ok(r.brokenCodes.includes('automation-markers'));
  assert.ok(r.patch.cleaned.includes('navigator.webdriver'));
  assert.ok(r.patch.added.includes('window.chrome'));
  assert.equal(r.patch.preserves, true, '不得改写任何真实数值');
  assert.ok(FP.NEVER_TOUCH.includes('navigator.hardwareConcurrency'));
  assert.ok(FP.NEVER_TOUCH.includes('screen.width'));
  /* patcher / buildPatchScript 自包含，可序列化注入页面 */
  assert.doesNotMatch(FP.patcher.toString(), /AUTOMATION_MARKERS|MISSING_OBJECT/);
  assert.ok(FP.buildPatchScript().includes('navigator.webdriver'));
  const W = { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
    document: { createElement: () => ({ getContext: () => null }) } };
  const N = { hardwareConcurrency: 16, language: 'zh-CN', languages: ['zh-CN'],
    userAgent: 'Chrome/131.0.0.0', webdriver: true };
  const sb = { window: W, navigator: N, screen: { width: 1920, height: 1080 },
    Intl, Promise, Object, Array, String, Number, JSON };
  sb.globalThis = sb;
  const snap = vm.runInNewContext('(' + FP.collect.toString() + ')()', sb);
  assert.equal(snap.navigator.hardwareConcurrency, 16, '读取真实值');
  assert.equal(snap.window.devicePixelRatio, 2);
  const report = FP.crossCheck(snap);
  assert.ok(Array.isArray(report.conflicts));
  assert.equal(report.fields.hardwareConcurrency, 16);
});

test('v3.9 · 地理一致性：IP→时区/语言/mkt 自洽、冲突识别、失败降级、当地作息', () => {
  const good = GEO.derive({ success: true, ip: '113.108.x.x', country_code: 'CN',
    city: 'Guangzhou', timezone: { id: 'Asia/Shanghai' } }, null, Date.now());
  assert.equal(good.source, 'ip');
  assert.equal(good.country, 'CN');
  assert.equal(good.mkt, 'zh-CN');
  assert.equal(good.timezone, 'Asia/Shanghai');
  assert.equal(GEO.crossCheck(good, Date.now()).ok, true);
  /* 矛盾：IP 在境外但 mkt=zh-CN */
  const bad = Object.assign({}, good, { country: 'US', timezone: 'Asia/Shanghai',
    locale: 'en-US', mkt: 'zh-CN' });
  const codes = GEO.crossCheck(bad, Date.now()).conflicts.map(c => c.code);
  assert.ok(codes.includes('ip-timezone'));
  assert.ok(codes.includes('mkt-ip-country'));
  /* 探测失败优雅降级 */
  const fb = GEO.fallback('zh-CN', 'Asia/Shanghai', Date.now());
  assert.equal(fb.source, 'system');
  assert.equal(fb.degraded, true);
  assert.equal(GEO.derive(null, fb, Date.now()).source, 'system');
  /* 当地凌晨不高频搜索：只拉长间隔，不停止任务 */
  const day = Date.UTC(2026, 10, 12, 4, 0, 0);    /* 北京 12:00 */
  const night = Date.UTC(2026, 10, 11, 19, 0, 0); /* 北京 03:00 */
  const fDay = GEO.scheduleFactor(day, good).factor;
  const fNight = GEO.scheduleFactor(night, good).factor;
  assert.equal(fDay, 1.0);
  assert.equal(fNight, 2.4);
  const budgetDay = H.roundBudget(H.createProfile({ humanLevel: 'mid' }, 1), fDay);
  const budgetNight = H.roundBudget(H.createProfile({ humanLevel: 'mid' }, 1), fNight);
  assert.ok(budgetNight > budgetDay * 2);
  /* mkt 注入 URL */
  assert.match(GEO.withMarket('https://www.bing.com/?mkt=zh-CN', good), /mkt=zh-CN/);
  assert.match(GEO.withMarket('https://www.bing.com/', good), /mkt=zh-CN/);
});

test('v3.9 · 两端源码同构接线，严格档仍完整保留', () => {
  const eb = read('edge-extension/background.js');
  const db = read('desktop-app/src/background.js');
  const dm = read('desktop-app/main.js');
  for (const [name, s] of [['plugin', eb], ['desktop', db]]) {
    for (const needle of [
      'HSA_HUMAN.isEnabled(RUN_SETTINGS)',
      'HSA_HUMAN.createProfile(RUN_SETTINGS',
      'HSA_GEO.probe(geoFetch',
      'HSA_HUMAN.wordOrder(built.queries, HUMAN)',
      'HSA_FINGERPRINT.collect',
      'HSA_FINGERPRINT.crossCheck',
      'HSA_FINGERPRINT.patcher',
      'HSA_HUMAN.splitRound(HUMAN_BUDGET, HUMAN)',
      'HSA_HUMAN.bezierPath(lastXY',
      'hsaHumanBrowse(tabId, HUMAN_TIMING, token)',
      'HUMAN_TIMING.gapMs',
      'runMode: HSA_HUMAN.DEFAULT_SETTINGS.runMode',
      'function strictClickPlan(box)',
      'STRICT.fixedRoundIntervalMs'
    ]) {
      assert.ok(s.includes(needle), name + ' 缺 ' + needle);
    }
  }
  assert.ok(eb.includes('HSA_HUMAN.cardSpacing(HUMAN, HUMAN.rng'));
  assert.ok(db.includes('runMode: RUN_SETTINGS') && db.includes('geoFactor:'));
  assert.ok(dm.includes("require('./shared/hsa-human.js')"));
  assert.ok(dm.includes('HSA_HUMAN.cardSpacing(humanCard, humanCard.rng'));
  assert.ok(dm.includes('HSA_HUMAN.bezierPath(lastCardXY'));
  assert.equal((dm.match(/HSA_HUMAN\.bezierPath\(lastCardXY/g) || []).length, 2,
    '两条卡片点击路径都要走贝塞尔轨迹');
  /* 加载点与权限 */
  assert.ok(eb.includes("importScripts('shared/hsa-human.js')"));
  for (const p of ['edge-extension/popup.html', 'desktop-app/src/popup.html',
    'desktop-app/host.html']) {
    const s = read(p);
    assert.ok(s.includes('hsa-human.js') && s.includes('hsa-fingerprint.js')
      && s.includes('hsa-geo.js'), p + ' 未加载新模块');
  }
  const mf = JSON.parse(read('edge-extension/manifest.json'));
  assert.ok(mf.host_permissions.some(h => h.includes('ipwho.is')));
  assert.ok(mf.host_permissions.some(h => h.includes('ipapi.co')));
});

test('v3.9 · 设置页「运行设置」合并、全维度开关、两端字典齐全', () => {
  const eh = read('edge-extension/popup.html');
  const dh = read('desktop-app/src/popup.html');
  for (const [name, s] of [['plugin', eh], ['desktop', dh]]) {
    assert.ok(s.includes('id="run-group"'), name);
    assert.ok(!s.includes('id="timing-group"'), name + ' 应已合并');
    const ra = s.indexOf('id="run-group"'), rb = s.indexOf('id="auto-group"', ra);
    const run = s.slice(ra, rb);
    for (const id of ['set-run-mode', 'set-auto-level', 'set-human-noise',
      'set-human-browse', 'set-human-session', 'set-fingerprint', 'set-geo',
      'run-preset-groups', 'run-preset-strict']) {
      assert.ok(run.includes('id="' + id + '"'), name + ' 运行设置缺 ' + id);
    }
    /* v4.2 · 专业数值项不再暴露，改由强度预设只读展示 */
    assert.equal((run.match(/data-preset="/g) || []).length, 7);
    assert.equal((run.match(/data-group="(quota|action|page)"/g) || []).length, 3);
    assert.ok(run.includes('set-feature-grid'));
    const aa = s.indexOf('id="auto-group"'), ab = s.indexOf('id="calendar-group"', aa);
    assert.ok(!s.slice(aa, ab).includes('id="set-auto-level"'), '强度应已移入运行设置');
  }
  /* 共有 DOM 仍逐字一致 */
  const body = s => {
    const a = s.indexOf('<div class="settings-body">');
    return s.slice(a, s.indexOf('</section>', a));
  };
  const d = body(dh);
  const ds = d.indexOf('<!-- v1.3.8 · 桌面版专有功能');
  const de = d.indexOf('id="set-reset"', ds);
  assert.equal(body(eh).trim(), (d.slice(0, ds) + d.slice(d.lastIndexOf('\n', de) + 1)).trim());
  /* 全量 i18n 键零缺失 */
  for (const [hk, jp] of [['EH', 'edge-extension/popup.js'], ['DH', 'desktop-app/src/popup.js']]) {
    const html = hk === 'EH' ? eh : dh, js = read(jp);
    const keys = [...html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)].map(m => m[1]);
    for (const k of new Set(keys)) {
      assert.ok(js.includes("'" + k + "':"), jp + ' 缺字典键 ' + k);
    }
  }
  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    const s = read(p);
    assert.ok(s.includes("onSegment('set-run-mode'"));
    assert.ok(s.includes('HSA_FEATURE_INPUTS'));
    assert.ok(s.includes('runMode: \'human\', humanLevel: 2'));
    assert.ok(s.includes('saveSettings({ humanLevel: Number(v) })'));
  }
});
