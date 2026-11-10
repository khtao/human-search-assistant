#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DESK_BG = fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8');
const EXT_BG = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'background.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const DESK_POPUP = fs.readFileSync(path.join(ROOT, 'src', 'popup.js'), 'utf8');
const EXT_POPUP = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'popup.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXT_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'manifest.json'), 'utf8'));

let pass = 0;
function ck(condition, message) {
  assert.ok(condition, message);
  pass++;
  console.log('  ✓ ' + message);
}
function block(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, 'missing source marker: ' + start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b >= 0, 'missing end marker: ' + end);
  return source.slice(a, b);
}

console.log('\n拟人搜索助手 · v1.3.7 同步任务定位索引专项（兼容 v1.3.6 索引结构）\n');

// Run the actual index helper in an isolated VM with a deterministic parser fixture.
const helperStart = DESK_BG.indexOf('/* v1.3.7：同步阶段建立任务点击索引。');
const helperEnd = DESK_BG.indexOf('\n/**\n * v2.0：注入到 Rewards 页面读取', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'task index helper block exists');
const helperSource = DESK_BG.slice(helperStart, helperEnd);
const dashHtml = '<h2>每日活动</h2><a data-bi-id="offer-123" id="task-1" aria-label="打开每日测验" target="_blank" href="https://www.bing.com/search?q=quiz&amp;form=ML2X97"><p class="line-clamp-3 text-globalBody2Strong">每日测验</p><p>+10</p></a>';
const earnHtml = '<a data-bi-id="offer-456" href="https://www.bing.com/search?q=earn&amp;form=ML2X97" target="_blank"><p class="line-clamp-3 text-globalBody2Strong">日常活动</p><p>+5</p></a>';
const context = {
  DASHBOARD_URL: 'https://rewards.bing.com/dashboard',
  EARN_URL: 'https://rewards.bing.com/earn',
  SECTION_LABEL: { daily: '每日活动', promo: '日常任务', search: '搜索' },
  URL, Date,
  decodePayload: value => String(value || ''),
  cleanText: value => String(value || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim().slice(0, 160),
  normalizeTaskUrl: value => String(value || '').replace(/&amp;/gi, '&').trim(),
  taskUrlFp: value => {
    try {
      const u = new URL(value);
      return u.hostname.replace(/^www\./i, '') + u.pathname.replace(/\/$/, '') + '|' +
        (u.searchParams.get('q') || '').toLowerCase().replace(/\s+/g, '') + '|' +
        (u.searchParams.get('form') || '').toLowerCase();
    } catch { return String(value || ''); }
  },
  cardsFromRewardsHtml: html => {
    const value = String(html || '');
    if (value.includes('每日测验')) return [{ name: '每日测验', description: '完成测验', points: 10, section: 'daily', completed: false, url: 'https://www.bing.com/search?q=quiz&form=ML2X97', source: 'rsc' }];
    if (value.includes('日常活动')) return [{ name: '日常活动', description: '打开活动', points: 5, section: 'promo', completed: true, earned: 5, url: '', source: 'rsc' }];
    return [];
  },
  console
};
vm.createContext(context);
vm.runInContext(helperSource, context);
const built = vm.runInContext(`buildTaskClickIndex({dash:{ok:true,html:${JSON.stringify(dashHtml)}},earn:{ok:true,html:${JSON.stringify(earnHtml)}}}, [])`, context);
ck(built.schemaVersion === 1 && built.source === 'sync-html', '同步阶段生成 schemaVersion=1 的点击索引');
ck(built.items.length === 2 && built.count === 2, 'Dashboard 与 Earn 的任务均进入同一索引');
const quiz = built.items.find(x => x.name === '每日测验');
const daily = built.items.find(x => x.name === '日常活动');
ck(quiz && quiz.page === '/dashboard' && quiz.points === 10, '索引保存任务页、名称和积分');
ck(quiz && quiz.url === 'https://www.bing.com/search?q=quiz&form=ML2X97', '索引保存解码后的完整任务 href');
ck(quiz && quiz.locator.dataBiId === 'offer-123' && quiz.locator.id === 'task-1', '索引提取 data-bi-id 与 DOM id');
ck(quiz && quiz.locator.ariaLabel === '打开每日测验' && quiz.locator.anchorIndex === 0, '索引提取 aria-label 与页面内锚点序号');
ck(quiz && quiz.target === '_blank' && quiz.locator.title === '每日测验', '索引保留 target 和语义标题');
ck(daily && daily.completed === true && built.pendingCount === 1, '索引保留任务完成状态并统计待办数量');
ck(!/"x"\s*:|"y"\s*:/.test(JSON.stringify(built)), '索引不保存易过期的鼠标坐标');
const wrongPointMatch = vm.runInContext("taskClickBestAnchor({name:'每日测验',description:'',points:10,url:''}, [{href:'https://www.bing.com/search?q=other',title:'每日测验',text:'每日测验 +5',points:5}])", context);
ck(wrongPointMatch === null, '同名但积分不一致的卡片不会被错误绑定');

// Both platforms build and persist the index as part of the same sync transaction.
for (const [label, source] of [['浏览器插件', EXT_BG], ['桌面版', DESK_BG]]) {
  ck(source.includes('const taskClickIndex = buildTaskClickIndex(pages, cards)'), label + '同步时解析任务并建立定位索引');
  ck(source.includes('taskClickIndex: taskClickIndex'), label + '将定位索引与积分/任务数据同批写回');
  ck(source.includes("'taskClickIndex'"), label + '从本地 storage 读取定位索引');
  ck(source.includes("k === 'taskClickIndex' ? (!before || before.updatedAt !== v.updatedAt)"), label + '每次成功同步都会刷新索引时间戳');
}

// Browser extension consumes the index and supplements it with DOM inspection.
const extOverride = block(EXT_BG, 'const humanClickTasksV136Original = humanClickTasks;', '\nchrome.tabs.onRemoved.addListener');
ck(extOverride.includes("load(['taskClickIndex'])"), '浏览器插件点击流程读取同步索引');
ck(EXT_BG.includes("const act = live ? 'human.aim' : 'human.aimIndexed'"), '浏览器插件根据索引与实时 DOM 使用对应定位方式');
ck(EXT_BG.includes("['human.scrollTo',{y}]") && EXT_BG.includes("['human.scrollInner',{idx:sc.idx,y}]"), '浏览器插件找不到目标时从头分段滚动外层及内层列表');
ck(extOverride.includes('collectFlyoutCardsFull') && extOverride.includes('hsaMergeLiveTaskCards'), '浏览器插件合并同步索引及真实 DOM 动态卡片');
ck(extOverride.includes('cdpClickAt(tabId, aim.x, aim.y)'), '浏览器插件最终仍使用 CDP 鼠标输入点击');
ck(extOverride.includes('indexFresh') && extOverride.includes('index.items'), '浏览器插件忽略过期索引并通过实时 DOM 校验任务卡');

// Desktop passes the stored index through preload IPC and resolves it in the main process.
ck(PRELOAD.includes("clickAll: (index, options) => invoke('chrome:task:clickAll', index, options || {})"), '桌面 preload 将任务定位索引传入主进程');
ck(EXT_POPUP.includes("Object.keys(changes).every(key => key === 'taskClickIndex')"), '浏览器插件忽略仅索引变化，避免无意义 UI 重绘');
ck(DESK_POPUP.includes("Object.keys(changes).every(key => key === 'taskClickIndex')"), '桌面弹窗忽略仅索引变化，避免无意义 UI 重绘');
ck(MAIN.includes("if (k === 'taskClickIndex') continue"), 'Electron 主进程不把定位索引变化广播成 UI 数据事件');
ck(DESK_BG.includes('panel.clickAll(clickIndex, { skipCompletedCards: skipCompletedCards, cardClickIntervalSec: clickSettings.cardClickIntervalSec })'), '桌面后台将同步索引交给任务侧栏');
const mainAim = block(MAIN, 'function taskAimIndexedSrc(entry) {', '\n/* CDP 原生输入事件');
ck(mainAim.includes('loc.dataBiId') && mainAim.includes('loc.ariaLabel') && mainAim.includes('expectedHref'), '桌面版优先按 href、data-bi-id、aria-label 定位');
ck(mainAim.includes('elementFromPoint') && mainAim.includes('getBoundingClientRect'), '桌面版定位后重新计算实时坐标并检查遮挡');
const mainHandler = block(MAIN, "ipcMain.handle('chrome:task:clickAll', async (_event, clickIndex, options) => {", "\nipcMain.handle('chrome:panel:hide'");
ck(mainHandler.includes('clickIndex.schemaVersion === 1') && mainHandler.includes('index.items'), '桌面主进程接收并校验索引版本');
ck(mainHandler.includes('locateIndexedCardAcrossScroll') && mainHandler.includes('discoverLiveScoredCards'), '桌面版逐段定位并补充实时 DOM 卡片');
ck(mainHandler.includes('dispatchTaskMouseClick(dbg, aim.x, aim.y)'), '桌面版通过 CDP 鼠标事件完成点击');
ck(mainHandler.includes('taskResultLoadPromise') && mainHandler.includes('loadTaskPage(tv, pageDef.url)'), '桌面版确认任务页响应后恢复原任务页');

ck(PKG.version === '1.3.8', '桌面应用版本升级为 1.3.8');
ck(EXT_MANIFEST.version === '1.3.8', '浏览器插件版本升级为 1.3.8');
ck(PKG.scripts.verify.includes('verify-task-index-v137.js'), '默认回归测试包含同步任务定位索引专项');

console.log('\n共 ' + pass + ' 项，通过 ' + pass + ' 项，失败 0 项');
