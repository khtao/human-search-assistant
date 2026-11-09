#!/usr/bin/env node
/* ============================================================================
 * v1.3.1 · 状态显示 / 统一同步 / 刷新体验 / 任务列表 / 不抢焦点 专项
 *
 * 与静态字符串检查不同：把 src/background.js 全文放进 vm 沙箱，用真实夹具
 * （纯中文官网 DOM + JS bundle 登录文案干扰）实跑 desktopSyncRewards，
 * 复现用户反馈的三个症状并证明修复：
 *   ① 有 20,192 分 + 完整任务列表却显示「未登录」
 *   ② 点击登录按键后状态对了、任务列表却只有每日活动 / 只剩一条估算
 *   ③ 刷新时 UI 被中途写空、多次重绘
 * 另验证：所有刷新入口同一套逻辑、运行态不抢系统焦点、消息分发不吞监听器。
 *
 * 运行： npm run verify:v131
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const bgSource = fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(ROOT, 'src', 'popup.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const fixture = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rewards-dashboard.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* ------------------------------------------------------- 真实官网可见快照 */
/* 形状与主进程 readVisibleNow() 完全一致：积分 + 卡片 + 可见文本登录态。 */
const visibleSnap = {
  at: Date.now(), url: 'https://rewards.bing.com/dashboard',
  pageKind: 'dashboard', reason: 'panel-loaded',
  text: 'Microsoft Rewards 20,192 金牌会员 可用积分 20,192 今日积分 257 可领取 0',
  html: fixture,
  points: { available: 20192, today: 257, claimable: 0 },
  cards: [
    { name: '必应 Star 奖励', description: '', section: 'daily', points: 50,
      earned: 0, completed: false, url: 'https://rewards.bing.com/earn/star', source: 'visible-panel' },
    { name: '每月升级奖励', description: '', section: 'daily', points: 420,
      earned: 0, completed: false, url: 'https://rewards.bing.com/earn/monthly', source: 'visible-panel' },
    { name: '默认搜索奖励', description: '', section: 'promo', points: 210,
      earned: 0, completed: false, url: 'https://rewards.bing.com/earn/defaultsearch', source: 'visible-panel' },
    { name: '免费专属壁纸', description: '', section: 'promo', points: 10,
      earned: 0, completed: false, url: 'https://rewards.bing.com/earn/wallpaper', source: 'visible-panel' }
  ],
  signedIn: true, signedOut: false
};
const loginSnap = {
  at: Date.now(), url: 'https://rewards.bing.com/earn', pageKind: 'earn',
  points: {}, cards: [], html: '',
  text: '登录 使用你的 Microsoft 帐户 电子邮件或电话号码 忘记用户名 创建帐户',
  signedIn: false, signedOut: true
};

/* ------------------------------------------------------------------ mock */
function makeCtx() {
  const mem = Object.create(null);
  const writes = [];
  const listeners = [];
  const chrome = {
    storage: {
      local: {
        get: keys => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in mem) out[k] = mem[k];
          return Promise.resolve(out);
        },
        set: obj => {
          writes.push({ keys: Object.keys(obj), obj });
          Object.assign(mem, obj);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(), clear: () => Promise.resolve()
      },
      onChanged: { addListener: fn => listeners.push(fn) }
    },
    runtime: {
      onMessage: { addListener() {} }, onStartup: { addListener() {} },
      onInstalled: { addListener() {} }, sendMessage: () => {},
      getURL: p => p, lastError: null
    },
    alarms: {
      create() {}, clear: () => Promise.resolve(true),
      get: (n, cb) => { if (typeof cb === 'function') cb(null); return Promise.resolve(null); },
      onAlarm: { addListener() {} }
    },
    tabs: {
      query: () => Promise.resolve([]), get: () => Promise.resolve(null),
      create: () => Promise.resolve({ id: 999, url: '' }),
      update: () => Promise.resolve({ id: 999 }), remove: () => Promise.resolve(),
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} }
    },
    windows: { onCreated: { addListener() {} }, update: () => Promise.resolve() },
    permissions: {
      contains: () => Promise.resolve(false),
      onAdded: { addListener() {} }, onRemoved: { addListener() {} }
    },
    scripting: { executeScript: () => Promise.resolve([{ result: null }]) },
    debugger: {
      attach: () => Promise.resolve(), detach: () => Promise.resolve(),
      sendCommand: () => Promise.resolve({}), onEvent: { addListener() {} }
    },
    action: { setBadgeText() {}, setTitle() {} }
  };
  const ctx = vm.createContext({
    console: { info() {}, warn() {}, error() {}, log() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, URL, TextDecoder, TextEncoder,
    fetch: () => Promise.reject(new Error('v1.3.1 test: no network')),
    chrome,
    window: { __desktop: { debugLog() {}, saveHtml() {} } },
    process: { env: {} }
  });
  return { ctx, mem, writes, chrome };
}

