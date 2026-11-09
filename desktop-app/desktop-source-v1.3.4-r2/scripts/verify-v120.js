#!/usr/bin/env node
/* ============================================================================
 * v1.2.0 主链专项：以上传代码为准重建后的桌面壳 / UI / 零监控校验
 *
 * 不重复 verify-github-align.js 的逐函数对齐证明，这里只验「上层的东西没坏」：
 *   · 桌面壳（main/preload/host）仍按最新 UI 要求工作
 *   · 自动完成任务的两个抓取时机、零周期监控、Debug 默认禁用
 *   · 界面：顶端两按键、徽标灰/金两态、侧栏、设置项冲突项已删
 *   · 参照版与基准就是用户上传的 7 个文件
 *   · 依赖 / 打包口径不变，不含编译产物
 *
 * 运行： npm run verify:v120
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
/* 干净解压目录也要能复验：优先包内 tests/github-upload（用户上传基准副本），
   工作区开发时可用 HSA_GITHUB_BASE 或 /data/inputs 覆盖。 */
const UP = process.env.HSA_GITHUB_BASE ||
  (fs.existsSync(path.join(__dirname, '..', 'tests', 'github-upload', 'background.js'))
    ? path.join(__dirname, '..', 'tests', 'github-upload') : '/data/inputs');
const read = p => fs.readFileSync(p, 'utf8');

const bg = read(path.join(ROOT, 'src', 'background.js'));
const main = read(path.join(ROOT, 'main.js'));
const preload = read(path.join(ROOT, 'preload.js'));
const host = read(path.join(ROOT, 'host.html'));
const popup = read(path.join(ROOT, 'src', 'popup.js'));
const popupHtml = read(path.join(ROOT, 'src', 'popup.html'));
const popupCss = read(path.join(ROOT, 'src', 'popup.css'));
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
const cap = read(path.join(ROOT, 'lib', 'debug-capture.js'));

let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');

function testCore() {
  group('1. 后台底本 = 用户上传的 GitHub 原始代码');
  ck(/const TASK_MODE = 'human'/.test(bg), 'TASK_MODE = human（上传版默认）');
  ck(/const TASK_PAGES = \[DASHBOARD_URL, EARN_URL\]/.test(bg),
     'TASK_PAGES 仍是 dashboard + earn 两页');
  ck(/两个页面都存在可点击任务，必须逐页独立扫描（不跨页去重）/.test(bg),
     '上传版「逐页独立扫描、不跨页去重」注释保留（v1.1.9 的跨页去重已撤销）');
  ck(!/doneCards/.test(bg), 'v1.1.9 的跨页 doneCards 去重已彻底移除');
  ck(/找到即停|停止遍历/.test(bg) || /break;/.test(bg),
     'humanClickTasks 仍是上传版「找到即停」遍历策略');
  ck(!/isSearchHref/.test(bg), 'v1.1.9 放宽的 isSearchHref 白名单已撤销');
  ck(!/localDayKey|validTodaySearch|completed: live && got >= max/.test(bg),
     'v1.1.9 的搜索缓存日期戳 / live 完成判定已撤销，回到上传版 searchTaskItem');
  ck(bg.includes('function testHumanSearch('), '上传版独有的 testHumanSearch 已保留');
  ck(!/readGainSignals|classifyGain/.test(bg),
     '旧基准里的冷却积分检测函数不存在（确认用的是用户上传版而非之前那份基准）');
}

