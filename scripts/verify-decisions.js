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
    assert.equal(CORE.VERSION, '2.3.0');
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
    assert.equal(CORE.VERSION, '2.3.0');
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
    has('db', /HSA_CORE\.taskListNames|taskListNames/);
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
      has(k, /logUserAction\('pull-refresh'/);
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
    /* 不引入 minirefresh 库文件，只复刻主题视觉；v2.8 起共享清单仍为 7 个文件 */
    const sync = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-shared.js'), 'utf8');
    assert.match(sync, /hsa-pull-refresh\.js/);
    assert.doesNotMatch(sync, /minirefresh/);
    for (const k of ['eh', 'dh']) {
      assert.doesNotMatch(F[k], /minirefresh[^"]*\.js/);
      has(k, /hsa-pull-refresh\.js/);
    }
    const files = sync.match(/const FILES = \[([\s\S]*?)\];/)[1];
    assert.equal((files.match(/\.js'|\.css'|\.json'/g) || []).length, 7);
  }],
  ['v2.9 · 全部浏览器伪装已移除：无 UA / UA-CH / navigator 注入 / 自定义请求头', () => {
    for (const k of ['eb', 'db', 'dm', 'preload', 'host']) {
      for (const pat of [
        /userAgentFallback/, /setUserAgent/, /sec-ch-ua(?:-|\s|'|"|:)/,
        /navigatorScript/, /EDGE_IDENTITY/, /edge-identity/, /SOURCE_UA/,
        /HSA_APPLY_EDGE_IDENTITY/, /chrome:edge:profile/, /getEdgeProfile/,
        /applyFetchHeaders/, /installEdgeClientHints/
      ]) {
        absent(k, pat, P[k] + ' 仍残留伪装 ' + pat);
      }
    }
    /* 不再伪造 User-Agent，Referer 等业务必需头照常保留 */
    for (const k of ['eb', 'db']) {
      absent(k, /'User-Agent':/);
      has(k, /Referer: 'https:\/\/weibo\.com\/'/);
    }
    /* 默认 Bing 是起始页设置，不属于身份伪装，保留 */
    has('dm', /const DEFAULT_BROWSER_HOME = 'https:\/\/www\.bing\.com\/\?mkt=zh-CN'/);
    has('dm', /const DEFAULT_SEARCH_ENGINE = 'https:\/\/www\.bing\.com\/search\?q='/);
    /* 伪装模块与旧专项测试文件已删除 */
    assert.equal(fs.existsSync(path.join(ROOT, 'desktop-app', 'lib', 'edge-identity.js')), false);
    assert.equal(fs.existsSync(path.join(ROOT, 'tests', 'edge-identity.test.js')), false);
    for (const k of ['ymlLinux', 'ymlWin']) {
      absent(k, /edge-identity\.js/);
      has(k, /lib\/runtime-budget\.js/);
    }
    /* 设置页文案如实说明「无伪装」 */
    has('dh', /不做任何身份伪装/);
    has('dp', /'desktop\.edgeValue': '默认主页 · Bing'/);
    has('dp', /'desktop\.edgeValue': 'Home · Bing'/);
    absent('dh', /伪装为 Microsoft Edge/);
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
  ['v2.9 · 默认 Bing 与登录/积分链路 URL 不变，共享清单仍 7 个文件', () => {
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
      .match(/\.js'|\.css'|\.json'/g) || []).length, 7);
  }],
  ['v2.9 · 设置页只读信息仍在且无新增开关', () => {
    has('dh', /data-i18n="desktop\.edge"/);
    has('dh', /data-i18n="desktop\.edgeValue"/);
    has('dh', /data-i18n-title="desktop\.edgeHint"/);
    assert.doesNotMatch(F.dh, /id="set-edge/);
    const at = F.dh.indexOf('data-i18n="desktop.edge"');
    assert.doesNotMatch(F.dh.slice(at, at + 320), /<input/);
  }],
  ['v3.0 · 打开主界面同步一次：共享判定 + 两端 popup + 两端后台（运行中例外）', () => {
    const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
    assert.equal(CORE.SYNC_ON_OPEN.messageType, 'syncOnOpen');
    assert.equal(CORE.SYNC_ON_OPEN.reason, 'ui-open');
    assert.equal(CORE.SYNC_ON_OPEN.minGapMs, 60000);
    assert.equal(CORE.SYNC_ON_OPEN.storageKey, 'syncOnOpenAt');
    assert.equal(CORE.syncOnOpenAllowed(false, null, 1000000), true, '空闲首次打开允许');
    assert.equal(CORE.syncOnOpenAllowed(true, null, 1000000), false, '正在运行一律例外');
    assert.equal(CORE.syncOnOpenAllowed(false, 970000, 1000000), false, '30s 内重复打开节流');
    assert.equal(CORE.syncOnOpenAllowed(false, 939000, 1000000), true, '超过 60s 可再次同步');
    assert.equal(CORE.syncCachePolicy('ui-open').fresh, true, '必须强制新数据');
    assert.equal(CORE.strictBlockedMessage('syncOnOpen', true), true,
      '严格运行期消息白名单兜底拦截');
    assert.equal(CORE.strictBlockedMessage('syncOnOpen', false), false);
    for (const k of ['ep', 'dp']) {
      has(k, /async function requestSyncOnOpen\(\)/);
      has(k, /HSA_CORE\.syncOnOpenAllowed\(running, lastAt, now\)/);
      has(k, /chrome\.storage\.local\.set\(\{ \[HSA_CORE\.SYNC_ON_OPEN\.storageKey\]: now \}\)/);
      has(k, /send\(HSA_CORE\.SYNC_ON_OPEN\.messageType/);
      has(k, /requestSyncOnOpen\(\);/);
    }
    /* 桌面 popup 常驻隐藏，额外监听主进程广播 */
    has('dp', /chrome\.runtime\.onUiOpened\.addListener\(\(\) => requestSyncOnOpen\(\)\)/);
    absent('ep', /onUiOpened/);
    has('preload', /onUiOpened: makeEvent\('ui:opened'\)/);
    has('dm', /broadcast\('ui:opened', \[\{ at: Date\.now\(\) \}\]\)/);
    for (const k of ['eb', 'db']) {
      has(k, /msg\.type === HSA_CORE\.SYNC_ON_OPEN\.messageType/);
      has(k, /reason: HSA_CORE\.SYNC_ON_OPEN\.reason/);
      has(k, /syncNotice/);
    }
    has('eb', /syncRewardsUnified\(\{ fresh: true, noTabs: true,/);
    has('db', /desktopSyncRewards\(\{ fresh: true, noTabs: true,/);
    /* 共享核心导出与副本一致 */
    const coreSrc = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8');
    assert.match(coreSrc, /SYNC_ON_OPEN: SYNC_ON_OPEN/);
    assert.match(coreSrc, /syncOnOpenAllowed: syncOnOpenAllowed/);
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
  ['v3.1 · 同步绝不打开 rewards 标签页/隐藏视图（noTabs 护栏）', () => {
    /* 插件版：降级注入条件加 !o.noTabs */
    has('eb', /if \(!cards\.length && pages\.reachable && !\(o\.skipInjection\) && !o\.noTabs\)/);
    /* 插件版全部 7 个 syncRewardsUnified 调用点都带 noTabs */
    const calls = F.eb.match(/syncRewardsUnified\(\{[^}]*\}\)/g) || [];
    assert.ok(calls.length >= 6, '应覆盖全部同步入口');
    for (const c of calls) assert.match(c, /noTabs: true/, '同步入口漏了 noTabs: ' + c);
    /* 自动运行的 readRewardsPage（积分读取 / 搜索点击）不受影响 */
    has('eb', /async function readRewardsPage\(/);
    assert.ok((F.eb.match(/await readRewardsPage\(/g) || []).length >= 2);
    /* 桌面版：跳过隐藏取数视图，且同步入口透传 noTabs */
    has('db', /if \(opts && opts\.noTabs\)/);
    has('db', /error: 'no-tabs sync'/);
    has('db', /noTabs: o\.noTabs/);
    has('db', /desktopSyncRewards\(\{ fresh: true, noTabs: true,/);
    /* 下拉刷新 / 手动刷新走 refreshTasks，同样被护栏覆盖 */
    for (const k of ['ep', 'dp']) has(k, /refreshTasks/);
    has('eb', /syncRewardsUnified\(\{ fresh: true, noTabs: true, reason: reason \}\)/);
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
    /* 共享副本与单一真源一致（同步脚本复制 7 个文件） */
    const a = fs.readFileSync(path.join(ROOT, 'shared', 'hsa-core.js'), 'utf8');
    const b = fs.readFileSync(path.join(ROOT, 'edge-extension', 'shared', 'hsa-core.js'), 'utf8');
    const stripHead = t => t.replace(/^\/\* AUTO-GENERATED[^\n]*\n/, '');
    assert.equal(stripHead(b), a, '插件版 shared 副本（去掉自动生成头）必须与 shared/ 一致');
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
