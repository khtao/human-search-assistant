'use strict';
/* ============================================================================
 * v4.0 · 运行风险规避（行为 / 过程 / 节奏 / 环境）两端同源动态回归
 *   node --test tests/v40-stealth.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const S = require(path.join(ROOT, 'shared', 'hsa-stealth.js'));
const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
const EB = read('edge-extension/background.js');
const DB = read('desktop-app/src/background.js');
const EH = read('edge-extension/popup.html');
const DH = read('desktop-app/src/popup.html');
const EP = read('edge-extension/popup.js');
const DP = read('desktop-app/src/popup.js');

test('v4.0 · 共享引擎自检全绿、版本与默认值', () => {
  const r = S.selftest();
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter(c => !c.ok)));
  assert.equal(S.VERSION, '1.0.0');
  assert.deepEqual({ ...S.DEFAULTS }, {
    stealthTyping: true, burstPacing: true, avoidNightRun: true,
    singleRunCapPct: 60, scheduleJitterMin: 20, geoCacheHours: 12
  });
  assert.equal(S.normalize({ singleRunCapPct: 999, scheduleJitterMin: -5, geoCacheHours: 999 })
    .singleRunCapPct, 100);
  assert.equal(S.normalize({ scheduleJitterMin: -5 }).scheduleJitterMin, 0);
  assert.equal(S.normalize({ geoCacheHours: 999 }).geoCacheHours, 72);
});

test('v4.0 · 严格档六项新特性恒关，逐字回到 v3.7 固定节奏', () => {
  assert.equal(S.enabled({ runMode: 'strict' }), false);
  assert.equal(S.capSearches(20, 30, 60, 'strict'), 20);
  assert.equal(S.scheduleJitter(1000, () => 0, 120, 'strict'), 1000);
  assert.equal(S.shouldDefer(Date.now(), { localHour: 3 }, { runMode: 'strict' }, false).defer, false);
  assert.equal(S.submitPlan(() => 0, { enabled: false }).method, 'enter');
  assert.equal(S.keystrokePlan('六个字的热搜词', () => 0, { enabled: false }).chunks.length, 1);
  const flat = S.sessionPlan({ rounds: 20, perRoundMs: 90000, enabled: false });
  assert.equal(flat.enabled, false);
  assert.equal(flat.bursts.length, 1);
  assert.equal(flat.totalBreakMs, 0);
  assert.equal(flat.scaleFor(9), 1);
  assert.equal(flat.breakAfter(9), 0);
  /* v3.7 固定策略本身完全不动 */
  const st = CORE.strictRunPolicy();
  assert.equal(st.fixedNapMs, 600);
  assert.equal(st.pageStableWaitMs, 3000);
  assert.equal(st.fixedRoundIntervalMs, 10000);
  assert.equal(st.randomDelay, false);
  assert.equal(st.scroll, false);
});

test('v4.0 · 会话分段：2~4 段、段间离席、索引连续、总时长守恒、段级起伏', () => {
  for (const [level, per] of [['low', 45000], ['mid', 90000], ['high', 180000]]) {
    const p = S.sessionPlan({ rounds: 20, perRoundMs: per,
      rng: S.mulberry32(20261112), enabled: true });
    assert.ok(p.bursts.length >= 2 && p.bursts.length <= 4, level + ' 段数');
    assert.ok(p.totalBreakMs > 60000, level + ' 段间离席');
    assert.equal(p.bursts[0].start, 0);
    assert.equal(p.bursts[p.bursts.length - 1].end, 19);
    for (let i = 1; i < p.bursts.length; i++) {
      assert.equal(p.bursts[i].start, p.bursts[i - 1].end + 1, level + ' 段索引不连续');
    }
    let sum = 0;
    for (let i = 0; i < 20; i++) sum += p.perRoundMs * p.scaleFor(i);
    sum += p.totalBreakMs;
    assert.ok(Math.abs(sum - p.totalMs) < p.totalMs * 0.12,
      level + ' 总时长 ' + Math.round(sum / 60000) + ' 分钟偏离 ' + Math.round(p.totalMs / 60000));
    assert.ok(p.bursts.some(b => Math.abs(b.scale - 1) > 0.05), level + ' 段级无起伏');
    /* 同一段内不同轮的 scale 也不能完全一致 */
    const scales = new Set();
    for (let i = 0; i < 20; i++) scales.add(p.scaleFor(i).toFixed(6));
    assert.ok(scales.size >= 4, level + ' 轮内起伏不足');
    /* breakAfter 只在段末返回一次 */
    let breaks = 0;
    for (let i = 0; i < 20; i++) if (p.breakAfter(i) > 0) breaks++;
    assert.equal(breaks, p.bursts.length - 1);
  }
});