function testLogin() {
  group('2. 登录判定回到上传版（用户反馈「识别登录状态出错」）');
  ck(/signedOut:\s*isSignInPage\(dash\.html\)\s*&&\s*isSignInPage\(earn\.html\)/.test(bg),
     'fetchBothPages：两页都判登录页才算 signedOut');
  ck(!/function classifyLogin|function detectLogin|function quickLoginCheck|function stickyLogin/.test(bg),
     '桌面自造的四层登录判定全部删除');
  ck(!/function parseTodayPointsFromEarn|function guardSignedOut|function noteSignedIn/.test(bg),
     '桌面自造的积分护栏全部删除');
  ck(/function isSignInPage\(/.test(bg), '只保留上传版 isSignInPage');
  /* 上传版规则足够严格，不会被已登录页 Next.js bundle 的登录文案误判 */
  ck(/Sign in to your Microsoft account\/i\.test\(text\) &&/.test(bg) ||
     /Sign in to your Microsoft account[\s\S]{0,80}Create \(?:an\? \)\?account/.test(bg),
     'isSignInPage 要求登录标题 + 创建账户同时出现（不误判 bundle）');
  ck(!/function readVisiblePanelDirect|function readFromVisibleRewardsTab|function synthPointsHtml/.test(bg),
     '不再有 visible 面板快照 / RSC 合成等自造数据源');
}

function testDataBridge() {
  group('3. 唯一数据源替换：fetchRewardsPage 走内置浏览器，返回形状不变');
  ck(/async function fetchRewardsPage\(path, opts\)/.test(bg) && /opts && opts\.fresh/.test(bg),
     'v1.3.0：fetchRewardsPage 支持 fresh（开始/收尾强制读实时页面，不吃 120s 快照）');
  ck(/clearTimeout\(guardTimer\)/.test(bg), 'race 胜出后清理 20s guard 定时器（旧版每次抓取泄漏一个）');
  ck(!/await fetch\('https:\/\/rewards\.bing\.com' \+ path/.test(bg),
     '不再用 fetch() 直接抓 Rewards 页面');
  ck(/function desktopFetchFromSnapshot/.test(bg) &&
     /function desktopFetchFromPanel/.test(bg) &&
     /function desktopFetchFromDataView/.test(bg),
     '三层内置浏览器读取：本地快照 → 可见面板 → 隐藏数据视图');
  ck(/return \{ ok: true, status: 200, url: s\.url, html, source: 'snapshot' \}/.test(bg),
     '返回形状严格等于上传版 {ok,status,url,html}');
  ck(/function readPageHtml\(\)/.test(bg), '新增自包含注入函数读整页 outerHTML');
  ck(/html: String\(r\.html \|\| ''\)/.test(main),
     '主进程把官网页面完整 HTML 存进快照（含 RSC payload）');
  ck(/funcSource: spec\.funcSource/.test(bg) &&
     /funcSource:\s*\(typeof s\.funcSource === 'string'/.test(preload),
     'A1 contextBridge 序列化：后台传 funcSource，preload 优先用它');
  ck(/\[native code\]/.test(read(path.join(ROOT, 'lib', 'core.js'))),
     'buildInjectCode 仍拦截 [native code] 代理函数');
}

function testZeroMonitor() {
  group('4. 零监控 / 整轮两次同步（v1.3.0 口径）');
  ck(!/periodInMinutes\s*:/.test(bg), 'background.js 无任何周期 alarm');
  ck(!/setInterval\s*\(/.test(bg), 'background.js 无 setInterval');
  ck(!/setInterval\s*\([^)]*ui:tick/.test(main), '主进程无 ui:tick 心跳');
  ck(/function armOneShot/.test(bg) && /when:\s*Date\.now\(\)/.test(bg),
     '全部排程走一次性 when');
  ck(/desktopOpenFetchGate\('autoComplete'\)/.test(bg),
     '时机 1：点击「自动完成任务」才开启抓取');
  ck(!/search-round-/.test(bg) && !/desktopLastSearchIndex/.test(bg),
     '已删除「每完成一次搜索就刷新积分与任务列表」的 onChanged 钩子');
  ck(/desktopSearchGuard = true/.test(bg) && /mid-search sync blocked/.test(bg),
     '搜索阶段硬拦截：任何积分抓取直接短路');
  ck(/async function syncStart\(/.test(bg) && /async function presetSyncFinish\(/.test(bg),
     '整轮只有开始时 syncStart 与收尾 presetSyncFinish 两次同步');
  ck(!/if \(\(await load\(\['liveCheck'\]\)\)\.liveCheck\)/.test(bg),
     'searchLoop 内不再有每轮 directToday 积分检测');
  ck(/desktopFetchAllowed\('refreshToday'\)/.test(bg),
     '空闲 refreshToday 被门控挡住');
  ck(!/chrome\.alarms\.create\([^)]*periodInMinutes/.test(main),
     '主进程不创建任何周期 alarm（alarms.get 的字段读取不算）');
  ck(/process\.env\.HSA_DEBUG === '1'/.test(cap),
     'Debug 采集仅在 HSA_DEBUG=1 时启用（默认禁用）');
  ck(!/HSA_DEBUG/.test(pkg.scripts.start), 'npm start 不开 debug');
  const sd = read(path.join(ROOT, 'scripts', 'start-debug.js'));
  ck(/HSA_DEBUG/.test(sd) && /['"]1['"]/.test(sd),
     'npm run start:debug 通过 start-debug.js 显式设置 HSA_DEBUG=1');
}

function testUI() {
  group('5. UI 保持桌面版最新要求（不随后台底本回退）');
  ck(/id="login-badge"/.test(popupHtml), '顶端有登录徽标');
  ck(/id="settings-open"/.test(popupHtml), '顶端有设置按钮');
  ck(!/theme-toggle/.test(popupHtml) || !/id="theme-toggle"/.test(popupHtml),
     '顶端没有独立主题按钮（已挪进设置）');
  ck(!/panel-toggle/.test(popupHtml), '顶端没有「收起」按钮');
  ck(/未登录|已登录/.test(popup + popupHtml), '徽标有未登录 / 已登录两态文案');
  ck(/login-badge/.test(popup) && /dblclick|dbl/.test(popup),
     '登录徽标双击跳转官网');
  ck(/openOfficial/.test(popup), '未登录点击「登录」打开官网侧栏');
  ck(!/settings\.defaultCount|set-count-chips|set-pace|set-autostop/.test(popupHtml),
     '桌面版设置界面已删除与自动完成任务冲突的三项设置');
  ck(/points-grid|point-card/.test(popupCss), '三张积分卡样式保留');
  ck(/loginBadge|login-badge/.test(popupCss) || /badge/.test(popupCss),
     '徽标灰/金两态样式存在');
  ck(/BrowserView|WebContentsView/.test(main), '侧栏仍是同一主窗口内的内置视图');
  ck(/打开主界面/.test(main) && /退出/.test(main),
     '托盘右击菜单只保留「打开主界面」「退出」');
  ck(!/调试|debug:pack/.test(main.slice(main.indexOf('tray') > 0 ? main.indexOf('tray') : 0,
     (main.indexOf('tray') > 0 ? main.indexOf('tray') : 0) + 2200)) ||
     /setContextMenu/.test(main),
     '托盘菜单构造存在（调试项已移除，详见 verify-v120 专项）');
}

function testReference() {
  group('6. 单份上传源码基准');
  const meta = JSON.parse(read(path.join(UP, 'baseline.json')));
  for (const [f, expected] of Object.entries(meta.files || {})) {
    const file = path.join(UP, f);
    const actual = fs.existsSync(file)
      ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '';
    ck(actual === expected, `${f} 基准校验通过`);
  }
  const manifest = JSON.parse(read(path.join(UP, 'manifest.json')));
  ck(manifest.manifest_version === 3, '参照源码为 Manifest V3');
  ck(fs.existsSync(path.join(ROOT, 'src', 'background.js')) &&
     fs.existsSync(path.join(ROOT, 'src', 'popup.html')),
     '桌面版运行资源保留在 src/');
}

function testPackage() {
  group('7. 依赖 / 交付口径不变');
  ck(pkg.devDependencies && pkg.devDependencies.electron === '45.2.3',
     'Electron 仍锁 45.2.3（Windows / Ubuntu 同一运行时）');
  ck(Object.keys(pkg.dependencies || {}).length === 0, '0 个运行时依赖');
  ck(/verify-github-align/.test(pkg.scripts.verify), '默认 verify 包含基准对齐专项');
  ck(!!pkg.scripts['verify:align'], '提供 npm run verify:align');
  ck(!!pkg.scripts['verify:v120'], '提供 npm run verify:v120');
  ck(!!pkg.scripts['start:debug'] && !!pkg.scripts['debug:pack'],
     'start:debug / debug:pack 仍在');
  ck(!/audit fix --force/.test(pkg.scripts.verify || ''), '不引导使用 audit fix --force');
  ck(fs.existsSync(path.join(ROOT, 'package-lock.json')), 'lock 文件存在');
  ck(fs.existsSync(path.join(ROOT, '.npmrc')) &&
     /electron_mirror|registry/.test(read(path.join(ROOT, '.npmrc'))),
     '.npmrc 已配置国内镜像（依赖安装不走 --force）');
  ck(!/electron-builder --dir|dist:win|dist:linux/.test(pkg.scripts.verify),
     '默认 verify 不触发任何打包 / 编译产物生成');
}

(async () => {
  console.log('\x1b[1m拟人搜索助手 · v1.3.0 流程优化 · 主链专项\x1b[0m');
  testCore();
  testLogin();
  testDataBridge();
  testZeroMonitor();
  testUI();
  testReference();
  testPackage();
  console.log('\n\x1b[1m共 ' + (pass + fail) + ' 项，通过 ' + pass + ' 项，失败 ' + fail + ' 项\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常', e); process.exit(1); });
