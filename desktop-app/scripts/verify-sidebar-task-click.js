#!/usr/bin/env node
/* ============================================================================
 * v1.3.8-s2 · 侧栏积分卡片点击专项验证
 *
 * 用上传的测试侧栏（保存页 panelflyout.html）跑真实的 DOM 识别逻辑，断言：
 *   · v3.5 点击计划 = 预设列表本身，一项不删、不合并、不重排
 *   · 侧栏 DOM 扫描只补定位，scored / 完成态 / kind 不参与「是否点击」
 *   · 有积分的「将推荐转化为奖励」不再被误判为 0 分推荐卡跳过
 *   · 反转侧栏 DOM 完成标记后计划不变；计划项按名称定位真实元素
 *   · 全完成零动作、当日停止态、页面重载 / 关闭链路仍保留
 *
 * 静态检查不依赖浏览器；动态部分需要 playwright + 本机 Chromium/Chrome。
 * 找不到浏览器时只打印提示并跳过动态检查，不阻断 npm run verify。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'lib', 'sidebar-task-cards.js');
const S = require(LIB_PATH);
const LIB = fs.readFileSync(LIB_PATH, 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const BG = fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8');
const POP = fs.readFileSync(path.join(ROOT, 'src', 'popup.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'popup.html'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const FIXTURE = path.join(ROOT, S.SIDEBAR_FIXTURE_REL);

/* 与用户截图 / 上传侧栏素材一致的任务列表（从上到下，严格按此顺序执行）。 */
const POINTS = {
  '即将到来的喜剧活动': 10,
  '阿德莱德春季葡萄酒之旅': 10,
  '云形成类型': 10,
  '探险火星': 15,
  '古代建筑': 15,
  '你是否知道答案？': 5,
  '完成此拼图': 5
};
const EXPECT_ALL = Object.keys(POINTS);
const EXPECT_SKIP_ON = ['即将到来的喜剧活动', '云形成类型'];

let pass = 0;
function ck(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log('  ✓ ' + msg);
}
function section(title) { console.log('\n' + title); }
const names = list => list.map(c => c.name);
/** v3.3：设置项已移除，运行时恒为 true；此处保留库级双分支覆盖。 */
const skipFromSetting = notSkip => !notSkip;

/** 模拟「主界面上的任务状态」（即同步后写入 todayTasks 的今日任务列表）。 */
function mainUiTaskState(overrides) {
  const o = overrides || {};
  return {
    items: EXPECT_ALL.map(name => ({
      name: name,
      points: POINTS[name],
      earned: o.allDone ? POINTS[name] : (EXPECT_SKIP_ON.includes(name) ? 0 : POINTS[name]),
      completed: !!o.allDone || !EXPECT_SKIP_ON.includes(name)
    })),
    total: EXPECT_ALL.reduce((s, n) => s + POINTS[n], 0),
    earned: o.allDone ? EXPECT_ALL.reduce((s, n) => s + POINTS[n], 0)
      : EXPECT_ALL.reduce((s, n) => s + (EXPECT_SKIP_ON.includes(n) ? 0 : POINTS[n]), 0),
    signedOut: false
  };
}

