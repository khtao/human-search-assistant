#!/usr/bin/env node
/* ============================================================================
 * v1.3.8 专项：积分日历 / 语言顺序 / 详细进度 / 桌面启动与静默
 *
 * 静态一致性 + vm 实跑新增的「进度详情 / 积分历史」写入函数。
 * 运行： npm run verify:v138
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DESK_HTML = read('src/popup.html');
const EXT_HTML = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'popup.html'), 'utf8');
const DESK_POP = read('src/popup.js');
const EXT_POP = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'popup.js'), 'utf8');
const DESK_CSS = read('src/popup.css');
const EXT_CSS = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'popup.css'), 'utf8');
const DESK_BG = read('src/background.js');
const EXT_BG = fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'background.js'), 'utf8');
const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const LITE = read('lib/electron-lite.js');
const PKG = JSON.parse(read('package.json'));
const LOCK = JSON.parse(read('package-lock.json'));
const EXT_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'edge-extension', 'manifest.json'), 'utf8'));
const DESK_MANIFEST = JSON.parse(read('src/manifest.json'));

let pass = 0, fail = 0;
function ck(condition, message) {
  if (condition) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + message); }
  else { fail++; console.log('  \x1b[31m✗ ' + message + '\x1b[0m'); }
}
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');

function settingsBlock(html) {
  const a = html.indexOf('<section id="settings"');
  assert.ok(a >= 0, 'settings section exists');
  const b = html.indexOf('</section>', a);
  assert.ok(b > a, 'settings section closes');
  return html.slice(a, b + '</section>'.length);
}
function langOrder(html) {
  const block = settingsBlock(html);
  const a = block.indexOf('id="set-lang"');
  assert.ok(a >= 0, 'set-lang group exists');
  const b = block.indexOf('</div>', a);
  return [...block.slice(a, b).matchAll(/data-value="(zh|en|system)"/g)].map(m => m[1]);
}
/** 按大括号配对抽取顶层具名函数（仅用于本专项的新增函数）。 */
function extractFn(src, name) {
  const m = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm').exec(src);
  assert.ok(m, 'missing function ' + name);
  const i = m.index;
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced function ' + name);
}

console.log('\n拟人搜索助手 · v1.3.8 升级专项\n');

/* -------------------------------------------------- 1. 语言顺序与跨端一致 */
group('1. 语言 / Language 顺序与设置页一致性');
const wantOrder = ['zh', 'en', 'system'];
for (const [label, html] of [['桌面版', DESK_HTML], ['浏览器插件', EXT_HTML]]) {
  ck(JSON.stringify(langOrder(html)) === JSON.stringify(wantOrder),
     label + ' 语言选项顺序为 中文 → 英文 → 跟随系统');
  ck(settingsBlock(html).includes('data-i18n="lang.zh"') &&
     settingsBlock(html).includes('data-i18n="lang.en"'),
     label + ' 中文 / 英文选项走双语字典');
}
const stripDesktopGroup = html => {
  let s = settingsBlock(html);
  const a = s.indexOf('      <!-- v1.3.8 · 桌面版专有');
  if (a >= 0) {
    const g = s.indexOf('id="desktop-group"', a);
    const b = s.indexOf('      </div>', g);
    if (g >= 0 && b > g) s = s.slice(0, a) + s.slice(b + '      </div>'.length);
  }
  return s.replace(/\s+/g, ' ').trim();
};
ck(stripDesktopGroup(DESK_HTML) === stripDesktopGroup(EXT_HTML),
   '桌面版与 Edge 设置页面共有部分 HTML 结构完全一致');
ck(settingsBlock(DESK_HTML).includes('id="desktop-group"') &&
   !settingsBlock(EXT_HTML).includes('id="desktop-group"'),
   '桌面专属组只在桌面版显示');
