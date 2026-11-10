#!/usr/bin/env node
/* ============================================================================
 * 差异决策落地校验（静态回归）
 *
 *   node scripts/verify-decisions.js
 *
 * 覆盖：27 项勾选与单一真源一致、两端源码/界面装配、共享副本一致、
 * JS 语法、HTML 本地资源、打包配置、以及内存相关的上限与定时器约束。
 * 这是源码级回归，不替代真实账号下的双平台运行测试。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CORE = require('../shared/hsa-core.js');
const syncShared = require('./sync-shared.js');
const decisions = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'decisions.json'), 'utf8'));

const P = {
  eb: 'edge-extension/background.js',
  ep: 'edge-extension/popup.js',
  eh: 'edge-extension/popup.html',
  ec: 'edge-extension/popup.css',
  ebs: 'edge-extension/popup-bootstrap.js',
  db: 'desktop-app/src/background.js',
  dp: 'desktop-app/src/popup.js',
  dh: 'desktop-app/src/popup.html',
  dc: 'desktop-app/src/popup.css',
  dm: 'desktop-app/main.js',
  host: 'desktop-app/host.html',
  sharedCss: 'shared/hsa-shared.css',
  recovery: 'shared/hsa-recovery.js'
};
const F = {};
for (const k of Object.keys(P)) F[k] = fs.readFileSync(path.join(ROOT, P[k]), 'utf8');

function has(key, re, msg) {
  assert.ok(re.test(F[key]), (msg || '缺少匹配 ' + re) + ' @ ' + P[key]);
}
function absent(key, re, msg) {
  assert.ok(!re.test(F[key]), (msg || '不应出现 ' + re) + ' @ ' + P[key]);
}
function before(key, a, b) {
  assert.ok(F[key].indexOf(a) >= 0 && F[key].indexOf(b) > F[key].indexOf(a),
    a + ' 必须先于 ' + b + ' @ ' + P[key]);
}
function near(key, anchor, needle, span) {
  const i = F[key].indexOf(anchor);
  assert.ok(i >= 0, '缺少 ' + anchor + ' @ ' + P[key]);
  assert.ok(F[key].slice(i, i + (span || 320)).includes(needle),
    anchor + ' 附近缺少 ' + needle + ' @ ' + P[key]);
}

function docChoices() {
  const dir = path.join(ROOT, 'docs');
  if (!fs.existsSync(dir)) return null;
  const file = fs.readdirSync(dir).find(f => /差异选择题/.test(f) && f.endsWith('.md'));
  if (!file) return null;
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  const out = {};
  let cur = '';
  for (const line of lines) {
    const title = line.match(/^###\s+([A-Z]\d{2})｜/);
    if (title) { cur = title[1]; continue; }
    const pick = line.match(/^- \[x\]\s+\*\*([ABCD])/);
    if (cur && pick) out[cur] = pick[1];
  }
  return Object.keys(out).length ? out : null;
}

function htmlResources() {
  const dirs = [
    path.join(ROOT, 'edge-extension'),
    path.join(ROOT, 'desktop-app'),
    path.join(ROOT, 'desktop-app', 'src')
  ];
  const missing = [];
  for (const d of dirs) {
    for (const name of fs.readdirSync(d).filter(f => f.endsWith('.html'))) {
      const file = path.join(d, name);
      const s = fs.readFileSync(file, 'utf8');
      for (const m of s.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const u = m[1];
        if (/^(https?:|data:|#|javascript:)/.test(u)) continue;
        const target = path.resolve(path.dirname(file), u.split('?')[0].split('#')[0]);
        if (!fs.existsSync(target)) missing.push(path.relative(ROOT, file) + ' → ' + u);
      }
    }
  }
  assert.deepEqual(missing, [], 'HTML 本地资源缺失：\n  ' + missing.join('\n  '));
}

function syntax() {
  const dirs = ['shared', 'tests', 'scripts', 'edge-extension', 'desktop-app/src',
    'desktop-app/lib', 'desktop-app/shared', 'edge-extension/shared'];
  const bad = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.js')) continue;
      const file = path.join(abs, name);
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (r.status !== 0) bad.push(path.relative(ROOT, file) + ': ' + String(r.stderr).split('\n')[0]);
    }
  }
  const top = ['main.js', 'preload.js'];
  for (const name of top) {
    const file = path.join(ROOT, 'desktop-app', name);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(path.relative(ROOT, file) + ': ' + String(r.stderr).split('\n')[0]);
  }
  assert.deepEqual(bad, [], 'JS 语法错误：\n  ' + bad.join('\n  '));
}

const CHECKS = [
  ['决策 · 27 项勾选与单一真源一致（U01=C 保留差异）', () => {
    assert.equal(Object.keys(decisions.choices).length, 27);
    assert.deepEqual(CORE.DECISIONS, decisions.choices);
    assert.equal(decisions.choices.U01, 'C');
    assert.equal(CORE.UI.loginBadgeInteractive, 'platform-specific');
  }],
  ['决策 · 附带文档的勾选与 decisions.json 一致', () => {
    const doc = docChoices();
    if (!doc) return '未附 docs/ 差异选择题，跳过（decisions.json 仍为唯一真源）';
    assert.deepEqual(doc, decisions.choices);
    return 'docs/ 勾选与 decisions.json 完全一致';
  }],
  ['装配 · 共享副本与 shared/ 单一真源逐字节一致', () => {
    assert.deepEqual(syncShared.verify(), []);
  }],
  ['装配 · 两端 popup/host 的本地资源引用全部存在', htmlResources],
  ['装配 · 共享核心先于业务脚本加载', () => {
    before('eh', 'shared/hsa-core.js', 'popup.js');
    before('dh', '../shared/hsa-core.js', 'popup.js');
    before('host', './shared/hsa-core.js', './src/background.js');
    before('eh', 'popup.css', 'shared/hsa-shared.css');
    before('dh', 'popup.css', '../shared/hsa-shared.css');
  }],
  ['装配 · 打包配置包含 shared/ 与扩展后台入口', () => {
    for (const f of ['desktop-app/electron-builder.yml', 'desktop-app/electron-builder.win.yml']) {
      assert.ok(fs.readFileSync(path.join(ROOT, f), 'utf8').includes('shared/**/*'), f + ' 未包含 shared/**/*');
    }
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'edge-extension', 'manifest.json'), 'utf8'));
    assert.equal(m.background.service_worker, 'background.js');
  }],
  ['装配 · 全部源码 JS 通过 node --check', syntax],

  ['T01 · D 宿主能力优先 CDP、不可用时降级并记录触发方式', () => {
    has('eb', /HSA_CORE\.triggerPlan\(/);
    has('eb', /HSA_CORE\.recordTrigger\(/);
    has('db', /T01=D/);
    has('dm', /T01=D/);
    assert.equal(CORE.triggerPlan(true).primary, 'cdp');
    assert.equal(CORE.triggerPlan(false).primary, 'page-interaction');
  }],
  ['T02 · A 主动滚动侧栏内外容器，分段收集且有上限', () => {
    has('eb', /scrollBy|scrollTop/);
    has('dm', /HSA_CORE\.scanPlan\(/);
    has('dm', /maxSteps|scanScrollSteps/);
    assert.ok(CORE.scanPlan().scrollEnabled && CORE.scanPlan().maxSteps > 0);
  }],
  ['T03 · B 侧栏失败回退到 /dashboard 与 /earn', () => {
    has('eb', /HSA_CORE\.fallbackPages\(/);
    has('eb', /\/earn/);
    has('dm', /\/dashboard/);
    has('dm', /\/earn/);
    assert.deepEqual(CORE.fallbackPages(), ['/dashboard', '/earn']);
  }],
  ['T04 · A 任务卡身份与去重键统一', () => {
    has('eb', /HSA_CORE\.taskCardKey\(/);
    has('dm', /HSA_CORE\.taskCardKey\(/);
  }],
  ['T05 · D 不自动代开链接，重定位一次后给手动入口并标未确认', () => {
    has('eb', /HSA_CORE\.followupPolicy\(/);
    has('dm', /T05=D/);
    has('dm', /manualLinks/);
    has('dm', /unconfirmed/);
    assert.equal(CORE.followupPolicy().autoOpenUrl, false);
    assert.equal(CORE.followupPolicy().relocateRetries, 1);
  }],
  ['T06 · D 已发出点击 / 已打开页面 / 官网确认三态独立计数', () => {
    has('eb', /HSA_CORE\.newClickResult\(/);
    has('eb', /HSA_CORE\.recordClick\(/);
    has('db', /HSA_CORE\.newClickResult\(/);
    has('db', /officialConfirmed/);
    assert.deepEqual(CORE.RESULT_STATES,
      ['clickSent', 'pageOpened', 'officialConfirmed', 'unconfirmed', 'failed']);
  }],
  ['T07 · D 默认 10 秒、1~60 秒范围、等待页面稳定', () => {
    has('ep', /HSA_CORE\.clampIntervalSec\(/);
    has('dp', /HSA_CORE\.clampIntervalSec\(/);
    has('eb', /pageStableWaitMs/);
    has('db', /pageStableWaitMs/);
    has('eh', /id="set-card-interval"[^>]*min="1"[^>]*max="60"/);
    has('dh', /id="set-card-interval"[^>]*min="1"[^>]*max="60"/);
    assert.equal(CORE.DEFAULTS.cardClickIntervalSec, 10);
    assert.equal(CORE.clampIntervalSec(999), 60);
    assert.equal(CORE.clampIntervalSec(-4), 1);
  }],
  ['T08 · A 今日全部完成的多条件严格判定', () => {
    has('eb', /HSA_CORE\.isAllDone\(/);
    has('db', /HSA_CORE\.isAllDone\(/);
    assert.equal(CORE.isAllDone({ percent: 100, items: [] }), false);
    assert.equal(CORE.isAllDone({ approx: true, percent: 100, items: [] }), false);
  }],
  ['T09 · D 全部完成时返回成功幂等结果并显示统一文案', () => {
    has('eb', /HSA_CORE\.allDoneResult\(/);
    has('db', /HSA_CORE\.allDoneResult\(/);
    const r = CORE.allDoneResult();
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'allDone');
    for (const k of ['ep', 'dp']) {
      has(k, /'status\.allDone': '已完成，无需动作'/);
      has(k, /HSA_CORE\.TEXT\.allDone/);
    }
  }],
  ['D01 · A 优先最新官网原始网络数据，缓存带时间与上限', () => {
    has('eb', /D01=A/);
    has('db', /D01=A/);
    has('eb', /htmlCacheMaxEntries/);
    has('db', /htmlCacheMaxBytes/);
    assert.equal(CORE.dataSourcePriority()[0], 'official-network');
  }],
  ['D02 · D 新鲜快照补缺，官网本次状态优先', () => {
    has('eb', /HSA_CORE\.mergeSnapshotCards\(/);
    has('db', /HSA_CORE\.mergeSnapshotCards\(/);
  }],
  ['D03 · B 两页失败时允许新鲜可见页面降级同步并标注来源', () => {
    has('eb', /HSA_CORE\.degradedSync\(/);
    has('db', /HSA_CORE\.degradedSync\(/);
    assert.equal(CORE.degradedSync({ at: Date.now() }, { pagesReachable: false }).label, CORE.TEXT.pageData);
  }],
  ['D04 · B 登录态以余额/面板证据为主，三态防误判', () => {
    has('eb', /HSA_CORE\.loginStateFromEvidence\(/);
    has('db', /HSA_CORE\.loginStateFromEvidence\(/);
    assert.equal(CORE.loginStateFromEvidence({}), 'unknown');
    assert.equal(CORE.loginStateFromEvidence({ available: 120 }), 'in');
  }],
  ['D05 · D 确认登出后隐藏当前余额，历史标为上次记录', () => {
    has('eb', /HSA_CORE\.logoutPresentation\(/);
    has('db', /HSA_CORE\.logoutPresentation\(/);
    has('dm', /D05=D/);
    has('ep', /displayLabel|historyLabelEn/);
    has('dp', /displayLabel|historyLabelEn/);
    assert.equal(CORE.logoutPresentation({ available: 300 }).pointsSummary.available, null);
  }],
  ['D06 · D 后台展示短期缓存，刷新/开始/收尾强制新数据', () => {
    has('eb', /HSA_CORE\.syncCachePolicy\(/);
    has('db', /HSA_CORE\.syncCachePolicy\(/);
    assert.equal(CORE.syncCachePolicy('manual-refresh').fresh, true);
    assert.equal(CORE.syncCachePolicy('manual-refresh').cacheAllowed, false);
    assert.equal(CORE.syncCachePolicy('idle').cacheAllowed, true);
  }],
  ['S01 · B 状态行展示运行详情与动态倒计时', () => {
    for (const k of ['ep', 'dp']) {
      has(k, /HSA_CORE\.formatActivityLine\(/);
      has(k, /activityDetail/);
    }
    has('eb', /activityDetail/);
    has('db', /activityDetail/);
  }],
  ['S02 · D 启动卡住一次性检查 + 状态变化复检 + 限时重试', () => {
    has('eh', /shared\/hsa-recovery\.js/);
    has('dh', /hsa-recovery\.js/);
    has('ebs', /globalThis\.HSA_RECOVERY/);
    has('ebs', /\.install\(/);
    has('dh', /HSA_RECOVERY\.install\(/);
    absent('recovery', /setInterval\s*\(/);
    absent('dh', /setInterval\s*\(/);
    assert.equal(CORE.DEFAULTS.stuckMaxRetries, 3);
  }],
  ['U01 · C 插件徽标仅显示状态，桌面保留单击/双击', () => {
    has('eh', /<div id="login-badge"/);
    has('dh', /<button id="login-badge"/);
    has('dp', /addEventListener\('dblclick'/);
    assert.equal(decisions.retainedDifferences[0].id, 'U01');
  }],
  ['U02 · A 应用图标无蓝色渐变底板与阴影', () => {
    has('sharedCss', /\.brand-icon\s*\{[^}]*background:\s*transparent/);
    has('sharedCss', /\.brand-icon\s*\{[^}]*box-shadow:\s*none/);
    absent('dc', /--brand-icon-(bg|shadow)/);
    absent('ec', /--brand-icon-(bg|shadow)/);
    assert.equal(CORE.UI.brandIconPlate, false);
  }],
  ['U03 · B 语言选项顺序 中文 → English → 跟随系统', () => {
    for (const k of ['eh', 'dh']) {
      const s = F[k];
      const zh = s.indexOf('data-value="zh"');
      const en = s.indexOf('data-value="en"');
      const sys = s.indexOf('data-value="system"');
      assert.ok(zh >= 0 && en > zh && sys > en, P[k] + ' 语言顺序不符');
    }
    assert.deepEqual(CORE.UI.languageOrder, ['zh', 'en', 'system']);
  }],
  ['U04 · A 英文语言按钮写 English', () => {
    has('eh', />English</);
    has('dh', />English</);
    absent('eh', />英文</);
    absent('dh', />英文</);
    assert.equal(CORE.UI.englishLabel, 'English');
  }],
  ['U05 · A 积分日历排在自动完成任务设置之后', () => {
    for (const k of ['eh', 'dh']) before(k, 'id="auto-group"', 'id="calendar-group"');
    assert.equal(CORE.UI.calendarAfterAutoGroup, true);
  }],
  ['U06 · B 积分日历默认展开', () => {
    has('eh', /<details[^>]*id="calendar-group"[^>]*\bopen\b/);
    has('dh', /<div class="set-group" id="calendar-group"/);
    absent('dh', /<details[^>]*id="calendar-group"/);
    assert.equal(CORE.UI.calendarDefaultOpen, true);
  }],
  ['U07 · B 积分日历显示颜色图例且双语文案齐全', () => {
    has('eh', /class="cal-legend"/);
    has('dh', /class="cal-legend"/);
    for (const k of ['ep', 'dp']) {
      has(k, /'calendar\.legendHas'/);
      has(k, /'calendar\.legendNone'/);
      assert.ok((F[k].match(/'calendar\.legendHas'/g) || []).length >= 2,
        P[k] + ' 缺少中英双语图例文案');
    }
    assert.equal(CORE.UI.calendarLegend, true);
  }],
  ['U08 · D 短提示单行、长提示换行且全文可读', () => {
    has('sharedCss', /white-space:\s*normal/);
    has('sharedCss', /overflow-wrap:\s*anywhere/);
    has('sharedCss', /max-height/);
    has('sharedCss', /hover-tip\[data-short="1"\]/);
    has('ep', /dataset\.short/);
    has('dp', /dataset\.short/);
    assert.equal(CORE.UI.hoverTipWrap, true);
  }],
  ['U09 · A 关闭定时自动运行时保留页面内解释', () => {
    for (const k of ['eh', 'dh']) has(k, /id="auto-disabled-hint"/);
    has('ep', /auto-disabled-hint/);
    has('dp', /auto-disabled-hint/);
    assert.equal(CORE.UI.autoDisabledHint, true);
  }],
  ['U10 · B 设置/返回按钮使用应用内自定义悬停提示', () => {
    for (const k of ['eh', 'dh']) {
      near(k, 'id="settings-open"', 'data-tip-role="hint"');
      near(k, 'id="settings-back"', 'data-tip-role="hint"');
    }
    assert.equal(CORE.UI.headerButtonsCustomTip, true);
  }],
  ['内存 · HTML 缓存有条目数与字节上限，恢复器不常驻轮询', () => {
    has('eb', /htmlCacheMaxEntries/);
    has('eb', /htmlCacheMaxBytes/);
    has('db', /htmlCacheMaxBytes/);
    has('dm', /manualLinks\.length\s*<\s*20|triggerMethods\.length\s*<\s*64/);
    assert.ok(CORE.DEFAULTS.htmlCacheMaxEntries > 0 && CORE.DEFAULTS.htmlCacheMaxBytes > 0);
  }]
];

function runChecks() {
  return CHECKS.map(([name, fn]) => {
    try {
      const detail = fn();
      return { name, ok: true, detail: typeof detail === 'string' ? detail : 'ok' };
    } catch (err) {
      return { name, ok: false, detail: String(err && err.message || err).split('\n').slice(0, 6).join(' | ') };
    }
  });
}

if (require.main === module) {
  const results = runChecks();
  for (const r of results) console.log((r.ok ? '[OK]   ' : '[FAIL] ') + r.name + ' — ' + r.detail);
  const failed = results.filter(r => !r.ok);
  console.log('—— 通过 ' + (results.length - failed.length) + ' / ' + results.length + ' 项 ——');
  if (failed.length) process.exit(1);
}

module.exports = { runChecks, CHECKS };