test('v4.0 · 单次配额上限：不一次刷满、边界不空转、严格档维持原语义', () => {
  assert.equal(S.capSearches(20, 30, 60, 'human'), 12);
  assert.equal(S.capSearches(20, 30, 100, 'human'), 20);
  assert.equal(S.capSearches(20, 30, 20, 'human'), 4);
  assert.equal(S.capSearches(1, 30, 60, 'human'), 1);
  assert.equal(S.capSearches(0, 30, 60, 'human'), 0);
  assert.equal(S.capSearches(20, 5, 60, 'human'), 3);
  assert.equal(S.capSearches(20, 30, 60, 'strict'), 20);
  for (const pct of [20, 40, 60, 80, 100]) {
    const v = S.capSearches(37, 30, pct, 'human');
    assert.ok(v >= 1 && v <= 30, 'pct=' + pct + ' 越界 ' + v);
  }
});

test('v4.0 · 深夜定时跳过、白天放行、手动不受限、时区降级', () => {
  const cfg = S.normalize({});
  const night = S.shouldDefer(Date.UTC(2026, 0, 1, 19, 0, 0), { localHour: 3 }, cfg, false);
  assert.equal(night.defer, true);
  assert.equal(night.reason, 'local-deep-night');
  assert.ok(night.retryAtMs > Date.UTC(2026, 0, 1, 19, 0, 0));
  assert.equal(S.shouldDefer(Date.now(), { localHour: 6 }, cfg, false).defer, false);
  assert.equal(S.shouldDefer(Date.now(), { localHour: 12 }, cfg, false).defer, false);
  assert.equal(S.shouldDefer(Date.now(), { localHour: 23 }, cfg, false).defer, false);
  assert.equal(S.shouldDefer(Date.now(), { localHour: 3 }, cfg, true).defer, false);
  assert.equal(S.shouldDefer(Date.now(), { localHour: 3 },
    S.normalize({ avoidNightRun: false }), false).defer, false);
  /* UTC 偏移推导 + 系统 Intl 兜底都不会抛错 */
  assert.equal(S.localHour(Date.UTC(2026, 0, 1, 4, 0, 0), { utcOffsetMinutes: 480 }), 12);
  assert.ok(Number.isInteger(S.localHour(Date.now(), null)) || S.localHour(Date.now(), null) === null);
});

test('v4.0 · 定时启动抖动：500 次有界、相对模式非负、严格档为零', () => {
  const base = Date.UTC(2026, 5, 1, 8, 0, 0);
  for (let i = 0; i < 500; i++) {
    const v = S.scheduleJitter(base, Math.random, 20, 'human');
    assert.ok(Math.abs(v - base) <= 20 * 60000, '绝对抖动越界 ' + (v - base));
    const rel = S.scheduleJitter(0, Math.random, 20, 'human');
    assert.ok(rel >= 0 && rel <= 20 * 60000, '相对抖动越界 ' + rel);
  }
  assert.equal(S.scheduleJitter(base, Math.random, 0, 'human'), base);
  assert.equal(S.scheduleJitter(base, Math.random, 20, 'strict'), base);
  assert.equal(S.scheduleJitter(0, () => 0, 20, 'human'), 0);
});

