#!/usr/bin/env node
/* ============================================================================
 * v1.3.0 · 基准对齐专项
 *
 * v1.2.0 口径：桌面版后台以用户上传的 GitHub 原始插件 background.js 为底本，
 * 除登记过的「桌面壳适配」外逐字节相同。
 * v1.3.0 新指令显式覆盖上传版流程：开始同步一次 → 锁定搜索次数 → 点卡片
 * → 跑满搜索（中间不同步积分）→ 收尾同步一次。因此 8 个函数属于**有意改造**，
 * 全部登记在 V13_WHITELIST，并在第 7 节逐条断言新流程特征。
 * 任务识别、卡片点击、拟人搜索动作、各解析器、登录判定仍逐字节沿用上传版。
 *
 * 另外用用户同批上传的真实官网 HTML 夹具实跑上传版的判定与解析函数：
 *   · 已登录 /dashboard 与 /earn 页不被 isSignInPage 误判成登录页
 *   · 真正的 Microsoft 登录页仍判为登录页
 *   · parsePointsTrio / parseSearchCounter / cardsFromRewardsHtml 能命中真实页面
 *
 * 运行： npm run verify:align
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
/* 项目只保留一份原始上传基准，避免在源码包中重复携带两份插件目录。 */
const UP = process.env.HSA_GITHUB_BASE
  ? path.resolve(process.env.HSA_GITHUB_BASE)
  : path.join(ROOT, 'tests', 'github-upload');
const upBg = fs.readFileSync(path.join(UP, 'background.js'), 'utf8');
const dkBg = fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8');
const baseline = JSON.parse(fs.readFileSync(path.join(UP, 'baseline.json'), 'utf8'));

let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');

/** 按大括号配对抽取一个顶层具名函数的完整源码（含 async 前缀）。 */
function funcs(s) {
  const out = {};
  const re = /^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm;
  let m;
  while ((m = re.exec(s))) {
    const i = m.index;
    const j = s.indexOf('{', i);
    let d = 0;
    for (let k = j; k < s.length; k++) {
      if (s[k] === '{') d++;
      else if (s[k] === '}') {
        if (--d === 0) { out[m[1]] = s.slice(i, k + 1); break; }
      }
    }
  }
  return out;
}

const UP_F = funcs(upBg);
const DK_F = funcs(dkBg);

/* 自动完成任务 + 积分/任务解析 + 登录判定 的核心函数组。
   用户点名「重点」，这一组不允许任何差异。 */
const CORE = [
  'checkAllTasksDone', 'cachedAllDone', 'officialTaskRows', 'rowsAllDone',
  'fetchOfficialTaskRows', 'runAutoComplete', 'startAutoRun', 'maybeRunAutoTasks',
  'completePendingTaskCards', 'completePendingTaskCardsOnRewards',
  'clickCardsOnPage', 'clickCardsInSidebar', 'clickTargetsFromTaskList',
  'humanClickTasks', 'buildClickTargets', 'waitForTaskPageReady',
  'taskClickSpacing', 'taskPageMatches', 'normalizeTaskUrl', 'taskUrlFp',
  'searchLoop', 'handleStart', 'handleStop', 'runFlow', 'finishRun',
  'finishLimitReached', 'finishWithError', 'enterCooldown', 'endCooldown',
  'prepareQueue', 'ensureQueue', 'readGainSignals', 'classifyGain',
  'estimateEarned', 'readPointsFromDashboard', 'readTodaySearch',
  'fetchBothPages', 'isSignInPage', 'parseBalance', 'parsePointsTrio',
  'cardsPoints', 'mergeTrio', 'parseSearchCounter', 'cardsFromRewardsHtml',
  'structuredItemsFrom', 'visibleCardsFrom', 'readTaskCardsFromDom',
  'rowsFromProgressTable', 'fallbackTaskItems', 'searchTaskItem',
  'summarizeTaskItems', 'refreshTodayTasks', 'refreshPointsSummary',
  'refreshPointsOnly', 'autoSearchCount', 'getAutoTasks', 'normalizeAutoTasks',
  'getAutoLog', 'autoHHMM', 'toMinutes', 'inActiveHours', 'sameUtcDay',
  'directPoints', 'directToday', 'readRewardsPage', 'waitForSettled',
  'openOrNavigate', 'closeTab', 'forceCloseTab', 'getTab', 'goto',
  'ensureTabActive', 'keepSearchTabAwake', 'restoreUserFocus',
  'cdpAttach', 'cdpCmd', 'cdpClickAt', 'cdpInsertText', 'cdpKey',
  'mousePath', 'humanClickPlan', 'scrollPlan', 'jerk', 'profileOf',
  'buildQueries', 'getKeywordPool', 'suggestRelated', 'relatedSearches',
  'previewTopic', 'previewReminder', 'testHumanSearch',
  'ybInject', 'injectAllFrames', 'injectFrame'
];

