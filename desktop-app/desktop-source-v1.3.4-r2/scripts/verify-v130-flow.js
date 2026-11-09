#!/usr/bin/env node
/* ============================================================================
 * v1.3.0 · 自动完成任务「真实运行时」流程专项
 *
 * 不只是静态字符串匹配：把 desktop-app/src/background.js 全文放进 vm 沙箱，
 * 用最小 chrome mock 执行真实的 syncStart / presetSearchCount /
 * runAutoComplete / handleStart / finishRun / presetSyncFinish / fetchRewardsPage，
 * 只把「打开标签页 / CDP / 热搜源」这些外部 I/O 换成记录型替身。
 *
 * 断言用户新口径：
 *   ① 开始时唯一一次同步（真实官网 HTML 夹具）
 *   ② 先点任务卡片、再搜索
 *   ③ 搜索次数在开始时按官方配额锁定，搜索中间零积分同步、次数不变
 *   ④ 结束后再同步一次，两次都强制读实时页面
 *   ⑤ 搜索进行中任何积分抓取被硬拦截
 *   ⑥ 未登录 / 页面不可读时零动作
 *
 * 运行： npm run verify:v130
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const bgSource = fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8');
const FX = path.join(ROOT, 'tests', 'fixtures');

let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* ---------------------------------------------------------------- 夹具 */
const dashHtml = fs.readFileSync(path.join(FX, 'uploaded-dashboard.html'), 'utf8');
let earnHtml = fs.readFileSync(path.join(FX, 'uploaded-earn.html'), 'utf8');
/* 构造「搜索未满」的现场：pc 配额 60，已完成 30 → 还需 10 次搜索 */
const quotaFrom = '\\"pc\\":{\\"max\\":60,\\"progress\\":60';
const quotaTo = '\\"pc\\":{\\"max\\":60,\\"progress\\":30';
if (!earnHtml.includes(quotaFrom)) throw new Error('夹具里找不到 pc 搜索配额，无法构造未满现场');
earnHtml = earnHtml.replace(quotaFrom, quotaTo);

/* ---------------------------------------------------------------- mock */
const mem = Object.create(null);
const listeners = [];
let storageWrites = 0;

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
        storageWrites++;
        Object.assign(mem, obj);
        const changes = {};
        for (const k of Object.keys(obj)) changes[k] = { oldValue: undefined, newValue: obj[k] };
        for (const fn of listeners.slice()) {
          try { fn(changes, 'local'); } catch {}
        }
        return Promise.resolve();
      }
    },
    onChanged: { addListener: fn => listeners.push(fn) }
  },
  runtime: {
    onMessage: { addListener() {} },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    sendMessage: () => {}, getURL: p => p, lastError: null
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
  fetch: () => Promise.reject(new Error('unexpected network fetch in v1.3.0 flow')),
  chrome,
  window: { __desktop: { debugLog() {}, saveHtml() {} }, __hsaAutoTasksTimes: [] },
  process: { env: {} }
});
ctx.__dash = dashHtml;
ctx.__earn = earnHtml;
ctx.__calls = { fetchBothPages: [], clicks: [], midFetch: [] };