test('v4.0 · 拟真键入：词内容逐字不变、分块、键间隔非均匀、纠错可重放', () => {
  const words = ['六个字的热搜词', '今日十个字的头条新闻词', '五个字词甲',
    '一二三四五六七八九十'];
  for (let j = 0; j < words.length; j++) {
    const kp = S.keystrokePlan(words[j], S.mulberry32(j + 7), { enabled: true });
    assert.equal(kp.finalText, words[j]);
    assert.equal(kp.exact, true);
    assert.ok(kp.chunks.length >= 2);
    assert.ok(CORE.isStrictKeyword(words[j]), '测试词本身必须是 ≥5 字合规词');
    /* 按块序列重放，最终输入框内容必须刚好是原词 */
    let acc = '';
    for (const c of kp.chunks) {
      if (c.action === 'type' || c.action === 'paste') acc += c.text;
      else if (c.action === 'backspace') acc = acc.slice(0, -Array.from(c.text).length);
    }
    assert.equal(acc, words[j], '重放后词被改坏：' + acc);
    const delays = kp.chunks.filter(c => c.action === 'type').map(c => c.delayMs);
    assert.ok(new Set(delays).size >= 1);
    assert.ok(delays.every(d => d >= 60 && d <= 320));
  }
  /* 关闭后 = 整段粘贴，与原行为一致 */
  const off = S.keystrokePlan('六个字的热搜词', () => 0, { enabled: false });
  assert.equal(off.chunks.length, 1);
  assert.equal(off.chunks[0].action, 'paste');
  assert.equal(off.chunks[0].text, '六个字的热搜词');
});

test('v4.0 · 提交方式拟人档有两种、严格档恒 Enter、按钮选择器可用', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(S.submitPlan(Math.random, { enabled: true }).method);
  assert.deepEqual([...seen].sort(), ['button', 'enter']);
  assert.equal(S.submitPlan(() => 0, { enabled: false }).method, 'enter');
  assert.ok(S.SUBMIT_BUTTONS.includes('#sb_form_go'));
  assert.ok(S.SUBMIT_BUTTONS.length >= 3);
});

test('v4.0 · 出口 IP 地理结果缓存 TTL 与降级', () => {
  const cache = { at: 1000, value: { geo: { mkt: 'zh-CN' }, source: 'ipwho.is' } };
  assert.equal(S.geoCacheValid(cache, 1000 + 3600000, 12), true);
  assert.equal(S.geoCacheValid(cache, 1000 + 11 * 3600000, 12), true);
  assert.equal(S.geoCacheValid(cache, 1000 + 13 * 3600000, 12), false);
  assert.equal(S.geoCacheValid(cache, 500, 12), false, '未来时间戳不采信');
  assert.equal(S.geoCacheValid(null, 2000, 12), false);
  assert.equal(S.geoCacheValid({ at: 1000 }, 2000, 12), false);
  assert.equal(S.geoCacheValid(cache, 2000, 0), false);
  assert.equal(S.normalize({ geoCacheHours: 999 }).geoCacheHours, 72);
});

test('v4.0 · 焦点模拟只在输入阶段：vm 实跑 releaseFocusEmulation 发 enabled:false', async () => {
  const calls = [];
  const helperSrc = EB.slice(EB.indexOf('async function releaseFocusEmulation'),
    EB.indexOf('async function stealthDeferScheduled'));
  const sandbox = {
    cdpAttached: new Set([42]),
    chrome: { debugger: { sendCommand: async (t, method, params) => {
      calls.push({ tabId: t.tabId, method, params }); return {};
    } } },
    Number, Math, console, Promise
  };
  vm.createContext(sandbox);
  vm.runInContext(helperSrc + '\nglobalThis.__rel = releaseFocusEmulation;', sandbox);
  assert.equal(await sandbox.__rel(42), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'Emulation.setFocusEmulationEnabled');
  assert.equal(calls[0].params.enabled, false);
  /* 未 attach 的标签不发命令 */
  assert.equal(await sandbox.__rel(99), false);
  assert.equal(calls.length, 1);
});