async function main() {
  console.log('\n拟人搜索助手 · 侧栏积分卡片点击专项（v3.5 · 严格预设列表）\n');

  section('1. v3.5 · 无跳过参数与零动作短路（两端一致）');
  ck(!BG.includes('notSkipCompleted') && !POP.includes('notSkipCompleted')
      && !HTML.includes('set-not-skip-completed'),
    '桌面版「不跳过已完成」设置项、默认值、读写代码全部移除');
  const EXT_BG = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'background.js'), 'utf8');
  ck(!EXT_BG.includes('dontSkipCompleted'),
    '插件版同名字段同时移除，两端不再有冲突设置');
  ck(!BG.includes('skipCompletedCards') && !MAIN.includes('skipCompletedCards')
      && BG.includes('if (sync.allDone) {'),
    'v3.5 运行时不再有任何「是否跳过」参数；全完成零动作无 force 例外');
  ck(!BG.includes('!o.force'),
    '不存在绕过全完成停止态的 force 死参数（与插件版一致）');
  ck(BG.includes('const sync = await syncStart(token);')
      && BG.indexOf('await syncStart(token)') < BG.indexOf('if (sync.allDone)'),
    '自动开始按键点击后先同步积分，再判断是否全部完成');

  section('2. 侧栏流程接线（重载 / 关闭 / 主界面状态决策）');
  ck(MAIN.includes("const SidebarCards = require('./lib/sidebar-task-cards');"),
    '主进程加载侧栏识别模块');
  const handlerStart = MAIN.indexOf("ipcMain.handle('chrome:task:clickAll'");
  const handlerEnd = MAIN.indexOf("\nipcMain.handle('chrome:panel:hide'", handlerStart);
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart, '找不到 chrome:task:clickAll 处理块');
  const handler = MAIN.slice(handlerStart, handlerEnd);
  ck(handler.includes('loadSidebarFlyout(tv, sidebarUrls, true)')
      && MAIN.includes('forceReload') && MAIN.includes('reloadIgnoringCache'),
    '点击流程开启时主动重新加载侧栏页面');
  ck(MAIN.includes('closeSidebarTaskPage') && MAIN.includes("loadURL('about:blank')")
      && handler.includes('closeSidebarTaskPage(tv)'),
    '点击流程结束时关闭侧栏页面');
  ck(handler.includes('HSA_CORE.buildTaskPlan(presetItems, domCards, syncSummary)')
      && handler.includes('const syncSummary = ')
      && !handler.includes('planSidebarClicks(merged'),
    'v3.7 计划 = 任务列表（主界面完成态 → 跳过已完成），DOM 扫描只用于定位');
  ck(handler.includes('const presetItems =') && handler.includes('taskClickIndex'),
    '预设列表来自同步阶段 taskClickIndex.items');
  ck(handler.includes("stateSource: 'main-ui-task-state'"),
    '返回结果标明状态来源是主界面任务状态');
  ck(LIB.includes('domCompleted: !!c.completed') && LIB.includes('completed: syncCompleted'),
    '识别模块把侧栏完成态降为诊断字段，决策字段只来自同步状态');
  ck(handler.includes('SidebarCards.sidebarAimSource(card)') && handler.includes('dispatchTaskMouseClick(dbg, aim.x, aim.y)'),
    '侧栏卡片仍经坐标命中检查 + CDP 真鼠标点击');
  ck(handler.includes("source: 'sidebar-flyout'") && handler.includes("method: 'sidebar-flyout + CDP Input.dispatchMouseEvent'"),
    '返回结果明确标记侧栏点击来源');
  ck(handler.includes('locateIndexedCardAcrossScroll') && handler.includes('discoverLiveScoredCards'),
    '侧栏无可用主界面状态时仍保留 dashboard/earn 回退');
  ck(BG.includes('sidebarFirst: true') && BG.includes('taskSummary:'),
    '后台把同步积分状态随点击请求透传');
  ck(BG.includes('panel.clickAll(clickIndex, { cardClickIntervalSec: clickSettings.cardClickIntervalSec,')
      && BG.includes('runMode: RUN_SETTINGS && RUN_SETTINGS.runMode')
      && BG.includes('humanLevel: RUN_SETTINGS && RUN_SETTINGS.humanLevel')
      && !BG.includes('skipCompletedCards'),
    'v3.9 后台透传点击间隔与拟人档位，仍不透传任何跳过指令');
  ck(!!PKG.scripts && /verify-sidebar-task-click\.js/.test(PKG.scripts.verify || ''),
    '默认回归链包含侧栏点击专项');

  section('3. 纯函数：v3.6 计划 = 任务列表跳过已完成');
  const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
  const preset = [
    { name: '将推荐转化为奖励', points: 10 },
    { name: 'A', points: 10, completed: true },
    { name: '将推荐转化为奖励', points: 10 },   /* 重复项也要保留 */
    { name: 'B', points: 0, completed: true },
    { name: 'C', points: 0 }
  ];
  const dom = [
    { idx: 3, name: 'A', href: 'u2', scored: true },
    { idx: 7, name: '将推荐转化为奖励', href: 'u1', scored: false, kind: 'referral' }
  ];
  const strictPlan = CORE.planTaskClicks(preset, dom);
  const expectNames = ['将推荐转化为奖励', '将推荐转化为奖励', 'C'];
  ck(strictPlan.length === 3
      && JSON.stringify(strictPlan.map(c => c.name)) === JSON.stringify(expectNames),
    '只跳过任务列表标记已完成的 2 张；重复项 / 0 分 / referral 一律保留');
  ck(strictPlan.every(c => !c.completed), '计划里没有任何已完成项');
  ck(strictPlan[0].matched === true && strictPlan[0].idx === 7,
    '有积分的「将推荐转化为奖励」不再被 referral / scored 判断排除');
  ck(strictPlan.some(c => c.name === 'C' && c.matched === false && c.idx === -1),
    'DOM 未匹配项仍保留在计划里（点击时记失败，不删减列表）');
  ck(CORE.pendingTaskItems(preset).length === 3,
    'pendingTaskItems 是唯一过滤，两端与计划同源');
  /* mergeSidebarWithSync 仍是库级诊断能力：完成态只来自主界面任务状态 */
  const conflict = S.mergeSidebarWithSync(
    [{ idx: 0, name: 'A', points: 10, completed: true, scored: true },
     { idx: 1, name: 'B', points: 5, completed: false, scored: true }],
    { items: [{ name: 'A', points: 10, earned: 0, completed: false },
              { name: 'B', points: 5, earned: 5, completed: true }] }, null);
  ck(conflict[0].domCompleted === true && conflict[0].completed === false
      && conflict[1].domCompleted === false && conflict[1].completed === true,
    '库级诊断：侧栏 DOM 完成标记与同步状态分离');
  ck(conflict.every(c => c.completed === c.syncedCompleted),
    '库级诊断：完成决策字段只来自主界面同步结果');

  section('4. 上传测试侧栏的动态验证（v3.6 · 任务列表驱动）');
  let browser = null;
  try {
    const { chromium } = require('playwright');
    const candidates = [
      process.env.HSA_CHROMIUM,
      '/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
      chromium.executablePath()
    ].filter(Boolean);
    const exe = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (!exe) throw new Error('no chromium binary');
    browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  } catch (err) {
    console.log('  ! 跳过动态验证（' + String(err.message || err) + '）');
    console.log('    安装 playwright 并准备 Chromium 后重跑：node scripts/verify-sidebar-task-click.js');
    console.log('\n共 ' + pass + ' 项静态/纯函数检查通过；动态检查未运行，退出码 0');
    return;
  }

  assert.ok(fs.existsSync(FIXTURE), '缺少测试侧栏文件：' + FIXTURE);
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.goto(pathToFileURL(FIXTURE).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const scan = await page.evaluate(S.SIDEBAR_SCAN_SOURCE);
  ck(scan && Array.isArray(scan.cards) && scan.total >= 13,
    '侧栏扫描拿到完整卡片集合（' + (scan && scan.total) + ' 个候选）');

  /* v3.6 · 任务列表是唯一依据：显式标记若干项「已完成」，
     计划必须只跳过这些项，其余（含 0 分 / referral / 重复名）严格保序保留。 */
  const presetItems = scan.cards
    .filter(c => c && String(c.name || '').trim())
    .map((c, i) => {
      const name = String(c.name).trim();
      return { name, points: Number(c.points) || 0,
        completed: i % 7 === 3 && !/将推荐转化为奖励/.test(name) };
    });
  ck(presetItems.length >= 10, '素材提供足够的任务卡用于定位');
  const skippedInList = presetItems.filter(c => c.completed).length;
  ck(skippedInList >= 2, '任务列表里显式标记了已完成项');
  const plan = CORE.planTaskClicks(presetItems, scan.cards);
  const expected = CORE.pendingTaskItems(presetItems).map(c => c.name);
  ck(plan.length === expected.length,
    '计划长度 = 任务列表跳过已完成（' + presetItems.length + ' → ' + plan.length + '）');
  ck(JSON.stringify(plan.map(c => c.name)) === JSON.stringify(expected),
    '计划顺序严格等于任务列表未完成项顺序，不删减、不合并、不重排');
  ck(plan.every(c => !c.completed), '计划里没有已完成项');

  /* 关键回归：scored=false 的「将推荐转化为奖励」也必须进入计划且能定位 */
  const referral = scan.cards.find(c => /将推荐转化为奖励/.test(String(c.name || '')));
  ck(!!referral, '素材包含「将推荐转化为奖励」卡片');
  const referralPlan = plan.filter(c => /将推荐转化为奖励/.test(c.name));
  ck(referralPlan.length >= 1 && referralPlan.every(c => c.matched),
    '有积分的推荐卡不再被 scored/kind 判断跳过，且能匹配到侧栏 DOM');
  ck(plan.filter(c => c.matched).length >= 4, '预设项按名称匹配到真实侧栏 DOM');

  /* 反证：反转侧栏 DOM 的完成标记，点击计划不得改变 */
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('a[href]')];
    let flipped = 0;
    for (const el of cards) {
      const badge = el.querySelector('.point_cont, [class*="point_cont"]');
      if (!badge) continue;
      const wrap = badge.closest('.complete, [class*="complete"]');
      if (wrap) wrap.classList.remove('complete');
      else if (badge.parentElement) badge.parentElement.classList.add('complete');
      if (++flipped >= 3) break;
    }
  });
  const scan2 = await page.evaluate(S.SIDEBAR_SCAN_SOURCE);
  const plan2 = CORE.planTaskClicks(presetItems, scan2.cards);
  ck(JSON.stringify(plan2.map(c => c.name)) === JSON.stringify(plan.map(c => c.name)),
    '侧栏 DOM 完成标记反转后计划不变：是否点击只看任务列表');
  ck(JSON.stringify(plan2.map(c => c.idx)) === JSON.stringify(plan.map(c => c.idx)),
    'DOM 扫描只补定位序号，不参与点击决策');

  /* 定位检查：有积分的推荐卡必须能真实定位（这是本轮修复的核心） */
  const aimReferral = await page.evaluate(S.sidebarAimSource(referralPlan[0]));
  ck(!!aimReferral && aimReferral.ok === true,
    '「将推荐转化为奖励」能定位并通过遮挡检查');
  let aimed = 0, checked = 0;
  for (const card of plan2) {
    if (!card.matched) continue;
    checked++;
    const aim = await page.evaluate(S.sidebarAimSource(card));
    if (aim && aim.ok) aimed++;
  }
  ck(checked >= 4 && aimed >= 1,
    '计划里 ' + checked + ' 项参与定位，其中 ' + aimed + ' 项通过遮挡检查');

  await browser.close();
  console.log('\n共 ' + pass + ' 项，通过 ' + pass + ' 项，失败 0 项');
  console.log('任务列表 ' + presetItems.length + ' 张 → 跳过已完成 ' + skippedInList
    + ' 张 → 计划 ' + plan.length + ' 张（唯一过滤条件）');
  console.log('其中「将推荐转化为奖励」→ 已进入计划（v3.6 修复）');
}

main().catch(err => {
  console.error('\n验证失败：' + (err && err.stack || err));
  process.exit(1);
});