(async () => {
  group('1. 真实后台脚本在 vm 沙箱中完整加载');
  const { ctx, mem, writes } = makeCtx();
  try {
    vm.runInContext(bgSource, ctx, { filename: 'background.js' });
    ck(true, 'src/background.js 全文顶层代码执行无异常');
  } catch (e) {
    ck(false, '加载失败：' + (e && e.message));
    console.error(e);
    process.exit(1);
  }
  for (const fn of ['desktopSyncRewards', 'desktopVisibleSnapshots',
                    'desktopSnapshotTrio', 'desktopSnapshotItems',
                    'desktopTaskItems', 'parsePointsTrio', 'isSignInPage']) {
    ck(vm.runInContext('typeof ' + fn, ctx) === 'function', '真实函数 ' + fn + ' 已就位');
  }

  group('2. 复现旧版误判（证明修复针对的是真问题）');
  const trapHTML = fixture.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  ck(/Sign in to your Microsoft account/.test(fixture),
     '夹具 outerHTML 含 JS bundle 的登录文案（真实官网同款干扰）');
  ck(!/Sign in to your Microsoft account/.test(trapHTML),
     '页面可见文本里没有登录字样');
  ck(vm.runInContext('isSignInPage(' + JSON.stringify(fixture) + ')', ctx) === true,
     '旧版 isSignInPage(outerHTML) 把已登录页误判为登录页');
  const trio = vm.runInContext('JSON.stringify(parsePointsTrio(' + JSON.stringify(fixture) + '))', ctx);
  ck(JSON.parse(trio).available === null,
     '纯中文 DOM 无官方 RSC 字段，官方解析拿不到 20,192（必须靠可见快照补）');

  group('3. 场景 A：已登录 20,192 + 完整任务，但两页 HTML 被误判为登录页');
  vm.runInContext(`
    fetchBothPages = async function () {
      return {
        dash: { ok: true, html: __fixture, url: 'https://rewards.bing.com/dashboard' },
        earn: { ok: true, html: __fixture, url: 'https://rewards.bing.com/earn' },
        signedOut: true, reachable: true
      };
    };
    desktopVisibleSnapshots = async function () { return [__snap]; };
  `, ctx);
  ctx.__fixture = fixture;
  ctx.__snap = visibleSnap;
  /* 上面覆写在赋值之前执行，vm 里 __snap 此时 undefined —— 重新执行一次 */
  vm.runInContext(`
    desktopVisibleSnapshots = async function () { return [__snap]; };
  `, ctx);
  writes.length = 0;
  const rA = await vm.runInContext(
    "(async () => await desktopSyncRewards({ pages: await fetchBothPages(), reason: 'panel-loaded' }))()", ctx);
  ck(rA.loginStatus === 'in',
     '登录态判为 in，不再把 20,192 分显示成「未登录」（实际 ' + rA.loginStatus + '）');
  ck(rA.pointsSummary.available === 20192 && rA.pointsSummary.today === 257 &&
     rA.pointsSummary.claimable === 0,
     '三项积分由可见快照补齐：20,192 / 257 / 0');
  const secs = [...new Set(rA.todayTasks.items.map(i => i.section))];
  ck(secs.includes('daily') && secs.includes('promo'),
     '任务列表同时含「每日活动」与「日常任务」两组（实际 ' + secs.join('/') + '）');
  ck(rA.todayTasks.items.length >= 5 && rA.todayTasks.approx !== true,
     '任务列表完整且不是估算兜底（' + rA.todayTasks.items.length + ' 条）');
  ck(rA.pointsSummary.sources.includes('visible-panel'),
     '同步结果标注了可见面板数据源，debug 可定位');

  group('4. 刷新期间 UI 不动：一次抓取、一次原子写回');
  /* v1.3.8：进度详情(activityDetail)与积分历史(pointsHistory)是独立业务键，
     分别服务于圆圈下方详情与设置页日历；不参与「积分/任务/登录态一次原子
     写回」的统计口径，也不与业务数据混在同一次 store 里。 */
  const DETAIL_KEYS = ['activityDetail', 'pointsHistory'];
  const isDetailWrite = w => w.keys.every(k => DETAIL_KEYS.indexOf(k) >= 0);
  const dataWrites = writes.filter(w => !isDetailWrite(w));
  const detailWrites = writes.filter(isDetailWrite);
  ck(dataWrites.length === 1,
     '整轮业务数据只写 storage 一次（实际 ' + dataWrites.length + ' 次），中途不清空界面');
  ck(detailWrites.some(w => w.obj.activityDetail && w.obj.activityDetail.state === 'syncing'),
     '「正在同步」详情单独写入，不混入业务数据');
  ck(detailWrites.some(w => w.obj.pointsHistory), '当日积分历史单独写入，供积分日历汇总');
  const w = dataWrites[0] || { keys: [] };
  ck(['pointsSummary', 'todayTasks', 'loginStatus']
     .every(k => w.keys.includes(k)),
     '积分 / 任务 / 登录态 同批原子写回 → storage.onChanged 只重绘一次');
  ck(!w.keys.includes('todaySearch'),
     '未变化的搜索配额不写入（只改变变化的值）');
  ck(!w.keys.includes('syncAt') && !w.keys.includes('loginCheckedAt'),
     '同步元数据不写进 storage，不触发无谓重绘');
  const writesAfterFirst = writes.length;
  await vm.runInContext(
    "(async () => await desktopSyncRewards({ pages: await fetchBothPages(), reason: 'repeat' }))()", ctx);
  const repeatWrites = writes.slice(writesAfterFirst).filter(w => !isDetailWrite(w));
  ck(repeatWrites.length === 1 && repeatWrites[0].keys.length === 1 && repeatWrites[0].keys[0] === 'taskClickIndex',
     '相同业务数据再同步只刷新 taskClickIndex 时间戳，不重复写积分/任务数据');
  ck(!w.keys.some(k => /^(startPoints|endPoints|finalEarned)$/.test(k)),
     '不同步写运行态临时字段，不触发额外动画');
  ck(/if \(el\.dataset\.odo === text\) return/.test(popupSource),
     'popup 数字写入有去重：值相同不重绘、无逐帧滚动动画');
  ck(/ring\.classList\.remove\('spinning'\)/.test(popupSource),
     '刷新不再让进度圈转圈');

  group('5. 场景 B / C：真登录页 与 /earn 单页登录页不误判');
  /* v1.3.3 新口径：清积分需要「双重确凿」——可见快照全是登录页、没有任何
     已登录信号，且 /dashboard 与 /earn 两页 HTML 都判登录页。只有单页登录页
     DOM（用户提交的 /earn 登录页文本）时绝不写 null，否则点一下徽标积分就没了。 */
  ctx.__pagesSignedOut = false;
  vm.runInContext(`
    fetchBothPages = async function () {
      return { dash: { ok: true, html: __fixture, url: 'https://rewards.bing.com/dashboard' },
               earn: { ok: true, html: __fixture, url: 'https://rewards.bing.com/earn' },
               signedOut: __pagesSignedOut, reachable: true };
    };
  `, ctx);
  ctx.__snapB = loginSnap;
  vm.runInContext('desktopVisibleSnapshots = async function () { return [__snapB]; };', ctx);
  writes.length = 0;
  const rB = await vm.runInContext(
    "(async () => await desktopSyncRewards({ pages: await fetchBothPages(), reason: 'login-return' }))()", ctx);
  ck(rB.pointsSummary.available === 20192,
     '★ 单页登录页快照不会把 20,192 清成 null（实际 ' + rB.pointsSummary.available + '）');
  ck(writes.every(w => !(w.obj.pointsSummary && w.obj.pointsSummary.available === null)),
     '★ 写入的业务键里没有把 available 置 null（图标与积分不被误清）');
  ck(rB.loginStatus === 'in', '登录态仍绑定可用积分，判为 in');

  /* 双重确凿的真登出：两页 HTML 换成真正的登录页内容 + 快照全登录页。
     fixture（已登录 dashboard）能解析出 20,192，不能用来冒充登录页。 */
  ctx.__loginHtml = '<html><body>登录 使用你的 Microsoft 帐户 电子邮件或电话号码 忘记用户名 创建帐户</body></html>';
  vm.runInContext(`
    fetchBothPages = async function () {
      return { dash: { ok: true, html: __loginHtml, url: 'https://rewards.bing.com/dashboard' },
               earn: { ok: true, html: __loginHtml, url: 'https://rewards.bing.com/earn' },
               signedOut: true, reachable: true };
    };
  `, ctx);
  const rB2 = await vm.runInContext(
    "(async () => await desktopSyncRewards({ pages: await fetchBothPages(), reason: 'login-return' }))()", ctx);
  ck(rB2.pointsSummary.available === 20192 && rB2.loginStatus === 'in',
     '★ 即使两页都判登录页也零写入、保持 20,192 / in（真登出由主进程 Cookie 信号处理）：' +
     JSON.stringify({ available: rB2.pointsSummary.available, login: rB2.loginStatus }));
  ck(rB2.ok === false && (!rB2.changed || rB2.changed.length === 0),
     '确凿登录页时零动作、零业务键写回，不凭旧缓存空跑');
  /* 复原为已登录 fixture，供场景 C 使用 */
  vm.runInContext(`
    fetchBothPages = async function () {
      return { dash: { ok: true, html: __fixture, url: 'https://rewards.bing.com/dashboard' },
               earn: { ok: true, html: __fixture, url: 'https://rewards.bing.com/earn' },
               signedOut: false, reachable: true };
    };
  `, ctx);
  ctx.__snapC = [visibleSnap, loginSnap];
  vm.runInContext('desktopVisibleSnapshots = async function () { return __snapC; };', ctx);
  const rC = await vm.runInContext(
    "(async () => await desktopSyncRewards({ pages: await fetchBothPages(), reason: 'refreshTasks' }))()", ctx);
  ck(rC.loginStatus === 'in',
     '/earn 单独出现登录文案时，已登录的 /dashboard 仍判 in（实际 ' + rC.loginStatus + '）');
  ck(rC.todayTasks.items.some(i => i.section === 'promo'),
     '/earn 登录页不覆盖 dashboard 的日常任务');

  group('6. 所有刷新入口调同一套 desktopSyncRewards');
  const bindings = [
    ['refreshTodayTasks', /refreshTodayTasks\s*=\s*async function[\s\S]{0,400}?desktopSyncRewards\(/],
    ['refreshPointsOnly', /refreshPointsOnly\s*=\s*async function[\s\S]{0,200}?desktopSyncRewards\(/],
    ['refreshPointsSummary', /refreshPointsSummary\s*=\s*async function[\s\S]{0,250}?desktopSyncRewards\(/],
    ['refreshToday', /refreshToday\s*=\s*async function[\s\S]{0,200}?desktopSyncRewards\(/]
  ];
  for (const [name, re] of bindings) ck(re.test(bgSource), name + ' 入口绑定统一同步');
  ck(/msg\.type === 'syncRewards'[\s\S]{0,500}?desktopSyncRewards\(/.test(bgSource),
     '登录完成 / 面板加载的 syncRewards 消息走统一同步');
  ck(/syncStart[\s\S]{0,700}?desktopSyncRewards\(/.test(bgSource) &&
     /presetSyncFinish[\s\S]{0,500}?desktopSyncRewards\(/.test(bgSource),
     '自动完成任务的开始与收尾都走统一同步');
  ck(/today-tasks-refresh[\s\S]{0,600}?refreshTasks/.test(popupSource) ||
     /send\('refreshTasks'\)/.test(popupSource),
     '首页「刷新」按钮经后台 refreshTasks → 同一套逻辑');
  ck(!/onMessage\.addListener\(\(msg, sender, sendResponse\) => \{\s*if \(msg && msg\.type === 'syncRewards'\)/.test(bgSource),
     '不再有会被主监听器抢先应答吞掉的独立 syncRewards 监听器');

  group('7. 运行态不抢系统焦点 / 搜索中间不同步');
  const quietFns = [
    ['ensureTabActive', /ensureTabActive\s*=\s*async function\s*\(tabId\)\s*\{\s*await cdpEmulateFocus\(tabId\)/],
    ['keepSearchTabAwake', /keepSearchTabAwake\s*=\s*async function\s*\(tabId\)\s*\{\s*await cdpEmulateFocus\(tabId\)/],
    ['cdpBringToFront', /cdpBringToFront\s*=\s*async function\s*\(\)\s*\{\s*return false/],
    ['restoreUserFocus', /restoreUserFocus\s*=\s*async function\s*\(\)\s*\{\s*\/\* 桌面版不抢回系统焦点 \*\//]
  ];
  for (const [name, re] of quietFns) ck(re.test(bgSource), name + ' 不把窗口拉到前台');
  ck(/function autoFocusAllowed\(\)[\s\S]{0,250}?if \(desktopQuietRun\(\)\) return false/.test(mainSource),
     '主进程 autoFocusAllowed 在运行态直接禁止自动聚焦');
  ck(/if \(desktopSearchGuard\)[\s\S]{0,220}?mid-search sync blocked/.test(bgSource),
     '搜索中间任何积分抓取被硬拦截');
  ck(/loginReturn && !desktopQuietRun\(\)/.test(mainSource),
     '运行中不派发面板快照同步（事件驱动，无监控）');
  ck(!/panelReason === 'user'[\s\S]{0,200}?syncRewards/.test(mainSource),
     '点击登录按键展开官网不再派发积分 / 登录状态刷新');
  ck(!/setInterval\(/.test(mainSource),
     '主进程无任何周期监控定时器');

  group('8. 消息分发：所有 onMessage 监听器都会收到消息');
  ck(/for \(const fn of \[\.\.\.messageListeners\]\)[\s\S]{0,900}?continue;/.test(preloadSource) &&
     /if \(!settled && !asyncPending\) finish\(undefined\)/.test(preloadSource),
     '分发器不再遇到第一个应答就 return，后续监听器不会被吞');
  /* 实跑分发器：两个监听器，第一个 fire-and-forget，第二个异步应答 */
  const dm = preloadSource.slice(
    preloadSource.indexOf('function dispatchMessage'),
    preloadSource.indexOf("ipcRenderer.on('chrome:runtime:dispatch'"));
  const dctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, Set });
  vm.runInContext('var seen = []; var messageListeners = new Set();\n' + dm, dctx);
  vm.runInContext(`
    messageListeners.add(() => { seen.push('first'); });
    messageListeners.add((m, s, sendResponse) => {
      seen.push('second'); sendResponse({ ok: true }); return true;
    });
  `, dctx);
  const reply = await vm.runInContext("dispatchMessage({ type: 'syncRewards' })", dctx);
  const seen = vm.runInContext('JSON.stringify(seen)', dctx);
  ck(seen === '["first","second"]',
     '两个监听器都收到消息（实际 ' + seen + '），修「syncRewards 被吞」');
  ck(reply && reply.ok === true, '异步应答正确回传主进程');

  group('9. 主进程统一同步触发点');
  ck(/panelReason === 'user'/.test(mainSource) &&
     /loginReturn/.test(mainSource),
     '登录跳回 / 用户展开官网两个事件都会触发统一同步');
  ck(!/pointsSummary:|todayTasks:|loginStatus:/.test(
       mainSource.slice(mainSource.indexOf('async function pushVisibleSnapshot'),
                        mainSource.indexOf("ipcMain.handle('chrome:tabs:goBack'"))),
     '可见快照不再直接写业务键（避免把完整任务列表覆盖成只有每日活动）');

  console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error('\x1b[31m验证异常：' + String(err && err.stack || err) + '\x1b[0m');
  process.exit(1);
});