test('v4.0 · 两端接线逐项同构、词规则与严格档 fallback 未破', () => {
  const needles = [
    'HSA_STEALTH = ', 'let STEALTH = null;', 'let STEALTH_ON = false;',
    'HSA_STEALTH.sessionPlan({', 'HSA_STEALTH.keystrokePlan(',
    'HSA_STEALTH.submitPlan(', 'HSA_STEALTH.capSearches(',
    'HSA_STEALTH.scheduleJitter(', 'HSA_STEALTH.shouldDefer(',
    'HSA_STEALTH.geoCacheValid(', 'HSA_STEALTH.normalize(RUN_SETTINGS)',
    'releaseFocusEmulation(tabId)', 'stealthDeferScheduled(',
    'stealthTypeQuery(tabId, keyword, realInput, token)',
    'stealthSubmitQuery(tabId, keyword, realInput, lastXY, token)',
    'SESSION_PLAN.breakAfter(current)',
    "Emulation.setFocusEmulationEnabled', { enabled: false }",
    'HSA_HUMAN.roundBudget(HUMAN,',
    'HSA_HUMAN.splitRound(HUMAN_BUDGET, HUMAN).segments',
    'strictClickPlan(',
    'HSA_CORE.strictQueries(', 'HSA_CORE.isStrictKeyword('
  ];
  for (const [name, src] of [['plugin', EB], ['desktop', DB]]) {
    for (const n of needles) assert.ok(src.includes(n), name + ' 缺 ' + n);
    const la = src.indexOf('async function searchLoop');
    const lb = src.indexOf('function waitForTab', la);
    assert.ok(!/suggestRelated\(|GO_HOME_RATE|RELATED_RATE/.test(src.slice(la, lb)),
      name + ' 搜索循环恢复改词 / 回首页');
    const ba = src.indexOf('async function hsaHumanBrowse');
    const bb = src.indexOf('async function navigateSearch', ba);
    assert.ok(!src.slice(ba, bb).includes('a.click()'), name + ' 仍用 DOM click 点结果');
    assert.ok(src.includes('finalText !== text'), name + ' 缺词内容不变校验');
  }
  const master = read('shared/hsa-stealth.js');
  for (const d of ['edge-extension/shared/hsa-stealth.js', 'desktop-app/shared/hsa-stealth.js']) {
    assert.equal(read(d).replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), master.trim() + '\n');
  }
});

test('v4.0 · 设置页 5 项控件两端一致、字典零缺失、默认值与共享 DEFAULTS 同源', () => {
  for (const [name, html] of [['plugin', EH], ['desktop', DH]]) {
    for (const id of ['set-stealth-typing', 'set-stealth-burst', 'set-stealth-night']) {
      assert.ok(html.includes('id="' + id + '"'), name + ' 缺 ' + id);
    }
    /* v4.2 · 配额 / 抖动数值改由强度预设摘要展示 */
    for (const key of ['singleRunCapPct', 'scheduleJitterMin']) {
      assert.ok(html.includes('data-preset="' + key + '"'), name + ' 缺 ' + key);
    }
    assert.match(html, /data-i18n="run\.riskDesc"/);
  }
  for (const [name, js, html] of [['plugin', EP, EH], ['desktop', DP, DH]]) {
    assert.match(js, /stealthTyping: true, burstPacing: true, avoidNightRun: true,/);
    assert.match(js, /singleRunCapPct: 60, scheduleJitterMin: 20, geoCacheHours: 12,/);
    assert.match(js, /HSA_HUMAN\.presetValues\(/);
    assert.match(js, /renderRunPreset\(\);/);
    const keys = [...html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)].map(m => m[1]);
    for (const key of new Set(keys)) {
      assert.ok(js.includes("'" + key + "':"), name + ' 缺字典键 ' + key);
    }
  }
  const bodyOf = x => {
    const a = x.indexOf('<div class="settings-body">');
    return x.slice(a, x.indexOf('</section>', a));
  };
  const d = bodyOf(DH);
  const ds = d.indexOf('<!-- v1.3.8 · 桌面版专有功能');
  const de = d.indexOf('id="set-reset"', ds);
  assert.equal(bodyOf(EH).trim(), (d.slice(0, ds) + d.slice(d.lastIndexOf('\n', de) + 1)).trim(),
    '两端共有设置 DOM 逐字一致');
});
