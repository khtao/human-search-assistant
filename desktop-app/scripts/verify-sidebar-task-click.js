#!/usr/bin/env node
/* ============================================================================
 * v1.3.8-s2 · 侧栏积分卡片点击专项验证
 *
 * 用上传的测试侧栏（保存页 panelflyout.html）跑真实的 DOM 识别逻辑，断言：
 *   · 自动开始先同步积分；积分与任务都完成 → 零动作（默认）
 *   · 「不跳过已完成任务卡」默认关闭 = 默认跳过已完成卡；开启后即使全部完成
 *     仍发起点击流程，点全部积分卡
 *   · 开启跳过（默认）：依次点击 即将到来的喜剧活动、云形成类型
 *   · 开启不跳过：依次点击 7 张积分卡（含已完成）
 *   · 点哪张只取决于主界面任务状态：故意把侧栏 DOM 的完成标记反过来，
 *     点击清单必须保持不变
 *   · 点击流程开启主动重新加载侧栏页面、结束关闭页面
 *   · 搜索配额、推荐、兑换、推广、签到进度、0 分卡被智能排除
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
/** 设置项 → 内部点击指令：默认关闭「不跳过」= 跳过已完成卡 */
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
  console.log('\n拟人搜索助手 · 侧栏积分卡片点击专项（v1.3.8-s2）\n');

  section('1. 设置项反转与零动作短路');
  ck(BG.includes('notSkipCompletedCards: false') && POP.includes('notSkipCompletedCards: false'),
    '设置项改为「不跳过已完成任务卡」，默认关闭（默认跳过已完成卡）');
  ck(HTML.includes('不跳过已完成任务卡') && HTML.includes('id="set-not-skip-completed"')
      && !HTML.includes('id="set-skip-completed"'),
    '设置界面文案与控件改为不跳过已完成任务卡');
  ck(POP.includes("saveSettings({ notSkipCompletedCards: e.target.checked })")
      && POP.includes("'set-not-skip-completed').checked"),
    '设置读写使用新字段 notSkipCompletedCards');
  ck(BG.includes('const skipCompletedCards = !notSkipCompletedCards;'),
    '内部点击指令由新设置反转推导：关闭=跳过已完成');
  ck(BG.includes('sync.allDone && !o.force && !notSkipCompletedCards'),
    '同步后积分与任务都完成 → 零动作，不做任何其他动作');
  ck(BG.includes('sync.allDone && notSkipCompletedCards'),
    '开启不跳过时，即使积分和任务都完成也继续发起点击流程');
  ck(BG.includes('const sync = await syncStart(token, o.cap);')
      && BG.indexOf('await syncStart(token, o.cap)') < BG.indexOf('sync.allDone && !o.force'),
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
  ck(handler.includes('SidebarCards.planSidebarClicks(merged, skipCompletedCards)'),
    '按设置生成真实点击计划');
  ck(handler.includes('syncSummary') && handler.includes('mergeSidebarWithSync')
      && handler.includes('matchedMainUi'),
    '完成状态取自主界面任务状态（todayTasks / taskClickIndex）');
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
  ck(BG.includes("panel.clickAll(clickIndex, { skipCompletedCards: skipCompletedCards, cardClickIntervalSec: clickSettings.cardClickIntervalSec })"),
    '后台保留跳过指令与点击间隔透传');
  ck(!!PKG.scripts && /verify-sidebar-task-click\.js/.test(PKG.scripts.verify || ''),
    '默认回归链包含侧栏点击专项');

  section('3. 纯函数：设置映射与主界面状态优先');
  const synthetic = [
    { idx: 0, name: 'A', points: 10, completed: false, scored: true },
    { idx: 1, name: 'B', points: 5, completed: true, scored: true },
    { idx: 2, name: '搜索卡', points: 0, completed: false, scored: false, kind: 'search' }
  ];
  ck(skipFromSetting(false) === true && skipFromSetting(true) === false,
    '默认关闭不跳过 = 跳过已完成；开启 = 不跳过');
  ck(JSON.stringify(names(S.planSidebarClicks(synthetic, true))) === JSON.stringify(['A']),
    '跳过开启时只点未完成的积分卡');
  ck(JSON.stringify(names(S.planSidebarClicks(synthetic, false))) === JSON.stringify(['A', 'B']),
    '不跳过开启时点全部积分卡（含已完成）');
  /* 侧栏说已完成、主界面说未完成（或反之）：一律以主界面为准 */
  const conflict = S.mergeSidebarWithSync(
    [{ idx: 0, name: 'A', points: 10, completed: true, scored: true },
     { idx: 1, name: 'B', points: 5, completed: false, scored: true }],
    { items: [{ name: 'A', points: 10, earned: 0, completed: false },
              { name: 'B', points: 5, earned: 5, completed: true }] }, null);
  ck(conflict[0].domCompleted === true && conflict[0].completed === false,
    '侧栏显示已完成但主界面未完成 → 判为未完成（仍会点击）');
  ck(conflict[1].domCompleted === false && conflict[1].completed === true,
    '侧栏显示未完成但主界面已完成 → 判为已完成（默认跳过）');
  ck(conflict.every(c => c.completed === c.syncedCompleted),
    '完成决策字段与同步判定完全一致，不受侧栏 DOM 影响');

  section('4. 上传测试侧栏的动态验证');
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
  const scored = scan.cards.filter(c => c.scored);
  ck(JSON.stringify(names(scored)) === JSON.stringify(EXPECT_ALL),
    '识别出 7 张真正提供积分的卡片，顺序与预期一致');

  /* 用主界面任务状态（同步结果）驱动点击清单 */
  const mainUi = mainUiTaskState();
  const merged = S.mergeSidebarWithSync(scan.cards, mainUi, null);
  const scoredMerged = merged.filter(c => c.scored);
  ck(scoredMerged.every(c => c.syncMatched) && scoredMerged.length === 7,
    '7 张积分卡都能匹配到主界面任务状态');
  const defaultPlan = S.planSidebarClicks(merged, skipFromSetting(false));
  const allPlan = S.planSidebarClicks(merged, skipFromSetting(true));
  ck(JSON.stringify(names(defaultPlan)) === JSON.stringify(EXPECT_SKIP_ON),
    '默认关闭不跳过：仅真实点击 即将到来的喜剧活动、云形成类型');
  ck(JSON.stringify(names(allPlan)) === JSON.stringify(EXPECT_ALL),
    '开启不跳过：依次点击 7 张积分卡（含已完成）');

  /* 积分与任务全部完成：默认零动作，开启不跳过仍发起点击流程 */
  const allDone = mainUiTaskState({ allDone: true });
  const mergedDone = S.mergeSidebarWithSync(scan.cards, allDone, null);
  ck(S.planSidebarClicks(mergedDone, skipFromSetting(false)).length === 0,
    '积分和任务全部完成时默认不点任何卡片（零动作）');
  ck(JSON.stringify(names(S.planSidebarClicks(mergedDone, skipFromSetting(true)))) === JSON.stringify(EXPECT_ALL),
    '开启不跳过时即使全部完成仍点击全部 7 张卡片');

  /* 反证：故意把侧栏 DOM 的完成标记反过来，点击清单不得改变 */
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('a.block')];
    const byName = n => cards.find(a => (a.innerText || a.textContent || '').includes(n));
    /* 把未完成的「即将到来的喜剧活动」在侧栏 DOM 上伪装成已完成 */
    const a = byName('即将到来的喜剧活动');
    if (a) {
      const pc = a.querySelector('.point_cont');
      if (pc) {
        pc.parentElement.classList.add('complete');
        const sp = pc.querySelector('.shortPoint') || pc;
        sp.setAttribute('aria-label', '10 添加到帐户的积分');
        sp.textContent = '10';
        const svg = pc.querySelector('svg');
        if (svg) svg.setAttribute('class', 'checkMark');
      }
    }
    /* 把已完成的「探险火星」在侧栏 DOM 上伪装成未完成 */
    const b = byName('探险火星');
    if (b) {
      b.querySelectorAll('.complete').forEach(e => e.classList.remove('complete'));
      const pc = b.querySelector('.point_cont');
      if (pc) {
        const sp = pc.querySelector('.shortPoint') || pc;
        sp.setAttribute('aria-label', '15 积分');
        sp.textContent = '15';
        const svg = pc.querySelector('svg');
        if (svg) svg.setAttribute('class', '');
      }
    }
  });
  const scan2 = await page.evaluate(S.SIDEBAR_SCAN_SOURCE);
  const domA = scan2.cards.find(c => c.name === '即将到来的喜剧活动');
  const domB = scan2.cards.find(c => c.name === '探险火星');
  ck(!!domA && !!domB && domA.completed === true && domB.completed === false,
    '侧栏 DOM 完成标记已被成功反转（用于反证）');
  const merged2 = S.mergeSidebarWithSync(scan2.cards, mainUi, null);
  ck(JSON.stringify(names(S.planSidebarClicks(merged2, skipFromSetting(false)))) === JSON.stringify(EXPECT_SKIP_ON)
      && JSON.stringify(names(S.planSidebarClicks(merged2, skipFromSetting(true)))) === JSON.stringify(EXPECT_ALL),
    '侧栏显示反转后点击清单不变：点哪张只取决于主界面任务状态');
  const a2 = merged2.find(c => c.name === '即将到来的喜剧活动');
  const b2 = merged2.find(c => c.name === '探险火星');
  ck(a2.domCompleted === true && a2.completed === false && b2.domCompleted === false && b2.completed === true,
    '侧栏显示与决策字段分离：domCompleted 仅诊断，completed 来自主界面');

  const excluded = scan2.cards.filter(c => !c.scored);
  const kinds = new Set(excluded.map(c => c.kind));
  for (const k of ['search', 'referral', 'redeem', 'promotion', 'progress']) {
    ck(kinds.has(k), '智能排除的卡片类型包含 ' + k);
  }
  const zeroPointReferral = excluded.find(c => c.name === '将推荐转化为奖励');
  ck(!!zeroPointReferral && zeroPointReferral.points === 0 && zeroPointReferral.kind === 'referral',
    '0 分「将推荐转化为奖励」被识别为推荐卡并排除');
  const searchCounter = excluded.find(c => /在\s*MICROSOFT\s*必应上搜索/i.test(c.name));
  ck(!!searchCounter && searchCounter.kind === 'search',
    '「在 Microsoft 必应上搜索」搜索配额卡被排除');
  ck(!scoredMerged.some(c => c.points <= 0), '点击计划里没有 0 分或负分卡片');

  const plan = S.planSidebarClicks(merged2, skipFromSetting(true));
  let aimed = 0;
  for (const card of plan) {
    const aim = await page.evaluate(S.sidebarAimSource(card));
    if (aim && aim.ok) aimed++;
  }
  ck(aimed === plan.length, '全部 ' + plan.length + ' 张待点卡片都能定位并通过遮挡检查');

  await browser.close();
  console.log('\n共 ' + pass + ' 项，通过 ' + pass + ' 项，失败 0 项');
  console.log('默认（跳过已完成）→ ' + EXPECT_SKIP_ON.join(' → '));
  console.log('开启不跳过       → ' + EXPECT_ALL.join(' → '));
}

main().catch(err => {
  console.error('\n验证失败：' + (err && err.stack || err));
  process.exit(1);
});