/* ---------------------------------------------------------------- 执行 */
(async () => {
  group('1. 真实后台脚本在 vm 沙箱中完整加载');
  try {
    vm.runInContext(bgSource, ctx, { filename: 'background.js' });
    ck(true, 'src/background.js 全文顶层代码执行无异常');
  } catch (e) {
    ck(false, '加载失败：' + (e && e.message));
    console.error(e);
    process.exit(1);
  }
  ck(vm.runInContext('typeof syncStart', ctx) === 'function', '新增编排函数 syncStart 已就位');
  ck(vm.runInContext('typeof presetSearchCount', ctx) === 'function', '新增编排函数 presetSearchCount 已就位');
  ck(vm.runInContext('typeof presetSyncFinish', ctx) === 'function', '新增编排函数 presetSyncFinish 已就位');
  ck(vm.runInContext('typeof desktopSearchGuard', ctx) === 'boolean', '搜索门控变量存在');

  /* 只替换外部 I/O，编排与解析全部是真实函数 */
  vm.runInContext(`
    fetchBothPages = async function (opts) {
      __calls.fetchBothPages.push({ fresh: !!(opts && opts.fresh), at: Date.now() });
      return {
        dash: { ok: true, html: __dash, url: 'https://rewards.bing.com/dashboard' },
        earn: { ok: true, html: __earn, url: 'https://rewards.bing.com/earn' },
        signedOut: false, reachable: true
      };
    };
    completePendingTaskCards = async function () {
      __calls.clicks.push({ at: Date.now() });
      return { clicked: 3, pages: [], openedTabs: 3 };
    };
    prepareQueue = async function () { return { queries: ['a','b','c'], usedWords: [] }; };
    /* 模拟真实 runFlow 的 searchLoop 阶段：置门控 → 每轮尝试抓积分 → 释放 → 收尾 */
    runFlow = async function (token) {
      desktopSearchGuard = true;
      try {
        for (let i = 0; i < 3; i++) {
          const r = await fetchRewardsPage('/earn');
          __calls.midFetch.push({ error: r.error || 'NOT-BLOCKED', at: Date.now() });
          await store({ currentSearch: i + 1, lastActivity: Date.now() });
        }
      } finally { desktopSearchGuard = false; }
      await finishRun(token);
    };
  `, ctx);

  group('2. 触发一次完整的「自动完成任务」（manual, cap=20）');
  const res = await vm.runInContext('runAutoComplete({ manual: true, cap: 20 })', ctx);
  const c = JSON.parse(vm.runInContext('JSON.stringify(__calls)', ctx));
  const st = await chrome.storage.local.get([
    'presetSearches', 'totalSearch', 'phase', 'running', 'pointsSummary',
    'todayTasks', 'todaySearch', 'runPreset', 'startKnown', 'endPoints', 'lastRun'
  ]);

  group('3. 流程顺序与次数锁定');
  ck(res && res.ok === true, 'runAutoComplete 正常返回 ok=true（' + JSON.stringify(res) + '）');
  ck(st.presetSearches === 10,
     '开始时按官方配额 30/60 锁定搜索次数 10（实际 ' + st.presetSearches + '）');
  ck(st.totalSearch === 10 && st.runPreset && st.runPreset.searches === 10,
     'handleStart 收到的次数与锁定值一致，totalSearch 未被中途改写');
  ck(c.clicks.length === 1, '任务卡片点击阶段执行一次');
  ck(res.searches === 10 && res.preset === true, '返回结构报告锁定的 10 次搜索');

  group('4. 搜索中间零积分同步');
  ck(c.midFetch.length === 3 && c.midFetch.every(e => e.error === 'mid-search sync blocked'),
     '门控期间 3 次积分抓取全部被硬拦截（' + c.midFetch.map(e => e.error).join(' / ') + '）');
  const gs = JSON.parse(vm.runInContext('JSON.stringify(window.__hsaFetchGuardStats())', ctx));
  ck(gs.guard === false && gs.blocks === 3,
     '门控用 finally 正确释放，累计拦截 3 次（' + JSON.stringify(gs) + '）');
  const fstats = JSON.parse(vm.runInContext('JSON.stringify(window.__hsaRewardsFetchStats())', ctx));
  ck(fstats.count === 0, '被拦的抓取没有进入内置浏览器读取链路（计数仍为 0）');

  group('5. 整轮只有开始 / 收尾两次同步，且都读实时页面');
  ck(c.fetchBothPages.length === 2,
     'fetchBothPages 恰好调用 2 次（实际 ' + c.fetchBothPages.length + '）');
  ck(c.fetchBothPages.every(x => x.fresh === true),
     '两次同步都带 fresh=true，不吃 120 秒旧快照');
  ck(c.fetchBothPages[0].at <= c.clicks[0].at, '① 开始同步发生在 ② 点击卡片之前');
  ck(c.clicks[0].at <= c.midFetch[0].at, '② 点击卡片发生在 ③ 搜索之前');
  ck(c.midFetch[c.midFetch.length - 1].at <= c.fetchBothPages[1].at,
     '④ 收尾同步发生在搜索结束之后，不在搜索中间');

  group('6. 解析结果写回界面');
  ck(st.pointsSummary && st.pointsSummary.available === 20192,
     '真实官网 HTML 解析出可用积分 20,192（实际 ' +
     (st.pointsSummary && st.pointsSummary.available) + '）');
  ck(st.todayTasks && Array.isArray(st.todayTasks.items) && st.todayTasks.items.length > 0,
     '今日任务列表由同一份 HTML 写入（' +
     (st.todayTasks && st.todayTasks.items && st.todayTasks.items.length) + ' 项）');
  const searchItem = st.todayTasks && st.todayTasks.items.find(i => i.section === 'search');
  ck(searchItem && searchItem.earned === 30 && searchItem.points === 60,
     '搜索任务显示 30/60（未完成），不会误标「已完成」');
  ck(st.todaySearch && st.todaySearch.progress === 30,
     'todaySearch 已更新为本次同步真实值，不是上一轮 60/60 缓存');
  ck(st.phase === 'completed' && st.running === false,
     '收尾后状态回到 completed / running=false');
  ck(st.lastRun && st.lastRun.total === 10, 'lastRun 记录锁定的 10 次');
  ck(storageWrites > 0, 'storage 写入由真实 store() 完成（' + storageWrites + ' 次）');

  group('7. 未登录 / 页面不可读时零动作');
  vm.runInContext(`
    fetchBothPages = async function (opts) {
      __calls.fetchBothPages.push({ fresh: !!(opts && opts.fresh), at: Date.now() });
      return { dash: { ok: false, html: '' }, earn: { ok: false, html: '' },
               signedOut: true, reachable: false };
    };
    __calls.clicks.length = 0;
    __calls.midFetch.length = 0;
    __calls.fetchBothPages.length = 0;
  `, ctx);
  await chrome.storage.local.set({ running: false });
  const bad = await vm.runInContext('runAutoComplete({ manual: true, cap: 20 })', ctx);
  const c2 = JSON.parse(vm.runInContext('JSON.stringify(__calls)', ctx));
  ck(bad && bad.ok === false && bad.reason === 'signedOut',
     '未登录时立即返回 signedOut（' + JSON.stringify(bad) + '）');
  ck(c2.clicks.length === 0 && c2.midFetch.length === 0 && c2.fetchBothPages.length === 1,
     '未登录时只做一次开始时同步，不点卡片、不搜索、不收尾空跑（实际 clicks=' +
     c2.clicks.length + ' mid=' + c2.midFetch.length + ' sync=' + c2.fetchBothPages.length + '）');

  console.log('\n\x1b[1m共 ' + (pass + fail) + ' 项，通过 ' + pass + ' 项，失败 ' + fail + ' 项\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常', e); process.exit(1); });
