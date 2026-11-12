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
  recovery: 'shared/hsa-recovery.js',
  hoverTip: 'shared/hsa-hover-tip.js',
  zipLib: 'shared/hsa-zip.js',
  pullLib: 'shared/hsa-pull-refresh.js',
  mv3Budget: 'edge-extension/lib/mv3-budget.js',
  runtimeBudget: 'desktop-app/lib/runtime-budget.js',
  preload: 'desktop-app/preload.js',
  sidebarLib: 'desktop-app/lib/sidebar-task-cards.js',
  winBuild: 'desktop-app/scripts/build-win-safe.js',
  linuxBuild: 'desktop-app/scripts/build-linux.sh',
  ymlLinux: 'desktop-app/electron-builder.yml',
  ymlWin: 'desktop-app/electron-builder.win.yml'
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
    has('eb', /pageStableWaitMs/);
    has('db', /pageStableWaitMs/);
    /* v4.2 · 卡片点击间隔改由拟人强度三组预设统一套用，UI 只读展示 */
    has('eh', /data-preset="cardClickIntervalSec"/);
    has('dh', /data-preset="cardClickIntervalSec"/);
    has('eb', /HSA_HUMAN\.applyRunPreset\(/);
    has('db', /HSA_HUMAN\.applyRunPreset\(/);
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
  ['U06 · B 积分日历默认展开（v3.3 两端统一为可折叠 details）', () => {
    for (const k of ['eh', 'dh']) {
      has(k, /<details[^>]*id="calendar-group"[^>]*\bopen\b/);
      has(k, /class="set-group cal-fold" id="calendar-group"/);
      has(k, /<summary class="set-title" data-i18n="calendar.title"/);
    }
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
    has('hoverTip', /dataset\.short/);
    has('hoverTip', /documentElement\.appendChild\(tip\)/);
    has('hoverTip', /2147483647/, 'important');
    has('sharedCss', /z-index: 2147483647 !important/);
    for (const k of ['ep', 'dp']) has(k, /HSA_HOVER_TIP\.install\(document\)/);
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
  }],

  ['严格模式 · 共享配置：≥5 字、当日热搜、禁用清单与安全护栏', () => {
    assert.equal(CORE.STRICT_RUN.minKeywordChars, 5);
    assert.equal(CORE.STRICT_RUN.requireSameDayHot, true);
    assert.equal(CORE.STRICT_RUN.allowFallbackWords, false);
    assert.equal(CORE.STRICT_RUN.allowRepeatWords, false);
    assert.ok(CORE.STRICT_RUN.disabledFeatures.length >= 15);
    assert.ok(CORE.STRICT_RUN.keptGuardrails.includes('stop'));
    assert.ok(CORE.STRICT_RUN.keptGuardrails.includes('page-stable-wait'));
    assert.equal(CORE.strictBlockedMessage('stop', true), false);
  }],
  ['严格模式 · 两端词长校验与当日热搜选词', () => {
    for (const k of ['eb', 'db']) {
      has(k, /HSA_CORE\.isStrictKeyword\(/);
      has(k, /HSA_CORE\.strictQueries\(/);
      has(k, /at: Date\.now\(\)/);
      has(k, /HOT_SOURCES\.slice\(\)/);
      absent(k, /items: shuffle\(unique\)/);
      absent(k, /s\.length >= 2/);
    }
    assert.equal(CORE.strictQueries(3, [{ text: '四字', at: Date.now() }], Date.now()).queries.length, 0);
  }],
  ['严格模式 · 两端禁用改词 / 回首页 / 拟人随机', () => {
    for (const k of ['eb', 'db']) {
      absent(k, /Math\.random\(\) < RELATED_RATE/);
      absent(k, /Math\.random\(\) < GO_HOME_RATE/);
      absent(k, /Math\.random\(\) < ENTER_RATE/);
      absent(k, /await nap\(rand\(/);
      absent(k, /await cdpClickPlan\(tabId, plan\)/);
      absent(k, /for \(const step of scrollPlan/);
      has(k, /strictClickPlan\(/);
      has(k, /STRICT\.fixedNapMs/);
      has(k, /STRICT\.fixedRoundIntervalMs/);
      has(k, /STRICT_POLICY\.pageStableWaitMs/);
      has(k, /strictNoWords/);
    }
  }],
  ['严格模式 · 运行期消息 / 闹钟 / 恢复拦截', () => {
    for (const k of ['eb', 'db']) {
      has(k, /strictRunActive/);
      has(k, /load\(\['running'\]\)\.then\(s => \{ strictRunActive = !!s\.running; \}\)/);
      has(k, /HSA_CORE\.strictBlockedMessage\(msg\.type/);
      has(k, /HSA_CORE\.strictAlarmAllowed\(/);
    }
    assert.equal(CORE.strictRuntimeFeatureAllowed('watchdog-resume', true), false);
    assert.equal(CORE.strictAlarmAllowed('watchdog', true), false);
    assert.equal(CORE.strictAlarmAllowed('cooldownEnd', true), true);
  }],
  ['严格模式 · 两端 popup 运行期禁止改设置 / 定时 / 刷新', () => {
    for (const k of ['ep', 'dp']) {
      has(k, /uiRunning/);
      has(k, /function strictRunGuard\(/);
      has(k, /strictRunGuard\('saveSettings'\)/);
      has(k, /strictRunGuard\('saveAutoTasks'\)/);
      has(k, /strictRunGuard\('refreshTasks'\)/);
      has(k, /HSA_CORE\.TEXT\.strictRunBlocked/);
    }
  }],
  ['严格模式 · 保留停止 / 超时 / 失败上限等护栏', () => {
    for (const k of ['eb', 'db']) {
      has(k, /msg\.type === 'stop'/);
      has(k, /MAX_FAILURES/);
      has(k, /PAGE_TIMEOUT/);
    }
    assert.deepEqual(CORE.STRICT_RUN.keptGuardrails,
      ['stop', 'timeout', 'max-failures', 'page-stable-wait', 'result-counting']);
  }],

  ['诊断 · 共享规则：日志上限 / 字段裁剪 / 实时抓取策略', () => {
    assert.equal(CORE.RUNLOG.maxEntries, 600);
    assert.equal(CORE.VERSION, '2.4.0');
    const l = CORE.runLogAppend([], { event: 'search', zh: 'x', html: '<html/>' }, Date.now());
    assert.equal(Object.prototype.hasOwnProperty.call(l[0], 'html'), false);
    assert.equal(CORE.runLogExport([], { now: 1 }).includes('<html/>'), false);
    const p = CORE.keyPagePolicy();
    assert.equal(p.fresh, true);
    assert.equal(p.cacheAllowed, false);
    assert.equal(p.snapshotAllowed, false);
    assert.equal(p.panelAllowed, false);
    assert.equal(p.dataViewAllowed, false);
    assert.deepEqual(p.pages.map(x => x.path), ['/dashboard', '/earn', '/rewards/panelflyout']);
    assert.equal(p.format, 'zip/html');
    assert.match(CORE.runLogFileName(Date.UTC(2026, 10, 11, 4, 0, 0)), /^hsa-runlog-\d{8}-\d{6}\.json$/);
    assert.match(CORE.keyPageFileName(Date.UTC(2026, 10, 11, 4, 0, 0)), /^hsa-keypages-\d{8}-\d{6}\.zip$/);
    const log = CORE.runLogAppend([], { event: 'user-action', actor: 'user', zh: 'x' }, 1)[0];
    assert.ok(log.ts && log.iso, '每条日志自动带系统时间');
    assert.equal(log.actor, 'user');
    assert.equal(CORE.runLogExport([], { now: 1 }).includes('hsa-runlog/2'), true);
  }],
  ['诊断 · 两端后台：日常只写运行日志，搜索 / 错误 / 抓取均有事件', () => {
    for (const k of ['eb', 'db']) {
      has(k, /const HSA_PLATFORM =/);
      has(k, /runLogEnabled = v !== false/);
      has(k, /function hsaRunLog\(/);
      has(k, /HSA_CORE\.runLogAppend/);
      has(k, /hsaRunLog\('search'/);
      has(k, /hsaRunLog\('error'/);
      has(k, /hsaRunLog\('key-pages'/);
      has(k, /msg\.type === 'exportRunLog'/);
      has(k, /msg\.type === 'captureKeyPages'/);
      has(k, /HSA_CORE\.runLogExport\(/);
      has(k, /HSA_CORE\.keyPageZipFiles\(/);
      has(k, /HSA_ZIP\.buildZip|globalThis\.HSA_ZIP/);
      has(k, /msg\.type === 'logUserAction'/);
    }
  }],
  ['诊断 · 关键网页实时抓取：直连 no-store，不复用缓存 / 快照 / 面板', () => {
    for (const k of ['eb', 'db']) {
      has(k, /async function hsaCaptureKeyPages\(/);
      has(k, /credentials: 'include', cache: 'no-store', signal: ctrl\.signal/);
      has(k, /source: p\.source/);
      has(k, /HSA_CORE\.keyPagePolicy\(\)/);
      const start = F[k].indexOf('async function hsaCaptureKeyPages');
      const body = F[k].slice(start, start + 1800);
      assert.ok(!/hsaHtmlCache|desktopFetchFromSnapshot|desktopFetchFromPanel|desktopFetchFromDataView|readVisibleRewardsSnapshot/.test(body),
        '抓取函数体不应复用缓存 / 快照 / 面板 @ ' + P[k]);
    }
  }],
  ['诊断 · 两端设置页：开关、两个按钮、双语文案与导出接线', () => {
    for (const k of ['eh', 'dh']) {
      has(k, /id="diag-group"/);
      has(k, /id="set-run-log"/);
      has(k, /id="btn-export-runlog"/);
      has(k, /id="btn-capture-keypages"/);
      has(k, /id="diag-status"/);
      has(k, /data-i18n="diag\.note"/);
      has(k, /data-i18n="diag\.capturePages"/);
    }
    for (const k of ['ep', 'dp']) {
      has(k, /runLogEnabled: true/);
      has(k, /'diag\.captureOk'/);
      has(k, /'diag\.empty'/);
      has(k, /function exportDiagFile/);
      has(k, /function runDiagAction/);
      has(k, /runDiagAction\('exportRunLog'/);
      has(k, /runDiagAction\('captureKeyPages'/);
      has(k, /strictRunGuard\('captureKeyPages'\)/);
      has(k, /saveSettings\(\{ runLogEnabled: e\.target\.checked \}\)/);
    }
    has('sharedCss', /\.diag-actions/);
    has('sharedCss', /\.diag-note/);
  }],
  ['诊断 · 桌面导出通道：系统保存对话框写盘', () => {
    const pre = fs.readFileSync(path.join(ROOT, 'desktop-app', 'preload.js'), 'utf8');
    assert.match(pre, /saveExport: \(fileName, content, encoding\) => invoke\('chrome:diag:export'/);
    has('dm', /ipcMain\.handle\('chrome:diag:export'/);
    has('dm', /dlg\.showSaveDialog/);
    has('dm', /fs\.writeFileSync\(res\.filePath/);
    has('dm', /typeof dlg\.showSaveDialog !== 'function'/);
  }],
  ['诊断 · 严格模式白名单：日志导出放行，运行期抓取网页禁用', () => {
    assert.equal(CORE.strictBlockedMessage('exportRunLog', true), false);
    assert.equal(CORE.strictBlockedMessage('captureKeyPages', true), true);
    assert.ok(CORE.STRICT_RUN.allowedMessages.includes('exportRunLog'));
    assert.ok(CORE.STRICT_RUN.blockedMessages.includes('captureKeyPages'));
    assert.ok(CORE.STRICT_RUN.disabledFeatures.includes('key-page-capture'));
  }],

  ['v2.3 · 悬浮框统一：两端同一份共享实现且始终最上层', () => {
    for (const k of ['eh', 'dh']) {
      has(k, /hsa-hover-tip\.js/);
      has(k, /hsa-zip\.js/);
      before(k, 'hsa-hover-tip.js', 'popup.js');
    }
    absent('ep', /function initHoverTips/);
    absent('dp', /function initHoverTips/);
    has('hoverTip', /z-index', '2147483647', 'important'/);
    has('hoverTip', /position', 'fixed', 'important'/);
    assert.equal(CORE.VERSION, '2.4.0');
  }],
  ['v2.3 · 日历禁止跳转到完全没有积分记录的日期', () => {
    for (const k of ['ep', 'dp']) {
      has(k, /HSA_CORE\.calendarNavAllowed\(/);
      has(k, /calendar-nav-blocked/);
      has(k, /id="cal-nav-msg"|cal-nav-msg/);
      has(k, /'calendar\.navBlocked'/);
    }
    for (const k of ['eh', 'dh']) has(k, /id="cal-nav-msg"/);
    const hist = { '2026-11-01': { today: 12 }, '2026-10-03': 15 };
    assert.equal(CORE.calendarNavAllowed(hist, 'day', 2026, 10, -1, '2026-11-11'), true);
    assert.equal(CORE.calendarNavAllowed(hist, 'day', 2026, 10, 1, '2026-11-11'), false);
    assert.equal(CORE.calendarNavAllowed(hist, 'day', 2026, 10, -2, '2026-11-11'), false);
    assert.equal(CORE.calendarNavAllowed(hist, 'month', 2025, 0, 1, '2026-11-11'), true);
  }],
  ['v2.3 · 每次打开设置积分日历自动复位', () => {
    for (const k of ['ep', 'dp']) {
      has(k, /function resetCalendar\(\)/);
      has(k, /HSA_CORE\.calendarReset\(\)/);
      has(k, /function openSettings\(\)[\s\S]{0,220}resetCalendar\(\)/);
    }
    const r = CORE.calendarReset();
    assert.equal(r.mode, 'day');
    assert.ok(r.cursor instanceof Date);
  }],
  ['v2.3 · 关键网页导出为 HTML 的 zip 包（含 Bing 侧边栏）', () => {
    assert.equal(CORE.keyPagePolicy().pages.length, 3);
    assert.equal(CORE.keyPagePolicy().format, 'zip/html');
    const zipSrc = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-zip.js'), 'utf8');
    assert.match(zipSrc, /0x04034B50/);
    assert.match(zipSrc, /0x06054B50/);
    for (const k of ['eb', 'db']) {
      has(k, /keyPageZipFiles\(/);
      has(k, /buildZip\(built\.files, now\)/);
      has(k, /encoding: 'base64'/);
      has(k, /page\.url \|\| \(p\.origin \+ page\.path\)/);
    }
    for (const k of ['ep', 'dp']) {
      has(k, /r\.encoding === 'base64'/);
      has(k, /HSA_ZIP\.fromBase64/);
      has(k, /application\/zip/);
    }
    has('dm', /Buffer\.from\(String\(content \|\| ''\), 'base64'\)/);
    has('preload', /saveExport: \(fileName, content, encoding\)/);
    assert.match(CORE.keyPageFileName(1), /\.zip$/);
  }],
  ['v2.3 · 日志含系统时间、用户操作、运行过程、结果与错误', () => {
    const now = Date.UTC(2026, 10, 10, 17, 52, 7, 321);
    const l = CORE.runLogAppend([], {
      event: 'user-action', actor: 'user', category: 'user-action',
      action: 'start', detail: 'count=30', result: 'ok', error: '', zh: '用户开始'
    }, now)[0];
    assert.ok(l.ts && l.iso, '缺系统时间');
    assert.equal(l.actor, 'user');
    assert.equal(l.category, 'user-action');
    assert.equal(l.detail, 'count=30');
    assert.equal(l.result, 'ok');
    assert.equal(Object.prototype.hasOwnProperty.call(l, 'html'), false);
    const out = JSON.parse(CORE.runLogExport([l], { now: now }));
    assert.equal(out.schema, 'hsa-runlog/2');
    assert.ok(out.fields.some(f => /系统时间/.test(f)));
    assert.ok(out.fields.some(f => /用户操作/.test(f)));
    assert.ok(out.fields.some(f => /错误信息/.test(f)));
    for (const k of ['eb', 'db']) {
      has(k, /msg\.type === 'logUserAction'/);
      has(k, /hsaRunLog\('run-state'|hsaRunLog\('activity'/);
      has(k, /category: 'error'|category: 'result'/);
    }
    for (const k of ['ep', 'dp']) {
      has(k, /function logUserAction\(/);
      has(k, /logUserAction\(type, summarize\(extra\)\)/);
    }
    assert.equal(CORE.strictBlockedMessage('logUserAction', true), false);
  }],
  ['v2.3 · Windows 与 Ubuntu 编译结果同目录并直接覆盖', () => {
    for (const k of ['ymlLinux', 'ymlWin']) {
      has(k, /output: \.\.\/release/);
      absent(k, /\$\{version\}/);
      assert.match(F[k], /artifactName: HumanSearchAssistant-(Ubuntu|Windows)[^\n]*\.\$\{ext\}/);
    }
    has('winBuild', /const outputRel = '\.\.\/release'/);
    absent('winBuild', /win-\$\{stamp\}-\$\{process\.pid\}/);
    absent('winBuild', /windows-builds/);
    has('linuxBuild', /release/);
    for (const k of ['ymlLinux', 'ymlWin']) has(k, /shared\/\*\*\/\*/);
  }],
  ['v2.3 · 任务卡严格按任务列表顺序依次执行', () => {
    has('dm', /HSA_CORE\.taskListOrder\(/);
    has('dm', /HSA_CORE\.taskListNames\(/);
    has('sidebarLib', /domOrder/);
    const cards = [{ name: 'C', idx: 9 }, { name: 'A', idx: 1 }, { name: 'B', idx: 5 }];
    const ordered = CORE.taskListOrder(cards);
    assert.deepEqual(ordered.map(c => c.name), ['A', 'B', 'C']);
    const stable = CORE.taskListOrder([{ name: 'X', domOrder: 2 }, { name: 'Y', domOrder: 1 }]);
    assert.deepEqual(stable.map(c => c.name), ['Y', 'X']);
    assert.equal(CORE.taskListNames(cards).join(' → '), 'A → B → C');
    has('db', /HSA_CORE\.taskPlanNames\(idxItems/);
  }],
  ['v2.4 · 桌面积分卡悬浮框对齐插件版并始终最上层', () => {
    has('dc', /\.tip \{[\s\S]{0,220}z-index: 2147483647/);
    has('dc', /\.point-card:hover,[\s\S]{0,260}z-index: 2147483647/);
    has('ec', /\.tip \{[\s\S]{0,220}z-index: 2147483647/);
    has('hoverTip', /documentElement\.appendChild\(tip\)/);
    has('sharedCss', /z-index: 2147483647 !important/);
    for (const k of ['dp', 'ep']) has(k, /HSA_HOVER_TIP\.install\(document\)/);
    /* 只对积分卡 .tip 规则块断言，避免误伤页面其它元素的 z-index: 30 */
    const tipAt = F.dc.indexOf('.tip {');
    const tipBlock = F.dc.slice(tipAt, tipAt + 400);
    assert.match(tipBlock, /z-index: 2147483647/);
    assert.doesNotMatch(tipBlock, /z-index: 30\b/);
  }],
  ['v2.4 · 桌面版移除「静默完成任务」开关', () => {
    for (const k of ['dh', 'dp']) {
      absent(k, /set-silent-run/);
      absent(k, /desktop\.silent/);
    }
    absent('dp', /silentRun/);
    has('dm', /function desktopSilentRun\(\)[\s\S]{0,220}return false/);
    /* v2.6：原位置顶替的「侧栏在独立窗口显示」开关也已移除，
       桌面专有设置只剩「开机自动启动」。 */
    for (const k of ['dh', 'dp']) {
      absent(k, /set-sidebar-window/);
      absent(k, /desktop\.sidebarWindow/);
      absent(k, /sidebarWindow/);
    }
    has('dh', /id="set-auto-launch"/);
  }],
  ['v2.4 · 主窗口与设置共用唯一滚动条，侧栏独立滚动', () => {
    has('dh', /<div id="scroll-root">/);
    has('dh', /<\/div><!-- \/#scroll-root -->/);
    const html = F.dh;
    assert.ok(html.indexOf('id="scroll-root"') < html.indexOf('class="app" id="main"'),
      '滚动容器必须先于主界面');
    assert.ok(html.indexOf('id="settings"') < html.indexOf('/#scroll-root'),
      '设置必须与主界面在同一个滚动容器内');
    has('dc', /#scroll-root \{[\s\S]{0,220}overflow-y: auto/);
    has('dc', /overscroll-behavior: contain/);
    has('dc', /body\.settings-open \.app \{ display: none; \}/);
    /* 设置不再 fixed 覆盖、不再自带滚动条 */
    absent('dc', /\.settings \{[\s\S]{0,260}position: fixed/);
    absent('dc', /\.settings-body \{[\s\S]{0,220}overflow-y: auto/);
    has('dc', /\.settings\.open \{\s*display: flex/);
    for (const tag of ['function openSettings()', 'function closeSettings()']) {
      const at = F.dp.indexOf(tag);
      assert.ok(at >= 0, '缺少 ' + tag);
      assert.match(F.dp.slice(at, at + 420), /scroll-root[\s\S]{0,120}scrollTop = 0/);
    }
  }],
  ['v2.6 · 独立窗口设置与功能已移除，侧栏固定内嵌', () => {
    /* 设置页 / 字典 / preload / 主进程 IPC / 独立窗口 helper 全部清空 */
    for (const k of ['dh', 'dp', 'preload', 'dm']) {
      for (const pat of [/'chrome:app:sidebarWindow'/, /setSidebarWindow/,
        /getSidebarWindow/, /sidebarWindowEnabled/, /sidebarWin\b/,
        /openDetachedSidebar/, /closeDetachedSidebar/, /sidebarDetachedOpen/,
        /set-sidebar-window/, /sidebarWindow: v/]) {
        absent(k, pat);
      }
    }
    absent('dh', /desktop\.sidebarWindow/);
    absent('dp', /desktop\.sidebarWindow/);
    /* 侧栏仍内嵌且自带独立滚动条，主界面与设置共用唯一滚动条 */
    has('dm', /function showSidePanel\(url, reason, active\)[\s\S]{0,1400}popupWin\.setSize\(COLLAPSED_WIDTH \+ PANEL_DEFAULT_RIGHT/);
    has('dm', /popupWin\.focus\(\);   \/\/ 仅显式用户动作激活窗口/);
    has('dm', /sideView\.setBounds\(\{ x: PANEL_LEFT, y: 0, width: Math\.max\(0, cw - PANEL_LEFT\), height: ch \}\)/);
    has('dc', /#scroll-root \{[\s\S]{0,220}overflow-y: auto/);
    has('dc', /overscroll-behavior: contain/);
  }],

  ['v2.5 · 两端下拉刷新页面：共享手势模块、指示器与刷新链路', () => {
    const PTR = require(path.join(ROOT, 'shared', 'hsa-pull-refresh.js'));
    assert.equal(PTR.VERSION, '1.0.0');
    has('pullLib', /function decide\(/);
    has('pullLib', /function wheelAccum\(/);
    has('pullLib', /function install\(/);
    has('pullLib', /touchstart|touchmove|mousedown|wheel/);
    /* 纯逻辑：顶部下拉才生效、带阻尼与阈值；刷新中 / 拦截时不响应 */
    const d = PTR.decide({ startY: 100, currentY: 240, scrollTop: 0 });
    assert.equal(d.active, true);
    assert.equal(d.pull, 70);
    assert.equal(d.armed, true);
    assert.equal(PTR.decide({ startY: 100, currentY: 240, scrollTop: 8 }).active, false);
    assert.equal(PTR.decide({ startY: 100, currentY: 240, scrollTop: 0, refreshing: true }).active, false);
    assert.equal(PTR.wheelAccum({ deltaY: -120, accumulated: 0, scrollTop: 0 }), 36);
    assert.equal(PTR.wheelAccum({ deltaY: -120, accumulated: 36, scrollTop: 5 }), 0);
    for (const k of ['eh', 'dh']) {
      has(k, /id="pull-refresh"/);
      has(k, /data-pull-text/);
      has(k, /hsa-pull-refresh\.js/);
      before(k, 'hsa-pull-refresh.js', 'popup.js');
    }
    for (const k of ['ep', 'dp']) {
      has(k, /HSA_PULL_REFRESH\.install\(/);
      has(k, /scroller: \(\) => \$\('scroll-root'\) \|\| document\.scrollingElement/);
      has(k, /await send\('refreshTasks'\)/);
      /* v3.2 · 一次下拉手势只留一条用户操作日志（send 统一埋点），
         旧的 trigger + refreshTasks + pull-refresh 三条重复已移除。 */
      absent(k, /logUserAction\('pull-refresh'/);
      absent(k, /logUserAction\('pull-refresh-trigger'/);
      has(k, /一次下拉手势只留一条/);
      for (const key of ['pull.idle', 'pull.pull', 'pull.armed',
        'pull.refreshing', 'pull.done', 'pull.error', 'pull.blocked']) {
        has(k, new RegExp("'" + key + "'"));
      }
    }
    has('sharedCss', /\.pull-refresh \{/);
    has('sharedCss', /pull-refresh\[data-state="refreshing"\]/);
    assert.ok(require(path.join(ROOT, 'scripts', 'sync-shared.js')) &&
      fs.readFileSync(path.join(ROOT, 'scripts', 'sync-shared.js'), 'utf8').includes('hsa-pull-refresh.js'));
  }],
  ['v2.5 · 下拉刷新与严格运行模式衔接：运行期拦截、空闲才刷新', () => {
    /* 下拉复用 refreshTasks：运行期由严格白名单拦截；日志写入仍放行。 */
    assert.equal(CORE.strictBlockedMessage('refreshTasks', true), true);
    assert.equal(CORE.strictBlockedMessage('logUserAction', true), false);
    for (const k of ['ep', 'dp']) {
      has(k, /blocked: \(\) => strictRunGuard\('refreshTasks'\)/);
      has(k, /enabled: \(\) => !body\.classList\.contains\('settings-open'\)/);
    }
  }],
  ['v2.5 · 所有悬浮框统一最上层（截图黑色提示 / 圆环卡 / 登录提示）', () => {
    const TOP = /z-index:\s*2147483647/;
    for (const k of ['ec', 'dc']) {
      for (const sel of ['.tip {', '.ring-hover-card {']) {
        const at = F[k].indexOf(sel);
        assert.ok(at >= 0, k + ' 缺少 ' + sel);
        assert.match(F[k].slice(at, at + 1200), TOP, k + ' ' + sel + ' 不在最上层');
      }
    }
    const loginAt = F.dc.indexOf('.login-badge-tip {');
    assert.ok(loginAt >= 0);
    assert.match(F.dc.slice(loginAt, loginAt + 320), TOP);
    has('hoverTip', /'z-index', '2147483647', 'important'/);
    has('sharedCss', /z-index: 2147483647 !important/);
  }],
  ['v2.5 · 下拉指示器不引入第二根滚动条，桌面单滚动条结构保持', () => {
    /* 指示器 fixed 且不接收指针事件，放在共享滚动容器之外，不参与滚动链。 */
    has('sharedCss', /\.pull-refresh \{[\s\S]{0,400}position: fixed/);
    has('sharedCss', /pointer-events: none/);
    for (const k of ['eh', 'dh']) {
      const html = F[k];
      assert.ok(html.indexOf('id="pull-refresh"') > 0, k + ' 缺少指示器');
      assert.ok(html.indexOf('</body>') > html.indexOf('id="pull-refresh"'),
        k + ' 指示器应放在 body 末尾，不夹在滚动容器与主界面之间');
    }
    has('dh', /<div id="scroll-root">/);
    has('dc', /#scroll-root \{[\s\S]{0,220}overflow-y: auto/);
    has('dc', /overscroll-behavior: contain/);
    has('dc', /body \{[\s\S]{0,400}overflow: hidden/);
  }],
  ['v2.6 · 下拉刷新为 minirefresh applet 主题风格（仿微信小程序三点）', () => {
    /* 50px 透明下拉区、无边框无文字；三点 ball-beat 与交错动画 */
    has('sharedCss', /v2\.6 · 下拉刷新 · minirefresh applet 主题风格/);
    has('sharedCss', /\.pull-refresh \{[\s\S]{0,360}height: 50px/);
    has('sharedCss', /background: transparent; border: 0/);
    has('sharedCss', /min\(var\(--pull, 0px\), 50px\)/);
    has('sharedCss', /\.ball-beat \.dot \{[\s\S]{0,260}width: 8px; height: 8px/);
    has('sharedCss', /opacity: calc\(\.3 \+ var\(--pull-progress, 0\) \* \.55\)/);
    has('sharedCss', /@keyframes hsa-ball-beat/);
    has('sharedCss', /animation: hsa-ball-beat \.9s infinite ease-in-out both/);
    has('sharedCss', /dot:nth-child\(2\) \{ animation-delay: \.16s/);
    has('sharedCss', /dot:nth-child\(3\) \{ animation-delay: \.32s/);
    has('sharedCss', /\.loading-applet \.ball-beat \.dot/);
    has('sharedCss', /\.pull-text \{[\s\S]{0,300}opacity: 0/);
    has('sharedCss', /\[data-state="error"\] \.pull-text/);
    has('sharedCss', /prefers-reduced-motion: reduce/);
    /* 视觉隐藏文字，仅拦截 / 失败时露出；无成功动画 */
    absent('sharedCss', /data-state="done"[^\n]*\{ opacity: 1/);
    /* 两端 DOM：三个点 + 文案节点，移除旧箭头 */
    for (const k of ['eh', 'dh']) {
      has(k, /class="ball-beat" aria-hidden="true"><i class="dot"><\/i><i class="dot"><\/i><i class="dot"><\/i>/);
      absent(k, /pull-arrow/);
      has(k, /class="pull-text" data-pull-text/);
    }
    /* 文案对齐 default 主题语义，新增 error 键 */
    for (const k of ['ep', 'dp']) {
      for (const lit of ["'pull.armed': '释放刷新'", "'pull.refreshing': '加载中...'",
        "'pull.done': '刷新成功'", "'pull.error': '刷新失败'",
        "'pull.armed': 'Release to refresh'", "'pull.done': 'Refreshed'",
        "'pull.error': 'Refresh failed'"]) {
        has(k, new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      has(k, /error: t\('pull\.error'\)/);
      has(k, /wrap: \(\) => \$\('main'\) \|\| \$\('scroll-root'\) \|\| document\.scrollingElement/);
    }
    /* 共享手势模块：内容跟随 translate、进度变量、loading 类、error 状态 */
    has('pullLib', /isWrapCssTranslate=true/);
    has('pullLib', /var getWrap =/);
    has('pullLib', /wrap\.style\.transform = pull > 0 \? 'translateY\(' \+ pull \+ 'px\)'/);
    has('pullLib', /--pull-progress/);
    has('pullLib', /classList\.toggle\('loading-applet', next === 'refreshing'\)/);
    has('pullLib', /error: l\.error/);
    has('pullLib', /render\(r && r\.ok === false \? 'error' : 'done'/);
    /* 纯逻辑回归：成功直接回弹收起、失败保留提示 */
    const PTR = require(path.join(ROOT, 'shared', 'hsa-pull-refresh.js'));
    assert.equal(PTR.decide({ startY: 0, currentY: 140, scrollTop: 0 }).armed, true);
    assert.equal(PTR.DEFAULTS.maxPull, 96);
  }],
  ['v2.6 · 下拉刷新仍零第三方依赖且两端共享唯一实现', () => {
    /* 不引入 minirefresh 库文件，只复刻主题视觉；v3.3 起共享清单为 12 个文件 */
    const sync = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-shared.js'), 'utf8');
    assert.match(sync, /hsa-pull-refresh\.js/);
    assert.doesNotMatch(sync, /minirefresh/);
    for (const k of ['eh', 'dh']) {
      assert.doesNotMatch(F[k], /minirefresh[^"]*\.js/);
      has(k, /hsa-pull-refresh\.js/);
    }
    const files = sync.match(/const FILES = \[([\s\S]*?)\];/)[1];
    assert.equal((files.match(/\.js'|\.css'|\.json'/g) || []).length, 12);
  }],
  ['v3.7 · 桌面版标准 Chrome 标识：去 Electron 化，且不过度伪造', () => {
    /* 插件版 / 后台 / preload / host 仍不做任何身份改写（只改桌面主进程） */
    for (const k of ['eb', 'db', 'preload', 'host']) {
      for (const pat of [
        /userAgentFallback/, /setUserAgent/, /CHROME_IDENTITY_SCRIPT/,
        /EDGE_IDENTITY/, /edge-identity/, /SOURCE_UA/,
        /HSA_APPLY_EDGE_IDENTITY/, /chrome:edge:profile/, /getEdgeProfile/,
        /applyFetchHeaders/, /installEdgeClientHints/
      ]) {
        absent(k, pat, P[k] + ' 不应有身份改写 ' + pat);
      }
    }
    /* 桌面主进程：UA / UA-CH / navigator 同源对齐，去掉 Electron 标记 */
    has('dm', /const CHROME_BUILD_VERSION = String\(process\.versions\.chrome/);
    has('dm', /app\.userAgentFallback = CHROME_UA/);
    has('dm', /const CHROME_UA = 'Mozilla\/5\.0 \('/);
    has('dm', /const CHROME_CH_UA = '"Chromium";v="'/);
    has('dm', /function applyChromeIdentityHeaders\(\)/);
    has('dm', /function attachChromeIdentity\(webContents\)/);
    has('dm', /app\.on\('web-contents-created'/);
    has('dm', /CHROME_IDENTITY_SCRIPT/);
    has('dm', /Chrome\/' \+ CHROME_BUILD_VERSION/);
    has('dm', /'"Chromium";v="' \+ CHROME_MAJOR/);
    /* 版本/平台只取真实值，不伪造硬件指纹，也不恢复旧 Edge 身份模块 */
    for (const pat of [/WEBGL_debug_renderer_info/, /WebGLRenderingContext/,
                       /defineProperty\(screen/, /EDGE_IDENTITY/,
                       /edge-identity\.js/, /SOURCE_UA/]) {
      absent('dm', pat, '桌面版不应过度伪造 ' + pat);
    }
    absent('dm', /'Electron;v=/);
    for (const k of ['eb', 'db']) {
      absent(k, /'User-Agent':/);
      has(k, /Referer: 'https:\/\/weibo\.com\/'/);
    }
    has('dm', /const DEFAULT_BROWSER_HOME = 'https:\/\/www\.bing\.com\/\?mkt=zh-CN'/);
    has('dm', /const DEFAULT_SEARCH_ENGINE = 'https:\/\/www\.bing\.com\/search\?q='/);
    assert.equal(fs.existsSync(path.join(ROOT, 'desktop-app', 'lib', 'edge-identity.js')), false);
    for (const k of ['ymlLinux', 'ymlWin']) {
      absent(k, /edge-identity\.js/);
      has(k, /lib\/runtime-budget\.js/);
    }
    /* 桌面专有设置行如实说明 Chrome 标识 */
    has('dh', /标准 Chrome 标识/);
    has('dp', /'desktop\.edgeValue': 'Chrome 标识 · Bing'/);
    has('dp', /'desktop\.edgeValue': 'Chrome · Bing'/);
    absent('dh', /伪装为 Microsoft Edge/);
    absent('dh', /不做任何身份伪装/);
  }],
  ['v2.9 · 插件版专用预算模块：MV3 策略与桌面版取值不同', () => {
    const M = require(path.join(ROOT, 'edge-extension', 'lib', 'mv3-budget.js'));
    const D = require(path.join(ROOT, 'desktop-app', 'lib', 'runtime-budget.js'));
    assert.equal(M.VERSION, '1.0.0');
    assert.equal(M.POLICY.htmlCacheMaxEntries, 1);
    /* v3.1：96KB 误把官网响应体截断导致同步弹官网，恢复为 applet 版 600KB，
       但仍只作为「单条缓存准入门槛」，响应体本身永不截断。 */
    assert.equal(M.POLICY.htmlCacheMaxBytes, 600 * 1024);
    assert.equal(M.POLICY.htmlCacheTtlMs, 45000);
    assert.equal(M.POLICY.capturedHtmlBytes, 256 * 1024);
    assert.equal(M.POLICY.runLogEntries, 180);
    assert.equal(M.POLICY.usedWordsMax, 120);
    /* 两端分别取值，不是共用一套 */
    assert.notEqual(M.POLICY.runLogEntries, D.POLICY.runLogEntries);
    assert.notEqual(M.POLICY.usedWordsMax, D.POLICY.usedWordsMax);
    has('eb', /importScripts\('lib\/mv3-budget\.js'\)/);
    absent('db', /mv3-budget/);
    has('eb', /已移除所有浏览器伪装/);
    /* 缓存裁剪纯函数 */
    const map = new Map([['a', { at: 1 }], ['b', { at: Date.now() }], ['c', { at: Date.now() }]]);
    assert.ok(M.trimCache(map, Date.now()) >= 2);
    assert.equal(map.size, 1);
    assert.equal(M.trimLog(Array.from({ length: 400 }, (_, i) => i)).length, 179);
    assert.equal(M.trimUsedWords(Array.from({ length: 500 }, (_, i) => i)).length, 120);
  }],
  ['v2.9 · 插件版日志批量合并：N 条只写一次，导出前冲刷', async () => {
    const M = require(path.join(ROOT, 'edge-extension', 'lib', 'mv3-budget.js'));
    const stores = [];
    let scheduled = null;
    const b = M.makeLogBatcher({
      load: () => Promise.resolve({ runLog: [] }),
      store: v => { stores.push(v); return Promise.resolve(); },
      append: (l, e) => l.concat([e]),
      schedule: fn => { scheduled = fn; return 7; },
      cancel: () => { scheduled = null; }
    });
    for (let i = 0; i < 5; i++) b.add({ at: i, event: 'e' + i });
    assert.equal(b.size(), 5);
    assert.ok(scheduled, '应排队一次尾随写');
    await b.flush();
    assert.equal(stores.length, 1, '5 条日志必须合并成 1 次 storage 写');
    assert.equal(stores[0].runLog.length, 5);
    assert.equal(b.size(), 0);
    has('eb', /const runLogBatcher = MV3\.makeLogBatcher/);
    has('eb', /function flushRunLog\(\)/);
    has('eb', /await flushRunLog\(\)/);
    has('eb', /hsaRunLog\('activity'/);
    has('eb', /MV3\.cacheableHtml\(html\)/);
    has('eb', /MV3\.officialPageValue\(res, html, Date\.now\(\)\)/);
    has('eb', /MV3\.POLICY\.capturedHtmlBytes/);
    has('eb', /MV3\.trimUsedWords/);
  }],
  ['v2.9 · 桌面版专用预算模块：写盘节流 / 落盘裁剪 / 空闲视图回收', () => {
    const D = require(path.join(ROOT, 'desktop-app', 'lib', 'runtime-budget.js'));
    assert.equal(D.VERSION, '1.0.0');
    assert.equal(D.POLICY.stateWriteMinGapMs, 150);
    assert.equal(D.POLICY.diskSnapshotHtmlBytes, 256 * 1024);
    assert.equal(D.POLICY.runLogEntries, 240);
    assert.equal(D.POLICY.dataViewIdleMs, 90000);
    /* 前导立即写 + 尾随合并 */
    let writes = 0, trailing = null;
    const t = D.makeWriteThrottle({
      now: () => 1000, write: () => writes++,
      schedule: fn => { trailing = fn; return 1; }, cancel: () => { trailing = null; }
    });
    t.save();
    assert.equal(writes, 1, '首次写必须立即落盘（启动校验依赖）');
    t.save(); t.save();
    assert.equal(writes, 1, '高频写应被合并');
    trailing();
    assert.equal(writes, 2);
    t.flush();
    assert.equal(writes, 3);
    /* 落盘副本裁剪但内存态完整 */
    const state = { a: 1,
      visibleRewardsSnapshot: { html: 'x'.repeat(700000), text: 'y'.repeat(90000), foo: 2 },
      runLog: Array.from({ length: 700 }, () => ({ z: 1 })) };
    const disk = D.diskState(state);
    assert.equal(disk.visibleRewardsSnapshot.html.length, D.POLICY.diskSnapshotHtmlBytes);
    assert.equal(disk.visibleRewardsSnapshot.text.length, D.POLICY.diskSnapshotTextBytes);
    assert.equal(disk.visibleRewardsSnapshot.htmlTruncated, true);
    assert.equal(disk.runLog.length, 240);
    assert.equal(state.visibleRewardsSnapshot.html.length, 700000, '内存态不得被裁剪');
    assert.equal(D.shouldReleaseIdleView(0, 91000, false), true);
    assert.equal(D.shouldReleaseIdleView(0, 91000, true), false, '运行中绝不释放');
    assert.equal(D.shouldReleaseIdleView(0, 1000, false), false);
    assert.equal(D.trimUsedWords(Array.from({ length: 500 }, () => 1)).length, 160);
  }],
  ['v2.9 · 桌面主进程接线：节流写盘 / 退出强刷 / 调试期零整页 HTML / 空闲视图回收', () => {
    has('dm', /const RUNTIME_BUDGET = require\('\.\/lib\/runtime-budget\.js'\)/);
    has('dm', /const stateWrites = RUNTIME_BUDGET\.makeWriteThrottle/);
    has('dm', /RUNTIME_BUDGET\.diskState\(state\)/);
    has('dm', /function flushStateSync\(\)/);
    has('dm', /flushStateSync\(\);   \/\/ v2\.9：把节流的尾随写强制落盘/);
    absent('dm', /JSON\.stringify\(state, null, 2\)/);
    has('dm', /if \(DBG\.enabled\) \{/);
    has('dm', /if \(!DBG\.enabled\) return;   \/\/ v2\.9：调试关闭时零整页 HTML 分配/);
    has('dm', /function startDataViewSweep\(\)/);
    has('dm', /function stopDataViewSweep\(\)/);
    has('dm', /RUNTIME_BUDGET\.shouldReleaseIdleView\(d\.lastUsed, now, false\)/);
    has('dm', /d\.lastUsed = now;/);
    has('dm', /if \(id\.unref\) id\.unref\(\);/);
    /* 视图创建入口改回无伪装名字，仍保持唯一 new ViewClass */
    has('dm', /function newEmbeddedView\(prefs\)/);
    assert.equal((F.dm.match(/newEmbeddedView\(embeddedViewPrefs\(\)\)/g) || []).length, 4);
    assert.equal((F.dm.match(/new ViewClass\(/g) || []).length, 1);
    absent('dm', /newEdgeView|edgeViews|applyEdgeProfile/);
  }],
  ['v2.9 · 桌面后台脚本分别收紧：日志 / 历史词 / 官网 HTML 上限', () => {
    has('db', /const DESKTOP_MEM = Object\.freeze\(\{/);
    has('db', /runLogEntries: 240/);
    has('db', /usedWordsMax: 160/);
    has('db', /htmlCacheMaxBytes: 600 \* 1024/);
    has('db', /function desktopTrimLog\(list\)/);
    has('db', /HSA_CORE\.runLogAppend\(desktopTrimLog\(s && s\.runLog\)/);
    has('db', /HSA_CORE\.runLogAppend\(desktopTrimLog\(cur && cur\.runLog\)/);
    has('db', /slice\(-DESKTOP_MEM\.usedWordsMax\)/);
    has('db', /slice\(0, DESKTOP_MEM\.htmlCacheMaxBytes\)/);
    /* 两端策略不同：插件用批量队列，桌面靠主进程写盘节流 */
    absent('db', /makeLogBatcher|runLogBatcher/);
    absent('eb', /makeWriteThrottle|diskState/);
  }],
  ['v2.9 · 默认 Bing 与登录/积分链路 URL 不变，共享清单 12 个文件（含 hsa-calendar.js）', () => {
    has('dm', /win\.loadURL\(url && url !== 'about:blank' \? url : DEFAULT_BROWSER_HOME\)/);
    has('dm', /sideView\.webContents\.loadURL\(DEFAULT_BROWSER_HOME\)/);
    has('dm', /openInSidePanel\(url \|\| DEFAULT_BROWSER_HOME, 'user'\)/);
    has('dm', /openInSidePanel\('https:\/\/rewards\.bing\.com\/dashboard', 'user'\)/);
    has('dm', /https:\/\/rewards\.bing\.com\/earn/);
    for (const k of ['eb', 'db']) {
      has(k, /const HOME_URL = 'https:\/\/www\.bing\.com\/\?mkt=zh-CN'/);
      has(k, /const DASHBOARD_URL = 'https:\/\/rewards\.bing\.com\/dashboard'/);
      has(k, /const EARN_URL = 'https:\/\/rewards\.bing\.com\/earn'/);
    }
    const sync = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-shared.js'), 'utf8');
    assert.doesNotMatch(sync, /edge-profile|mv3-budget|runtime-budget/);
    assert.equal((sync.match(/const FILES = \[([\s\S]*?)\];/)[1]
      .match(/\.js'|\.css'|\.json'/g) || []).length, 12);
  }],
  ['v2.9 · 设置页只读信息仍在且无新增开关', () => {
    has('dh', /data-i18n="desktop\.edge"/);
    has('dh', /data-i18n="desktop\.edgeValue"/);
    has('dh', /data-i18n-title="desktop\.edgeHint"/);
    assert.doesNotMatch(F.dh, /id="set-edge/);
    const at = F.dh.indexOf('data-i18n="desktop.edge"');
    assert.doesNotMatch(F.dh.slice(at, at + 320), /<input/);
  }],
  ['v3.2 · 打开主界面同步一次：30 分钟冷却 + 两端统一闸门', () => {
    const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
    assert.equal(CORE.SYNC_ON_OPEN.messageType, 'syncOnOpen');
    assert.equal(CORE.SYNC_ON_OPEN.reason, 'ui-open');
    assert.equal(CORE.SYNC_ON_OPEN.minGapMs, 30 * 60 * 1000, '用户要求 30 分钟');
    assert.equal(CORE.SYNC_ON_OPEN.storageKey, 'syncOnOpenAt');
    assert.equal(CORE.syncOnOpenAllowed(false, null, 1000000), true);
    assert.equal(CORE.syncOnOpenAllowed(true, null, 1000000), false, '运行中一律例外');
    assert.equal(CORE.syncOnOpenAllowed(false, 400000, 1000000), false, '10 分钟内重复打开被拦');
    assert.equal(CORE.syncOnOpenAllowed(false, -800000, 1000000), true, '正好 30 分钟放行');
    assert.equal(CORE.syncCachePolicy('ui-open').fresh, true);
    assert.equal(CORE.strictBlockedMessage('syncOnOpen', true), true);
    assert.equal(CORE.strictBlockedMessage('syncOnOpen', false), false);
    for (const k of ['ep', 'dp']) {
      has(k, /async function requestSyncOnOpen\(\)/);
      has(k, /HSA_CORE\.syncOnOpenAllowed\(running, lastAt, now\)/);
      has(k, /send\(HSA_CORE\.SYNC_ON_OPEN\.messageType/);
      has(k, /requestSyncOnOpen\(\);/);
      /* 短状态与详细全文 */
      has(k, /HSA_CORE\.clampStatus/);
      has(k, /HSA_CORE\.statusFull/);
    }
    has('dp', /chrome\.runtime\.onUiOpened\.addListener\(\(\) => requestSyncOnOpen\(\)\)/);
    absent('ep', /onUiOpened/);
    has('preload', /onUiOpened: makeEvent\('ui:opened'\)/);
    has('dm', /broadcast\('ui:opened', \[\{ at: Date\.now\(\) \}\]\)/);
    for (const k of ['eb', 'db']) {
      has(k, /msg\.type === HSA_CORE\.SYNC_ON_OPEN\.messageType/);
      has(k, /syncGate\.request\(\{ reason: HSA_CORE\.SYNC_ON_OPEN\.reason \}\)/);
      has(k, /const syncGate = HSA_CORE\.createSyncGate\(\{/);
    }
    const coreSrc = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8');
    assert.match(coreSrc, /syncNotice: notice/);
    assert.match(coreSrc, /createSyncGate: createSyncGate/);
    assert.equal(CORE.VERSION,
      require(path.join(ROOT, 'edge-extension', 'shared', 'hsa-core.js')).VERSION);
  }],
  ['v3.0 · 桌面静默内存：静默期最多留 2 个 renderer', () => {
    const GOV = fs.readFileSync(path.join(ROOT, 'desktop-app', 'lib', 'memory-governor.js'), 'utf8');
    /* 侧栏创建时不再预加载 Bing SPA，只在展开 / 恢复时加载 */
    has('dm', /function loadSideViewDefault\(url\)/);
    has('dm', /if \(!url\) loadSideViewDefault\(\)/);
    has('dm', /创建时不预加载/);
    const ensure = F.dm.slice(F.dm.indexOf('function ensureSideView(initialUrl)'),
      F.dm.indexOf('function ensureSideView(initialUrl)') + 700);
    assert.doesNotMatch(ensure, /loadURL\(DEFAULT_BROWSER_HOME\)/,
      '创建视图时不得预加载默认页');
    assert.match(ensure, /if \(initialUrl\)/, '恢复时按原 URL 重建');
    /* 静默无条件释放侧栏 + 退出静默按需恢复 */
    has('dm', /let sideViewRestore = null;/);
    has('dm', /sideViewRestore = \{/);
    has('dm', /function restoreSideViewIfNeeded\(\)/);
    has('dm', /if \(!r \|\| !r\.visible\) return 0;/);
    has('dm', /if \(sideViewRestore\) sideViewRestore\.visible = false;/);
    absent('dm', /侧栏只在面板收起时释放/);
    /* 退出/dispose 不重建 */
    has('dm', /onExit: reason => \{/);
    has('dm', /if \(reason === 'dispose' \|\| quitting\) return;/);
    /* 静默期大快照从内存移除 + 日志收紧 */
    has('dm', /delete s\.html;/);
    has('dm', /s\.htmlQuietTrimmed = true;/);
    has('dm', /RUNTIME_BUDGET\.POLICY\.runLogEntries/);
    has('dm', /trimSnapshotHtml\(s, SNAPSHOT_HTML_LIMIT\)/);
    /* 静默时停止隐藏 renderer 加载 + 清 HTTP 缓存（不碰 Cookie） */
    has('dm', /if \(on\) \{ try \{ if \(typeof wc\.stop === 'function'\) wc\.stop\(\); \} catch \{\} \}/);
    has('dm', /s\.clearCache\(\)/);
    has('dm', /不影响登录 Cookie/);
    /* 巡检 2 分钟且会重复回收静默期间新建的视图 */
    assert.match(GOV, /sweepIntervalMs: 2 \* 60 \* 1000/);
    assert.match(GOV, /const released = Number\(this\._call\('releaseIdleViews'\)\) \|\| 0;/);
    assert.match(GOV, /this\._call\('onEnter', reason\)/);
    assert.match(GOV, /this\._call\('onExit', reason\)/);
    assert.match(GOV, /unref\(\)/);
  }],
  ['v3.1 · 异常根因已消除：官网响应体不再被缓存上限截断', () => {
    const M = require(path.join(ROOT, 'edge-extension', 'lib', 'mv3-budget.js'));
    /* 纯函数：响应体原样保留，700KB 也不截断 */
    const big = '<html>' + 'x'.repeat(700000) + '</html>';
    const v = M.officialPageValue({ ok: true, status: 200, url: 'https://rewards.bing.com/earn' },
      big, 123);
    assert.equal(v.html.length, big.length, '官网 HTML 必须完整交给解析器');
    assert.equal(v.source, 'official-network');
    assert.equal(v.ok, true);
    assert.equal(M.cacheableHtml(big), false, '超限页面不进缓存，但本次照常解析');
    assert.equal(M.cacheableHtml('<html>' + 'y'.repeat(500000) + '</html>'), true);
    assert.equal(M.cacheableHtml(''), false);
    /* 源码：不再出现 res.text()).slice(...)，返回值在缓存 if 之外 */
    absent('eb', /res\.text\(\)\)\.slice\(0, MV3\.POLICY/);
    absent('db', /res\.text\(\)\)\.slice\(0, MV3\.POLICY/);
    has('eb', /const html = await res\.text\(\);/);
    has('eb', /const value = MV3\.officialPageValue\(res, html, Date\.now\(\)\)/);
    has('eb', /if \(res\.ok && MV3\.cacheableHtml\(html\)\)/);
    has('eb', /return value;/);
    /* 缓存预算仍在：条目 1 / TTL 45s，常驻 ≤600KB（applet 版 2.4MB） */
    assert.equal(M.POLICY.htmlCacheMaxEntries, 1);
    assert.equal(M.POLICY.htmlCacheTtlMs, 45000);
    const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
    assert.equal(M.POLICY.htmlCacheMaxBytes, CORE.DEFAULTS.htmlCacheMaxBytes);
    /* 桌面版同一根因：256KB → 600KB */
    has('db', /htmlCacheMaxBytes: 600 \* 1024/);
    has('db', /slice\(0, DESKTOP_MEM\.htmlCacheMaxBytes\)/);
  }],
  ['v3.2 · 同步绝不打开 rewards 标签页/隐藏视图（闸门统一注入 noTabs）', () => {
    const coreSrc = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8');
    assert.match(coreSrc, /Object\.assign\(\{\}, o, \{ fresh: true, noTabs: true \}\)/,
      '所有同步请求由闸门统一注入 noTabs，两端不再各自拼装');
    /* 底层降级护栏仍在（v3.1 修复不回退） */
    has('eb', /if \(!cards\.length && pages\.reachable && !\(o\.skipInjection\) && !o\.noTabs\)/);
    has('db', /if \(opts && opts\.noTabs\)/);
    has('db', /error: 'no-tabs sync'/);
    /* 两端全部同步入口都走闸门，不再有裸的底层同步调用 */
    for (const k of ['eb', 'db']) {
      has(k, /const syncGate = HSA_CORE\.createSyncGate\(\{/);
      has(k, /sync: opts => (?:syncRewardsUnified|desktopSyncRewards)\(opts\)/);
      assert.ok((F[k].match(/syncGate\.request\(/g) || []).length >= 5,
        k + ' 同步入口应全部经闸门');
      assert.doesNotMatch(F[k], /(?:syncRewardsUnified|desktopSyncRewards)\(\{ fresh: true/,
        k + ' 不得残留裸同步调用');
    }
    /* 自动运行的积分读取 / 搜索点击仍可用 openOrNavigate */
    has('eb', /async function readRewardsPage\(/);
    assert.ok((F.eb.match(/await readRewardsPage\(/g) || []).length >= 2);
    has('eb', /async function openOrNavigate\(/);
    /* 官网响应体仍完整（v3.1 修复不回退） */
    has('eb', /const html = await res\.text\(\);/);
    has('eb', /MV3\.cacheableHtml\(html\)/);
    for (const k of ['ep', 'dp']) has(k, /refreshTasks/);
  }],
  ['v3.1 · 对话中后续改动仍完整落在插件版（applet 基线功能未被破坏）', () => {
    /* applet 下拉刷新主题（共享模块未改动） */
    has('eh', /hsa-pull-refresh\.js/);
    has('sharedCss', /hsa-ball-beat|pull-refresh/);
    const pull = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-pull-refresh.js'), 'utf8');
    assert.match(pull, /ball-beat|applet/);
    /* 关键页 ZIP 导出、悬浮提示、日历复位、严格运行、日志导出 */
    has('eh', /hsa-zip\.js|diag-group/);
    has('ec', /2147483647/);
    has('eh', /hsa-hover-tip\.js/);
    has('ep', /calendarReset\(\)/);
    has('eb', /HSA_CORE\.isStrictKeyword|strictQueries/);
    has('eb', /exportRunLog/);
    /* v2.9 两端分别优化、v3.0 打开同步，插件版都已接线 */
    has('eb', /importScripts\('lib\/mv3-budget\.js'\)/);
    has('ep', /async function requestSyncOnOpen\(\)/);
    has('eb', /msg\.type === HSA_CORE\.SYNC_ON_OPEN\.messageType/);
    /* 共享副本与单一真源一致（同步脚本复制 12 个文件） */
    const a = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8');
    const b = fs.readFileSync(path.join(ROOT, 'edge-extension', 'shared', 'hsa-core.js'), 'utf8');
    const stripHead = t => t.replace(/^\/\* AUTO-GENERATED[^\n]*\n/, '');
    assert.equal(stripHead(b), a, '插件版 shared 副本（去掉自动生成头）必须与 shared/ 一致');
  }],
  ['v3.2 · 状态文案：≤15 中文显示宽度、两端完全相同、详细全文可悬浮查看', () => {
    const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
    assert.equal(CORE.STATUS_MAX_WIDTH, 15);
    const ctx = { today: 12345, available: 987654, n: 99, m: 100,
      s: 60, clicked: 12, searches: 30, at: Date.now(), reason: 'ui-open',
      waitMs: 1800000, durationMs: 12345 };
    for (const st of Object.keys(CORE.STATUS_LINES)) {
      for (const lang of ['zh', 'en']) {
        const t = CORE.statusText(st, ctx, lang);
        assert.ok(CORE.displayWidth(t) <= 15,
          st + '/' + lang + ' 超宽: ' + t + ' (' + CORE.displayWidth(t) + ')');
      }
    }
    assert.equal(CORE.statusText('synced', { today: 90, available: 495 }, 'zh'),
      '同步完成 90/495', '截图绿色提示改为带数值的短文案');
    assert.equal(CORE.statusText('synced', { today: 90, available: 495 }, 'en'),
      'Synced 90/495');
    assert.equal(CORE.displayWidth('同步中·官网两页'), 8);
    assert.equal(CORE.displayWidth('Syncing · 2 pages'), 9);
    /* 任意长文本都会被压到 15 宽以内 */
    const long = '正在同步 · /dashboard + /earn 读取积分并准备点击全部任务卡片';
    assert.ok(CORE.displayWidth(CORE.clampStatus(long)) <= 15);
    /* 详细全文给 aria-label / title / 日志：含完整数值与时间，不受 15 限制 */
    const full = CORE.statusFull('synced', { today: 90, available: 495,
      durationMs: 1700 }, 'zh');
    assert.match(full, /今日 90 分 \/ 可用 495 分/);
    assert.match(full, /耗时 1700 毫秒/);
    assert.match(full, /\+08:00/);
    assert.ok(CORE.displayWidth(full) > 15, '全文应比短文案详细');
    const act = CORE.syncActivity('syncFresh', ctx);
    assert.ok(CORE.displayWidth(act.zh) <= 15 && CORE.displayWidth(act.en) <= 15);
    assert.equal(act.green, true);
    /* 两端 popup 都统一 clamp + 详细全文 + 共享绿字 */
    for (const k of ['ep', 'dp']) {
      has(k, /const short = HSA_CORE\.clampStatus/);
      has(k, /HSA_CORE\.statusFull\('synced'/);
      has(k, /HSA_CORE\.statusText\('synced'/);
      has(k, /statusEl\.setAttribute\('aria-label', full \|\| short\)/);
      has(k, /a\.fullEn : a\.fullZh/);
    }
    /* 两端旧长文案已移除 */
    absent('eb', /正在读取官网 \/dashboard 与 \/earn/);
    absent('db', /正在同步 · \/dashboard \+ \/earn 读取积分/);
    absent('db', /同步完成 · 今日 /);
  }],
  ['v3.2 · 统一同步闸门：分档冷却 / 合并并发 / 指纹去重 / 当日完成停止任务', () => {
    const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
    const G = CORE.SYNC_GATE;
    assert.equal(G.uiOpenGapMs, 30 * 60 * 1000);
    assert.equal(G.manualGapMs, 10 * 1000);
    assert.equal(G.internalGapMs, 2 * 1000);
    assert.equal(G.stateKey, 'hsaSyncState');
    assert.equal(CORE.syncReasonClass('ui-open'), 'passive');
    assert.equal(CORE.syncReasonClass('refreshTasks'), 'manual');
    assert.equal(CORE.syncReasonClass('start'), 'internal');
    /* 打开界面 30 分钟冷却 */
    let d = CORE.syncDecision({ reason: 'ui-open', now: 1000000,
      state: { at: 1000000 - 10 * 60000 }, allDoneAt: 0 });
    assert.equal(d.allow, false);
    assert.equal(d.code, 'cooldown');
    assert.equal(d.waitMs, 20 * 60000);
    /* 手动刷新 10 秒、内部链路 2 秒 */
    d = CORE.syncDecision({ reason: 'refreshTasks', now: 1000000,
      state: { at: 995000 }, allDoneAt: 0 });
    assert.equal(d.allow, false);
    d = CORE.syncDecision({ reason: 'refreshTasks', now: 1000000,
      state: { at: 989000 }, allDoneAt: 0 });
    assert.equal(d.allow, true);
    /* 运行中 passive 被拦、force 越过冷却 */
    d = CORE.syncDecision({ reason: 'ui-open', now: 1000000,
      state: { at: 0 }, allDoneAt: 0, running: true });
    assert.equal(d.code, 'running');
    d = CORE.syncDecision({ reason: 'ui-open', now: 1000000,
      state: { at: 999999 }, allDoneAt: 0, force: true });
    assert.equal(d.code, 'forced');
    /* 当日全部完成 → passive 停止、manual 降频到 30 分钟、跨日解除 */
    const day1 = Date.parse('2026-11-11T10:00:00+08:00');
    const day1Later = Date.parse('2026-11-11T20:00:00+08:00');
    const day2 = Date.parse('2026-11-12T09:00:00+08:00');
    assert.equal(CORE.tasksStopped(day1, day1Later), true);
    assert.equal(CORE.tasksStopped(day1, day2), false);
    d = CORE.syncDecision({ reason: 'ui-open', now: day1Later,
      state: { at: 0 }, allDoneAt: day1 });
    assert.equal(d.code, 'allDone');
    d = CORE.syncDecision({ reason: 'refreshTasks', now: day1Later,
      state: { at: day1Later - 60000 }, allDoneAt: day1 });
    assert.equal(d.code, 'cooldown');
    assert.equal(d.gapMs, 30 * 60 * 1000);
    d = CORE.syncDecision({ reason: 'ui-open', now: day2,
      state: { at: 0 }, allDoneAt: day1 });
    assert.equal(d.allow, true, '跨 UTC+8 日界自动恢复');
    /* 业务指纹：时间戳变化不算数据变化，卡片状态变化算 */
    const r1 = { pointsSummary: { available: 495, today: 90, updatedAt: 1 },
      todayTasks: { items: [{ id: 'a', done: 1, total: 1 }] }, todaySearch: { progress: 2 } };
    const r2 = { pointsSummary: { available: 495, today: 90, updatedAt: 2 },
      todayTasks: { items: [{ id: 'a', done: 1, total: 1 }] }, todaySearch: { progress: 2 } };
    const r3 = { pointsSummary: { available: 495, today: 91, updatedAt: 3 },
      todayTasks: { items: [{ id: 'a', done: 1, total: 1 }] }, todaySearch: { progress: 2 } };
    assert.equal(CORE.syncFingerprint(r1), CORE.syncFingerprint(r2));
    assert.notEqual(CORE.syncFingerprint(r1), CORE.syncFingerprint(r3));
    assert.ok(CORE.syncSummary(r1).pointsSummary.available === 495);
    /* 两端接线完全同构 */
    for (const k of ['eb', 'db']) {
      has(k, /const syncGate = HSA_CORE\.createSyncGate\(\{/);
      has(k, /function hsaSyncActivity\(payload\)/);
      has(k, /sync: opts =>/);
      has(k, /load: keys => load\(keys\)/);
      has(k, /log: \(event, info\) => hsaRunLog\(event, info\)/);
      has(k, /activity: payload => hsaSyncActivity\(payload\)/);
      has(k, /onStopAll: \(\) => \{/);
      has(k, /syncGate\.guardTaskStart\(\)/);
      has(k, /syncGate\.isStopped\(\)/);
      has(k, /syncGate\.noteAllDone\('all-tasks-done'\)/);
    }
    /* 日志字段两端对齐：桌面不再写出空 platform */
    has('db', /platform: HSA_PLATFORM/);
    has('db', /actor: 'system', category: 'run-step'/);
  }],
  ['v3.0 · 打开同步不引入新的常驻定时器，且默认 Bing / 官网链路不变', () => {
    for (const k of ['ep', 'dp']) {
      const fn = F[k].slice(F[k].indexOf('async function requestSyncOnOpen'),
        F[k].indexOf('async function requestSyncOnOpen') + 900);
      assert.doesNotMatch(fn, /setInterval|setTimeout/, '打开同步不得引入常驻轮询');
    }
    has('dm', /const DEFAULT_BROWSER_HOME = 'https:\/\/www\.bing\.com\/\?mkt=zh-CN'/);
    has('dm', /win\.loadURL\(url && url !== 'about:blank' \? url : DEFAULT_BROWSER_HOME\)/);
    has('dm', /sideView\.webContents\.loadURL\(DEFAULT_BROWSER_HOME\)/);
    has('dm', /openInSidePanel\(url \|\| DEFAULT_BROWSER_HOME, 'user'\)/);
    for (const k of ['eb', 'db']) {
      has(k, /const DASHBOARD_URL = 'https:\/\/rewards\.bing\.com\/dashboard'/);
      has(k, /const EARN_URL = 'https:\/\/rewards\.bing\.com\/earn'/);
    }
  }],
  ['v3.3 · 「不跳过已完成」设置项与相关代码全部移除（两端一致）', () => {
    const keys = ['dontSkipCompleted', 'notSkipCompleted', 'set-dont-skip',
                  'set-not-skip', 'set-skip-completed'];
    for (const k of ['eb', 'ep', 'eh', 'ec', 'db', 'dp', 'dh', 'dc', 'dm']) {
      for (const key of keys) {
        assert.ok(!F[k].includes(key), P[k] + ' 仍残留 ' + key);
      }
    }
    assert.ok(!/不跳过已完成任务卡/.test(F['eh'] + F['dh']), '设置页不得再有该开关');
    /* v3.5 · 运行时不再有任何「是否跳过」参数，点击严格按预设列表 */
    absent('eb', /const includeDone = false;/);
    absent('db', /const skipCompletedCards = true;/);
    absent('dm', /const skipCompletedCards = true;/);
    has('eb', /if \(sync\.allDone\) \{/);
    has('db', /if \(sync\.allDone\) \{/);
    absent('db', /!o\.force/, '不得存在绕过全完成停止态的 force 死参数');
    absent('eb', /sync\.allDone && includeDone/, '插件版不得保留全量点击例外分支');
    /* v3.2 当日完成停止态在两端都保留，与「零动作」不冲突 */
    for (const k of ['eb', 'db']) has(k, /syncGate\.noteAllDone\('all-tasks-done'\)/);
  }],
  ['v3.3 · 积分日历两端逐字一致：共享模块 + 可折叠 + 零空白', () => {
    const cal = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-calendar.js'), 'utf8');
    assert.match(cal, /function buildModel/);
    assert.match(cal, /function createController/);
    assert.match(cal, /clipStart = wStart < first \? first : wStart/);
    assert.match(cal, /clipEnd = wEnd > last \? last : wEnd/);
    for (const k of ['eh', 'dh']) {
      has(k, /shared\/hsa-calendar\.js|shared\/hsa-calendar\.js/);
      has(k, /<details class="set-group cal-fold" id="calendar-group"[^>]*\bopen\b/);
      has(k, /<summary class="set-title" data-i18n="calendar.title"/);
      has(k, /id="cal-nav-msg"/);
    }
    /* 两端日历 HTML 块逐字相同 */
    const blockOf = s => {
      const i = s.indexOf('<details class="set-group cal-fold" id="calendar-group"');
      const j = s.indexOf('</details>', i);
      return s.slice(i, j + '</details>'.length);
    };
    assert.equal(blockOf(F['eh']), blockOf(F['dh']), '两端日历 DOM 必须逐字一致');
    /* 样式单一真源在 shared/hsa-shared.css，两端 popup.css 不再各自维护 */
    has('sharedCss', /v3\.3 · 积分日历/);
    has('sharedCss', /\.cal-grid\.cal-compact/);
    has('sharedCss', /\.cal-fold > summary/);
    for (const k of ['ep', 'dp']) {
      has(k, /HSA_CALENDAR\.createController\(/);
      has(k, /function renderPointsCalendar\(\) \{ return calendar\.render\(\); \}/);
      has(k, /function resetCalendar\(\) \{ return calendar\.reset\(\); \}/);
      has(k, /function moveCalendar\(step\) \{ return calendar\.move\(step\); \}/);
      absent(k, /let calMode|let calCursor|function periodCell/, '旧日历实现必须移除');
    }
    const sync = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-shared.js'), 'utf8');
    assert.match(sync, /hsa-calendar\.js/);
  }],
  ['v3.3 · 日历模型：日只有积分日 / 周不跨月 / 月只有积分月 / 复位定位', () => {
    const CAL = require(path.join(ROOT, 'shared', 'hsa-calendar.js'));
    const now = new Date(2026, 10, 11);
    const hist = {
      '2026-11-03': { today: 90 }, '2026-10-05': 15, '2026-10-06': 20,
      '2026-09-01': 5, '2026-12-31': 999
    };
    const day = CAL.buildModel({ hist, mode: 'day', cursor: new Date(2026, 10, 1), now });
    assert.equal(day.cells.length, 1, '日视图只渲染有积分的日期，不铺 42 格');
    assert.equal(day.cells[0].value, 90);
    assert.equal(day.empty, false);

    const week = CAL.buildModel({ hist, mode: 'week', cursor: new Date(2026, 10, 1), now });
    for (const c of week.cells) {
      assert.equal(c.daily.length, 7, '每周仍是 7 个点');
      for (const d of c.daily) {
        assert.ok(!/^10月/.test(d.label) && !/^12月/.test(d.label),
          '周起止裁剪到当月，绝不跨月：' + d.label);
      }
    }
    assert.ok(week.cells.length >= 1);

    const month = CAL.buildModel({ hist, mode: 'month', cursor: new Date(2026, 0, 1), now });
    assert.deepEqual(month.cells.map(c => c.label), ['2026/09', '2026/10', '2026/11'],
      '月视图只列有积分的月，未来月与无积分月都不显示');

    const emptyMonth = CAL.buildModel({ hist, mode: 'day', cursor: new Date(2026, 7, 1), now });
    assert.equal(emptyMonth.empty, true, '无积分月不铺空白格');
    assert.equal(emptyMonth.hasAny, true);

    const r = CAL.resetCursor(hist, {}, new Date(2026, 11, 20));
    assert.equal(r.mode, 'day');
    assert.equal(r.cursor.getFullYear() + '-' + CAL.pad2(r.cursor.getMonth() + 1),
      '2026-11', '当前月无积分时复位到最近有积分的月份');
    const r2 = CAL.resetCursor(hist, {}, new Date(2026, 10, 11));
    assert.equal(r2.cursor.getFullYear() + '-' + CAL.pad2(r2.cursor.getMonth() + 1),
      '2026-11', '当月有积分时复位到当月');
  }],
  ['v3.3 · UI 尽可能一致：共有设置行 / 组序号 / 文案 / 语言按钮', () => {
    for (const k of ['eh', 'dh']) {
      has(k, /data-i18n="lang\.zh"/);
      has(k, /data-i18n="lang\.en"/);
      has(k, /id="auto-group" style="--g:1"/);
      has(k, /id="calendar-group" style="--g:2"/);
      has(k, /id="diag-group" style="--g:3"/);
      has(k, /style="--g:4"/);
      /* v4.2 · 该专业项已收进「动作节奏」预设组，不再暴露输入框 */
      has(k, /data-preset="cardClickIntervalSec"/);
      has(k, /title="到点自动点击任务卡并按剩余分数搜索"/);
      has(k, /title="日\/周\/月视图只显示有积分的周期；周不跨月；悬停查看详情"/);
      absent(k, /data-i18n="auto\.(dontSkipCompleted|notSkipCompleted)/);
    }
    /* 桌面专有组仍保留，但排在共有组之后，不干扰一致性 */
    has('dh', /id="desktop-group" style="--g:5"/);
    assert.equal(CORE.UI.calendarAfterAutoGroup, true);
  }],
  ['v3.4 · 插件版语言按钮不再泄漏 lang.zh / lang.en 字典键（两端护栏一致）', () => {
    for (const k of ['ep', 'dp']) {
      has(k, /'lang\.zh':/);
      has(k, /'lang\.en':/);
      has(k, /'lang\.system':/);
      has(k, /const hasI18n = key =>/);
      has(k, /Object\.prototype\.hasOwnProperty\.call\(I18N\.zh, key\)/);
      has(k, /if \(hasI18n\('app\.title'\)\) document\.title = t\('app\.title'\)/);
      has(k, /if \(hasI18n\(el\.dataset\.i18n\)\) el\.textContent = t\(el\.dataset\.i18n\)/);
      has(k, /if \(hasI18n\(el\.dataset\.i18nTitle\)\) el\.title = t\(el\.dataset\.i18nTitle\)/);
      has(k, /if \(hasI18n\(el\.dataset\.i18nAria\)\) el\.setAttribute/);
      has(k, /if \(hasI18n\(el\.dataset\.i18nPh\)\) el\.placeholder/);
    }
    /* 两端语言键逐字一致：中文界面「中文 / English」，英文界面「Chinese / English」 */
    for (const k of ['ep', 'dp']) {
      has(k, /'lang\.zh': '中文', 'lang\.en': 'English'/);
      has(k, /'lang\.zh': 'Chinese', 'lang\.en': 'English'/);
    }
    /* HTML 静态文案不得是字典键形状（护栏未命中时保留的文字） */
    for (const k of ['eh', 'dh']) {
      has(k, /data-i18n="lang\.zh"[^>]*>中文</);
      has(k, /data-i18n="lang\.en"[^>]*>English</);
      has(k, /data-i18n="lang\.system"[^>]*>跟随系统</);
      absent(k, />lang\.zh</);
      absent(k, />lang\.en</);
    }
    /* 上一轮只改了桌面字典的两个提示，本轮把插件版也对齐，消除共键文案差异 */
    for (const k of ['ep', 'dp']) {
      has(k, /'auto\.cardIntervalHint': '相邻两张任务卡片的点击间隔（1–60 秒）'/);
      has(k, /'auto\.enableHint': '到点自动点击任务卡并按剩余分数搜索，最多 10 个时间点'/);
    }
    has('dp', /'login\.tip': 'Click to toggle sidebar · double-click to open Rewards'/);
  }],
  ['v3.5 · 运行提示词两端同一份 runActivity：只报当前动作、不提示下一步', () => {
    const core = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8');
    assert.match(core, /var RUN_LINES = Object\.freeze/);
    assert.match(core, /function runActivity\(state, ctx\)/);
    assert.match(core, /function planTaskClicks\(items, domCards\)/);
    has('db', /async function desktopActivityWrite\(runState, ctx\)/);
    has('dm', /function desktopActivityPush\(runState, ctx\)/);
    has('eb', /async function hsaActivityPush\(runState, ctx\)/);
    for (const k of ['db', 'dm', 'eb']) {
      has(k, /HSA_CORE\.runActivity\(/);
      absent(k, /下一步：| · Next:|之后核对|then check points|继续下一步/);
    }
    /* 两端不再各自硬编码运行期 zh / en 长文案 */
    absent('db', /zh: '打开页面|zh: '\{s\}|zh: '搜索 /);
    absent('dm', /zh: '侧栏点击|zh: '点击 '|zh: '本页已点击/);
    /* 所有可见文案 ≤15 显示宽度，且不含下一步类词 */
    const width = t => {
      let w = 0;
      for (const ch of String(t)) w += ch.charCodeAt(0) < 0x80 ? 0.5 : 1;
      return w;
    };
    for (const st of Object.keys(CORE.RUN_LINES)) {
      const a = CORE.runActivity(st, { n: 9, m: 17, s: 10, sec: 10,
        clicked: 3, searches: 12, card: '将推荐转化为奖励' });
      for (const t of [a.zh, a.en]) {
        assert.ok(width(t) <= 15, st + ' 文案超宽：' + t);
        assert.ok(!/下一步|Next|之后|then/.test(t), st + ' 含下一步：' + t);
      }
      assert.equal(a.next, '', st + ' next 必须为空');
      assert.ok(a.fullZh.includes('拟人搜索助手') && a.fullEn.includes('Human Search Assistant'));
    }
    /* waiting 保留 {s} 给前端倒计时 */
    assert.match(CORE.runActivity('waiting', { sec: 10, delayMs: 10000 }).zh, /\{s\}/);
  }],
  ['v3.5 · 严格按预设点击列表：两端同一份 planTaskClicks，无二次判断', () => {
    has('dm', /HSA_CORE\.buildTaskPlan\(presetItems, domCards, syncSummary\)/);
    has('eb', /HSA_CORE\.buildTaskPlan\(taskStates, /);
    has('db', /desktopActivityWrite\('taskList'/);
    has('eb', /hsaActivityPush\('taskList'/);
    for (const k of ['dm', 'db', 'eb']) {
      absent(k, /const skipCompletedCards = true;/);
      absent(k, /const includeDone = false;/);
      absent(k, /!includeDone/);
      absent(k, /skipCompletedCards: skipCompletedCards/);
    }
    /* 桌面主进程不再用 scored / completed / syncMatched 删减计划 */
    absent('dm', /merged\.filter\(c => c && c\.scored\)/);
    absent('dm', /matchedScored/);
    absent('dm', /planSidebarClicks\(merged/);
    /* 插件扫描不再把「将推荐转化为奖励」当成推荐卡排除 */
    absent('eb', /将推荐\|推荐好友\|准备推荐/);
    assert.ok(!/将推荐\|/.test(fs.readFileSync(
      path.join(ROOT, 'edge-extension', 'flyout-bridge.js'), 'utf8')));
    /* v3.6 · 唯一过滤 = 任务列表项自身 completed；其余一项不删 */
    const items = [
      { name: '将推荐转化为奖励', points: 10 },
      { name: '古代创新', points: 10, completed: true },
      { name: '足球传奇', points: 5, completed: true },
      { name: '完成此拼图', points: 5 },
      { name: '0 分项', points: 0 }
    ];
    const plan = CORE.planTaskClicks(items,
      [{ idx: 7, name: '将推荐转化为奖励', kind: 'referral', href: 'u1' }]);
    assert.equal(plan.length, 3, '只跳过 2 张任务列表标记已完成的卡');
    assert.deepEqual(plan.map(c => c.name),
      ['将推荐转化为奖励', '完成此拼图', '0 分项'], '其余严格保持列表顺序');
    assert.equal(plan[0].matched, true, '有积分卡不得被 referral 判断排除');
    assert.equal(plan[0].idx, 7, 'DOM 扫描只补定位');
    assert.equal(plan[1].matched, false, '未匹配项仍保留在计划里');
    assert.equal(plan[2].points, 0, '0 分但未完成仍保留');
  }],
  ['v3.6 · 两端都以任务列表为准，唯一过滤是列表项自身完成标记', () => {
    const core = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8');
    assert.match(core, /function pendingTaskItems\(items\)/);
    assert.match(core, /return !\(it\.completed === true \|\| it\.done === true\)/);
    assert.match(core, /var list = taskListOrder\(pendingTaskItems\(items\)\)/);
    /* 两端包装层的 m / 列表长度也走同一个 pendingTaskItems */
    has('db', /HSA_CORE\.taskPlanNames\(idxItems, snap\.todayTasks\)/);
    has('eb', /HSA_CORE\.taskPlanNames\(taskStates, \{ items: taskStates \}\)/);
    /* 唯一过滤条件不包含任何 DOM / 类型 / 积分判别 */
    const fn = core.slice(core.indexOf('function pendingTaskItems'),
      core.indexOf('function planTaskClicks'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const bad of ['scored', 'kind', 'points', 'dom', 'href', 'syncMatched',
                       'earned', 'promoCard', 'EXCLUDE']) {
      assert.ok(!new RegExp('\\b' + bad + '\\b', 'i').test(fn),
        'pendingTaskItems 不应引用 ' + bad);
    }
    /* 两端运行时不再有其它「是否点击」判别参数 */
    for (const k of ['dm', 'db', 'eb']) {
      absent(k, /const skipCompletedCards = true;/);
      absent(k, /const includeDone = false;/);
      absent(k, /planSidebarClicks\(merged/);
      absent(k, /merged\.filter\(c => c && c\.scored\)/);
    }
    /* 纯函数：完成态只认列表项，DOM 完成标记、kind、积分都不改变计划 */
    const items = [
      { name: 'A', completed: false },
      { name: 'B', completed: true },
      { name: 'C', completed: false, points: 0 },
      { name: 'D', completed: false, kind: 'referral' },
      { name: 'A', completed: false }
    ];
    const dom = [
      { idx: 1, name: 'A', completed: true, scored: false },
      { idx: 2, name: 'B', completed: false, scored: true },
      { idx: 3, name: 'C', completed: true, scored: false },
      { idx: 4, name: 'D', completed: true, kind: 'referral', scored: false }
    ];
    const plan = CORE.planTaskClicks(items, dom);
    assert.deepEqual(plan.map(c => c.name), ['A', 'C', 'D', 'A'],
      '只按列表 completed 跳过 B；DOM 完成标记 / kind / scored 不参与');
    assert.deepEqual(plan.map(c => c.matched), [true, true, true, true]);
    assert.equal(CORE.pendingTaskItems(items).length, 4);
    /* 全部已完成 → 空计划（零动作），与 allDone 停止态一致 */
    assert.equal(CORE.planTaskClicks([{ name: 'X', completed: true }], []).length, 0);
  }],
  ['v3.6 · 插件版后台静默运行：不抢焦点但用 CDP 保活保证可靠', () => {
    has('eb', /const QUIET_BACKGROUND = true;/);
    has('eb', /const FOCUS_WINDOW_TOO = false;/);
    has('eb', /const RESTORE_FOCUS_ON_FINISH = false;/);
    has('eb', /let lastRunTabId = null;/);
    /* 强制后台创建 / 导航，即使调用方传 active=true */
    has('eb', /const wantActive = QUIET_BACKGROUND \? false : !!active;/);
    absent('eb', /openOrNavigate\('searchTabId', HOME_URL, true\)/);
    absent('eb', /openOrNavigate\('humanTabId', pg\.url, true\)/);
    /* ensureTabActive 后台分支只关自动丢弃，不切换活动标签 / 不聚焦窗口 */
    has('eb', /if \(QUIET_BACKGROUND\) \{\s*try \{ await chrome\.tabs\.update\(tab\.id, \{ autoDiscardable: false \}\)/);
    /* cdpBringToFront 后台模式直接短路 */
    has('eb', /if \(QUIET_BACKGROUND\) return false;/);
    /* 可靠性：焦点模拟 + 生命周期保活 */
    has('eb', /async function cdpKeepActive/);
    has('eb', /'Emulation\.setFocusEmulationEnabled'/);
    has('eb', /'Page\.setWebLifecycleState', \{ state: 'active' \}/);
    has('eb', /await cdpEmulateFocus\(tabId\);\s*await cdpKeepActive\(tabId\);/);
    const awake = F['eb'].slice(F['eb'].indexOf('async function keepSearchTabAwake'),
      F['eb'].indexOf('async function restoreUserFocus'));
    assert.ok(awake.indexOf('await cdpEmulateFocus(tabId)') >= 0
      && awake.indexOf('await cdpKeepActive(tabId)') >= 0,
      '每轮都做 CDP 焦点模拟与生命周期保活');
    assert.ok(awake.indexOf('await cdpEmulateFocus(tabId)')
      < awake.indexOf('if (!QUIET_BACKGROUND)'),
      '抢焦点的兼容分支只在静默模式关闭时才可能执行');
    /* 结束不把用户拉回原标签；稳定等待看自己的标签而非当前活动标签 */
    has('eb', /if \(QUIET_BACKGROUND \|\| !RESTORE_FOCUS_ON_FINISH \|\| userActiveTabId == null\)/);
    has('eb', /let tab = id > 0 \? await chrome\.tabs\.get\(id\)/);
    /* 用户显式「打开官网」仍可激活，不被误伤 */
    has('eb', /chrome\.tabs\.create\(\{ url: target, active: true \}\)/);
  }],
  ['v3.6 · 扫描层只做定位：两端不再有任何业务词判别 / 回退不新增计划项', () => {
    for (const k of ['db', 'eb']) has(k, /var bannedText = \/\$\^\/;/);
    has('eb', /var EX_TITLE = \/\$\^\/;/);
    const bridge = fs.readFileSync(path.join(ROOT, 'edge-extension', 'flyout-bridge.js'), 'utf8');
    assert.match(bridge, /const EXCLUDE_TITLE_RE = \/\$\^\/;/);
    /* 保留结构必要条件 */
    has('eb', /var EX_URL = \/\^\(\?:javascript:/);
    /* 桌面回退路径不再把 DOM 扫描结果 push 进计划 */
    absent('dm', /pageEntries\.push\(item\)/);
    has('dm', /const hasPaged = entries\.some/);
    has('dm', /页面 DOM 扫描只给已有计划项补定位/);
    /* 唯一过滤在共享层，运行时没有其它判别参数 */
    for (const k of ['dm', 'db', 'eb']) {
      absent(k, /const skipCompletedCards = true;/);
      absent(k, /const includeDone = false;/);
    }
  }],
  ['v3.7 · 两端运行时只按任务列表跳过已完成（主界面完成态为权威）', () => {
    const core = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8');
    assert.match(core, /function applyTaskCompletion\(items, summary\)/);
    assert.match(core, /function buildTaskPlan\(items, domCards, summary\)/);
    assert.match(core, /function taskPlanNames\(items, summary\)/);
    assert.match(core, /return planTaskClicks\(applyTaskCompletion\(items, summary\), domCards\)/);
    /* 桌面根因：同步阶段用 todayTasks 覆盖点击索引完成态 */
    has('db', /taskClickIndex\.items = HSA_CORE\.applyTaskCompletion\(taskClickIndex\.items, todayTasks\)/);
    has('dm', /const syncSummary = \(clickIndex && clickIndex\.taskSummary\) \|\| state\.todayTasks/);
    has('dm', /HSA_CORE\.buildTaskPlan\(presetItems, domCards, syncSummary\)/);
    /* 插件版走同一个入口；runTaskStates 也做一次完成态合并 */
    has('eb', /const taskStates = HSA_CORE\.applyTaskCompletion\(mappedStates, sync\.todayTasks\)/);
    has('eb', /HSA_CORE\.buildTaskPlan\(taskStates, cards, \{ items: taskStates \}\)/);
    has('eb', /HSA_CORE\.buildTaskPlan\(taskStates, merged, \{ items: taskStates \}\)/);
    /* 动态复现截图：HTML 索引 completed 全 false，主界面标 3 张已完成 → 只点未完成 */
    const idx = [
      { name: '将推荐转化为奖励', points: 10, completed: false },
      { name: '迪拜沙漠舒适宜人', points: 10, completed: false },
      { name: '古代创新', points: 10, completed: false },
      { name: '探险火星', points: 15, completed: false },
      { name: '将推荐转化为奖励', points: 10, completed: false }
    ];
    const today = { items: [
      { name: '迪拜沙漠舒适宜人', points: 10, completed: true },
      { name: '古代创新', points: 10, completed: true },
      { name: '探险火星', points: 15, earned: 15 },
      { name: '将推荐转化为奖励', points: 10, earned: 0 }
    ] };
    const plan = CORE.buildTaskPlan(idx, [], today);
    assert.deepEqual(plan.map(c => c.name),
      ['将推荐转化为奖励', '将推荐转化为奖励'], '只跳过主界面标记已完成的 3 张');
    assert.deepEqual(CORE.taskPlanNames(idx, today), plan.map(c => c.name),
      '状态行 m 与实际计划同源');
    /* 没有主界面状态时保留原完成态，不臆造 */
    assert.equal(CORE.buildTaskPlan([{ name: 'A', completed: true }], [], null).length, 0);
  }],
  ['v3.7 · 拟人搜索间隔：两端设置项与后台策略同源', () => {
    const core = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8');
    assert.match(core, /var INTERVALS = Object\.freeze\(\{/);
    assert.match(core, /function normalizeIntervals\(settings\)/);
    assert.match(core, /function strictRunPolicy\(overrides\)/);
    /* v4.2 · 5 项间隔由强度预设套用；两端只读摘要逐字一致 */
    for (const k of ['eh', 'dh']) {
      for (const key of ['actionGapSec', 'pageStableSec', 'roundGapSec',
                         'roundWaitSec', 'cardClickIntervalSec']) {
        has(k, new RegExp('data-preset="' + key + '"'));
      }
      has(k, /id="run-preset-groups"/);
    }
    for (const k of ['ep', 'dp']) {
      for (const key of ['auto.actionGap', 'auto.pageStable', 'auto.roundGap', 'auto.roundWait']) {
        has(k, new RegExp("'" + key + "'"));
      }
      has(k, /HSA_HUMAN\.presetValues\(/);
      has(k, /function renderRunPreset\(\)/);
    }
    /* 两端后台都按设置在一次运行时刷新策略 */
    for (const k of ['eb', 'db']) {
      has(k, /let STRICT = HSA_CORE\.strictRunPolicy\(\)/);
      has(k, /STRICT = HSA_CORE\.strictRunPolicy\(RUN_SETTINGS\)/);
      has(k, /actionGapSec: HSA_CORE\.intervalDefaultSec\('actionGapMs'\)/);
    }
    /* 固定节奏，不恢复随机延时 / 拟人轨迹 */
    const policy = CORE.strictRunPolicy({ actionGapSec: 1.2, pageStableSec: 4,
      roundGapSec: 20, roundWaitSec: 2, cardClickIntervalSec: 15 });
    assert.equal(policy.fixedNapMs, 1200);
    assert.equal(policy.pageStableWaitMs, 4000);
    assert.equal(policy.fixedRoundIntervalMs, 20000);
    assert.equal(policy.fixedRoundWaitMs, 2000);
    assert.equal(policy.cardClickIntervalSec, 15);
    assert.equal(policy.randomDelay, false);
    assert.equal(policy.humanVariation, false);
    assert.equal(CORE.clampIntervalMs('actionGapMs', 99), 5000);
    assert.equal(CORE.clampIntervalMs('actionGapMs', -1), 600);
  }],

  ['v3.9 · 设置页重新分类：运行节奏+拟人强度合并为「运行设置」', () => {
    for (const k of ['eh', 'dh']) {
      const s = F[k];
      for (const id of ['appearance-group', 'run-group', 'auto-group',
                        'calendar-group', 'diag-group']) {
        has(k, new RegExp('id="' + id + '"'));
      }
      absent(k, /id="timing-group"/);
      /* 顺序：外观 → 运行设置 → 自动任务 → 积分日历 → 数据与诊断 */
      before(k, 'id="appearance-group"', 'id="run-group"');
      before(k, 'id="run-group"', 'id="auto-group"');
      before(k, 'id="auto-group"', 'id="calendar-group"');
      before(k, 'id="calendar-group"', 'id="diag-group"');
      for (const step of ['01', '02', '03', '05']) {
        has(k, new RegExp('<span class="set-badge" aria-hidden="true">' + step + '</span>'));
      }
      has(k, /class="settings-head-sub" data-i18n="settings.subtitle"/);
      has(k, /data-i18n="run.title"/);
      /* v4.2 · 运行设置：模式 + 强度 + 8 个特征开关 + 三组只读预设摘要 */
      const ra = s.indexOf('id="run-group"');
      const rb = s.indexOf('id="auto-group"', ra);
      const run = s.slice(ra, rb);
      for (const id of ['set-run-mode', 'set-auto-level',
                        'set-human-noise', 'set-human-browse', 'set-human-session',
                        'set-fingerprint', 'set-geo',
                        'set-stealth-typing', 'set-stealth-burst', 'set-stealth-night',
                        'run-preset-groups', 'run-preset-strict']) {
        assert.ok(run.includes('id="' + id + '"'), P[k] + ' 运行设置缺 ' + id);
      }
      for (const gone of ['set-card-interval', 'set-action-gap', 'set-page-stable',
                          'set-round-gap', 'set-round-wait',
                          'set-stealth-cap', 'set-stealth-jitter']) {
        assert.ok(!run.includes('id="' + gone + '"'), P[k] + ' 仍暴露专业数值项 ' + gone);
      }
      assert.match(run, /class="preset-groups"/);
      assert.match(run, /set-feature-grid/);
      assert.equal((run.match(/data-group="(quota|action|page)"/g) || []).length, 3);
      assert.equal((run.match(/data-preset="/g) || []).length, 7);
      /* 拟人强度已从自动任务组移出 */
      const aa = s.indexOf('id="auto-group"');
      const ab = s.indexOf('id="calendar-group"', aa);
      assert.ok(!s.slice(aa, ab).includes('id="set-auto-level"'),
        '拟人强度不应再留在自动任务组');
    }
    has('dh', /id="desktop-group" style="--g:5"/);
    before('dh', 'id="diag-group"', 'id="desktop-group"');
    absent('eh', /id="desktop-group"/);
    const bodyOf = s => {
      const a = s.indexOf('<div class="settings-body">');
      const b = s.indexOf('</section>', a);
      return s.slice(a, b);
    };
    const d = bodyOf(F.dh);
    const ds = d.indexOf('<!-- v1.3.8 · 桌面版专有功能');
    const de = d.indexOf('id="set-reset"', ds);
    const dCommon = d.slice(0, ds) + d.slice(d.lastIndexOf('\n', de) + 1);
    assert.equal(bodyOf(F.eh).trim(), dCommon.trim(), '两端共有设置 DOM 必须逐字一致');
    for (const k of ['eh', 'dh']) {
      has(k, /id="auto-group" style="--g:1"/);
      has(k, /id="calendar-group" style="--g:2"/);
      has(k, /id="diag-group" style="--g:3"/);
      has(k, /style="--g:4"/);
      has(k, /<summary class="set-title" data-i18n="calendar.title"/);
    }
    const cal = s => {
      const i = s.indexOf('<details class="set-group cal-fold" id="calendar-group"');
      const j = s.indexOf('</details>', i);
      return s.slice(i, j + 10);
    };
    assert.equal(cal(F.eh), cal(F.dh), '日历 DOM 仍逐字一致');
  }],
  ['v3.8 · 外观美化：样式单一真源 + 数字输入统一 + 新字典键两端齐全', () => {
    for (const k of ['sharedCss', 'ec', 'dc']) {
      /* sharedCss 是单一真源；两端 popup.css 不应再各自维护一套 */
      if (k === 'sharedCss') {
        has(k, /v3\.8 · 设置页重新分类与外观美化/);
        has(k, /\.set-group-head/);
        has(k, /\.set-badge/);
        has(k, /\.set-desc/);
        has(k, /\.set-grid/);
        has(k, /\.set-inline-number input\[type="number"\]/);
        has(k, /\.settings-head-sub/);
        has(k, /\.cal-fold > summary::before/);
        has(k, /body\.reduce-motion/);
        has(k, /@media \(max-width: 350px\)/);
      }
    }
    /* 两端 shared 副本与 shared/ 主文件一致 */
    const master = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-shared.css'), 'utf8');
    for (const p of ['edge-extension/shared/hsa-shared.css', 'desktop-app/shared/hsa-shared.css']) {
      const c = fs.readFileSync(path.join(ROOT, p), 'utf8');
      assert.equal(c.replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), master.trim() + '\n',
        p + ' 未同步 v3.8 样式');
    }
    /* 新增 data-i18n 键在两端 zh/en 字典都命中 */
    const keys = ['settings.subtitle', 'settings.appearanceDesc',
      'timing.title', 'timing.desc', 'auto.desc', 'diag.desc', 'desktop.desc'];
    for (const k of ['ep', 'dp']) {
      for (const key of keys) {
        has(k, new RegExp("'" + key + "':"));
      }
      has(k, /v3\.8 · 设置页重排|v3\.8 · Settings regroup/);
    }
    /* 所有 data-i18n 键两端字典零缺失（动态扫一遍 HTML） */
    for (const [hk, jk] of [['eh', 'ep'], ['dh', 'dp']]) {
      const html = F[hk], js = F[jk];
      const found = [...html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)]
        .map(m => m[1]);
      for (const key of new Set(found)) {
        assert.ok(js.includes("'" + key + "':"),
          jk + ' 缺字典键 ' + key);
      }
    }
  }],

  ['v3.9 · 拟人引擎：强度对应时长、间隔随机均匀、全维度噪声（严格档不回退）', () => {
    const H = require(path.join(ROOT, 'shared', 'hsa-human.js'));
    const F_ = require(path.join(ROOT, 'shared', 'hsa-fingerprint.js'));
    const G = require(path.join(ROOT, 'shared', 'hsa-geo.js'));
    /* 20 次搜索 ≈ 15 / 30 / 60 分钟，各段大致均匀 */
    for (const [lv, min] of [['low', 15], ['mid', 30], ['high', 60]]) {
      assert.equal(H.LEVELS[lv].targetMinutes, min);
      const p = H.createProfile({ runMode: 'human', humanLevel: lv }, 12345);
      let total = 0, worst = 1;
      for (let i = 0; i < H.SEARCHES; i++) {
        const b = H.roundBudget(p, 1), sp = H.splitRound(b, p);
        total += b;
        const vals = H.ROUND_SEGMENTS.map(k => sp.segments[k]);
        worst = Math.max(worst, Math.max(...vals) / Math.max(1, Math.min(...vals)));
      }
      assert.ok(Math.abs(total / 60000 - min) / min < 0.05, lv + ' 总时长偏离标称值');
      assert.ok(worst < 1.6, lv + ' 各段分配不均匀');
    }
    /* 随机但可复现；贝塞尔终点正确；词只重排不增删；卡片随机间隔 */
    assert.equal(H.splitRound(90000, H.createProfile({}, 1)).segments.gap
      !== H.splitRound(90000, H.createProfile({}, 2)).segments.gap, true);
    const bzPath = H.bezierPath([10, 10], [300, 220], H.mulberry32(9), {});
    assert.ok(bzPath.points.length >= 9 && bzPath.points[bzPath.points.length - 1].x === 300);
    const words = ['第一天热搜词甲', '第二天热搜词乙', '第三天热搜词丙'];
    const wo = H.wordOrder(words, H.createProfile({}, 3));
    assert.equal(wo.length, 3);
    assert.ok(words.every(w => wo.includes(w)));
    assert.ok(H.cardSpacing(H.createProfile({}, 4), H.mulberry32(4), 10000, 1).delayMs > 0);
    /* 严格档仍固定、不引入随机（既有 v3.7 约束不回退） */
    assert.equal(CORE.strictRunPolicy().randomDelay, false);
    assert.equal(CORE.strictRunPolicy().humanVariation, false);
    assert.equal(H.isEnabled({ runMode: 'strict' }), false);
    assert.equal(H.isEnabled({ runMode: 'human' }), true);
    /* 指纹 / 地理 selftest */
    assert.equal(F_.selftest().ok, true, '指纹一致性自检失败');
    assert.equal(G.selftest().ok, true, '地理一致性自检失败');
    assert.ok(F_.NEVER_TOUCH.includes('navigator.hardwareConcurrency'),
      '不得硬编码/改写硬件值');
    assert.ok(F_.buildPatchScript().includes('navigator.webdriver'));
    assert.equal(G.fallback('zh-CN', 'Asia/Shanghai', Date.now()).degraded, true);
  }],
  ['v3.9 · 两端接线同构：画像 / 词策略 / 指纹 / 地理 / 卡片随机间隔', () => {
    for (const k of ['eb', 'db']) {
      has(k, /HSA_HUMAN\.isEnabled\(RUN_SETTINGS\)/);
      has(k, /HSA_HUMAN\.createProfile\(RUN_SETTINGS/);
      has(k, /HSA_GEO\.probe\(geoFetch/);
      has(k, /HSA_HUMAN\.wordOrder\(built\.queries, HUMAN\)/);
      has(k, /HSA_FINGERPRINT\.collect/);
      has(k, /HSA_FINGERPRINT\.crossCheck/);
      has(k, /HSA_FINGERPRINT\.patcher/);
      has(k, /HSA_HUMAN\.splitRound\(HUMAN_BUDGET, HUMAN\)/);
      has(k, /HSA_GEO\.scheduleFactor\(Date\.now\(\), GEO\.geo\)/);
      has(k, /hsaHumanMouse\(tabId,/);
      has(k, /HSA_HUMAN\.bezierPath\(lastXY/);
      has(k, /hsaHumanBrowse\(tabId, HUMAN_TIMING, token\)/);
      has(k, /HUMAN_TIMING\.gapMs/);
      has(k, /runMode: HSA_HUMAN\.DEFAULT_SETTINGS\.runMode/);
      /* 严格档仍完整可用 */
      has(k, /function strictClickPlan\(box\)/);
      has(k, /STRICT\.fixedRoundIntervalMs/);
    }
    /* 插件后台自己做卡片随机间隔；桌面由主进程 humanCard 承担 */
    has('eb', /HSA_HUMAN\.cardSpacing\(HUMAN, HUMAN\.rng/);
    has('db', /runMode: RUN_SETTINGS/);
    has('db', /geoFactor: GEO && GEO\.geo/);
    /* 桌面主进程：卡片也拟人化 */
    has('dm', /const HSA_HUMAN = require\('\.\/shared\/hsa-human\.js'\)/);
    has('dm', /HSA_HUMAN\.cardSpacing\(humanCard, humanCard\.rng/);
    has('dm', /HSA_HUMAN\.bezierPath\(lastCardXY/);
    /* 加载点：插件 importScripts / 桌面 host + 两端 popup */
    has('eb', /importScripts\('shared\/hsa-(human|fingerprint|geo)\.js'\)/);
    for (const k of ['eh', 'dh']) {
      has(k, /hsa-human\.js/); has(k, /hsa-fingerprint\.js/); has(k, /hsa-geo\.js/);
    }
    assert.match(fs.readFileSync(path.join(ROOT, 'desktop-app', 'host.html'), 'utf8'),
      /shared\/hsa-human\.js/);
    const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'edge-extension', 'manifest.json'), 'utf8'));
    assert.ok(mf.host_permissions.some(h => h.includes('ipwho.is')));
    assert.ok(mf.host_permissions.some(h => h.includes('ipapi.co')));
    /* 设置页：运行设置 + 全维度开关 + 双语文案 */
    for (const k of ['eh', 'dh']) {
      for (const id of ['set-run-mode', 'set-auto-level', 'set-human-noise',
                        'set-human-browse', 'set-human-session', 'set-fingerprint', 'set-geo']) {
        has(k, new RegExp('id="' + id + '"'));
      }
      has(k, /data-i18n="run.levelNote"/);
    }
    for (const k of ['ep', 'dp']) {
      for (const key of ['run.title', 'run.mode', 'run.modeStrict', 'run.modeHuman',
                         'run.noise', 'run.browse', 'run.session', 'run.fingerprint',
                         'run.geo', 'run.levelHint', 'run.baseIntervalsDesc']) {
        has(k, new RegExp("'" + key.replace('.', '\\.') + "':"));
      }
      has(k, /onSegment\('set-run-mode'/);
      has(k, /HSA_FEATURE_INPUTS/);
      has(k, /saveSettings\(\{ humanLevel: Number\(v\) \}\)/);
      has(k, /runMode: 'human', humanLevel: 2/);
    }
    absent('eh', /id="timing-group"/);
  }],

  ['v3.9 · 拟人增强档默认开启、严格档可切回，两端运行逻辑同构', () => {
    const H = require(path.join(ROOT, 'shared', 'hsa-human.js'));
    const G = require(path.join(ROOT, 'shared', 'hsa-geo.js'));
    const FP = require(path.join(ROOT, 'shared', 'hsa-fingerprint.js'));
    /* 三个新共享模块进入单一真源清单，且两端副本一致 */
    for (const f of ['hsa-human.js', 'hsa-fingerprint.js', 'hsa-geo.js']) {
      assert.ok(fs.existsSync(path.join(ROOT, 'shared', f)), '缺共享模块 ' + f);
    }
    const FILES = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-shared.js'), 'utf8');
    for (const f of ['hsa-human.js', 'hsa-fingerprint.js', 'hsa-geo.js']) {
      assert.ok(FILES.includes("'" + f + "'"), '同步清单缺 ' + f);
    }
    /* 默认档 = 拟人增强；严格档仍完整保留 */
    assert.equal(H.DEFAULT_SETTINGS.runMode, 'human');
    assert.equal(H.isEnabled(H.DEFAULT_SETTINGS), true);
    assert.equal(H.isEnabled({ runMode: 'strict' }), false);
    assert.equal(H.normalizeSettings({ runMode: 'strict' }).runMode, 'strict');
    assert.equal(H.levelFromValue(1).key, 'low');
    assert.equal(H.levelFromValue(3).key, 'high');
    assert.equal(H.levelFromValue('mid').key, 'mid');
    assert.equal(H.selftest().ok, true);
    assert.equal(G.selftest().ok, true);
    assert.equal(FP.selftest().ok, true);
    /* v3.7 固定节奏策略本身完全不动 */
    const strictPolicy = CORE.strictRunPolicy();
    assert.equal(strictPolicy.fixedNapMs, 600);
    assert.equal(strictPolicy.pageStableWaitMs, 3000);
    assert.equal(strictPolicy.fixedRoundIntervalMs, 10000);
    assert.equal(strictPolicy.randomDelay, false);
    assert.equal(strictPolicy.scroll, false);
    assert.equal(strictPolicy.clickResult, false);
    /* 词规则未破：仍只用当日 ≥5 字热搜原文 */
    for (const k of ['eb', 'db']) {
      has(k, /HSA_CORE\.strictQueries\(/);
      has(k, /HSA_CORE\.isStrictKeyword\(/);
      const t = F[k];
      const loopA = t.indexOf('async function searchLoop');
      const loopB = t.indexOf('function waitForTab', loopA);
      const loopText = t.slice(loopA, loopB);
      assert.ok(!/suggestRelated\(|relatedRewrite|GO_HOME_RATE|RELATED_RATE/.test(loopText),
        P[k] + ' 搜索循环不应恢复改词 / 回首页');
    }
    /* 两端接线逐项同构 */
    for (const k of ['eb', 'db']) {
      const t = F[k];
      for (const needle of [
        /let HUMAN = null, GEO = null, RUN_SETTINGS = null;/,
        /runMode: HSA_HUMAN\.DEFAULT_SETTINGS\.runMode,/,
        /RUN_SETTINGS = await getSettings\(\);/,
        /STRICT = HSA_CORE\.strictRunPolicy\(RUN_SETTINGS\)/,
        /HUMAN = HSA_HUMAN\.isEnabled\(RUN_SETTINGS\)/,
        /HSA_HUMAN\.createProfile\(RUN_SETTINGS,/,
        /HSA_GEO\.probe\(geoFetch/,
        /HSA_HUMAN\.roundBudget\(HUMAN,/,
        /HSA_HUMAN\.splitRound\(HUMAN_BUDGET, HUMAN\)/,
        /HSA_HUMAN\.bezierPath\(lastXY, clickCenter/,
        /HSA_HUMAN\.wordOrder\(built\.queries, HUMAN\)/,
        /HSA_HUMAN\.cardSpacing\(HUMAN, HUMAN\.rng,/,
        /HSA_FINGERPRINT\.collect/,
        /HSA_FINGERPRINT\.patcher/,
        /function hsaHumanMouse\(/,
        /function hsaHumanBrowse\(/,
        /strictClickPlan\(/
      ]) {
        assert.ok(needle.test(t), P[k] + ' 缺 v3.9 接线 ' + needle);
      }
      /* 严格档 fallback 仍在：HUMAN 为 null 时逐字回到固定中心点击 + 固定间隔 */
      assert.ok(/else if \(realInput\) await cdpClickAt\(tabId, clickCenter\[0\], clickCenter\[1\]\)/.test(t),
        P[k] + ' 严格档点击回退丢失');
      assert.ok(!/GO_HOME_RATE|RELATED_RATE/.test(t.slice(t.indexOf('async function searchLoop'))),
        P[k] + ' 不应恢复改词/回首页');
    }
    /* 桌面主进程也用拟人档做卡片间隔与轨迹 */
    has('dm', /const HSA_HUMAN = require\('\.\/shared\/hsa-human\.js'\)/);
    has('dm', /HSA_HUMAN\.cardSpacing\(humanCard/);
    has('dm', /HSA_HUMAN\.bezierPath\(lastCardXY/);
    has('db', /runMode: RUN_SETTINGS && RUN_SETTINGS\.runMode/);
    /* 指纹只去自动化标记，不伪造 UA / 屏幕 / 硬件值 */
    has('sharedCss', /v3\.9 · 运行设置/);
    const fp = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-fingerprint.js'), 'utf8');
    assert.match(fp, /untouched: \[/);
    assert.match(fp, /'navigator\.userAgent'/);
    assert.ok(!/defineProperty\(navigator, 'userAgent'/.test(fp), '不应改写 UA');
  }],
  ['v3.9 · 设置页拟人档控件两端一致，默认 human，字典零缺失', () => {
    for (const k of ['eh', 'dh']) {
      const t = F[k];
      for (const id of ['set-run-mode', 'set-auto-level', 'set-human-noise',
                        'set-human-browse', 'set-human-session',
                        'set-fingerprint', 'set-geo']) {
        has(k, new RegExp('id="' + id + '"'));
      }
      has(k, /id="run-group" style="--g:1"/);
      has(k, /data-value="human" data-i18n="run\.modeHuman"/);
      has(k, /data-value="strict" data-i18n="run\.modeStrict"/);
      has(k, /class="set-feature-grid"/);
      /* v4.2 · 基准间隔说明已换成三组预设摘要 */
      has(k, /data-i18n="run\.presetDesc"/);
      /* v4.2 · 02 组改为三组只读预设摘要，不再有 5 个数值输入框 */
      const a = t.indexOf('id="run-group"');
      const b = t.indexOf('id="auto-group"', a);
      const run = t.slice(a, b);
      assert.equal((run.match(/id="set-(card-interval|action-gap|page-stable|round-gap|round-wait)"/g) || []).length, 0);
      assert.ok(run.includes('id="run-preset-groups"'));
      assert.equal((run.match(/data-preset="/g) || []).length, 7);
    }
    for (const k of ['ep', 'dp']) {
      const t = F[k];
      has(k, /runMode: 'human', humanLevel: 2,/);
      has(k, /fingerprintCheck: true, geoConsistency: true,/);
      has(k, /setSegment\('set-run-mode', settings\.runMode === 'strict' \? 'strict' : 'human'\)/);
      has(k, /onSegment\('set-run-mode', v => saveSettings\(\{ runMode: v \}\)/);
      for (const key of ['run.title', 'run.desc', 'run.mode', 'run.modeStrict',
                         'run.modeHuman', 'run.noise', 'run.browse', 'run.session',
                         'run.fingerprint', 'run.geo', 'run.baseIntervalsDesc']) {
        has(k, new RegExp("'" + key.replace('.', '\\.') + "':"));
      }
    }
    /* 全量 data-i18n 键两端字典零缺失（防 key 泄漏回归） */
    for (const [hk, jk] of [['eh', 'ep'], ['dh', 'dp']]) {
      const html = F[hk], js = F[jk];
      const keys = [...html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)]
        .map(m => m[1]);
      for (const key of new Set(keys)) {
        assert.ok(js.includes("'" + key + "':"), P[jk] + ' 缺字典键 ' + key);
      }
    }
    /* 两端共有设置 DOM 逐字一致（只去掉桌面专有组块） */
    const bodyOf = s => {
      const a = s.indexOf('<div class="settings-body">');
      return s.slice(a, s.indexOf('</section>', a));
    };
    const d = bodyOf(F.dh);
    const ds = d.indexOf('<!-- v1.3.8 · 桌面版专有功能');
    const de = d.indexOf('id="set-reset"', ds);
    const dCommon = d.slice(0, ds) + d.slice(d.lastIndexOf('\n', de) + 1);
    assert.equal(bodyOf(F.eh).trim(), dCommon.trim(), '两端共有设置 DOM 必须逐字一致');
  }],

  ['v4.0 · 风险规避引擎两端同源、严格档恒关、既有硬规则不回退', () => {
    const S = require(path.join(ROOT, 'shared', 'hsa-stealth.js'));
    assert.equal(S.VERSION, '1.0.0');
    assert.equal(S.selftest().ok, true, 'hsa-stealth selftest 失败');
    const files = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-shared.js'), 'utf8');
    assert.ok(files.includes("'hsa-stealth.js'"), '同步清单缺 hsa-stealth.js');
    assert.equal((files.match(/\.js'|\.css'|\.json'/g) || []).length, 12);
    /* 严格档：六项新特性全部恒关 */
    assert.equal(S.enabled({ runMode: 'strict' }), false);
    assert.equal(S.capSearches(20, 30, 60, 'strict'), 20);
    assert.equal(S.scheduleJitter(1000, () => 0, 120, 'strict'), 1000);
    assert.equal(S.shouldDefer(Date.now(), { localHour: 3 }, { runMode: 'strict' }, false).defer, false);
    assert.equal(S.submitPlan(() => 0, { enabled: false }).method, 'enter');
    assert.equal(S.keystrokePlan('六个字的热搜词', () => 0, { enabled: false }).chunks.length, 1);
    assert.equal(S.sessionPlan({ rounds: 20, perRoundMs: 90000, enabled: false }).burstCount, undefined);
    assert.equal(S.sessionPlan({ rounds: 20, perRoundMs: 90000, enabled: false }).totalBreakMs, 0);
    /* 词规则与严格档 fallback 未破 */
    for (const k of ['eb', 'db']) {
      has(k, /HSA_CORE\.strictQueries\(/);
      has(k, /HSA_CORE\.isStrictKeyword\(/);
      has(k, /HSA_HUMAN\.roundBudget\(HUMAN,/);
      has(k, /HSA_HUMAN\.splitRound\(HUMAN_BUDGET, HUMAN\)\.segments/);
      has(k, /strictClickPlan\(/);
      has(k, /HSA_STEALTH = /);
      has(k, /let STEALTH = null;/);
      has(k, /let STEALTH_ON = false;/);
      for (const needle of [
        'HSA_STEALTH.sessionPlan({', 'HSA_STEALTH.keystrokePlan(',
        'HSA_STEALTH.submitPlan(', 'HSA_STEALTH.capSearches(',
        'HSA_STEALTH.scheduleJitter(', 'HSA_STEALTH.shouldDefer(',
        'HSA_STEALTH.geoCacheValid(', 'HSA_STEALTH.normalize(RUN_SETTINGS)',
        'releaseFocusEmulation(tabId)', 'stealthDeferScheduled(',
        'stealthTypeQuery(tabId, keyword, realInput, token)',
        'stealthSubmitQuery(tabId, keyword, realInput, lastXY, token)',
        'SESSION_PLAN.breakAfter(current)',
        "Emulation.setFocusEmulationEnabled', { enabled: false }",
        'hsaHumanMouse(tabId, HSA_HUMAN.bezierPath([120, 140]'
      ]) {
        assert.ok(F[k].includes(needle), P[k] + ' 缺 v4.0 接线 ' + needle);
      }
      /* 结果页点开结果不再是 DOM 合成 a.click() */
      const browseA = F[k].indexOf('async function hsaHumanBrowse');
      const browseB = F[k].indexOf('async function navigateSearch', browseA);
      const bt = F[k].slice(browseA, browseB > browseA ? browseB : browseA + 3000);
      assert.ok(!bt.includes('a.click()'), P[k] + ' 结果页仍用 DOM click');
      /* 搜索循环内仍不回首页 / 不改词 */
      const la = F[k].indexOf('async function searchLoop');
      const lb = F[k].indexOf('function waitForTab', la);
      assert.ok(!/suggestRelated\(|GO_HOME_RATE|RELATED_RATE/.test(F[k].slice(la, lb)),
        P[k] + ' 搜索循环恢复改词 / 回首页');
    }
    /* 桌面主进程拟人卡片链路未回退 */
    has('dm', /HSA_HUMAN\.cardSpacing\(humanCard/);
    has('dm', /HSA_HUMAN\.bezierPath\(lastCardXY/);
    has('db', /runMode: RUN_SETTINGS && RUN_SETTINGS\.runMode/);
    /* 共享副本逐字节一致 */
    const master = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-stealth.js'), 'utf8');
    for (const d of ['edge-extension/shared/hsa-stealth.js', 'desktop-app/shared/hsa-stealth.js']) {
      assert.equal(fs.readFileSync(path.join(ROOT, d), 'utf8')
        .replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), master.trim() + '\n', d + ' 副本不一致');
    }
  }],
  ['v4.0 · 设置页 5 项风险规避控件两端一致、字典零缺失、默认值同源', () => {
    const S = require(path.join(ROOT, 'shared', 'hsa-stealth.js'));
    for (const k of ['eh', 'dh']) {
      for (const id of ['set-stealth-typing', 'set-stealth-burst', 'set-stealth-night']) {
        has(k, new RegExp('id="' + id + '"'));
      }
      /* v4.2 · 配额 / 抖动两项数值改由强度预设摘要展示 */
      for (const key of ['singleRunCapPct', 'scheduleJitterMin']) {
        has(k, new RegExp('data-preset="' + key + '"'));
      }
      has(k, /data-i18n="run\.riskDesc"/);
      has(k, /class="set-feature-grid"/);
    }
    for (const k of ['ep', 'dp']) {
      const t = F[k];
      has(k, /stealthTyping: true, burstPacing: true, avoidNightRun: true,/);
      has(k, /singleRunCapPct: 60, scheduleJitterMin: 20, geoCacheHours: 12,/);
      for (const key of ['run.riskDesc', 'run.typing', 'run.typingHint',
                         'run.burst', 'run.burstHint', 'run.night', 'run.nightHint',
                         'run.cap', 'run.capHint', 'run.jitter', 'run.jitterHint',
                         'settings.minutes']) {
        has(k, new RegExp("'" + key.replace('.', '\\.') + "':"));
      }
      has(k, /set-stealth-typing', 'stealthTyping'/);
      /* v4.2 · 数值项不再逐项保存，由后台 applyRunPreset 整组套用 */
      has(k, /HSA_HUMAN\.presetValues\(/);
      has(k, /renderRunPreset\(\);/);
    }
    /* 两端共有设置 DOM 逐字一致（只去掉桌面专有组块） */
    const bodyOf = x => {
      const a = x.indexOf('<div class="settings-body">');
      return x.slice(a, x.indexOf('</section>', a));
    };
    const d = bodyOf(F.dh);
    const ds = d.indexOf('<!-- v1.3.8 · 桌面版专有功能');
    const de = d.indexOf('id="set-reset"', ds);
    const dCommon = d.slice(0, ds) + d.slice(d.lastIndexOf('\n', de) + 1);
    assert.equal(bodyOf(F.eh).trim(), dCommon.trim(), '两端共有设置 DOM 必须逐字一致');
    /* 全量 i18n 键零缺失 */
    for (const [hk, jk] of [['eh', 'ep'], ['dh', 'dp']]) {
      const keys = [...F[hk].matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)].map(m => m[1]);
      for (const key of new Set(keys)) {
        assert.ok(F[jk].includes("'" + key + "':"), P[jk] + ' 缺字典键 ' + key);
      }
    }
    /* popup 默认值与共享 DEFAULTS 同源 */
    assert.equal(S.DEFAULTS.stealthTyping, true);
    assert.equal(S.DEFAULTS.burstPacing, true);
    assert.equal(S.DEFAULTS.avoidNightRun, true);
    assert.equal(S.DEFAULTS.singleRunCapPct, 60);
    assert.equal(S.DEFAULTS.scheduleJitterMin, 20);
    assert.equal(S.DEFAULTS.geoCacheHours, 12);
  }],

  ['v4.1 · 「今日 Bing 搜索」不是可点击卡片：共享层排除、两端接线同构', () => {
    const C = require(path.join(ROOT, 'shared', 'hsa-core.js'));
    const searchZh = { name: '今日 Bing 搜索', completed: false, points: 60, section: 'search', url: '' };
    const searchEn = { name: 'Bing search today', completed: false, points: 60 };
    const doneCard = { name: '迪拜沙漠舒适宜人', completed: true, points: 10 };
    const liveCard = { name: '古代创新', completed: false, points: 10 };
    assert.equal(C.isNonClickableTaskItem(searchZh), true);
    assert.equal(C.isNonClickableTaskItem(searchEn), true);
    assert.equal(C.isNonClickableTaskItem(doneCard), false);
    assert.equal(C.isNonClickableTaskItem(liveCard), false);
    assert.equal(C.isNonClickableTaskItem({ name: '今日 Bing 搜索', url: 'https://rewards.bing.com/x' }), false,
      '有真实链接的同名项仍按可点卡片处理');
    /* 顺序不变、只删非卡片与已完成 */
    assert.deepEqual(C.pendingTaskItems([searchZh, doneCard, liveCard, searchEn]).map(x => x.name),
      ['古代创新']);
    assert.deepEqual(C.taskPlanNames([searchZh, doneCard, liveCard], null), ['古代创新']);
    /* 两端 gate：只剩搜索项 / 只剩已完成 → false；有未完成卡 → true */
    assert.equal(C.hasClickableCards([searchZh], [searchZh], null), false);
    assert.equal(C.hasClickableCards([doneCard], [doneCard], null), false);
    assert.equal(C.hasClickableCards([searchZh, doneCard], [searchZh, doneCard], null), false);
    assert.equal(C.hasClickableCards([], [liveCard], null), true, '索引空但主界面有卡时不误短路');
    assert.equal(C.hasClickableCards([liveCard], [], null), true);
    for (const d of ['edge-extension/shared/hsa-core.js', 'desktop-app/shared/hsa-core.js']) {
      assert.equal(fs.readFileSync(path.join(ROOT, d), 'utf8')
        .replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''),
        fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8').trim() + '\n',
        d + ' 副本不一致');
    }
    for (const k of ['eb', 'db']) {
      for (const needle of [
        'async function hasPendingClickableCards()',
        'async function skipCardPhaseIfEmpty(stat)',
        "HSA_CORE.hasClickableCards(primary, secondary, summary)",
        "'no-clickable-cards'", 'hsaRunLog(',
        'if (await skipCardPhaseIfEmpty(stat)) return stat;',
        'if (!ordered.length && !(await hasPendingClickableCards()).ok)'
      ]) {
        assert.ok(F[k].includes(needle), P[k] + ' 缺 v4.1 接线 ' + needle);
      }
      /* gate 必须写在任何侧栏/官网页面打开之前 */
      const gate = F[k].indexOf('async function skipCardPhaseIfEmpty');
      const entry = F[k].indexOf('if (await skipCardPhaseIfEmpty(stat)) return stat;');
      assert.ok(gate > 0 && entry > gate, P[k] + ' 短路不在入口');
    }
    /* 插件：内部侧栏与回退流程也走同一个 gate，且在 ensureEmbeddedPanel / openOrNavigate 之前 */
    const eGate1 = F.eb.indexOf('if (!(await hasPendingClickableCards()).ok)');
    const eGate2 = F.eb.indexOf('if (!(await hasPendingClickableCards()).ok)', eGate1 + 1);
    assert.ok(eGate1 > 0 && eGate1 < F.eb.indexOf("await openOrNavigate('humanTabId', pg.url)"),
      '插件回退流程 gate 必须在打开官网页面之前');
    assert.ok(eGate2 > eGate1 && eGate2 < F.eb.indexOf('await ensureEmbeddedPanel(token)'),
      '插件内部侧栏 gate 必须在打开侧栏之前');
    /* 桌面主进程：gate 必须在 showSidePanel / loadSidebarFlyout 之前 */
    const dm = fs.readFileSync(path.join(ROOT, 'desktop-app', 'main.js'), 'utf8');
    const clickAll = dm.indexOf("'chrome:task:clickAll'");
    const mainGate = dm.indexOf("reason: 'no-clickable-cards'", clickAll);
    assert.ok(clickAll > 0 && mainGate > clickAll, '桌面主进程缺 v4.1 短路');
    assert.ok(mainGate < dm.indexOf("showSidePanel(null, 'run', false)", clickAll),
      '桌面主进程 gate 必须在 showSidePanel 之前');
    assert.ok(mainGate < dm.indexOf('loadSidebarFlyout(tv, sidebarUrls, true)'),
      '桌面主进程 gate 必须在加载 panelflyout 之前');
    assert.ok(dm.includes('sidebarOpened: false'));
    /* 词规则与严格档不回退 */
    for (const k of ['eb', 'db']) {
      has(k, /HSA_CORE\.strictQueries\(/);
      has(k, /HSA_CORE\.isStrictKeyword\(/);
      has(k, /strictClickPlan\(/);
    }
    has('dm', /HSA_HUMAN\.cardSpacing\(humanCard/);
  }],
  ['v4.1 · 日志与状态行：无卡片时不推送 0/0、短路事件两端同字段', () => {
    for (const k of ['eb', 'db']) {
      const t = F[k];
      has(k, /hsaRunLog\('no-clickable-cards'/);
      assert.ok(t.includes("zh: '无可点击任务卡，跳过侧栏'"), P[k] + ' 日志中文字段不一致');
      assert.ok(t.includes("en: 'No clickable cards, sidebar skipped'"), P[k] + ' 日志英文字段不一致');
      assert.ok(t.includes("state: 'skipped'") && t.includes("result: 'skipped'"),
        P[k] + ' 日志状态字段不一致');
      assert.ok(t.includes('搜索进度项与已完成卡已排除'), P[k] + ' 日志详情缺排除说明');
    }
    /* 主界面任务列表 / isAllDone 不受影响（搜索项仍参与配额判定） */
    const C = require(path.join(ROOT, 'shared', 'hsa-core.js'));
    assert.equal(typeof C.isAllDone, 'function');
    for (const k of ['eb', 'db']) has(k, /HSA_CORE\.isAllDone\(sync\.todayTasks/);
    /* 共享 UI 数据源不删搜索项 */
    for (const k of ['eb', 'db']) has(k, /searchTaskItem\(|'今日 Bing 搜索'|Bing search today/);
  }],

  ['v4.2 · 三组预设由拟人强度统一管理：共享真源 / 后台套用 / 两端 UI 同构', () => {
    const H = require(path.join(ROOT, 'shared', 'hsa-human.js'));
    const C = require(path.join(ROOT, 'shared', 'hsa-core.js'));
    assert.equal(H.PRESET_GROUPS.length, 3);
    assert.deepEqual(H.PRESET_GROUPS.map(g => g.key), ['quota', 'action', 'page']);
    assert.equal(H.PRESET_GROUPS.reduce((a, g) => a + g.keys.length, 0), 7);
    for (const lv of [1, 2, 3]) {
      const p = H.applyRunPreset({ runMode: 'human', humanLevel: lv });
      for (const key of ['singleRunCapPct', 'scheduleJitterMin', 'cardClickIntervalSec',
                         'actionGapSec', 'pageStableSec', 'roundGapSec', 'roundWaitSec']) {
        assert.ok(Number.isFinite(p[key]), '档 ' + lv + ' 缺 ' + key);
      }
      assert.ok(p.runPresetMinutes === [15, 30, 60][lv - 1]);
    }
    assert.equal(H.applyRunPreset({ runMode: 'strict', roundGapSec: 42 }).roundGapSec, 42);
    assert.equal(H.presetValues(3, 'strict'), null);
    assert.equal(H.selftest().ok, true);
    /* 严格档固定节奏完全不回退 */
    const st = C.strictRunPolicy();
    assert.equal(st.fixedNapMs, 600);
    assert.equal(st.randomDelay, false);
    for (const k of ['eb', 'db']) {
      has(k, /HSA_HUMAN\.applyRunPreset\(/);
      has(k, /Object\.assign\(\{\}, DEFAULT_SETTINGS, settings \|\| \{\}\)/);
    }
    for (const k of ['eh', 'dh']) {
      for (const gone of ['set-card-interval', 'set-action-gap', 'set-page-stable',
                          'set-round-gap', 'set-round-wait',
                          'set-stealth-cap', 'set-stealth-jitter']) {
        assert.ok(!F[k].includes('id="' + gone + '"'), P[k] + ' 仍暴露 ' + gone);
      }
      assert.equal((F[k].match(/data-preset="/g) || []).length, 7);
      assert.equal((F[k].match(/data-group="(quota|action|page)"/g) || []).length, 3);
    }
    for (const k of ['ep', 'dp']) {
      has(k, /function renderRunPreset\(\)/);
      has(k, /HSA_HUMAN\.presetValues\(settings\.humanLevel, settings\.runMode\)/);
      for (const key of ['run.presetDesc', 'run.groupQuota', 'run.groupAction',
                         'run.groupPage', 'run.presetStrictNote']) {
        has(k, new RegExp("'" + key.replace('.', '\\.') + "':"));
      }
    }
    /* 两端共有设置 DOM 逐字一致；共享 CSS 与副本一致 */
    const bodyOf = x => {
      const a = x.indexOf('<div class="settings-body">');
      return x.slice(a, x.indexOf('</section>', a));
    };
    const d = bodyOf(F.dh);
    const ds = d.indexOf('<!-- v1.3.8 · 桌面版专有功能');
    const de = d.indexOf('id="set-reset"', ds);
    assert.equal(bodyOf(F.eh).trim(),
      (d.slice(0, ds) + d.slice(d.lastIndexOf('\n', de) + 1)).trim());
    const css = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-shared.css'), 'utf8');
    assert.match(css, /\.preset-groups/);
    for (const f of ['edge-extension/shared/hsa-shared.css', 'desktop-app/shared/hsa-shared.css']) {
      assert.equal(fs.readFileSync(path.join(ROOT, f), 'utf8')
        .replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''), css, f + ' 副本不一致');
    }
    for (const k of ['eh', 'dh']) {
      const keys = [...F[k].matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)].map(m => m[1]);
      const jk = k === 'eh' ? 'ep' : 'dp';
      for (const key of new Set(keys)) {
        assert.ok(F[jk].includes("'" + key + "':"), P[jk] + ' 缺字典键 ' + key);
      }
    }
  }],
  ['v4.2 · 搜索词一天之内不能重复：UTC+8 日界、跨运行去重、不补词', () => {
    const C = require(path.join(ROOT, 'shared', 'hsa-core.js'));
    const now = Date.UTC(2026, 10, 12, 4, 0, 0);
    const day = C.hotDayKey(now);
    assert.equal(day, '2026-11-12');
    const words = ['六个字的热搜词', '今日十个字的头条新闻词', '第五个合规词条甲乙'];
    assert.ok(words.every(w => C.isStrictKeyword(w)));
    const st = C.todayUsedState({ day, words: [words[0]] }, now);
    assert.equal(st.day, day);
    assert.deepEqual(st.words, [words[0]]);
    assert.deepEqual(C.todayUsedState({ day: '2026-11-11', words }, now).words, [],
      '跨 UTC+8 日界自动失效');
    assert.deepEqual(C.todayUsedState(null, now).words, []);
    assert.deepEqual(C.dropUsedWords(words, st.words), [words[1], words[2]],
      '顺序不变、只剔除已用词、不补词');
    assert.equal(C.mergeUsedWords([['甲'], ['甲', '乙']]).length, 2);
    const pushed = C.todayUsedPush(st, [words[1]]);
    assert.deepEqual(pushed.words, [words[0], words[1]]);
    assert.equal(C.todayUsedPush(pushed, words).words.length, 3, '重复项不再累加');
    assert.equal(C.USED_WORDS_MAX, 320);
    for (const k of ['eb', 'db']) {
      for (const needle of ["load(['todayUsedWords'])",
        'HSA_CORE.todayUsedState(saved, now)', 'HSA_CORE.mergeUsedWords(',
        'HSA_CORE.dropUsedWords(built.queries, usedAll)',
        'HSA_CORE.todayUsedPush(usedState, queries)',
        "store({ todayUsedWords: nextState })",
        '当日合规词已全部用完', 'droppedUsed']) {
        assert.ok(F[k].includes(needle), P[k] + ' 缺当日去重接线 ' + needle);
      }
      /* 词规则不回退 */
      has(k, /HSA_CORE\.strictQueries\(pool\.items\.length, pool\.items, now\)/);
      has(k, /HSA_CORE\.isStrictKeyword\(/);
    }
    for (const d of ['edge-extension/shared/hsa-core.js', 'desktop-app/shared/hsa-core.js']) {
      assert.equal(fs.readFileSync(path.join(ROOT, d), 'utf8')
        .replace(/^\/\* AUTO-GENERATED[^\n]*\n/, ''),
        fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8').trim() + '\n');
    }
  }],

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