for (const [label, pop] of [['桌面版', DESK_POP], ['浏览器插件', EXT_POP]]) {
  ck(pop.includes("'lang.zh': '中文'") && pop.includes("'lang.en': '英文'") &&
     pop.includes("'lang.zh': 'Chinese'") && pop.includes("'lang.en': 'English'"),
     label + ' 中英字典都补齐 lang.zh / lang.en');
}

/* ------------------------------------------------------------ 2. 积分日历 */
group('2. 积分赚取日历（日 / 周 / 月汇总，格子不显示日期）');
for (const [label, html] of [['桌面版', DESK_HTML], ['浏览器插件', EXT_HTML]]) {
  const block = settingsBlock(html);
  for (const id of ['calendar-group', 'cal-prev', 'cal-next', 'cal-range',
                    'cal-total', 'cal-hero-label', 'cal-mode', 'cal-weekdays',
                    'cal-grid', 'cal-summary']) {
    ck(block.includes('id="' + id + '"'), label + ' 日历控件 ' + id + ' 存在');
  }
  ck(/data-value="day"[\s\S]{0,160}data-value="week"[\s\S]{0,160}data-value="month"/.test(block),
     label + ' 提供 日 / 周 / 月 三种汇总粒度');
}
for (const [label, pop] of [['桌面版', DESK_POP], ['浏览器插件', EXT_POP]]) {
  ck(pop.includes("calMode === 'day'") && pop.includes("calMode === 'week'") &&
     pop.includes("calMode === 'month'"), label + ' 三种汇总分支齐备');
  ck(pop.includes('vals.reduce((a, b) => a + b, 0)') && pop.includes("t('calendar.summary'"),
     label + ' 汇总行计算合计 / 平均 / 峰值');
  ck(pop.includes("chrome.storage.local.get(['pointsHistory', 'pointsSummary'])"),
     label + ' 日历读取积分历史与当日积分');
  ck(pop.includes("'calendar.hoverTip':") && pop.includes("'calendar.cellTip':") &&
     pop.includes("'calendar.noPointsTip':"),
     label + ' 格子不显示日期、说明与当日详情都走悬停提示');
  ck(pop.includes("cal-blank") && pop.includes("cal-past-empty") &&
     pop.includes("k > todayK") && pop.includes("cal-today"),
     label + ' 未来不显示方块、过去无积分灰色、今日细描边');
  ck(pop.includes("cell.textContent = value == null ? '·' : ptsText(value)") &&
     !/\.textContent\s*=\s*dkey\(/.test(pop),
     label + ' 日历格子只输出积分，不输出日期数字');
  ck(pop.includes("heroTotal.textContent = ptsText(total)") &&
     pop.includes("'calendar.totalLabel'") && pop.includes("'calendar.yearLabel'"),
     label + ' 收益日历式大数字主指标（月 / 年累计）');
  ck(pop.includes("'calendar.weekLabel'") && pop.includes("'calendar.monthLabel'"),
     label + ' 周 / 月汇总格使用极简角标');
  ck(pop.includes("renderPointsCalendar();") && pop.includes("changes.pointsHistory"),
     label + ' 历史变化后自动重绘日历');
}
for (const [label, css] of [['桌面版', DESK_CSS], ['浏览器插件', EXT_CSS]]) {
  ck(css.includes('.cal-grid.cal-day') && css.includes('.cal-grid.cal-week') &&
     css.includes('.cal-grid.cal-month'), label + ' 日历三种布局样式齐备');
  ck(css.includes('aspect-ratio: 1 / 1') && css.includes('border-radius: 10px') &&
     css.includes('border: 0'),
     label + ' 三种视图统一为无边框圆角正方形');
  ck(css.includes('--cal-has-bg') && css.includes('.cal-cell.cal-has') &&
     css.includes('box-shadow: none'), label + ' 有积分淡蓝色、扁平无阴影');
  ck(css.includes('.cal-cell.cal-past-empty') && css.includes('--cal-gray-bg'),
     label + ' 过去无积分灰色方块');
  ck(css.includes('.cal-cell.cal-blank { visibility: hidden;'),
     label + ' 未来日期不渲染方块');
  ck(css.includes('.cal-hero {') && css.includes('.cal-total {') &&
     css.includes('font-size: 28px'),
     label + ' 支付宝收益日历的大数字主指标');
  ck(css.includes('.hover-tip {') && css.includes('position: fixed'),
     label + ' 自定义悬停浮层（不受设置页滚动裁剪）');
  ck(css.includes('.status.activity {') && css.includes('text-overflow: ellipsis'),
     label + ' 详情复用状态行且长句可悬停看全文');
  ck(!css.includes('.cal-note') && !css.includes('.cal-unit') &&
     !css.includes('.cal-dots'), label + ' 去掉每格单位 / 圆点串 / 页内小字注释');
  ck(!css.includes('.status-detail'), label + ' 不再有独立详情文本框样式');
}
for (const [label, bg] of [['桌面版', DESK_BG], ['浏览器插件', EXT_BG]]) {
  ck(bg.includes('async function desktopActivityRecordHistory') &&
     bg.includes("await store({ pointsHistory: hist })"),
     label + ' 每次同步写入当日积分历史');
  ck(bg.includes('while (keys.length > 400) delete hist[keys.shift()]'),
     label + ' 积分历史有 400 天上限');
}

/* ------------------------------------------- 3. 进度详情数据结构（vm 实跑） */
group('3. 进度详情 / 积分历史数据结构实跑');
const mem = Object.create(null);
const writes = [];
const store = obj => { writes.push(obj); Object.assign(mem, obj); return Promise.resolve(); };
const load = keys => {
  const out = {};
  for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in mem) out[k] = mem[k];
  return Promise.resolve(out);
};
const ctx = vm.createContext({
  store, load, Date, Number, Math, String, Object, Array, Promise, JSON,
  isFinite: Number.isFinite, console,
  desktopActivityLast: { key: '', at: 0 }
});
for (const fn of ['desktopActivityFmt', 'desktopActivityDayKey',
                  'desktopActivityWrite', 'desktopActivityRecordHistory']) {
  vm.runInContext(extractFn(DESK_BG, fn), ctx);
}
(async () => {
  const fixedDay = vm.runInContext('desktopActivityDayKey(new Date(2026, 10, 9))', ctx);
  ck(fixedDay === '2026-11-09', '本地日期键格式 YYYY-MM-DD（实际 ' + fixedDay + '）');
  const day = vm.runInContext('desktopActivityDayKey()', ctx);
  await vm.runInContext(
    "desktopActivityWrite({ state: 'syncing', zh: ['正在同步', '下一步：点击卡片'], " +
    "en: ['Syncing', 'Next: click cards'], page: '/dashboard, /earn', card: '每日活动', " +
    "query: '天气', delayMs: 3500, next: 'click' })", ctx);
  const a = mem.activityDetail;
  ck(!!a && a.state === 'syncing' && a.zh === '正在同步 · 下一步：点击卡片' &&
     a.en === 'Syncing · Next: click cards', '详情为单行简洁文本（数组按 · 合并）');
  ck(a.page === '/dashboard, /earn' && a.card === '每日活动' && a.query === '天气' &&
     a.delayMs === 3500 && a.next === 'click', '页面 / 卡片 / 搜索词 / 延迟 / 下一步字段齐备');
  ck(a.until === a.at + 3500, '延迟动作写入 until 终点供倒计时使用');
  const before = writes.length;
  await vm.runInContext(
    "desktopActivityWrite({ state: 'syncing', delayMs: 3500, " +
    "zh: ['正在同步', '下一步：点击卡片'], " +
    "en: ['Syncing', 'Next: click cards'] })", ctx);
  ck(writes.length === before, '相同详情 1 秒内去重，避免高频写盘');
  await vm.runInContext(
    "desktopActivityRecordHistory({ pointsSummary: { today: 257, available: 20192, claimable: 0 } })", ctx);
  ck(mem.pointsHistory && mem.pointsHistory[day].today === 257 &&
     mem.pointsHistory[day].available === 20192, '首次同步落下当日积分 257 / 可用 20192');
  await vm.runInContext(
    "desktopActivityRecordHistory({ pointsSummary: { today: 200, available: 20192, claimable: 0 } })", ctx);
  ck(mem.pointsHistory[day].today === 257, '同日积分不回退（取最大值）');
  await vm.runInContext(
    "desktopActivityRecordHistory({ pointsSummary: { today: 300, available: 20192, claimable: 0 } })", ctx);
  ck(mem.pointsHistory[day].today === 300, '同日积分增长时更新到 300');

  /* ------------------------------------------------- 4. 详细进度显示与埋点 */
  group('4. 进度圆圈下方详细文本与埋点');
  for (const [label, html] of [['桌面版', DESK_HTML], ['浏览器插件', EXT_HTML]]) {
    ck(!html.includes('status-detail') && html.includes('id="status-text"'),
       label + ' 不新增文本框，详情复用圆圈下方原状态行');
    ck(html.indexOf('id="status-text"') < html.indexOf('class="points-grid"'),
       label + ' 状态行仍位于进度圆圈下方、积分卡上方');
  }
  for (const [label, pop] of [['桌面版', DESK_POP], ['浏览器插件', EXT_POP]]) {
    ck(pop.includes("'activityDetail', 'pointsHistory'"), label + ' KEYS 包含详情与历史');
    ck(pop.includes('function activityLine(d, phaseCls)') &&
       pop.includes("lang === 'en' ? a.en : a.zh"),
       label + ' 按界面语言选择中/英详情文本');
    ck(pop.includes('const act = activityLine(d, cls);') &&
       pop.includes("setStatus(act.text, act.cls, false)"),
       label + ' 详情写入原状态行（绿色字同一位置）');
    ck(pop.includes("green ? 'completed all-done'"), label + ' 同步完成沿用绿色字样式');
    ck(pop.includes('function scheduleCountdown(until, template, cls)') &&
       pop.includes("template.split('{s}').join(String(left))") &&
       pop.includes('stopCountdown()'),
       label + ' 延迟动作显示倒计时且到点自动停止');
    ck(pop.includes("if (!d.running && Date.now() - a.at > 12000) return null;"),
       label + ' 空闲后详情自动回落为常规状态文字');
    ck(pop.includes("cls: cls + ' activity'") &&
       pop.includes('statusEl.title = act.text'),
       label + ' 详情状态行排版放松，长句悬停可读全文');
  }
  for (const [label, bg] of [['桌面版', DESK_BG], ['浏览器插件', EXT_BG]]) {
    for (const state of ["'syncing'", "'synced'", "'opening'",
                         "'clicking'", "'waiting'", "'searching'", "'autoStart'"]) {
      ck(bg.includes("state: " + state), label + ' 后台埋点 ' + state);
    }
    ck(bg.includes("'syncFailed'"), label + ' 同步失败状态已登记');
    ck(bg.includes("skipped ? 'allDone' : 'done'"), label + ' 全完成 / 正常结束状态齐备');
    ck(bg.includes('正在同步 · /dashboard + /earn 读取积分') &&
       bg.includes("'同步完成 · 今日 '") && bg.includes("' 分 / 可用 '") &&
       bg.includes("'打开页面 · ' + desktopActivityShort(url)") &&
       bg.includes('点击卡片 · ') && bg.includes('{s} 秒后继续 · 下一步：核对积分') &&
       bg.includes("'搜索 ' +") && bg.includes('关键词「') && bg.includes('下一步：'),
       label + ' 稍详细但仍单行：页面 / 卡片 / 延迟 / 搜索 / 下一步 / 积分');
  ck(bg.includes('全部完成 · 今日任务已做满') &&
       bg.includes('积分与任务状态已刷新'),
       label + ' 收尾文案补充任务状态信息');
    ck(bg.includes('until: delayMs ? now + delayMs : 0') &&
       bg.includes('delayMs: wait') && bg.includes('chrome.storage.onChanged.addListener'),
       label + ' 等待倒计时终点与搜索信息由监听写入');
    ck(!bg.includes('silentRun'), label + ' 后台完全不感知静默开关，流程与正常模式一致');
    ck(/const desktopActivityOrigSync = (desktopSyncRewards|syncRewardsUnified)/.test(bg),
       label + ' 统一同步被包装（函数体未改）');
    ck(bg.includes('const desktopActivityOrigAuto = runAutoComplete') &&
       bg.includes('const desktopActivityOrigCards = completePendingTaskCards'),
       label + ' 自动任务与卡片阶段被包装');
  }
  ck(MAIN.includes("'点击 ' + (page.clicked + 1) + '/' + pageEntries.length") &&
     MAIN.includes("'打开页面 · Rewards '") &&
     MAIN.includes("' · 等 ' + TASK_CLICK_SETTLE_MS + 'ms'") && MAIN.includes('下一步：'),
     '桌面主进程写出卡片序号 / 卡片名 / 页面 / 延迟与下一步');
  ck(MAIN.includes('function desktopActivityPush') &&
     MAIN.includes("broadcast('storage.onChanged', [{ activityDetail:"),
     '主进程详情与后台共用 activityDetail 并广播重绘');

  /* --------------------------------------------- 5. 桌面启动项与静默运行 */
  group('5. 桌面版开机自启与静默完成任务（默认关闭）');
  ck(PRELOAD.includes("invoke('chrome:app:autoLaunch', !!enabled)") &&
     PRELOAD.includes('desktopApp,'), 'preload 暴露开机自启 IPC 与 desktopApp');
  ck(MAIN.includes("ipcMain.handle('chrome:app:autoLaunch'") &&
     MAIN.includes('app.setLoginItemSettings({ openAtLogin: on, openAsHidden: false })') &&
     MAIN.includes("ipcMain.handle('chrome:app:autoLaunch:get'"),
     '主进程通过 Electron 登录项 API 设置 / 读取开机自启');
  ck(LITE.includes('setLoginItemSettings') && LITE.includes('getLoginItemSettings'),
     '无头验证替身同样提供登录项 API');
  ck(MAIN.includes("if (typeof state.silentRun !== 'boolean') state.silentRun = false;") &&
     MAIN.includes("if (typeof state.launchAtLogin !== 'boolean') state.launchAtLogin = false;"),
     '静默运行与开机自启默认关闭');
  ck(settingsBlock(DESK_HTML).includes('id="set-auto-launch"') &&
     settingsBlock(DESK_HTML).includes('id="set-silent-run"'),
     '桌面版设置页提供开机自启与静默完成');
  ck(!EXT_HTML.includes('set-auto-launch') && !EXT_HTML.includes('set-silent-run') &&
     !settingsBlock(EXT_HTML).includes('desktop-group'),
     '浏览器插件设置页不显示桌面版专属功能');
  for (const [label, pop] of [['桌面版', DESK_POP], ['浏览器插件', EXT_POP]]) {
    ck(pop.includes('async function loadDesktopPrefs') &&
       pop.includes('chrome.desktopApp') && pop.includes('api.setAutoLaunch(v)') &&
       pop.includes('chrome.storage.local.set({ silentRun: v })'),
       label + ' 桌面能力存在时写入开机自启与静默开关');
    ck(pop.includes('if (!auto || !silent) return;') &&
       pop.includes("if (!api || typeof api.setAutoLaunch !== 'function') return;"),
       label + ' 无桌面 DOM / 无桌面能力时静默跳过，不报错');
    ck(pop.includes('silent.checked = !!s.silentRun'), label + ' 静默开关回显默认关闭状态');
  }
  ck(MAIN.includes('function desktopSilentRun()') &&
     MAIN.includes('state.silentRun === true && desktopQuietRun()'),
     '静默判定只在「手动开启 + 自动运行期间」生效');
  ck(MAIN.includes('desktopSilentRun() && !panelActionActive()') &&
     MAIN.includes('x: -3000, y: -3000, width: 1180, height: 820'),
     '静默时官网侧栏留在离屏视口；用户显式动作仍正常显示');
  ck(MAIN.includes('function desktopActivityPush') &&
     MAIN.includes("state: 'clicking', page: pageDef.url, card: cardName") &&
     !MAIN.includes('if (desktopSilentRun()) return;'),
     '静默模式下卡片 / 页面 / 下一步详情照常写入，不跳过任何详情');
  ck(MAIN.includes('if (desktopSilentRun()) {\n    taskView.setBounds({ x: -3400'),
     '静默时任务视图离屏但保留可点击视口');
  ck(MAIN.includes('if (desktopSilentRun()) {\n      sideView.setBounds({ x: -3000'),
     '窗口 resize 时也不把离屏侧栏拉回可见区');

  /* ------------------------------------------------- 6. 版本与回归入口 */
  group('6. 版本与回归入口');
  ck(PKG.version === '1.3.8' && LOCK.version === '1.3.8' &&
     LOCK.packages[''].version === '1.3.8', '桌面 package / lock 统一为 1.3.8');
  ck(EXT_MANIFEST.version === '1.3.8' && DESK_MANIFEST.version === '1.3.8',
     '两个 manifest 统一为 1.3.8');
  ck(PKG.scripts.verify.includes('verify-v138.js') &&
     fs.existsSync(path.join(ROOT, '..', 'CHANGELOG_V1.3.8.md')),
     '默认回归包含 v1.3.8 专项且交付含变更说明');
  ck(DESK_BG.includes('v1.3.8 · 精简运行详情') && EXT_BG.includes('v1.3.8 · 精简运行详情'),
     '两端后台都标注 v1.3.8 新增模块');
  const added = [...DESK_BG.matchAll(/^(?:async\s+)?function (desktopActivity\w+)\(/gm)].map(m => m[1]);
  ck(added.length >= 5, '新增函数全部以 desktopActivity 前缀命名（基准对齐口径）');

  group('7. 设置页小字注释全部改为悬停提示');
  for (const [label, html] of [['桌面版', DESK_HTML], ['浏览器插件', EXT_HTML]]) {
    ck(!html.includes('<small') && !html.includes('cal-note') &&
       !html.includes('auto-disabled-hint'),
       label + ' 设置页不再有常驻小字注释');
    ck(html.includes('data-tip-role="hint"') && html.includes('data-i18n-title='),
       label + ' 说明文字改为 data-i18n-title 悬停提示（随语言切换）');
    ck(html.includes('id="cal-grid"') &&
       /id="cal-grid"[\s\S]{0,260}data-i18n-title="calendar.hoverTip"/.test(settingsBlock(html)),
       label + ' 日历说明挂在日历容器悬停提示上');
  }
  for (const [label, pop] of [['桌面版', DESK_POP], ['浏览器插件', EXT_POP]]) {
    ck(pop.includes('function initHoverTips()') && pop.includes('MutationObserver') &&
       pop.includes("attributeFilter: ['title']"),
       label + ' 原生 title 被同步为自定义浮层，语言切换后自动刷新');
    ck(pop.includes("closestTip(e.target)") && pop.includes("window.addEventListener('scroll'"),
       label + ' 悬停浮层用事件委托并随滚动收起');
    ck(pop.includes("'calendar.hoverTip'") && pop.includes("'calendar.cellTip'"),
       label + ' 悬停文案使用双语字典');
    ck(pop.includes("setTimeout(() => { if (el.textContent === text) el.hidden = true; }, 4000)"),
       label + ' 操作反馈小字 4 秒后自动收起，不常驻');
  }

  console.log('\n\x1b[1m共 ' + (pass + fail) + ' 项，通过 ' + pass + ' 项，失败 ' + fail + ' 项\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error('\x1b[31m验证异常：' + String(err && err.stack || err) + '\x1b[0m');
  process.exit(1);
});