/* 允许差异的 10 个函数，全部是「桌面壳适配」，每个都有明确理由。 */
const ADAPT_WHITELIST = {
  inject: 'A1 contextBridge 函数序列化（Electron 45 真机必需）',
  injectAllFrames: 'A1 contextBridge 函数序列化',
  injectFrame: 'A1 contextBridge 函数序列化',
  fetchRewardsPage: 'A2 数据源换成内置浏览器页面，返回形状不变',
  refreshToday: 'A5 空闲零抓取门控',
  endCooldown: 'A4 周期 watchdog → 一次性 when',
  handleStart: 'A4 周期 watchdog → 一次性 when',
  handleStop: 'A4 周期 watchdog → 一次性 when',
  ensureReminderTick: 'A6 周期 reminderTick → 一次性 when',
  rebuildAutoAlarm: 'A6 每分钟 autoTaskTick → 下一个时间点一次性排程',
  /* ---- v1.3.0 有意改造：仅流程编排与同步时机，不改任务识别/点击/搜索动作 ---- */
  runAutoComplete: 'V13 重排为开始同步→点卡片→按锁定次数搜索→收尾同步',
  searchLoop: 'V13 删除每轮 directToday 积分检测与冷却/autoStop 中途判定',
  runFlow: 'V13 搜索阶段置位 desktopSearchGuard 硬拦截',
  finishRun: 'V13 预设流程收尾合并为一次两页同步',
  fetchBothPages: 'V13 透传 fresh，开始/收尾跳过 120s 快照',
  summarizeTaskItems: 'V137 进度精确取整，只有 earned 达到 total 才显示 100%',
  refreshTodayTasks: 'V13 支持复用同一份 pages、可跳过 25s 注入兜底',
  autoSearchCount: 'V13 修正 cap=0 被 || 吞掉的 bug',
  maybeShowReminder: 'V13 禁用「浏览网页就抓 /earn」的空闲请求'
};

function testAlignment() {
  group('1. 单份上传基准完整性');
  const referenceFiles = Object.keys(baseline.files || {});
  ck(referenceFiles.length >= 10, `参照基准包含 ${referenceFiles.length} 个文件`);
  for (const f of referenceFiles) {
    const file = path.join(UP, f);
    const exists = fs.existsSync(file);
    const actual = exists ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '';
    ck(exists && actual === baseline.files[f], `${f} 与基准 SHA-256 一致`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(UP, 'manifest.json'), 'utf8'));
  ck(manifest.manifest_version === 3, '保留的参照源码为 Manifest V3');
  ck(fs.existsSync(path.join(ROOT, 'src', 'background.js')) &&
     fs.existsSync(path.join(ROOT, 'src', 'popup.html')),
     '桌面版运行资源位于 src/，不依赖外层插件副本');

  group('2. 自动完成任务核心函数组逐字节等于上传版');
  let coreHit = 0, coreAdapted = [], coreMiss = [];
  for (const name of CORE) {
    if (!(name in UP_F)) continue;            // 上传版本身没有的函数跳过
    if (DK_F[name] && DK_F[name].trim() === UP_F[name].trim()) coreHit++;
    else if (ADAPT_WHITELIST[name]) coreAdapted.push(name);
    else coreMiss.push(name);
  }
  ck(coreMiss.length === 0,
     `核心组 ${coreHit} 个函数逐字节相同` +
     (coreMiss.length ? '（未登记差异：' + coreMiss.join(', ') + '）' : ''));
  ck(coreAdapted.every(k => !!ADAPT_WHITELIST[k]),
     `核心组中 ${coreAdapted.length} 个差异全部是已登记的桌面壳适配：` +
     coreAdapted.map(k => k + '(' + (ADAPT_WHITELIST[k] || '').split(' ')[0] + ')').join('、'));
  ck(coreHit >= 68, `核心组逐字节相同 ${coreHit} 个（≥68）`);
  /* 上传版原封不动保留的重点：任务全完成判定、卡片点击、搜索项、登录判定 */
  for (const k of ['checkAllTasksDone', 'humanClickTasks', 'searchTaskItem',
                   'isSignInPage', 'completePendingTaskCards', 'clickCardsOnPage']) {
    ck(DK_F[k] && DK_F[k].trim() === UP_F[k].trim(),
       `  · ${k} 逐字节等于上传版（未改动）`);
  }
  /* v1.3.0 新指令要求改流程，这 8 个属于登记过的有意偏离 */
  for (const k of ['runAutoComplete', 'searchLoop', 'runFlow', 'finishRun',
                   'fetchBothPages', 'refreshTodayTasks', 'autoSearchCount',
                   'maybeShowReminder']) {
    ck(!!ADAPT_WHITELIST[k] && DK_F[k] && DK_F[k].trim() !== UP_F[k].trim(),
       `  · ${k} 已按 v1.3.0 流程改造且登记在白名单`);
  }

  group('3. 全量函数对齐统计与差异白名单');
  const same = Object.keys(UP_F).filter(k => DK_F[k] && DK_F[k].trim() === UP_F[k].trim());
  const diff = Object.keys(UP_F).filter(k => DK_F[k] && DK_F[k].trim() !== UP_F[k].trim());
  const missing = Object.keys(UP_F).filter(k => !DK_F[k]);
  ck(missing.length === 0, `上传版 ${Object.keys(UP_F).length} 个函数一个都没丢` +
     (missing.length ? '（缺：' + missing.join(', ') + '）' : ''));
  ck(same.length >= 138, `逐字节相同 ${same.length} 个（≥138，其余为登记过的适配/流程改造）`);
  const unexpected = diff.filter(k => !ADAPT_WHITELIST[k]);
  ck(unexpected.length === 0, `差异 ${diff.length} 个全部在适配白名单内` +
     (unexpected.length ? '（未登记：' + unexpected.join(', ') + '）' : ''));
  for (const k of diff) {
    ck(!!ADAPT_WHITELIST[k], `  · ${k} → ${ADAPT_WHITELIST[k] || '未登记'}`);
  }
  const added = Object.keys(DK_F).filter(k => !(k in UP_F));
  ck(added.every(k => /^desktop|^armOneShot|^readPageHtml|^preset|^syncStart|^taskClick|^buildTaskClickIndex|^isTaskSummaryComplete/.test(k)),
     `桌面版新增 ${added.length} 个函数全部是适配层、同步定位索引或流程编排层`);

  group('4. 零监控口径（不重新引入周期定时器）');
  const periodic = (dkBg.match(/periodInMinutes\s*:/g) || []).length;
  ck(periodic === 0, 'background.js 没有任何 periodInMinutes 周期 alarm');
  ck(!/setInterval\s*\(/.test(dkBg), 'background.js 没有 setInterval');
  ck(/function armOneShot/.test(dkBg) && /when:\s*Date\.now\(\)/.test(dkBg),
     '所有排程都走一次性 when');
  ck(/desktopFetchAllowed\('refreshToday'\)/.test(dkBg),
     'refreshToday 有空闲零抓取门控');
  ck(/desktopOpenFetchGate\('autoComplete'\)/.test(dkBg),
     '点击「自动完成任务」才开启抓取门控（时机 1）');
  ck(!/search-round-/.test(dkBg) && !/desktopLastSearchIndex/.test(dkBg),
     'v1.3.0：已删除「每完成一次搜索刷新积分/任务」的钩子');
  ck(/desktopSearchGuard = true/.test(dkBg) && /mid-search sync blocked/.test(dkBg),
     'v1.3.0：搜索进行中任何积分抓取被硬拦截');
  ck(/async function syncStart\(/.test(dkBg) && /async function presetSyncFinish\(/.test(dkBg) &&
     /async function presetSearchCount\(/.test(dkBg),
     'v1.3.0：开始时一次同步、次数预锁定、收尾一次同步三个编排函数齐备');
  ck(!/await checkAllTasksDone\(\)/.test(dkBg),
     'v1.3.0：不再在同步之前额外请求官方 getuserinfo（省一次网络往返）');

  group('5. 不再有 v1.1.x 自造登录判定（用户反馈「识别登录状态出错」的根因）');
  for (const k of ['classifyLogin', 'detectLogin', 'quickLoginCheck', 'stickyLogin',
                   'mergeLogin', 'parseTodayPointsFromEarn', 'guardSignedOut',
                   'readVisiblePanelDirect', 'readFromVisibleRewardsTab',
                   'synthPointsHtml', 'readEmbeddedRewardsPage', 'embeddedResult']) {
    ck(!new RegExp('function\\s+' + k + '\\s*\\(').test(dkBg), `已移除自造函数 ${k}`);
  }
  ck(/signedOut:\s*isSignInPage\(dash\.html\)\s*&&\s*isSignInPage\(earn\.html\)/.test(dkBg),
     '登录判定回到上传版：两页都判登录页才算 signedOut');
}

function testV13Flow() {
  group('7. v1.3.0 自动完成任务流程特征');
  ck(/const sync = await syncStart\(token, o\.cap\)/.test(dkBg),
     '第①步：开始时唯一一次同步（积分 + 任务列表 + 搜索配额）');
  ck(/const cnt = await presetSearchCount\(pages, cap\)/.test(dkBg) &&
     /presetSearches: cnt\.searches/.test(dkBg),
     '搜索次数在开始时依据官方配额算好并写入 presetSearches 锁定');
  ck(/const clickRes = await completePendingTaskCards\(level, token\)/.test(dkBg) &&
     dkBg.indexOf('completePendingTaskCards(level, token)') < dkBg.indexOf('handleStart(searches'),
     '第②步先点任务卡片，第③步才搜索');
  ck(/const searches = sync\.searches/.test(dkBg) &&
     /await handleStart\(searches, \{/.test(dkBg),
     '第③步使用锁定的次数，不再在点击后重算');
  ck(!/if \(\(await load\(\['liveCheck'\]\)\)\.liveCheck\)/.test(dkBg) &&
     !/enterCooldown\(settings\)/.test(dkBg.slice(dkBg.indexOf('async function searchLoop'), dkBg.indexOf('function waitForTab'))),
     '搜索循环内没有积分读取、autoStop 与冷却判定');
  ck(/if \(desktopSearchGuard\)/.test(dkBg) &&
     /finally \{ desktopSearchGuard = false; \}/.test(dkBg),
     '搜索阶段用 finally 保证门控释放，收尾同步不受影响');
  ck(/await presetSyncFinish\(st, searches, start\)/.test(dkBg) &&
     /await presetSyncFinish\(Object\.assign\(\{\}, st, \{ totalSearch: 0 \}\), 0, sync\.startPoints \|\| 0\)/.test(dkBg),
     '第④步：有搜索 / 无搜索两条路径都只收尾同步一次');
  ck(/if \(!sync\.ok\)/.test(dkBg) &&
     /未登录或页面不可读，零动作返回/.test(dkBg),
     'v1.3.1：统一同步返回不可读时立即返回，不点卡片、不空跑搜索');
  ck(/fresh: true/.test(dkBg),
     '开始/收尾同步强制跳过 120 秒快照，避免用旧积分冒充最终积分');
  ck(/clearTimeout\(guardTimer\)/.test(dkBg),
     '修复 bug：race 胜出后清理 20 秒 guard 定时器');
  ck(/DESKTOP_NO_REMINDER_FETCH/.test(dkBg),
     '修复 bug：禁用浏览网页时偷抓 /earn 的空闲请求');
  const syncBody = dkBg.slice(dkBg.indexOf('async function desktopSyncRewards('),
                              dkBg.indexOf('refreshTodayTasks = async function'));
  ck(/async function desktopSyncRewards\(/.test(dkBg) &&
     !/readRewardsPage\(/.test(syncBody),
     'v1.3.1：统一同步层不调用最长 25 秒的后台注入兜底');
}

/* -------------------------------------------------- 真实 HTML 夹具实跑 */
function extract(name) {
  const i = upBg.indexOf('function ' + name + '(');
  if (i < 0) return null;
  const j = upBg.indexOf('{', i);
  let d = 0;
  for (let k = j; k < upBg.length; k++) {
    if (upBg[k] === '{') d++;
    else if (upBg[k] === '}') { if (--d === 0) return upBg.slice(i, k + 1); }
  }
  return null;
}

/* parseSearchCounter 函数体含正则字面量 {0,600} / \{([^{}]*)\}，
   大括号配对会失准；用与上传版逐字相同的正则做等价替身，专门验证真实夹具。 */
const PSC_SHIM = [
  'function parseSearchCounter(html) {',
  '  const clean = decodePayload(html);',
  '  const block = clean.match(/"pointsCounters"\\s*:\\s*\\{[\\s\\S]{0,600}?"(?:pc|pcSearch|combined|combinedSearch|search)"\\s*:\\s*\\{([^{}]*)\\}/);',
  '  if (!block) return null;',
  '  const max = block[1].match(/"max"\\s*:\\s*(\\d+)/);',
  '  const progress = block[1].match(/"progress"\\s*:\\s*(\\d+)/);',
  '  if (!max || !progress) return null;',
  '  const result = { progress: parseInt(progress[1], 10), max: parseInt(max[1], 10) };',
  '  return result.max > 0 ? result : null;',
  '}'
].join('\n');

function testRealHtml() {
  group('6. 用用户同批上传的真实官网 HTML 实跑上传版判定与解析');
  const fx = path.join(ROOT, 'tests', 'fixtures');
  const dash = fs.readFileSync(
    fs.existsSync(path.join(fx, 'uploaded-dashboard.html'))
      ? path.join(fx, 'uploaded-dashboard.html')
      : '/data/inputs/0002-data-view-dash-rewards.bing.com-dashboard.html', 'utf8');
  const earn = fs.readFileSync(
    fs.existsSync(path.join(fx, 'uploaded-earn.html'))
      ? path.join(fx, 'uploaded-earn.html')
      : '/data/inputs/0001-data-view-earn-rewards.bing.com-earn.html', 'utf8');
  ck(dash.length > 300000 && earn.length > 300000,
     `真实夹具已就位（dashboard ${dash.length} / earn ${earn.length} 字节）`);

  const ctx = vm.createContext({
    String, Number, Array, Object, RegExp, JSON, Math, Date, isNaN,
    parseInt, parseFloat, Boolean, Promise, console, Set, Map, bgLang: 'zh'
  });
  const decodeLine = /const decodePayload\s*=\s*[^;]+;/.exec(upBg);
  const labelsLine = /const POINT_LABELS\s*=\s*\{[\s\S]*?\n\};/.exec(upBg);
  vm.runInContext(decodeLine[0] + '\n' + (labelsLine ? labelsLine[0] : ''), ctx);
  for (const n of ['isSignInPage', 'numFrom', 'pickNumber', 'cardsPoints',
                   'parsePointsTrio', 'mergeTrio', 'parseBalance']) {
    const src = extract(n);
    if (src) vm.runInContext(src, ctx);
  }
  vm.runInContext(PSC_SHIM, ctx);
  const verdict = h => vm.runInContext('isSignInPage(' + JSON.stringify(h) + ')', ctx);
  ck(verdict(dash) === false, '真实已登录 /dashboard 页不被误判为登录页');
  ck(verdict(earn) === false, '真实已登录 /earn 页不被误判为登录页');
  const loginHtml = '<html><body>Sign in to your Microsoft account. No account? Create one.</body></html>';
  ck(verdict(loginHtml) === true, '真正的 Microsoft 登录页仍判为登录页');
  const combo = vm.runInContext(
    'isSignInPage(' + JSON.stringify(dash) + ') && isSignInPage(' + JSON.stringify(earn) + ')', ctx);
  ck(combo === false, 'fetchBothPages 的 signedOut 判定对已登录现场为 false（不会清空积分）');

  const safe = (expr, label) => {
    try {
      return { v: vm.runInContext(expr, ctx), err: null };
    } catch (e) {
      return { v: null, err: String(e && e.message || e).slice(0, 120), label };
    }
  };
  const t = safe('parsePointsTrio(' + JSON.stringify(dash) + ')', 'parsePointsTrio');
  ck(!t.err && t.v && Number.isFinite(t.v.available) && t.v.available > 10000,
     'parsePointsTrio 从真实 /dashboard 读出可用积分（实际 ' +
     (t.v && t.v.available) + (t.err ? ' / ' + t.err : '') + '）');
  const c = safe('parseSearchCounter(' + JSON.stringify(earn) + ')', 'parseSearchCounter');
  ck(!c.err && c.v && c.v.max > 0,
     'parseSearchCounter 从真实 /earn 读出搜索配额（实际 ' +
     JSON.stringify(c.v) + (c.err ? ' / ' + c.err : '') + '）');
  const dp = safe('decodePayload(' + JSON.stringify(earn) + ')', 'decodePayload');
  ck(!dp.err && /"pointsCounters"\s*:\s*\{/.test(String(dp.v || '')),
     '真实 /earn 的 RSC payload 里确含 pointsCounters（今日积分/搜索配额来源）');
}

(async () => {
  console.log('\x1b[1m拟人搜索助手 · v1.3.0 流程优化 · 基准对齐专项\x1b[0m');
  testAlignment();
  testRealHtml();
  testV13Flow();
  console.log('\n\x1b[1m共 ' + (pass + fail) + ' 项，通过 ' + pass + ' 项，失败 ' + fail + ' 项\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常', e); process.exit(1); });
