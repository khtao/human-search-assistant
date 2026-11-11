/* 共享核心：host.html 在本脚本之前加载 <script src="../shared/hsa-core.js">；
   Node 静态校验环境则回退到 CommonJS 加载。两端调用同一份纯逻辑。 */
const HSA_CORE = (typeof globalThis !== 'undefined' && globalThis.HSA_CORE) ||
  (typeof require === 'function' ? require('../shared/hsa-core.js') : null);

const DASHBOARD_URL = 'https://rewards.bing.com/dashboard';
const EARN_URL = 'https://rewards.bing.com/earn';
/** 两个页面都存在可点击任务，必须逐页独立扫描（不跨页去重）。 */
const TASK_PAGES = [DASHBOARD_URL, EARN_URL];
const HOME_URL = 'https://www.bing.com/?mkt=zh-CN';
const POINTS_PER_SEARCH = 3;
const RESULT_HOLD_MIN = 16000;   // 拟人轮内时长下限（想加快可自行调小）
const RESULT_HOLD_MAX = 29000;   // 拟人轮内时长上限
const PAGE_TIMEOUT = 20000;
const READ_DEADLINE = 25000;
const DIRECT_TIMEOUT = 12000;
const SETTLE_MS = 1500;
const LOGIN_GRACE_MS = 15000;
const ABOUT_GRACE_MS = 4000;
const MAX_FAILURES = 3;
const ACTIVE_PHASES = ['fetchingStartPoints', 'checkingLimit', 'searching', 'fetchingEndPoints'];

/* ==========================================================================
 * v1.3.0 · 自动完成任务流程（按用户明确口径重排）
 *   ① 开始时只同步一次：/dashboard + /earn 两页并行抓一次 → 三项积分 + 任务列表
 *   ② 若仍有待完成任务：先点任务卡片，再做搜索任务
 *   ③ 搜索次数在 ① 依据官方搜索配额预先算好并锁定；搜索中间不读积分、
 *      不刷任务列表、不做 autoStop / 冷却判定（这些都需要中途积分信号）
 *   ④ 结束后再同步一次，把最终积分与任务状态显示到界面
 * 任务识别、卡片点击、拟人搜索、各解析器仍全部沿用上传版原文。
 * ========================================================================== */
const DESKTOP_NO_REMINDER_FETCH = true;   // 禁止「浏览网页就抓 /earn」的空闲请求
let desktopSearchGuard = false;           // 搜索进行中：任何积分抓取直接短路
let desktopGuardBlocks = 0;

/* ==========================================================================
 * v2.0 · 按真实 Rewards DOM 重写任务识别（修「只开页面不点击」）
 *  · /dashboard 的每日活动卡根本没有 bg-statusSuccessRewardsBg 元素
 *    （该字符串只出现在 RSC flight payload 的转义文本里），旧版遍历徽章 = 0 张
 *  · dashboard 用 <a target="_blank"> + 文本 "+10"；earn 用徽章 <p>5</p>
 *  · 统一改为以 a[href] 为入口，双通道取积分，定位/点击都落在 <a> 本身
 * ==========================================================================
 * v1.9 · 双页面独立点击 / 同名卡片可区分 / 页面就绪等待 / 可配置间隔（默认 10s）
 *  · dashboard 与 earn 两页都存在可点击任务，逐页独立扫描、各自去重，
 *    一页点过不会让另一页的同名任务被跳过
 *  · 同名同分卡片（如「你是否知道答案？」×2）用页面内序号 idx 定位，逐张点击
 *  · 导航后等页面真正加载完成并识别登录页，避免扫到上一页 / 空 DOM 就提前退出
 *  · 相邻两次点击按配置的点击时刻调度（默认 10s），跨页、跨轮次都成立
 *  · 任务卡片：每日活动(每日任务) → 日常任务；点击弹出的任务页保留不关闭
 *  · 搜索标签页运行期间保持焦点、结束关闭（后台节流会让搜索暂停）
 * ======================================================================== */
const TASK_CLICK_INTERVAL_MS = HSA_CORE.DEFAULTS.cardClickIntervalSec * 1000;
const KEEP_TASK_TABS = true;            // 任务阶段打开的标签页一律不关闭
const KEEP_SEARCH_TAB_FOCUSED = true;   // 每轮搜索前把搜索页拉回焦点，防后台节流暂停
const FOCUS_WINDOW_TOO = true;          // 同时把浏览器窗口置为系统前台
const RESTORE_FOCUS_ON_FINISH = true;   // 搜索结束后把焦点还给用户原来的标签页
const TASK_TAB_KEYS = new Set(['rewardsTabId', 'taskClickTabId', 'sidebarTabId', 'taskListTabId', 'humanTabId']);
let lastTaskClickAt = 0;                // 上一次「点击时刻」，用于可配置间隔调度

/* ==========================================================================
 * v2.1 · 从 Bing 搜索/首页右侧的 Microsoft Rewards 侧栏点任务卡
 *  · 之前几版都在 rewards.bing.com/dashboard、/earn 上找卡片，真机始终点不到，
 *    改为在截图里的 cn.bing.com 侧栏（网页内 flyout）完成点击
 *  · 面板可能挂在主文档、iframe 或 shadow DOM 里 → allFrames + 递归 shadow
 *  · 识别靠文本启发式（+10 / +5、每日活动 / 日常任务、已完成），不绑死 class
 *  · 点击：CDP 真鼠标优先 → 页面内完整指针/鼠标事件序列 + el.click() → 按 href 兜底开页
 *  · 若面板其实是浏览器内置 UI（非网页 DOM），注入扫不到，日志会明确提示
 * ======================================================================== */
const TASK_MODE = 'human';              // 'human' | 'tasklist' | 'sidebar' | 'rewards'
/* 直接导航任务 URL 不会计入 Rewards 完成；找不到卡片必须明确失败并给诊断。 */
const HUMAN_PAGE_SETTLE_MS = 1500;
const HUMAN_SCROLL_RESCAN = true;
/* 点击前后调官方 getuserinfo 核验，只点「未完成且给分」的卡；
   页面内 fetch 失败 / CORS 时静默回退到本地严格白名单。 */
const HUMAN_VERIFY_OFFICIAL = true;
/* 侧栏 flyout 顶层页：中文环境实际落在 cn.bing.com，不是 www */
const FLYOUT_URLS = [
  'https://cn.bing.com/rewards/panelflyout?channel=bingflyout&partnerId=BingRewards',
  'https://www.bing.com/rewards/panelflyout?channel=bingflyout&partnerId=BingRewards'
];
const TASKLIST_CDP_FIRST = true;        // 先 CDP 真鼠标，没弹出新标签页再补页面内事件序列
const TASKLIST_CARD_WAIT_ROUNDS = 6;    // 等目标卡片渲染的轮数（跨候选页）
const TASKLIST_CLICK_RETRIES = 3;       // 点击后没开出任务页时的重试次数
const TASKLIST_TRY_SIDEBAR = true;      // 来源页找不到时，再去 Bing 侧栏（含 iframe）找同一张卡
const SIDEBAR_URL = 'https://cn.bing.com/?scope=web&FORM=ANNTH1&pc=CNNDDB';
const SIDEBAR_FALLBACK_URLS = [
  'https://www.bing.com/?mkt=zh-CN',
  'https://cn.bing.com/'
];
const SIDEBAR_CLICK_MODE = 'cdp-first'; // 'cdp-first' | 'dom'：有顶层坐标就先真鼠标
const SIDEBAR_WAIT_ROUNDS = 6;          // 等面板渲染的扫描轮数
/**
 * v2.2：侧栏内容在 #rewid-f 的 <iframe> 里（保存页 src = ./…_files/flyout.html）。
 * 跨域 iframe 的注入 / CDP 坐标换算都不可靠，优先把 iframe 的绝对 URL
 * 开成独立标签页 —— 任务卡变成顶层 DOM，扫描与点击都不再受 frame 限制。
 */
const PROMOTE_SIDEBAR_IFRAME = true;
const SIDEBAR_IFRAME_HOST = /(?:^|\.)bing\.com$/i;
/** 点击任务卡时把载体页临时置为 active：后台标签页的 CDP 点击可能不触发 target=_blank */
const KEEP_TASK_CLICK_ACTIVE = true;
/** 已标记「已完成 / 已领取」的卡片默认跳过；设为 true 可强制重点 */
const FORCE_CLICK_COMPLETED = false;

/* 后台错误文案也跟随界面语言（uiLang 由弹窗写入 storage.local） */
var bgLang = 'zh';
const BG_TEXT = {
  zh: {
    signIn: '请先在浏览器中登录 Microsoft Rewards（rewards.bing.com），然后重新开始。',
    topics: '所有热搜源均不可用，请检查网络后重试（不使用本地词库）。',
    strictNoWords: HSA_CORE.TEXT.strictNoWords,
    network: 'Bing 没有响应，请检查网络连接。',
    stale: '上次运行被中断（浏览器关闭或电脑休眠），请重新点击开始。',
    runStopped: m => '运行已中止：' + m,
    startFailed: m => '启动失败：' + m
  },
  en: {
    signIn: 'Sign in to Microsoft Rewards (rewards.bing.com) in this browser, then press Start again.',
    topics: 'All trending sources are unavailable. Check your connection (no local word list).',
    strictNoWords: HSA_CORE.TEXT.strictNoWordsEn,
    network: 'Bing is not responding. Check your connection.',
    stale: 'The last run was cut off (browser closed or PC slept). Press Start to run again.',
    runStopped: m => 'Run stopped: ' + m,
    startFailed: m => 'Start failed: ' + m
  }
};
function bgMsg(key, extra) {
  const table = BG_TEXT[bgLang === 'en' ? 'en' : 'zh'] || BG_TEXT.zh;
  const v = table[key];
  return typeof v === 'function' ? v(extra == null ? '' : extra) : (v || key);
}

let flowToken = 0;
let flowActive = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
/* 严格运行模式：running 状态由 store 统一维护，供消息 / 闹钟同步拦截使用。 */
let strictRunActive = false;
const store = obj => {
  if (obj && Object.prototype.hasOwnProperty.call(obj, 'running')) strictRunActive = !!obj.running;
  /* 运行过程 / 运行结果 / 错误信息：状态变化自动写详细日志。
     系统时间 ts / iso、平台、类别全部由 shared/hsa-core.js 统一补齐。 */
  try {
    if (obj && (obj.phase || obj.running !== undefined || obj.error || obj.stopRequested)) {
      const phase = String(obj.phase || '');
      const isError = !!obj.error || phase === 'error';
      const isResult = phase === 'completed' || (obj.running === false && !isError);
      const snapshot = {
        phase: phase, running: obj.running, stopRequested: obj.stopRequested,
        error: obj.error, currentSearch: obj.currentSearch, totalSearch: obj.totalSearch
      };
      hsaRunLog('run-state', {
        level: isError ? 'error' : 'info',
        category: isError ? 'error' : isResult ? 'result' : 'run-step',
        event: 'run-state', state: phase,
        zh: (isError ? '运行错误：' : isResult ? '运行结束：' : '运行阶段：') + (phase || 'state'),
        en: (isError ? 'Run error: ' : isResult ? 'Run finished: ' : 'Run phase: ') + (phase || 'state'),
        detail: JSON.stringify(snapshot),
        result: isResult ? 'finished' : '',
        error: String(obj.error || ''), ok: !isError,
        count: Number(obj.currentSearch) || 0
      }).catch(() => {});
    }
  } catch (err) {}
  return chrome.storage.local.set(obj);
};
const load = keys => chrome.storage.local.get(keys);
/* 宿主视图重启后补齐运行态，避免消息 / 闹钟拦截出现空窗。 */
load(['running']).then(s => { strictRunActive = !!s.running; }).catch(() => {});
/* 诊断设置：日常运行只有运行日志；开关由设置页控制，运行期不允许改。 */
const HSA_PLATFORM = 'desktop-app';
/* v2.9 · 桌面版专用预算（与插件版分别优化）：主进程已做写盘节流与落盘副本
   裁剪，这里只需收紧常驻 storage 里的日志 / 历史词 / 官网 HTML 体积。 */
const DESKTOP_MEM = Object.freeze({
  /* v3.1 · 恢复到 applet 版的 600KB。v2.9 误压到 256KB 会截断 /dashboard
     与 /earn 的官网响应，导致积分/任务解析失败（插件版表现为弹出官网标签）。 */
  htmlCacheMaxBytes: 600 * 1024,
  runLogEntries: 240,              // 原 600（插件版 180）
  usedWordsMax: 160                // 原 1000（插件版 120）
});
function desktopTrimLog(list) {
  return Array.isArray(list) ? list.slice(-(DESKTOP_MEM.runLogEntries - 1)) : [];
}
let runLogEnabled = true;
load(['settings']).then(s => {
  const v = s && s.settings && s.settings.runLogEnabled;
  runLogEnabled = v !== false;
}).catch(() => {});

/* 追加一条运行日志：字段白名单裁剪 + 环形上限，绝不写网页 HTML / 快照。 */
function hsaRunLog(event, info) {
  if (!runLogEnabled) return Promise.resolve();
  const o = Object.assign({ event: String(event || 'activity'), at: Date.now() }, info || {});
  const now = Number(o.at) || Date.now();
  return load(['runLog'])
    .then(s => store({ runLog: HSA_CORE.runLogAppend(desktopTrimLog(s && s.runLog), o, now) }))
    .catch(() => {});
}

/* 关键网页实时抓取：强制 fresh + cache:no-store，不走 120 秒 HTML 缓存，
   不读可见快照 / 面板 / 隐藏数据视图；抓到的 HTML 只随本次导出返回。 */
async function hsaCaptureKeyPages(policy) {
  const p = policy || HSA_CORE.keyPagePolicy();
  const out = [];
  for (const page of p.pages) {
    /* 三页均为完整 URL：/dashboard、/earn、Bing 侧边栏 panelflyout。 */
    const url = page.url || (p.origin + page.path);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), p.timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        credentials: 'include', cache: 'no-store', signal: ctrl.signal
      });
      const html = String((await res.text()) || '').slice(0, p.maxBytes);
      out.push({
        name: page.name, path: page.path, url: res.url || url, file: page.file,
        ok: !!res.ok, status: Number(res.status) || 0,
        bytes: html.length, html: html,
        collectedAt: Date.now(), durationMs: Date.now() - started,
        source: p.source
      });
    } catch (err) {
      out.push({
        name: page.name, path: page.path, url: url, file: page.file,
        ok: false, status: 0, bytes: 0, html: '',
        collectedAt: Date.now(), durationMs: Date.now() - started,
        source: p.source,
        error: (err && err.name === 'AbortError') ? 'timed out' : String(err && err.message || err)
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

const isCurrent = token => token === flowToken;

function parseUrl(url) {
  try { return new URL(url); } catch { return null; }
}
const onBing = u => !!u && /(^|\.)bing\.com$/.test(u.hostname);
const isBingHome = url => { const u = parseUrl(url); return onBing(u) && u.pathname === '/'; };
const isBingSearch = url => { const u = parseUrl(url); return onBing(u) && u.pathname.startsWith('/search'); };
const isRewards = url => { const u = parseUrl(url); return !!u && u.hostname === 'rewards.bing.com'; };
const isLogin = url => { const u = parseUrl(url); return !!u && /(^|\.)(login\.live\.com|login\.microsoftonline\.com)$/.test(u.hostname); };

const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ============================================================================
 * 拟人搜索核心（移植自 github.com/khtao/human-search-assistant v4.2）
 *
 * 替换了原来的「Google Trends + Bing 英文联想词」生成器与「注入脚本逐字输入」：
 *   · 关键词：6 路真实热搜源（Bing 趋势 / 百度 / 微博 / 今日头条 / 知乎 / 新浪 RSS）
 *             随机挑 2~4 个源抓取，无本地词库，全失败明确报错；每轮词截断 30 字
 *   · 相关延伸：当前 SERP 的「相关搜索」链接 → Bing autosuggest → 热搜词回退
 *   · 每轮随机混合：粘贴关键词 / 直接改词 × 回首页 / 留在结果页
 *   · 粘贴前先清空搜索框（CDP Ctrl+A + Backspace，降级为 value="" + input/change）
 *   · 输入：chrome.debugger + CDP 真实鼠标/键盘；不可用时降级为页面内合成事件
 *   · 节奏：轮内 16~29 秒、轮间 3~12 秒、贝塞尔鼠标轨迹、滚动、按概率点结果再返回
 *   · 点「停止」立即中止：haltFlag + 可中断等待 + 立即 detach 调试会话
 *
 * 积分读取、每日限额、冷却、提醒、设置与弹窗 UI 全部沿用原扩展，未改动。
 * ========================================================================== */

/* ---------------------------------------------------------------- 常量 */
const SEARCH_INPUTS = ["#sb_form_q", "textarea[name='q']", "input[name='q']", "#q"];
const SEARCH_BUTTONS = ["#sb_form_go", "input[type='submit']", "#sb_form_submit", "label#search_icon"];
const RESULT_LINKS = ["li.b_algo h2 a", "#b_results > li h2 a", ".b_algo a", "#b_results li a"];
const RELATED_SELECTORS = [
  ".b_rs a", "#b_rs a", ".b_related a", "[class*='related' i] a",
  "[class*='Related'] a", ".b_ans a[href*='/search']",
  "a[href*='/search?q=']", "a[href*='search?q=']"
];
const HOT_SOURCES = ['bing', 'baidu', 'weibo', 'toutiao', 'zhihu', 'sina'];
/* v2.9 · 已移除所有浏览器伪装：不再伪造 User-Agent / Accept-Language /
   sec-ch-ua* 客户端提示，也不再注入 navigator 覆盖脚本。请求头由运行时
   （扩展 / Electron）自行提供，Referer 等站点必需字段照常保留。 */
const SOURCE_TIMEOUT = 8000;
const USE_REAL_INPUT = true;          // 关掉即全程使用页面内合成事件
const GO_HOME_RATE = 0.38;
const RELATED_RATE = 0.42;
const ENTER_RATE = 0.5;
const CLICK_RESULT_RATE = 0.35;
const STOP = Symbol('stopped');
/* 严格运行模式（单一真源 shared/hsa-core.js）：固定节奏，禁用一切运行期可变功能。 */
const STRICT = HSA_CORE.STRICT_RUN;

/* 拟人强度：影响鼠标轨迹密度、过冲概率、滚动幅度与每轮时长 */
const HUMAN_PROFILES = {
  1: { steps: [4, 10], overshoot: 0, scroll: [0.2, 0.8], screens: 0.6, round: 0.7 },
  2: { steps: [12, 30], overshoot: 0.22, scroll: [0.4, 1.6], screens: 1.0, round: 0.85 },
  3: { steps: [24, 52], overshoot: 0.4, scroll: [0.6, 2.8], screens: 1.2, round: 1.0 }
};
const profileOf = level => HUMAN_PROFILES[clampInt(Number(level) || 3, 1, 3)] || HUMAN_PROFILES[3];
function clampInt(v, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(v))); }

/* ------------------------------------------------------- 运行状态 / 立即停止 */
let haltFlag = false;
let runSignal = null;
const cdpAttached = new Set();

function resetHalt() {
  haltFlag = false;
  runSignal = new AbortController();
}

function haltRun() {
  haltFlag = true;
  try { runSignal && runSignal.abort(); } catch {}
  cdpDetachAll().catch(() => {});
}

function bail(token) {
  if (haltFlag || !isCurrent(token)) throw STOP;
}

/** 可中断等待；分片调用 storage 让 MV3 service worker 在长跑期间保持存活。 */
async function nap(ms, token) {
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < end) {
    bail(token);
    await sleep(Math.min(800, Math.max(1, end - Date.now())));
    await load(['running']);
  }
  bail(token);
}

function directSearchUrl(query) {
  return `https://www.bing.com/search?q=${encodeURIComponent(String(query))}&form=QBLH`;
}

/* --------------------------------------------------------------- 关键词清洗 */
function cleanKeyword(s) {
  return String(s || '')
    .replace(/[#\[\]【】「」"'“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim(' -—·|');
}

function validKeyword(s) {
  /* 严格运行模式：少于 5 字的单调词一律拒绝，词源只能是当日热搜。 */
  return HSA_CORE.isStrictKeyword(s);
}

async function fetchSource(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SOURCE_TIMEOUT);
  try {
    return await fetch(url, Object.assign({}, opts, {
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal
    }));
  } finally {
    clearTimeout(timer);
  }
}

function textOf(html, patterns) {
  const out = [];
  for (const re of patterns) {
    for (const m of String(html || '').matchAll(re)) out.push(cleanKeyword(m[1]));
    if (out.length) break;
  }
  return out;
}

/* 6 路真实热搜源；禁止本地词库，任何源都抓不到时如实返回空。 */
const HOT_SOURCE_FNS = {
  bing: async () => {
    const r = await fetchSource('https://www.bing.com/news/trendingtopics?form=HPNTOP',
      { /* v2.9：无浏览器伪装，交给 Electron 自带请求头 */ });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return textOf(await r.text(), [
      /<a[^>]+class="[^"]*title[^"]*"[^>]*>([^<]{2,60})<\/a>/g,
      /"text"\s*:\s*"([^"\\]{2,60})"/g
    ]);
  },
  baidu: async () => {
    const r = await fetchSource('https://top.baidu.com/board?tab=realtime',
      {});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return textOf(await r.text(), [
      /"query"\s*:\s*"([^"\\]{2,60})"/g,
      /class="c-single-text-ellipsis"[^>]*>([^<]{2,60})</g
    ]);
  },
  weibo: async () => {
    const r = await fetchSource('https://weibo.com/ajax/side/hotSearch',
      { headers: { Referer: 'https://weibo.com/' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return ((data && data.data && data.data.realtime) || [])
      .map(it => cleanKeyword((it && (it.word || it.note)) || ''));
  },
  toutiao: async () => {
    const r = await fetchSource('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
      {});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return ((data && data.data) || []).map(it => cleanKeyword((it && (it.Title || it.title)) || ''));
  },
  zhihu: async () => {
    const r = await fetchSource('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true',
      {});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return ((data && data.data) || []).map(it => cleanKeyword(
      (it && ((it.target && it.target.title) || it.title)) || ''
    ));
  },
  sina: async () => {
    const r = await fetchSource('https://rss.sina.com.cn/news/marquee/ddt.xml',
      {});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return [...String(await r.text()).matchAll(/<title>(?:<!\[CDATA\[)?([^<\]]{2,80})/g)]
      .map(m => cleanKeyword(m[1]));
  }
};

/** 严格模式：固定抓取全部 6 路当日热搜源，合并去重后不洗牌。 */
async function getKeywordPool(limit) {
  const chosen = HOT_SOURCES.slice();  /* 严格模式：固定抓取全部当日热搜源 */
  const collected = [];
  const errors = [];
  for (const name of chosen) {
    try {
      const list = await HOT_SOURCE_FNS[name]();
      for (const text of list) if (validKeyword(text)) collected.push({ text, source: name, at: Date.now() });
    } catch (err) {
      errors.push(name + ': ' + (err && err.message ? err.message : String(err)));
    }
  }
  const seen = new Set();
  const unique = collected.filter(k => {
    const key = k.text.toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    items: unique.slice(0, Math.max(1, limit)),
    sources: chosen,
    errors
  };
}

/** 接口与原版一致：返回 { queries, usedWords, trendCount } */
async function buildQueries(count, usedList) {
  /* 严格运行模式：只用本次抓取的「当日热搜原文」；不足 5 字的单调词、
     历史缓存词、本地词库、相关延伸 / autosuggest 一律不参与选词。 */
  const pool = await getKeywordPool(Math.max(24, count * 3));
  if (!pool.items.length) {
    throw new Error(bgMsg('topics') + ' (' + pool.errors.join(' / ').slice(0, 180) + ')');
  }
  const built = HSA_CORE.strictQueries(count, pool.items, Date.now());
  if (!built.queries.length) {
    throw new Error(bgMsg('strictNoWords') + ' (短词 ' + built.droppedShort
      + ' / 非当日 ' + built.droppedStale + ')');
  }
  console.info('[HumanSearch] 严格模式 · 当日热搜 ' + pool.sources.join('+')
    + ' · 合规词 ' + built.queries.length + '/' + built.requested
    + ' · 丢弃短词 ' + built.droppedShort + ' / 非当日 ' + built.droppedStale
    + ' / 重复 ' + built.droppedDuplicate);
  return {
    /* 词不够就少跑几轮：不补词、不拼接、不复用、不循环重复。 */
    queries: built.queries,
    usedWords: (usedList || []).concat(built.queries).slice(-DESKTOP_MEM.usedWordsMax), // v2.9：上限 160
    trendCount: pool.items.length,
    strict: built
  };
}

/** 相关延伸：Bing 官方 autosuggest，失败返回空数组，不编词。 */
async function suggestRelated(query) {
  const q = cleanKeyword(query);
  if (!validKeyword(q)) return [];
  const url = 'https://www.bing.com/AS/Suggestions?pt=page.home&mkt=zh-CN&q=' + encodeURIComponent(q);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      credentials: 'omit',
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' }
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out = [];
    for (const re of [
      /<a\b[^>]*>([\s\S]*?)<\/a>/gi,
      /"query"\s*:\s*"([^"\\]{2,60})"/g,
      /"text"\s*:\s*"([^"\\]{2,60})"/g
    ]) {
      for (const m of String(html).matchAll(re)) out.push(m[1]);
    }
    return [...new Set(out.map(cleanKeyword).filter(validKeyword))]
      .filter(t => t.toLowerCase() !== q.toLowerCase())
      .slice(0, 12);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------- 页面内定位 / 合成事件降级 */
async function probe(tabId, selectors) {
  return inject(tabId, sels => {
    for (const s of sels) {
      let el = null;
      try { el = document.querySelector(s); } catch { continue; }
      if (!el) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      return {
        selector: s,
        box: { x: b.x, y: b.y, w: b.width, h: b.height },
        text: (el.innerText || el.textContent || '').trim().slice(0, 80),
        href: el.href || ''
      };
    }
    return null;
  }, [selectors]);
}

/** 从当前 Bing 结果页抓「相关搜索 / 也有人搜」，只读可见链接文本与 href 里的 q=。 */
async function relatedSearches(tabId) {
  const raw = await inject(tabId, sels => {
    const out = [];
    const seen = new Set();
    const add = value => {
      const t = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 30 || t.length < 2 || seen.has(t)) return;
      if (/^(https?:|www\.|bing\.com|microsoft)/i.test(t)) return;
      if (!/[a-zA-Z0-9\u3400-\u9fff]/.test(t)) return;
      seen.add(t);
      out.push(t);
    };
    for (const s of sels) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(s)]; } catch { continue; }
      for (const a of nodes) {
        const b = a.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) continue;
        add(a.innerText || a.textContent);
        try {
          const href = a.getAttribute('href') || '';
          const m = href.match(/[?&]q=([^&]+)/);
          if (m) add(decodeURIComponent(m[1].replace(/\+/g, ' ')));
        } catch {}
      }
    }
    return out.slice(0, 24);
  }, [RELATED_SELECTORS]);
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map(cleanKeyword).filter(validKeyword))].slice(0, 20);
}

async function domClearInput(tabId) {
  return inject(tabId, sels => {
    const find = s => { for (const sel of s) { const e = document.querySelector(sel); if (e && !e.disabled && !e.readOnly) return e; } return null; };
    const el = find(sels) || document.activeElement;
    if (!el) return false;
    try {
      el.focus();
      if (typeof el.select === 'function') el.select();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch { return false; }
  }, [SEARCH_INPUTS]);
}

async function domInput(tabId, text) {
  return inject(tabId, (sels, value) => {
    const find = s => { for (const sel of s) { const e = document.querySelector(sel); if (e && !e.disabled && !e.readOnly) return e; } return null; };
    const el = find(sels) || document.activeElement;
    if (!el) return false;
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    let inserted = false;
    try { el.focus(); inserted = document.execCommand('insertText', false, value); } catch {}
    if (!inserted || el.value !== value) {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }, [SEARCH_INPUTS, text]);
}

async function domClick(tabId, x, y) {
  return inject(tabId, (cx, cy) => {
    const el = document.elementFromPoint(cx, cy) || document.activeElement;
    if (!el) return false;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0
      }));
    }
    return true;
  }, [x, y]);
}

async function domKey(tabId, key) {
  return inject(tabId, (sels, k) => {
    const find = s => { for (const sel of s) { const e = document.querySelector(sel); if (e && !e.disabled && !e.readOnly) return e; } return null; };
    const el = find(sels) || document.activeElement;
    if (!el) return false;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
    const form = el.form || (el.closest && el.closest('form'));
    if (k === 'Enter' && form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    }
    return true;
  }, [SEARCH_INPUTS, key || 'Enter']);
}

async function domWheel(tabId, dy) {
  return inject(tabId, d => { window.scrollBy({ top: d, behavior: 'smooth' }); return true; }, [dy]);
}

/* ------------------------------------------- chrome.debugger / CDP 真实输入 */
async function cdpAttach(tabId) {
  if (haltFlag || !USE_REAL_INPUT) return false;
  const id = Number(tabId);
  if (cdpAttached.has(id)) return true;
  let tab = null;
  try { tab = await chrome.tabs.get(id); } catch { return false; }
  if (!tab || !/^https:\/\/[^\/]*bing\.com\//i.test(String(tab.url || ''))) return false;
  try {
    await chrome.debugger.attach({ tabId: id }, '1.3');
    if (haltFlag) {
      try { await chrome.debugger.detach({ tabId: id }); } catch {}
      return false;
    }
    cdpAttached.add(id);
    // 让页面始终「自认为」有焦点：不抢可见焦点也能避免后台页自身被挂起
    try {
      await chrome.debugger.sendCommand({ tabId: id },
        'Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch {}
    return true;
  } catch {
    return false;
  }
}

async function cdpDetachAll() {
  for (const id of [...cdpAttached]) {
    try { await chrome.debugger.detach({ tabId: id }); } catch {}
    cdpAttached.delete(id);
  }
}

async function cdpCmd(tabId, method, params) {
  if (haltFlag) throw STOP;
  const id = Number(tabId);
  if (!cdpAttached.has(id)) {
    const ok = await cdpAttach(tabId);
    if (!ok || haltFlag) throw STOP;
  }
  if (haltFlag) throw STOP;
  return chrome.debugger.sendCommand({ tabId: id }, method, params || {});
}

async function cdpMousePath(tabId, path) {
  for (const p of path || []) {
    await cdpCmd(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0
    });
    if (p.dt > 0) await sleep(Math.min(p.dt, 120));
  }
}

async function cdpClickPlan(tabId, plan) {
  await cdpMousePath(tabId, plan.path);
  await sleep(plan.beforeMs || 0);
  const [x, y] = plan.center;
  await cdpCmd(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1
  });
  await sleep(plan.downMs || 60);
  await cdpCmd(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1
  });
}

async function cdpClickAt(tabId, x, y) {
  await cdpCmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(70);
  await cdpCmd(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1
  });
  await sleep(65);
  await cdpCmd(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1
  });
}

/** 粘贴前清空：Ctrl+A 全选 → Backspace 删除。rawKeyDown 不带 text，避免插入字母 a。 */
async function cdpClearInput(tabId) {
  const ctrlA = {
    key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2
  };
  await cdpCmd(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ctrlA });
  await sleep(30);
  await cdpCmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...ctrlA });
  await sleep(40);
  await cdpKey(tabId, 'Backspace');
  await sleep(50);
}

async function cdpInsertText(tabId, text) {
  await cdpCmd(tabId, 'Input.insertText', { text: String(text) });
}

async function cdpKey(tabId, key) {
  const map = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }
  };
  const k = map[key] || map.Enter;
  await cdpCmd(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
  await sleep(35);
  await cdpCmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

async function cdpWheel(tabId, dy) {
  await cdpCmd(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: dy, button: 'none'
  });
}

/* --------------------------------------------------------------- 拟人动作计划 */
/** 最小急动度速度剖面 + 二次贝塞尔 + 手抖，产出 [{x,y,dt}]。 */
function jerk(t) { return 30 * t * t - 60 * t * t * t + 30 * t ** 4; }

function mousePath(from, to, level = 3) {
  const p = profileOf(level);
  const [lo, hi] = p.steps;
  const steps = lo + Math.floor(Math.random() * (hi - lo + 1));
  const [x0, y0] = from;
  const [x1, y1] = to;
  const cx = x0 + (x1 - x0) * rand(0.2, 0.5) + rand(-60, 60);
  const cy = y0 + (y1 - y0) * rand(0.1, 0.6) + rand(-40, 40);
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const raw = i / steps;
    const t = raw * raw * (3 - 2 * raw);
    let x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1;
    let y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1;
    if (i > 0 && i < steps) { x += rand(-1.5, 1.5); y += rand(-1.5, 1.5); }
    const v = jerk((i + 0.5) / steps);
    const dt = rand(0.006, 0.03) * (1 / Math.max(0.25, v * 1.6)) * (4 - level) * 0.6;
    points.push({ x, y, dt: Math.min(dt, 0.09) * 1000 });
  }
  // 真人瞄不准会冲过去再拉回来
  const dist = Math.hypot(x1 - x0, y1 - y0);
  if (Math.random() < p.overshoot && dist > 80) {
    const ux = (x1 - x0) / dist, uy = (y1 - y0) / dist;
    const over = rand(4, 18);
    points.push({ x: x1 + ux * over, y: y1 + uy * over, dt: 40 });
    points.push({ x: x1 + rand(-2, 2), y: y1 + rand(-2, 2), dt: 60 });
  }
  return points;
}

/* 严格运行模式：固定中心点击，不生成拟人轨迹 / 过冲 / 随机延时。 */
function strictClickPlan(box) {
  return { center: [box.x + box.w / 2, box.y + box.h / 2] };
}

function humanClickPlan(box, from, level = 3) {
  const cx = box.x + box.w * rand(0.25, 0.75);
  const cy = box.y + box.h * rand(0.3, 0.7);
  return {
    center: [cx, cy],
    path: mousePath(from, [cx, cy], level),
    beforeMs: rand(50, 300),
    downMs: rand(20, 100)
  };
}

function scrollPlan(level = 3) {
  const p = profileOf(level);
  const total = Math.round(p.screens * 900);
  const [lo, hi] = p.scroll;
  const out = [];
  let moved = 0, elapsed = 0;
  while (moved < total && elapsed < 8) {
    const dy = Math.random() < 0.85 ? rand(220, 620) : -rand(80, 260);
    const dt = rand(lo, hi);
    out.push({ dy, dt });
    moved += Math.abs(dy);
    elapsed += dt;
  }
  if (Math.random() < 0.4 && elapsed < 8) out.push({ dy: -rand(120, 400), dt: rand(0.5, 1.5) });
  return out;
}

/* ----------------------------------------------------------- 导航（作用域页） */
async function navigateSearch(tabId, url, test, token) {
  bail(token);
  let cur = null;
  try { cur = await chrome.tabs.get(tabId); } catch { return null; }
  if (cur.url === url) { await nap(1100, token); return cur; }
  const loaded = waitForTab(tabId, test, PAGE_TIMEOUT, false);
  await chrome.tabs.update(tabId, { url });
  const tab = await loaded;
  await nap(450, token);
  return tab;
}

async function goBackSearch(tabId, token) {
  try { await chrome.tabs.goBack(tabId); } catch {}
  await nap(900, token);
}

/* ============================================================================
 * 搜索主循环：替换原版「随机英文词 → 首页逐字输入 → 直接跳转 URL」的单调路径。
 * 积分检测 / 每日上限 / 冷却逻辑沿用原版，插在每轮末尾。
 * ========================================================================== */
async function searchLoop(token) {
  let failures = 0;

  let tabId = null;
  let realInput = false;
  let lastQuery = '';
  let lastXY = [120, 140];
  const modeCount = { paste: 0, related: 0, home: 0, stay: 0 };
  /* 严格运行模式：拟人强度 / 随机停留不再参与运行，全部改为固定节奏。 */
  const STRICT_POLICY = HSA_CORE.strictRunPolicy();
  console.info('[HumanSearch] 严格运行模式：仅当日 ≥' + STRICT_POLICY.minKeywordChars
    + ' 字热搜词，运行期禁用其它功能');

  try {
    tabId = await openOrNavigate('searchTabId', HOME_URL, true);
    bail(token);
    await keepSearchTabAwake(tabId);          // 前台 + 焦点，避免后台节流把搜索挂起
    await waitForTab(tabId, isBingHome, PAGE_TIMEOUT, true);
    bail(token);
    realInput = await cdpAttach(tabId);
    await keepSearchTabAwake(tabId);
    console.info('[HumanSearch] 输入方式：' + (realInput ? 'CDP 真实键鼠' : '页面内合成事件'));
  } catch (err) {
    if (err === STOP) throw err;
    tabId = await openOrNavigate('searchTabId', HOME_URL, true);
    await keepSearchTabAwake(tabId);
    realInput = false;
  }

  while (isCurrent(token) && !haltFlag) {
    // 用户中途切走 → 下一轮拉回焦点；后台标签页被节流是「搜索暂停」的主因
    await keepSearchTabAwake(tabId);
    bail(token);
    const st = await load(['currentSearch', 'totalSearch', 'searchQueue', 'stopRequested']);
    const current = st.currentSearch || 0;
    if (st.stopRequested || current >= st.totalSearch) return;
    const baseQuery = st.searchQueue && st.searchQueue[current];
    if (!baseQuery) return;
    /* 严格运行模式：运行期再次确认词长，防止外部写入少于 5 字的短词。 */
    if (!HSA_CORE.isStrictKeyword(baseQuery)) throw new Error(bgMsg('strictNoWords'));

    /* 严格运行模式：固定节奏，不启用拟人强度 / 随机停留 / 改词 / 回首页。 */
    let keyword = baseQuery;
    let method = '';
    let searched = false;

    try {
      /* 严格运行模式：禁用相关延伸 / autosuggest 改词，关键词只能是当日热搜池原文。 */
      {
        method = '粘贴关键词';
        let box = await probe(tabId, SEARCH_INPUTS);
        bail(token);
        if (!box) {
          await navigateSearch(tabId, HOME_URL, isBingHome, token);
          box = await probe(tabId, SEARCH_INPUTS);
          bail(token);
        }
        if (!box) throw new Error('找不到 Bing 搜索框');

        /* 严格运行模式：固定中心点击，不使用拟人轨迹与过冲。 */
        const plan = strictClickPlan(box.box);
        lastXY = plan.center;
        if (realInput) await cdpClickAt(tabId, plan.center[0], plan.center[1]);
        else await domClick(tabId, plan.center[0], plan.center[1]);
        await nap(STRICT.fixedNapMs, token);

        // 关键一步：粘贴前清空
        if (realInput) await cdpClearInput(tabId);
        else await domClearInput(tabId);
        await nap(STRICT.fixedNapMs, token);

        if (realInput) await cdpInsertText(tabId, keyword);
        else await domInput(tabId, keyword);
        await nap(STRICT.fixedNapMs, token);

        /* 严格运行模式：固定 Enter 提交，不随机切换按钮 / 回车。 */
        if (realInput) await cdpKey(tabId, 'Enter');
        else await domKey(tabId, 'Enter');
        const result = await waitForTab(tabId, isBingSearch, PAGE_TIMEOUT, true);
        searched = !!result && isBingSearch(result.url);
        if (!searched) {
          // 表单提交没落到结果页时，与原版一样直接把查询词换到地址上
          await navigateSearch(tabId, directSearchUrl(keyword), isBingSearch, token);
          const afterDirect = await chrome.tabs.get(tabId).catch(() => null);
          searched = !!afterDirect && isBingSearch(afterDirect.url);
        }
        modeCount.paste++;
      }

      modeCount.stay++;
      lastQuery = keyword;
      await store({ currentQuery: keyword });
      console.info(`[HumanSearch] [${current + 1}/${st.totalSearch}] ${keyword} · ${method}`
        + ' · 严格模式');
      hsaRunLog('search', {
        level: 'info', actor: 'system', category: 'run-step',
        state: 'searching', query: keyword, page: 'bing-search',
        zh: '第 ' + (current + 1) + '/' + st.totalSearch + ' 轮搜索：' + keyword,
        en: 'Search ' + (current + 1) + '/' + st.totalSearch + ': ' + keyword,
        detail: '严格模式：当日 ≥5 字热搜原文「' + keyword + '」→ 固定点击 → 输入 → Enter → 页面稳定等待',
        result: 'query submitted', count: current + 1
      }).catch(() => {});
      bail(token);
    } catch (err) {
      if (err === STOP || haltFlag) throw STOP;
      console.warn('[HumanSearch] 本轮异常：', err && err.message ? err.message : String(err));
    }

    if (!isCurrent(token) || haltFlag) return;

    if (!searched) {
      failures++;
      if (failures >= MAX_FAILURES) throw new Error(bgMsg('network'));
      await nap(STRICT.fixedNapMs, token);
      continue;
    }
    failures = 0;

    /* 严格运行模式：禁用滚动 / 点结果 / 随机停留，只保留页面稳定等待（T07）。 */
    try {
      await nap(STRICT_POLICY.pageStableWaitMs, token);
    } catch (err) {
      if (err === STOP || haltFlag) throw STOP;
    }

    if (!isCurrent(token) || haltFlag) return;
    await store({ currentSearch: current + 1, lastActivity: Date.now() });

    /* v1.3.0：搜索中间不进行任何积分 / 任务列表同步。
       次数已在开始时按官方配额锁定，跑满即收尾；
       autoStop、冷却等待都需要中途积分信号，与新流程冲突，一并停用。
       这里仍只写 currentSearch 供进度环显示，不触发界面数值刷新。 */
    if (current + 1 < st.totalSearch && !haltFlag) {
      await nap(STRICT.fixedRoundIntervalMs, token);
    }
  }

  console.info('[HumanSearch] 严格运行模式：当日热搜词 ' + modeCount.paste + ' 次'
    + ' · 禁用改词 / 回首页 / 拟人随机 / 滚动 / 点结果');
}

/* 提醒预览用的主题词也改走真实热搜池（失败时不编词，退回 Bing 首页）。 */
async function previewTopic() {
  /* 严格运行模式：运行期禁用提醒预览，不额外抓词。 */
  if (strictRunActive && !HSA_CORE.strictRuntimeFeatureAllowed('preview-topic', true)) return null;
  try {
    const pool = await getKeywordPool(12);
    return pool.items.length ? pickOne(pool.items).text : null;
  } catch {
    return null;
  }
}

function waitForTab(tabId, test, timeout, checkNow) {
  return new Promise(resolve => {
    let done = false;
    const finish = tab => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(tab);
    };
    const onUpdated = (id, info, tab) => {
      if (id === tabId && tab.status === 'complete' && test(tab.url)) finish(tab);
    };
    const onRemoved = id => { if (id === tabId) finish(null); };
    const timer = setTimeout(() => {
      chrome.tabs.get(tabId).then(finish, () => finish(null));
    }, timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    if (checkNow) {
      chrome.tabs.get(tabId).then(
        tab => { if (tab.status === 'complete' && test(tab.url)) finish(tab); },
        () => finish(null)
      );
    }
  });
}

async function getTab(key) {
  const data = await load([key]);
  if (data[key] == null) return null;
  try { return await chrome.tabs.get(data[key]); } catch { return null; }
}

async function goto(key, url, test) {
  const existing = await getTab(key);
  if (!existing) {
    const tab = await chrome.tabs.create({ url, active: false });
    await store({ [key]: tab.id });
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch {}
    return waitForTab(tab.id, test, PAGE_TIMEOUT, true);
  }
  const loaded = waitForTab(existing.id, test, PAGE_TIMEOUT, false);
  await chrome.tabs.update(existing.id, { url });
  return loaded;
}

/** 无条件关闭并清空引用（测试清理等场景使用）。 */
async function forceCloseTab(key) {
  const data = await load([key]);
  if (data[key] != null) {
    try { await chrome.tabs.remove(data[key]); } catch {}
  }
  await store({ [key]: null });
}

/**
 * v1.8：任务相关标签页（rewardsTabId / taskClickTabId / 点击弹出的任务页）
 * 一律保留——不关闭、也不清空 id，让 openOrNavigate 复用同一个标签页，避免越堆越多。
 * 搜索标签页 searchTabId 仍走原逻辑，结束/停止时关闭。
 */
async function closeTab(key) {
  if (KEEP_TASK_TABS && TASK_TAB_KEYS.has(key)) return;
  return forceCloseTab(key);
}

/* -------- 焦点 / 前台保活：解决「搜索页不是焦点时自动搜索可能暂停」 -------- */
async function ensureTabActive(tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab) return false;
  try {
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    if (FOCUS_WINDOW_TOO && typeof tab.windowId === 'number') {
      // 窗口不在系统前台时 Chrome 同样会节流该窗口内的标签页
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
    }
  } catch {}
  return true;
}

/** CDP：把页面「视为」有焦点，避免 document.hasFocus()=false 引发的输入/定时器挂起。 */
async function cdpEmulateFocus(tabId) {
  if (!cdpAttached.has(Number(tabId))) return false;
  try {
    await chrome.debugger.sendCommand({ tabId: Number(tabId) },
      'Emulation.setFocusEmulationEnabled', { enabled: true });
    return true;
  } catch { return false; }
}

async function cdpBringToFront(tabId) {
  if (!cdpAttached.has(Number(tabId))) return false;
  try {
    await chrome.debugger.sendCommand({ tabId: Number(tabId) }, 'Page.bringToFront', {});
    return true;
  } catch { return false; }
}

/** 每轮搜索前调用：标签页 active + 窗口 focused + CDP 置前 + 焦点模拟。 */
async function keepSearchTabAwake(tabId) {
  if (!KEEP_SEARCH_TAB_FOCUSED) return;
  await ensureTabActive(tabId);
  await cdpBringToFront(tabId);
  await cdpEmulateFocus(tabId);
}

/** 搜索期间抢占了焦点，结束后把用户原来的标签页还回去。 */
async function restoreUserFocus() {
  if (!RESTORE_FOCUS_ON_FINISH) return;
  const { userActiveTabId } = await load(['userActiveTabId']);
  if (userActiveTabId == null) return;
  try { await chrome.tabs.update(Number(userActiveTabId), { active: true }); } catch {}
  await store({ userActiveTabId: null });
}

let lastInjectError = null;

/* ==========================================================================
 * A1 · 桌面壳适配（唯一改动点）：contextBridge 函数序列化
 *
 * Electron 45 / Chromium 156 的 contextBridge 会把跨世界的函数变成代理，
 * toString() === 'function () { [native code] }'。主进程把这段字符串拼成
 * `const __fn = function () { [native code] };` 后 V8 直接抛
 * `SyntaxError: Unexpected identifier 'code'`（用户 debug 现场 855 次）。
 * 修法与上传版无关：在 main world 里先把 func.toString() 存成字符串
 * `funcSource` 随 spec 传入，preload.js 优先用 funcSource。
 * 除此之外三个 inject 函数的行为、参数、返回形状与上传版完全一致。
 * ========================================================================== */
function desktopInjectSpec(func, args) {
  return {
    funcSource: typeof func === 'function' ? Function.prototype.toString.call(func) : '',
    args: Array.isArray(args) ? args : (args == null ? [] : [args])
  };
}

async function inject(tabId, func, args) {
  try {
    const spec = desktopInjectSpec(func, args);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId }, funcSource: spec.funcSource, args: spec.args
    });
    lastInjectError = null;
    return res ? res.result : null;
  } catch (err) {
    lastInjectError = err && err.message ? err.message : String(err);
    console.warn('[Inject] executeScript 失败：' + lastInjectError);
    return null;
  }
}

/** v2.2：面板可能在 iframe 里 → 注入所有 frame，返回每条结果的 frameId。 */
async function injectAllFrames(tabId, func, args) {
  try {
    const spec = desktopInjectSpec(func, args);
    const list = await chrome.scripting.executeScript({
      target: { tabId }, allFrames: true, funcSource: spec.funcSource, args: spec.args
    });
    lastInjectError = null;
    const out = (list || []).map(r => ({ frameId: r.frameId, result: r.result, error: r.error ? String(r.error) : null }));
    for (const r of out) if (r.error) console.warn('[Inject] frame ' + r.frameId + ' 注入失败：' + r.error);
    return out;
  } catch (err) {
    lastInjectError = err && err.message ? err.message : String(err);
    console.warn('[Inject] allFrames 注入失败：' + lastInjectError);
    return [];
  }
}

/** 在指定 frame 里点击（iframe / shadow DOM 内的卡片必须回到原 frame）。 */
async function injectFrame(tabId, frameId, func, args) {
  try {
    const spec = desktopInjectSpec(func, args);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [Number(frameId)] }, funcSource: spec.funcSource, args: spec.args
    });
    return res ? res.result : null;
  } catch (err) {
    lastInjectError = err && err.message ? err.message : String(err);
    console.warn('[Inject] frame ' + frameId + ' 注入失败：' + lastInjectError);
    return null;
  }
}

async function readAvailablePoints() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const num = s => {
    const n = parseInt(String(s).replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const findKey = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 6) return null;
    if (typeof o.availablePoints === 'number') return o.availablePoints;
    for (const v of Object.values(o)) {
      const r = findKey(v, depth + 1);
      if (r !== null) return r;
    }
    return null;
  };
  const fromApi = async () => {
    try {
      const res = await fetch('/api/getuserinfo?type=1', { credentials: 'include', cache: 'no-store', redirect: 'error' });
      if (!res.ok) return null;
      return findKey(await res.json(), 0);
    } catch {
      return null;
    }
  };
  const isNumber = t => /^\d[\d,.\s  ]{0,12}$/.test(t);
  const fromCard = () => {
    const scopes = [];
    const icon = document.querySelector('img[alt="Available points" i]');
    if (icon && icon.parentElement) scopes.push(icon.parentElement);
    for (const el of document.querySelectorAll('p, span, h2, h3, div')) {
      if (el.children.length === 0 && /^\s*available points\s*$/i.test(el.textContent)) {
        const card = el.parentElement && el.parentElement.parentElement;
        if (card) scopes.push(card);
      }
    }
    for (const scope of scopes) {
      const big = scope.querySelector('.text-pageHeader');
      if (big && isNumber(big.textContent.trim())) return num(big.textContent);
      for (const leaf of scope.querySelectorAll('p, span, div')) {
        const t = leaf.textContent.trim();
        if (leaf.children.length === 0 && isNumber(t)) return num(t);
      }
    }
    return null;
  };
  const fromData = () => {
    const html = document.documentElement.innerHTML;
    for (const re of [/\\?"availablePoints\\?"\s*:\s*(\d+)/, /\\?"balance\\?"\s*:\s*(\d+)/]) {
      const m = html.match(re);
      if (m) return num(m[1]);
    }
    return null;
  };
  const fromText = () => {
    const body = document.body;
    if (!body) return null;
    for (const t of [body.innerText, body.textContent]) {
      const m = (t || '').match(/Available points?[^\dA-Za-z]{0,24}(\d[\d,.  ]*)/i);
      if (m) return num(m[1]);
    }
    for (const sel of ['.mee-rewards-user-status-balance', '#balanceToolTipDiv .pointsValue', '.pointsValue']) {
      for (const el of document.querySelectorAll(sel)) {
        const t = el.textContent.trim();
        if (/^[\d,.\s]{1,9}$/.test(t)) return num(t);
      }
    }
    return null;
  };

  let sawZero = false;
  for (let i = 0; i < 12; i++) {
    if (i % 4 === 0) {
      const api = await fromApi();
      if (api !== null && api > 0) return { ok: true, points: api };
    }
    for (const v of [fromCard(), fromData(), fromText()]) {
      if (v !== null && v > 0) return { ok: true, points: v };
      if (v === 0) sawZero = true;
    }
    await wait(1000);
  }
  if (sawZero) return { ok: true, points: 0 };
  const text = document.body ? document.body.innerText : '';
  const html = document.documentElement.innerHTML;
  const at = text.search(/points/i);
  return {
    ok: false,
    signedOut: /\bsign in\b/i.test(text) && !/available points/i.test(text),
    diag: {
      page: location.pathname,
      title: document.title,
      visible: document.visibilityState,
      keys: (html.match(/\\?"(availablePoints|balance|points|pointsBalance|userStatus)\\?"\s*:\s*[^,}\]]{0,20}/g) || []).slice(0, 6),
      text: text.slice(Math.max(0, at - 120), at + 180).replace(/\s+/g, ' ')
    }
  };
}

async function readSearchBreakdown() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const num = s => parseInt(String(s).replace(/\D/g, ''), 10);
  const pick = (a, b) => {
    const progress = num(a);
    const max = num(b);
    return Number.isFinite(progress) && Number.isFinite(max) && max > 0 ? { progress, max } : null;
  };
  const fromText = () => {
    const body = document.body;
    if (!body) return null;
    for (const t of [body.innerText, body.textContent]) {
      const m = (t || '').match(/(?:Bing|PC)\s+search[^\dA-Za-z]{0,12}(\d[\d,.]*)\s*\/\s*(\d[\d,.]*)/i);
      if (m) {
        const r = pick(m[1], m[2]);
        if (r) return r;
      }
    }
    return null;
  };
  const fromModel = () => {
    const clean = document.documentElement.innerHTML.replace(/\\\\"/g, '"').replace(/\\"/g, '"');
    const block = clean.match(/"pointsCounters"\s*:\s*\{[\s\S]{0,600}?"(?:pc|pcSearch|combined|combinedSearch|search)"\s*:\s*\{([^{}]*)\}/);
    if (!block) return null;
    const max = block[1].match(/"max"\s*:\s*(\d+)/);
    const progress = block[1].match(/"progress"\s*:\s*(\d+)/);
    return max && progress ? pick(progress[1], max[1]) : null;
  };
  const fromRow = () => {
    for (const el of document.querySelectorAll('p, span, div, td, th')) {
      if (el.children.length > 0 || !/^\s*(bing|pc) search\s*$/i.test(el.textContent)) continue;
      const cell = el.parentElement && el.parentElement.children.length === 1 && el.parentElement.tagName !== 'TR'
        ? el.parentElement
        : el;
      let sib = cell.nextElementSibling;
      for (let n = 0; sib && n < 2; n++, sib = sib.nextElementSibling) {
        const m = sib.textContent.match(/(\d[\d,.]*)\s*\/\s*(\d[\d,.]*)/);
        if (m) {
          const r = pick(m[1], m[2]);
          if (r) return r;
        }
      }
    }
    return null;
  };
  const fromData = () => {
    const seg = document.documentElement.innerHTML.match(/\\?"pcSearch\\?"\s*:\s*\[[\s\S]{0,800}?\]/);
    if (!seg) return null;
    const p = seg[0].match(/\\?"pointProgress\\?"\s*:\s*(\d+)/);
    const m = seg[0].match(/\\?"pointProgressMax\\?"\s*:\s*(\d+)/);
    return p && m ? pick(p[1], m[1]) : null;
  };
  const fromApi = async () => {
    try {
      const res = await fetch('/api/getuserinfo?type=1', { credentials: 'include', cache: 'no-store', redirect: 'error' });
      if (!res.ok) return null;
      const data = await res.json();
      const list = data && data.dashboard && data.dashboard.userStatus &&
        data.dashboard.userStatus.counters && data.dashboard.userStatus.counters.pcSearch;
      if (!Array.isArray(list) || !list.length) return null;
      const progress = list.reduce((s, c) => s + (c.pointProgress || 0), 0);
      const max = list.reduce((s, c) => s + (c.pointProgressMax || 0), 0);
      return max > 0 ? { progress, max } : null;
    } catch {
      return null;
    }
  };
  const findTrigger = () => {
    const clickable = document.querySelectorAll('a, button, [role="button"], [role="link"]');
    for (const el of clickable) {
      if (/points breakdown/i.test((el.innerText || el.textContent || '').trim())) return el;
    }
    for (const el of document.querySelectorAll('span, div, p')) {
      if (/^\s*points breakdown\s*$/i.test(el.textContent || '')) {
        return el.closest('a, button, [role="button"], [role="link"]') || el;
      }
    }
    for (const el of clickable) {
      const t = (el.innerText || '').trim();
      if (/today['’]s points/i.test(t) && t.length < 120) return el;
    }
    return null;
  };
  const press = el => {
    const rect = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    };
    const ptr = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 }, base);
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ buttons: 1, pressure: 0.5 }, ptr)));
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1, detail: 1 }, base)));
    el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ buttons: 0, pressure: 0 }, ptr)));
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0, detail: 1 }, base)));
    el.dispatchEvent(new MouseEvent('click', Object.assign({ buttons: 0, detail: 1 }, base)));
  };
  const isOpen = el =>
    !!document.querySelector('[role="dialog"], [aria-modal="true"]') ||
    (el && el.getAttribute('aria-expanded') === 'true');
  const activate = (el, mode) => {
    if (mode === 0) {
      press(el);
    } else if (mode === 1) {
      try { el.focus({ preventScroll: true }); } catch {}
      for (const type of ['keydown', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
    } else {
      el.click();
    }
  };
  let clicked = false;
  let attempts = 0;
  let lastAttempt = -10;
  for (let i = 0; i < 20; i++) {
    const r = fromModel() || fromRow() || fromText() || fromData();
    if (r) return { ok: true, search: r };
    if (document.readyState !== 'loading' && attempts < 6 && i - lastAttempt >= 3) {
      const el = findTrigger();
      if (el && !isOpen(el)) {
        const laidOut = el.getBoundingClientRect().width > 0;
        if (laidOut || i >= 8) {
          activate(el, laidOut ? attempts % 3 : 1);
          clicked = true;
          attempts++;
          lastAttempt = i;
        }
      }
    }
    if (i === 12) {
      const api = await fromApi();
      if (api) return { ok: true, search: api };
    }
    await wait(1000);
  }
  const text = document.body ? document.body.innerText : '';
  const at = text.search(/today['’]s activity|bing search/i);
  return {
    ok: false,
    diag: {
      page: location.pathname,
      title: document.title,
      clicked,
      text: (at >= 0 ? text.slice(at, at + 220) : text.slice(0, 220)).replace(/\s+/g, ' ')
    }
  };
}


const pathStarts = (url, prefix) => {
  const u = parseUrl(url);
  return !!u && u.pathname.toLowerCase().startsWith(prefix);
};

async function openOrNavigate(key, url, active = false) {
  const existing = await getTab(key);
  if (existing) {
    await chrome.tabs.update(existing.id, active ? { url, active: true } : { url });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url, active });
  await store({ [key]: tab.id });
  try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch {}
  return tab.id;
}

async function waitForSettled(tabId, deadline) {
  let lastUrl = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return null; }
    if (tab.status === 'complete' && tab.url) {
      if (tab.url !== lastUrl) {
        lastUrl = tab.url;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= SETTLE_MS) {
        return tab;
      }
    } else {
      lastUrl = null;
    }
    await sleep(400);
  }
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

async function readRewardsPage(url, onTarget, reader, token) {
  const deadline = Date.now() + READ_DEADLINE;
  const tabId = await openOrNavigate('rewardsTabId', url);
  let loginSince = 0;
  let aboutSince = 0;
  let renavs = 0;
  let last = null;
  await sleep(800);

  while (Date.now() < deadline && isCurrent(token)) {
    const tab = await waitForSettled(tabId, deadline);
    if (!tab) break;

    if (isLogin(tab.url)) {
      loginSince = loginSince || Date.now();
      if (Date.now() - loginSince > LOGIN_GRACE_MS) return { ok: false, signedOut: true };
      await sleep(1000);
      continue;
    }
    loginSince = 0;

    if (isRewards(tab.url) && pathStarts(tab.url, '/about')) {
      aboutSince = aboutSince || Date.now();
      if (Date.now() - aboutSince > ABOUT_GRACE_MS) return { ok: false, signedOut: true };
      await sleep(1000);
      continue;
    }
    aboutSince = 0;

    if (!isRewards(tab.url) || !onTarget(tab.url)) {
      if (renavs >= 2) break;
      renavs++;
      await chrome.tabs.update(tabId, { url });
      await sleep(800);
      continue;
    }

    last = await inject(tabId, reader);
    if (last && (last.ok || last.signedOut)) return last;
    await sleep(1000);
  }
  let finalUrl = null;
  try { finalUrl = (await chrome.tabs.get(tabId)).url; } catch {}
  const result = last || { ok: false };
  if (!result.ok) {
    result.diag = Object.assign(
      { target: url, tabUrl: finalUrl, injectError: lastInjectError },
      result.diag || { note: 'page never became readable' }
    );
    console.warn('[Rewards Automator] Could not read', result.diag);
  }
  return result;
}

const decodePayload = html => html.replace(/\\\\"/g, '"').replace(/\\"/g, '"');

function parseBalance(html) {
  const clean = decodePayload(html);
  let m = clean.match(/"(?:availablePoints|balance)"\s*:\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  m = html.match(/Available points<\/p>[\s\S]{0,600}?text-pageHeader[^>]*>\s*([\d,.  ]+)\s*</i);
  if (m) {
    const n = parseInt(m[1].replace(/\D/g, ''), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseSearchCounter(html) {
  const clean = decodePayload(html);
  const block = clean.match(/"pointsCounters"\s*:\s*\{[\s\S]{0,600}?"(?:pc|pcSearch|combined|combinedSearch|search)"\s*:\s*\{([^{}]*)\}/);
  if (!block) return null;
  const max = block[1].match(/"max"\s*:\s*(\d+)/);
  const progress = block[1].match(/"progress"\s*:\s*(\d+)/);
  if (!max || !progress) return null;
  const result = { progress: parseInt(progress[1], 10), max: parseInt(max[1], 10) };
  return result.max > 0 ? result : null;
}

/* ==========================================================================
 * A2 · 桌面壳适配：Rewards 页面数据源换成「内置浏览器里的同一个页面」
 *
 * 上传版在这里用 fetch() 直接取 HTML（浏览器扩展的 service worker 可以）。
 * 桌面版按「全部功能都使用内置浏览器、助手页面与官网页面实际上是同一个页面」
  * 的要求，改为读内置 WebContentsView 里已渲染的完整 outerHTML。
 *
 * 关键：**返回形状严格等于上传版** { ok, status, url, html, error }，
 * 不附加 domText / domPoints / signedOut 等桌面自造判定字段。
 * 因此 fetchBothPages / isSignInPage / parsePointsTrio / parseSearchCounter /
 * cardsFromRewardsHtml / refreshTodayTasks 等全部下游函数逐字沿用上传版。
 *
 * 顺序：① 主进程在官网页面 did-finish-load 后写入的本地快照（含 html，纯本地读）；
 *      ② 实时向主进程要一次可见面板（侧栏真的停在目标路径时）；
 *      ③ 侧栏不在目标路径时，开一个隐藏数据视图读 outerHTML。
 * 三层都失败才返回 ok:false，绝不伪造登录页。
 * ========================================================================== */
function readPageHtml() {
  return {
    ok: true, url: location.href,
    html: document.documentElement.outerHTML,
    text: String(document.body && document.body.innerText || '').slice(0, 30000)
  };
}

function desktopSnapKey(path) {
  return /^\/earn/i.test(String(path || ''))
    ? 'visibleRewardsEarnSnapshot' : 'visibleRewardsSnapshot';
}

function desktopPageMatches(url, path) {
  const u = String(url || '');
  if (/^\/earn/i.test(String(path || ''))) return /\/earn(?:\/|[?#]|$)/i.test(u);
  return !/\/earn(?:\/|[?#]|$)/i.test(u);
}

/* D01=A（桌面宿主适配）：window.fetch 已被 host.html 代理为主进程 net.fetch，
   带同账号会话 Cookie，属于「最新官网原始网络数据」。解析不足时才读已渲染页面。 */
async function desktopFetchOfficialHtml(path) {
  try {
    const url = 'https://rewards.bing.com' + path;
    const res = await Promise.race([
      fetch(url, { credentials: 'include', cache: 'no-store' }),
      sleep(8000).then(() => null)
    ]);
    if (!res || !res.ok || typeof res.text !== 'function') return null;
    const html = String(await res.text() || '').slice(0, DESKTOP_MEM.htmlCacheMaxBytes);
    if (html.length < 800 || isSignInPage(html)) return null;
    return { ok: true, status: res.status || 200, url: res.url || url, html: html,
             source: 'official-network', collectedAt: Date.now() };
  } catch (err) { return null; }
}

async function desktopFetchFromSnapshot(path) {
  try {
    const got = await load([desktopSnapKey(path)]);
    const s = got && got[desktopSnapKey(path)];
    if (!s || !Number.isFinite(s.at) || Date.now() - s.at > 120000) return null;
    const html = String(s.html || '');
    if (html.length < 800) return null;
    if (!desktopPageMatches(s.url, path)) return null;
    desktopDebugHtml('read-snapshot-' + String(path).replace(/\W+/g, '_'), s.url, html,
      { source: 'visible-snapshot', bytes: html.length });
    return { ok: true, status: 200, url: s.url, html, source: 'snapshot' };
  } catch { return null; }
}

/* v1.3.1：把本次实时读到的可见面板结果留一份给 desktopSyncRewards 复用，
   避免统一同步再发一次跨进程注入（性能优化）。只缓存 5 分钟内的数据。 */
let desktopLastVisible = null;
let desktopLastVisibleAt = 0;

async function desktopFetchFromPanel(path) {
  try {
    const d = typeof window !== 'undefined' && window.__desktop &&
      typeof window.__desktop.readVisibleRewards === 'function'
      ? await Promise.race([
          window.__desktop.readVisibleRewards(),
          sleep(6000).then(() => null)
        ]) : null;
    if (d && d.ok && d.html && d.html.length >= 800) {
      desktopLastVisible = d;
      desktopLastVisibleAt = Date.now();
    }
    if (!d || !d.ok || !d.html || d.html.length < 800) return null;
    if (!desktopPageMatches(d.url, path)) return null;
    desktopDebugHtml('read-visible-panel-' + String(path).replace(/\W+/g, '_'), d.url, d.html,
      { source: 'visible-panel', bytes: d.html.length });
    return { ok: true, status: 200, url: d.url, html: d.html, source: 'panel' };
  } catch { return null; }
}

async function desktopFetchFromDataView(path, opts) {
  const url = 'https://rewards.bing.com' + path;
  const key = 'desktopDataTab_' + String(path).replace(/\W+/g, '_');
  const fresh = !!(opts && opts.fresh);
  let tabId = null;
  try {
    const existing = await getTab(key);
    if (existing) {
      tabId = existing.id;
      const cur = await chrome.tabs.get(tabId).catch(() => null);
      /* v1.3.3：手动刷新 / 开始 / 收尾都必须重新导航隐藏视图。
         旧版 URL 没变就复用上次加载的 DOM，用户完成部分日常任务后点「刷新」
         读到的还是几分钟前的旧页面 → 任务状态不变 → UI 看起来「不更新」。 */
      if (fresh || !cur || !isRewards(cur.url) || !desktopPageMatches(cur.url, path)) {
        await chrome.tabs.update(tabId, { url });
      }
    } else {
      const tab = await chrome.tabs.create({ url, active: false, dataOnly: true });
      tabId = tab.id;
      await store({ [key]: tabId });
    }
    const tab = await waitForSettled(tabId, Date.now() + READ_DEADLINE);
    if (!tab || !isRewards(tab.url)) return null;
    const d = await inject(tabId, readPageHtml);
    if (!d || !d.html || d.html.length < 800) return null;
    desktopDebugHtml('data-view-' + String(path).replace(/\W+/g, '_'), d.url, d.html,
      { source: 'data-view', bytes: d.html.length });
    return { ok: true, status: 200, url: d.url, html: d.html, source: 'data-view' };
  } catch (err) {
    return { ok: false, status: 0, url: null, html: '', error: String(err && err.message || err) };
  }
}

async function fetchRewardsPage(path, opts) {
  /* v1.3.0：搜索中间绝不进行积分同步。即便将来有新的调用点，也在这里硬拦。 */
  if (desktopSearchGuard) {
    desktopGuardBlocks++;
    return { ok: false, status: 0, url: null, html: '', error: 'mid-search sync blocked' };
  }
  desktopFetchCount++;
  desktopLastFetchAt = Date.now();
  let guardTimer = null;
  const guard = new Promise(resolve => {
    guardTimer = setTimeout(() => resolve({
      ok: false, status: 0, url: null, html: '', error: 'embedded read timed out'
    }), DIRECT_TIMEOUT + 8000);
  });
  const work = (async () => {
    /* D01=A：官网原始网络数据优先（解析不足时才读同账号已渲染页面）。
       D06=D：后台展示可复用 120 秒内快照；刷新 / 开始 / 收尾跳过缓存。 */
    const network = await desktopFetchOfficialHtml(path);
    if (network) return network;
    if (!(opts && opts.fresh)) {
      const snap = await desktopFetchFromSnapshot(path);
      if (snap) return snap;
    }
    const panel = await desktopFetchFromPanel(path);
    if (panel) return panel;
    /* v3.1 · noTabs：打开主界面 / 手动刷新等同步入口不创建隐藏取数视图，
       既不弹页面，也不与静默态的视图回收冲突。 */
    if (opts && opts.noTabs) {
      return { ok: false, status: 0, url: null, html: '', error: 'no-tabs sync' };
    }
    return await desktopFetchFromDataView(path, opts);
  })();
  try {
    return await Promise.race([work, guard]);
  } finally {
    /* 旧版 race 胜出后 20 秒定时器仍挂着，每次抓取泄漏一个 —— 这里清掉 */
    clearTimeout(guardTimer);
  }
}

let desktopFetchCount = 0;
let desktopLastFetchAt = 0;
const desktopRewardsFetchStats = () => ({ count: desktopFetchCount, lastAt: desktopLastFetchAt });
if (typeof window !== 'undefined') {
  try {
    window.__hsaRewardsFetchStats = desktopRewardsFetchStats;
    window.__hsaFetchGuardStats = () => ({ guard: desktopSearchGuard, blocks: desktopGuardBlocks });
  } catch {}
}

/** A9：debug 采集只在 HSA_DEBUG=1 时落盘，默认完全禁用。 */
function desktopDebugHtml(kind, url, html, meta) {
  try {
    const d = typeof window !== 'undefined' && window.__desktop;
    if (d && typeof d.saveHtml === 'function') d.saveHtml(kind, url, html, meta || {});
  } catch {}
}

const fetchInfo = r => ({ status: r.status, url: r.url, error: r.error || null, bytes: r.html.length });

async function directPoints() {
  const r = await fetchRewardsPage('/dashboard');
  return { points: r.ok ? parseBalance(r.html) : null, info: fetchInfo(r) };
}

async function directToday() {
  const r = await fetchRewardsPage('/earn');
  return {
    today: r.ok ? parseSearchCounter(r.html) : null,
    activities: r.ok ? todayActivitiesFrom(r.html) : null,
    info: fetchInfo(r)
  };
}

function todayActivitiesFrom(html) {
  const list = parseActivities(html)
    .filter(a => a.enabled && a.id !== 'bing')
    .map(({ id, name, done, total, unit }) => ({ id, name, done, total, unit }));
  const keep = keepEarningSummary(parseKeepEarning(html));
  if (keep) list.push(keep);
  return list;
}

function parseKeepEarning(html) {
  const clean = decodePayload(html);
  const at = clean.indexOf('"activityCards"');
  if (at < 0) return null;
  const open = clean.indexOf('[', at);
  if (open < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = open; i < clean.length && i < open + 60000; i++) {
    if (clean[i] === '[') depth++;
    else if (clean[i] === ']' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return null;
  const objs = [];
  let level = 0;
  let from = -1;
  for (let i = open + 1; i < end; i++) {
    const ch = clean[i];
    if (ch === '{') { if (level++ === 0) from = i; }
    else if (ch === '}' && level > 0 && --level === 0) objs.push(clean.slice(from, i + 1));
  }
  return objs.map(obj => {
    const str = re => { const m = obj.match(re); return m ? m[1] : null; };
    return {
      title: (str(/"title"\s*:\s*"([^"]*)"/) || 'Activity').replace(/\s+/g, ' ').trim(),
      points: Number(str(/"points"\s*:\s*(\d+)/)) || 0,
      done: /"isCompleted"\s*:\s*true/.test(obj),
      locked: /"isLocked"\s*:\s*true/.test(obj)
    };
  }).filter(c => !c.locked);
}

function keepEarningSummary(cards) {
  if (!cards || !cards.length) return null;
  const total = cards.reduce((s, c) => s + c.points, 0);
  const done = cards.filter(c => c.done).reduce((s, c) => s + c.points, 0);
  const left = cards.filter(c => !c.done).map(c => ({ title: c.title, points: c.points }));
  if (!total) {
    return { id: 'keepearning', name: 'Keep earning', done: cards.length - left.length, total: cards.length, unit: '', left };
  }
  return { id: 'keepearning', name: 'Keep earning', done, total, unit: 'pts', left };
}

const DEFAULT_SETTINGS = {
  defaultCount: 30,
  pace: 'normal',
  autoStop: true,
  reminderPerDay: 3,
  reminderGapHours: 2,
  reminderFrom: '08:00',
  reminderTo: '23:00',
  reminderSeconds: 5,
  reduceMotion: false,
  cardClickIntervalSec: HSA_CORE.DEFAULTS.cardClickIntervalSec,
  /* v1.3.8-s2：设置项反转为「不跳过已完成任务卡」，默认关闭 = 默认跳过已完成卡 */
  notSkipCompletedCards: false
};

async function getSettings() {
  const { settings } = await load(['settings']);
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

function holdRange(settings) {
  return settings.pace === 'relaxed' ? [22000, 32000] : [RESULT_HOLD_MIN, RESULT_HOLD_MAX];
}

function describeFailure(diag) {
  if (!diag) return '';
  if (diag.injectError) return ' Edge blocked page access: ' + diag.injectError;
  if (diag.direct && diag.direct.error) return ' Network: ' + diag.direct.error;
  if (diag.tabUrl) return ' Last page: ' + diag.tabUrl.replace(/^https?:\/\//, '');
  return '';
}

async function readPointsFromDashboard(token) {
  const direct = await directPoints();
  if (direct.points !== null) return { points: direct.points, signedOut: false, diag: null };
  if (!isCurrent(token)) return { points: null, signedOut: false, diag: null };
  const r = await readRewardsPage(DASHBOARD_URL, url => !pathStarts(url, '/earn'), readAvailablePoints, token);
  return {
    points: r.ok ? r.points : null,
    signedOut: !!r.signedOut,
    diag: r.ok ? null : Object.assign({ direct: direct.info }, r.diag)
  };
}

async function readTodaySearch(token) {
  const direct = await directToday();
  if (direct.activities) await store({ todayActivities: direct.activities, todayCheckedAt: Date.now() });
  if (direct.today) return { today: direct.today, live: true };
  if (!isCurrent(token)) return { today: null, live: false };
  const r = await readRewardsPage(EARN_URL, url => pathStarts(url, '/earn'), readSearchBreakdown, token);
  if (!r.ok && r.diag) await store({ diagLimit: Object.assign({ direct: direct.info }, r.diag) });
  return { today: r.ok ? r.search : null, live: false };
}

/* A5 · 桌面壳适配：空闲零抓取。上传版 refreshToday() 会在 reminder / 页面活动
 * 时顺手 refreshTodayTasks；桌面版只允许两个时机（点击开始、每轮搜索完成）。
 * directToday() 本身也走 fetchRewardsPage('/earn')，所以整段在空闲时必须不执行。 */
async function refreshToday() {
  if (!desktopFetchAllowed('refreshToday')) return;
  const { running } = await load(['running']);
  if (running) return;
  const { today, activities } = await directToday();
  const update = { todayCheckedAt: Date.now() };
  if (today) update.todaySearch = today;
  if (activities) update.todayActivities = activities;
  await store(update);
  refreshTodayTasks(flowToken).catch(() => {});
}

async function runFlow(token) {
  flowActive = true;
  try {
    let { phase } = await load(['phase']);

    if (phase === 'fetchingStartPoints') {
      const res = await readPointsFromDashboard(token);
      if (!isCurrent(token)) return;
      if (res.signedOut) {
        await closeTab('rewardsTabId');
        await finishWithError(bgMsg('signIn'));
        return;
      }
      const known = res.points !== null;
      await store({
        startPoints: known ? res.points : 0,
        startKnown: known,
        warning: known ? null : 'Could not read your starting points.' + describeFailure(res.diag),
        diag: known ? null : res.diag,
        phase: 'checkingLimit'
      });
    }

    ({ phase } = await load(['phase']));
    if (phase === 'checkingLimit') {
      const { today, live } = await readTodaySearch(token);
      await closeTab('rewardsTabId');
      if (!isCurrent(token)) return;
      const maxed = !!(today && today.progress >= today.max);
      await store({ todaySearch: today, todayStart: today, liveCheck: live, searchMaxedAtStart: maxed });
      if (maxed) {
        await finishLimitReached();
        return;
      } else {
        await store({ phase: 'searching' });
      }
    }

    ({ phase } = await load(['phase']));
    if (phase === 'searching') {
      await ensureQueue(token);
      if (!isCurrent(token)) return;
      desktopSearchGuard = true;
      try { await searchLoop(token); }
      finally { desktopSearchGuard = false; }
      if (!isCurrent(token)) return;
      if ((await load(['phase'])).phase === 'cooldown') return;
      await store({ phase: 'fetchingEndPoints' });
    }

    ({ phase } = await load(['phase']));
    if (phase === 'fetchingEndPoints') {
      await finishRun(token);
    }
  } catch (err) {
    if (!isCurrent(token)) return;
    if (err === STOP) {
      await store({ phase: 'fetchingEndPoints', stopRequested: false, currentQuery: null });
      await finishRun(token);
      return;
    }
    await closeTab('searchTabId');
    await closeTab('rewardsTabId');
    await finishWithError(bgMsg('runStopped', err && err.message ? err.message : String(err)));
  } finally {
    if (isCurrent(token)) flowActive = false;
  }
}

async function finishLimitReached() {
  await cdpDetachAll();
  const { startPoints, todaySearch } = await load(['startPoints', 'todaySearch']);
  await closeTab('searchTabId');
  await store({
    todayStart: todaySearch,
    endPoints: startPoints,
    finalEarned: 0,
    earnedIsEstimate: false,
    currentQuery: null,
    phase: 'limitReached',
    running: false
  });
  chrome.alarms.clear('watchdog');
  await restoreUserFocus();
}

async function endCooldown() {
  const st = await load(['running', 'phase']);
  if (!st.running || st.phase !== 'cooldown') return;
  chrome.alarms.clear('cooldownEnd');
  await store({ phase: 'searching', cooldownUntil: null });
  armOneShot('watchdog', 30 * 60 * 1000);
  if (!flowActive) runFlow(++flowToken);
}


function estimateEarned(searches, todayStart) {
  const est = searches * POINTS_PER_SEARCH;
  return todayStart ? Math.min(est, Math.max(0, todayStart.max - todayStart.progress)) : est;
}

async function finishRun(token) {
  await cdpDetachAll();
  await closeTab('searchTabId');
  const st = await load(['startPoints', 'startKnown', 'currentSearch', 'totalSearch',
                         'todaySearch', 'todayStart', 'runPreset']);
  const searches = st.currentSearch || 0;
  const start = st.startPoints || 0;

  /* v1.3.0：预设流程收尾只做一次两页同步，不再「读积分 + 读进度 + 刷任务」三连抓 */
  if (st.runPreset && st.runPreset.at) {
    await presetSyncFinish(st, searches, start);
    return;
  }

  await sleep(2000);
  let res = await readPointsFromDashboard(token);
  if (!isCurrent(token)) return;
  if (st.startKnown && searches > 0 && res.points !== null && res.points <= start) {
    await sleep(4000);
    const retry = await readPointsFromDashboard(token);
    if (!isCurrent(token)) return;
    if (retry.points !== null) res = retry;
  }
  const finalCheck = await directToday();
  if (finalCheck.activities) await store({ todayActivities: finalCheck.activities, todayCheckedAt: Date.now() });
  // 收尾阶段刷新今日任务但不阻塞流程（注入兜底最长可能等 25 秒）
  refreshTodayTasks(token).catch(() => {});
  const finalToday = finalCheck.today || st.todaySearch || null;
  await closeTab('rewardsTabId');
  if (!isCurrent(token)) return;

  const exact = st.startKnown && res.points !== null;
  let earned;
  if (exact) {
    earned = Math.max(0, res.points - start);
  } else if (st.todayStart && finalToday) {
    earned = Math.max(0, finalToday.progress - st.todayStart.progress);
  } else {
    earned = estimateEarned(searches, st.todayStart);
  }
  const endPoints = res.points !== null ? res.points : start + earned;

  await store({
    endPoints,
    finalEarned: earned,
    earnedIsEstimate: !exact,
    todaySearch: finalToday,
    lastRun: { at: Date.now(), searches, total: st.totalSearch, start, end: endPoints, earned, estimate: !exact },
    currentQuery: null,
    cooldownUntil: null,
    phase: 'completed',
    running: false,
    stopRequested: false
  });
  chrome.alarms.clear('watchdog');
  chrome.alarms.clear('cooldownEnd');
  await restoreUserFocus();
}

async function finishWithError(message) {
  await cdpDetachAll();
  await store({ phase: 'error', running: false, stopRequested: false, error: message });
  hsaRunLog('error', {
    level: 'error', actor: 'system', category: 'error',
    state: 'error', reason: 'run-failed', ok: false,
    zh: String(message || ''), en: String(message || ''),
    detail: '运行失败：' + String(message || ''),
    error: String(message || ''), result: 'failed'
  }).catch(() => {});
  chrome.alarms.clear('watchdog');
  await restoreUserFocus();
}

let queuePromise = null;


async function prepareQueue(token, count) {
  const { usedWords } = await load(['usedWords']);
  const built = await buildQueries(count, usedWords);
  if (isCurrent(token) && built.queries.length) {
    await store({
      searchQueue: built.queries,
      usedWords: built.usedWords,
      totalSearch: Math.min(count, built.queries.length)
    });
  }
  return built;
}

async function ensureQueue(token) {
  const hasQueue = async () => {
    const { searchQueue } = await load(['searchQueue']);
    return Array.isArray(searchQueue) && searchQueue.length > 0;
  };
  if (await hasQueue()) return;
  if (queuePromise) await queuePromise;
  if (await hasQueue()) return;
  const { totalSearch } = await load(['totalSearch']);
  await prepareQueue(token, totalSearch || 30);
  if (!(await hasQueue())) throw new Error(bgMsg('topics'));
}


async function handleStart(count, params) {
  if (flowActive) return;
  params = params || {};
  const runLevel = clampInt(Number(params.level) || 3, 1, 3);
  resetHalt();
  const token = ++flowToken;
  flowActive = true;
  try {
    await closeTab('searchTabId');
    await closeTab('rewardsTabId');
    if (RESTORE_FOCUS_ON_FINISH) {
      const cur = await load(['userActiveTabId']);
      if (cur.userActiveTabId == null) {
        const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
        const keep = Array.isArray(active) && active[0] && typeof active[0].id === 'number'
          ? active[0].id : null;
        await store({ userActiveTabId: keep });
      }
    }
    if (params.preset) {
      /* v1.3.0：开始时已同步过，直接进搜索阶段，不再重读 dashboard / earn。
         搜索次数 presetSearches 已锁定，整轮不再变化。 */
      const snap = await load(['startPoints', 'startKnown', 'todaySearch',
                               'todayStart', 'presetSearches']);
      await store({
        running: true, phase: 'searching',
        stopRequested: false, currentSearch: 0, totalSearch: count,
        searchQueue: [], currentQuery: null,
        startPoints: snap.startPoints || 0, startKnown: !!snap.startKnown,
        endPoints: 0, finalEarned: 0, earnedIsEstimate: false,
        todaySearch: snap.todaySearch || null, todayStart: snap.todayStart || null,
        liveCheck: false, stoppedEarly: false, searchMaxedAtStart: false,
        cooldownUntil: null, cooldownCycles: 0, cooldownGaveUp: false,
        error: null, warning: null, diag: null, diagLimit: null,
        lastActivity: Date.now(), runLevel,
        runAuto: !!params.auto, runAutoTime: params.time || null,
        presetSearches: snap.presetSearches == null ? count : snap.presetSearches
      });
    } else {
      await store({
        running: true,
        phase: 'fetchingStartPoints',
        stopRequested: false,
        currentSearch: 0,
        totalSearch: count,
        searchQueue: [],
        currentQuery: null,
        startPoints: 0,
        startKnown: false,
        endPoints: 0,
        finalEarned: 0,
        earnedIsEstimate: false,
        todaySearch: null,
        todayStart: null,
        liveCheck: false,
        stoppedEarly: false,
        searchMaxedAtStart: false,
        cooldownUntil: null,
        cooldownCycles: 0,
        cooldownGaveUp: false,
        error: null,
        warning: null,
        diag: null,
        diagLimit: null,
        lastActivity: Date.now(),
        runLevel,
        runAuto: !!params.auto,
        runAutoTime: params.time || null,
        runPreset: null, presetSearches: null
      });
    }
    armOneShot('watchdog', 30 * 60 * 1000);
    queuePromise = prepareQueue(token, count).catch(() => null);
    await runFlow(token);
  } catch (err) {
    if (isCurrent(token)) await finishWithError(bgMsg('startFailed', err.message));
  } finally {
    if (isCurrent(token)) flowActive = false;
  }
}

async function handleStop() {
  const { phase, running } = await load(['phase', 'running']);
  if (!running) return;

  if (phase === 'searching') {
    haltRun();
    await store({ stopRequested: true });
    resumeIfNeeded();
    return;
  }
  if (phase === 'cooldown') {
    haltRun();
    chrome.alarms.clear('cooldownEnd');
    await store({ phase: 'fetchingEndPoints', stopRequested: true, cooldownUntil: null });
    armOneShot('watchdog', 30 * 60 * 1000);
    resumeIfNeeded();
    return;
  }
  if (phase === 'fetchingEndPoints') return;

  flowToken++;
  flowActive = false;
  chrome.alarms.clear('watchdog');
  await closeTab('searchTabId');
  await closeTab('rewardsTabId');
  await store({ running: false, phase: 'idle', stopRequested: false, searchQueue: [], currentQuery: null });
  await restoreUserFocus();
}

// A run whose last sign of life is this old was cut off by the browser closing.
// Don't pick it up again on the next launch: it would start searching by itself
// with yesterday's start balance.
const STALE_RUN_MS = 30 * 60 * 1000;

async function resumeIfNeeded() {
  if (flowActive) return;
  const st = await load(['running', 'phase', 'cooldownUntil', 'lastActivity']);
  if (flowActive) return;
  if (st.running && Date.now() - Math.max(st.lastActivity || 0, st.cooldownUntil || 0) > STALE_RUN_MS) {
    flowToken++;
    chrome.alarms.clear('watchdog');
    chrome.alarms.clear('cooldownEnd');
    await closeTab('searchTabId');
    await closeTab('rewardsTabId');
    await store({ searchQueue: [], currentQuery: null, cooldownUntil: null });
    await finishWithError(bgMsg('stale'));
    return;
  }
  if (st.running && st.phase === 'cooldown') {
    if (Date.now() >= (st.cooldownUntil || 0)) endCooldown();
    return;
  }
  if (st.running && ACTIVE_PHASES.includes(st.phase)) {
    runFlow(++flowToken);
  } else {
    chrome.alarms.clear('watchdog');
  }
}

const REMINDER_ARM_MS = 20 * 60 * 1000;
const REMINDER_TICK_MINUTES = 30;
const ALL_SITES = { origins: ['<all_urls>'] };
let reminderBusy = false;

const todayKey = () => new Date().toLocaleDateString('en-CA');

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
}

function inActiveHours(settings, now = new Date()) {
  const from = toMinutes(settings.reminderFrom);
  const to = toMinutes(settings.reminderTo);
  if (from === null || to === null || from === to) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

function ensureReminderTick() {
  armOneShot('reminderTick', REMINDER_TICK_MINUTES * 60 * 1000);
}
const isRegularPage = url => { const u = parseUrl(url); return !!u && (u.protocol === 'https:' || u.protocol === 'http:'); };

function parseActivities(html) {
  const clean = decodePayload(html);
  const label = key => { const m = clean.match(new RegExp('"' + key + '"\\s*:\\s*"([^"]{1,40})"')); return m ? m[1] : null; };
  const out = [];
  const seen = new Set();
  for (const m of clean.matchAll(/"streak"\s*:\s*\{/g)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (let i = end; i < clean.length && i < end + 4000; i++) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}' && --depth === 0) { end = i; break; }
    }
    const seg = clean.slice(m.index, end + 1);
    const num = k => { const x = seg.match(new RegExp('"' + k + '"\\s*:\\s*(\\d+)')); return x ? Number(x[1]) : null; };
    const str = k => { const x = seg.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"')); return x ? x[1] : null; };
    const bool = k => { const x = seg.match(new RegExp('"' + k + '"\\s*:\\s*(true|false)')); return x ? x[1] === 'true' : null; };
    const titleKey = str('activityTitle');
    const done = num('activitiesCompleted');
    const total = num('activitiesTotal');
    if (!titleKey || seen.has(titleKey) || done === null || !total) continue;
    seen.add(titleKey);
    out.push({
      id: str('partner') || titleKey,
      name: label(titleKey) || titleKey.replace(/_activityTitle$/, ''),
      done: Math.min(done, total),
      total,
      unit: /^Minutes/.test(str('activitiesLabel') || '') ? 'min' : '',
      enabled: bool('isEnabled') !== false
    });
  }
  return out;
}

async function reminderPayload() {
  const r = await fetchRewardsPage('/earn');
  if (!r.ok) return null;
  const search = parseSearchCounter(r.html);
  const acts = parseActivities(r.html);
  const keep = keepEarningSummary(parseKeepEarning(r.html));
  if (!search && !acts.length && !keep) return null;
  let items = [];
  if (search) items.push({ id: 'search', name: 'Bing search', done: search.progress, total: search.max, unit: 'pts' });
  for (const a of acts) {
    if (a.enabled && a.id !== 'bing') items.push({ id: a.id, name: a.name, done: a.done, total: a.total, unit: a.unit });
  }
  items = keep ? [...items.slice(0, 4), keep] : items.slice(0, 5);
  const { uiTheme } = await load(['uiTheme']);
  const settings = await getSettings();
  return {
    items,
    left: items.filter(i => i.done < i.total).length,
    theme: uiTheme || null,
    duration: Math.min(30, Math.max(3, Number(settings.reminderSeconds) || 5)) * 1000,
    reduceMotion: !!settings.reduceMotion
  };
}

function showRewardsToast(data) {
  const ID = 'rewards-automator-toast';
  const old = document.getElementById(ID);
  if (old) old.remove();
  const dark = data.theme ? data.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const duration = data.duration || 5000;
  const calm = data.reduceMotion ? '.t,.r,.tm i{animation:none}.b i{transition:none}' : '';
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const css = `
    .t{--bg:${dark ? '#1A1A1F' : '#fff'};--fg:${dark ? '#ECEDEE' : '#11181C'};--mu:${dark ? '#9BA1A6' : '#687076'};
       --bd:${dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)'};--tr:${dark ? '#2A2A31' : '#E8ECF2'};
       --chip:${dark ? 'rgba(59,130,246,.16)' : '#EEF4FF'};--ac:${dark ? '#60A5FA' : '#0066FF'};--hv:${dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.05)'};
       width:320px;font:13px/1.4 'Segoe UI Variable','Segoe UI',system-ui,sans-serif;color:var(--fg);background:var(--bg);
       border:1px solid var(--bd);border-radius:16px;overflow:hidden;cursor:pointer;transform-origin:top right;
       box-shadow:0 14px 36px rgba(0,0,0,${dark ? '.45' : '.18'}),0 2px 6px rgba(0,0,0,.08);
       animation:in .55s cubic-bezier(.22,1.25,.36,1) both}
    .t.out{animation:out .26s ease-in both}
    @keyframes in{from{opacity:0;transform:translateX(28px) scale(.95)}to{opacity:1;transform:none}}
    @keyframes out{to{opacity:0;transform:translateX(28px) scale(.95)}}
    .h{display:flex;align-items:center;gap:10px;padding:14px 12px 10px 14px}
    .lg{width:30px;height:30px;border-radius:9px;flex-shrink:0;display:grid;place-items:center;color:#fff;
        background:linear-gradient(135deg,#0066FF,#00AAFF);box-shadow:0 3px 10px rgba(0,102,255,.35)}
    .tt{flex:1;min-width:0}.k{font-size:11px;font-weight:600;color:var(--mu)}.ti{font-size:14px;font-weight:700}
    .x{all:unset;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;color:var(--mu);cursor:pointer}
    .x:hover{background:var(--hv);color:var(--fg)}.x:focus-visible{outline:2px solid var(--ac)}
    .rs{display:flex;flex-direction:column;gap:10px;padding:2px 14px 14px}
    .r{display:grid;grid-template-columns:24px 1fr auto;align-items:center;column-gap:10px;row-gap:5px;animation:in .5s cubic-bezier(.22,1,.36,1) both}
    .ic{grid-row:span 2;width:24px;height:24px;border-radius:7px;background:var(--chip);color:var(--ac);display:grid;place-items:center}
    .n{font-weight:600;font-size:12.5px}.v{font-size:12px;font-weight:700;color:var(--mu);font-variant-numeric:tabular-nums}
    .b{grid-column:2/4;height:4px;border-radius:99px;background:var(--tr);overflow:hidden}
    .b i{display:block;height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,#0066FF,#00AAFF);transition:width .9s cubic-bezier(.22,1,.36,1)}
    .xl{grid-column:2/4;display:flex;flex-direction:column;gap:3px;margin-top:2px}
    .xi{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--mu)}
    .xi::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--ac);flex-shrink:0;opacity:.75}
    .xi span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .xi b{font-weight:700;color:var(--ac);font-variant-numeric:tabular-nums}
    .xi.m::before{background:transparent}
    .r.d .b i{background:#22C55E}.r.d .v{color:#16A34A}.r.d .ic{color:#16A34A;background:${dark ? 'rgba(34,197,94,.14)' : '#E7F8EE'}}
    .tm{height:3px;background:var(--tr)}.tm i{display:block;height:100%;transform-origin:left;background:linear-gradient(90deg,#0066FF,#00AAFF);animation:cd ${duration}ms linear forwards}
    .t:hover .tm i{animation-play-state:paused}@keyframes cd{to{transform:scaleX(0)}}
    @media (prefers-reduced-motion:reduce){.t,.r,.tm i{animation:none}.b i{transition:none}}${calm}`;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const st = document.createElement('style');
    st.textContent = css;
    root.appendChild(st);
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const icon = paths => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '14'); s.setAttribute('height', '14');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    for (const d of paths) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  };
  const ICONS = {
    search: ['M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z', 'M15.5 15.5L20 20'],
    dailyset: ['M7 4h10v14H7z', 'M4 7v13h11'],
    bingapp: ['M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5z', 'M11 18.5h2'],
    visualsearch: ['M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8', 'M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8', 'M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16', 'M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16', 'M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z'],
    done: ['M5 12.5l4.5 4.5L19 7.5'],
    keepearning: ['M4 10h16v10H4z', 'M3 6.5h18V10H3z', 'M12 6.5V20', 'M12 6.5C10.5 3 7 3.5 7.5 5.5 8 6.5 12 6.5 12 6.5z', 'M12 6.5c1.5-3.5 5-3 4.5-1-.5 1-4.5 1-4.5 1z'],
    other: ['M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z']
  };

  const toast = el('div', 't');
  toast.setAttribute('role', 'status');
  const head = el('div', 'h');
  const logo = el('div', 'lg');
  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.setAttribute('viewBox', '0 0 128 128');
  mark.setAttribute('width', '20');
  mark.setAttribute('height', '20');
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  mark.append(
    svgEl('circle', { cx: 52, cy: 52, r: 18, fill: '#FBBF24' }),
    svgEl('circle', { cx: 52, cy: 52, r: 29, fill: 'none', stroke: '#fff', 'stroke-width': 13 }),
    svgEl('path', { d: 'M73 73L96 96', stroke: '#fff', 'stroke-width': 16, 'stroke-linecap': 'round' })
  );
  logo.appendChild(mark);
  const titles = el('div', 'tt');
  titles.append(el('div', 'k', 'Microsoft Rewards'),
    el('div', 'ti', data.left ? `${data.left} left today` : 'All done today — nice work!'));
  const close = el('button', 'x');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.appendChild(icon(['M6 6l12 12', 'M18 6L6 18']));
  head.append(logo, titles, close);

  const rows = el('div', 'rs');
  const bars = [];
  data.items.forEach((it, i) => {
    const doneRow = it.done >= it.total;
    const row = el('div', 'r' + (doneRow ? ' d' : ''));
    row.style.animationDelay = `${140 + i * 70}ms`;
    const ic = el('div', 'ic');
    ic.appendChild(icon(doneRow ? ICONS.done : (ICONS[it.id] || ICONS.other)));
    const bar = el('div', 'b');
    const fill = el('i');
    bar.appendChild(fill);
    bars.push([fill, Math.round((it.done / it.total) * 100)]);
    row.append(ic, el('div', 'n', it.name), el('div', 'v', `${it.done}/${it.total}${it.unit ? ' ' + it.unit : ''}`), bar);
    const open = !doneRow && Array.isArray(it.left) ? it.left : [];
    if (open.length) {
      const list = el('div', 'xl');
      const shown = open.length > 3 ? open.slice(0, 2) : open;
      for (const c of shown) {
        const line = el('div', 'xi');
        line.append(el('span', null, c.title), el('b', null, c.points ? `+${c.points}` : ''));
        list.appendChild(line);
      }
      if (open.length > shown.length) {
        const more = open.slice(shown.length).reduce((s, c) => s + (c.points || 0), 0);
        const line = el('div', 'xi m');
        line.append(el('span', null, `${open.length - shown.length} more`), el('b', null, more ? `+${more}` : ''));
        list.appendChild(line);
      }
      row.appendChild(list);
    }
    rows.appendChild(row);
  });
  const timer = el('div', 'tm');
  timer.appendChild(el('i'));
  toast.append(head, rows, timer);
  root.appendChild(toast);
  document.documentElement.appendChild(host);
  setTimeout(() => bars.forEach(([f, pct]) => { f.style.width = pct + '%'; }), 200);

  let remaining = duration;
  let started = Date.now();
  let timerId = null;
  const dismiss = () => {
    clearTimeout(timerId);
    toast.classList.add('out');
    setTimeout(() => host.remove(), 280);
  };
  const run = () => { started = Date.now(); timerId = setTimeout(dismiss, remaining); };
  toast.addEventListener('mouseenter', () => { clearTimeout(timerId); remaining -= Date.now() - started; });
  toast.addEventListener('mouseleave', run);
  close.addEventListener('click', e => { e.stopPropagation(); dismiss(); });
  toast.addEventListener('click', () => {
    try { chrome.runtime.sendMessage({ type: 'openEarn' }); } catch {}
    dismiss();
  });
  run();
  return true;
}

async function injectToast(tabId, payload) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: showRewardsToast, args: [payload] });
    return !!(res && res.result);
  } catch {
    return false;
  }
}

async function armReminder() {
  const { reminderEnabled } = await load(['reminderEnabled']);
  if (reminderEnabled) await store({ reminderArmedUntil: Date.now() + REMINDER_ARM_MS });
}

async function maybeShowReminder(tab) {
  if (DESKTOP_NO_REMINDER_FETCH) return;   // v1.3.0：桌面版不留任何空闲抓取入口
  if (reminderBusy || !tab || !tab.active || tab.incognito || !isRegularPage(tab.url) || previewTabs.has(tab.id)) return;
  reminderBusy = true;
  try {
    const st = await load(['reminderEnabled', 'reminderArmedUntil', 'reminderLog', 'running', 'searchTabId', 'rewardsTabId']);
    if (!st.reminderEnabled || !st.reminderArmedUntil || Date.now() > st.reminderArmedUntil) return;
    if (st.running || tab.id === st.searchTabId || tab.id === st.rewardsTabId) return;
    const settings = await getSettings();
    if (!inActiveHours(settings)) return;
    const perDay = Math.min(10, Math.max(1, Number(settings.reminderPerDay) || 3));
    const gap = Math.max(0.5, Number(settings.reminderGapHours) || 2) * 60 * 60 * 1000;
    const log = st.reminderLog && st.reminderLog.date === todayKey() ? st.reminderLog : { date: todayKey(), count: 0, last: 0 };
    if (log.count >= perDay || Date.now() - log.last < gap) {
      await store({ reminderArmedUntil: 0 });
      return;
    }
    if (!(await chrome.permissions.contains(ALL_SITES))) return;
    const payload = await reminderPayload();
    if (!payload || payload.left === 0) {
      await store({ reminderArmedUntil: 0 });
      return;
    }
    if (await injectToast(tab.id, payload)) {
      await store({ reminderArmedUntil: 0, reminderLog: { date: log.date, count: log.count + 1, last: Date.now() } });
    }
  } finally {
    reminderBusy = false;
  }
}

async function previewReminder(tabId) {
  let tab = null;
  if (tabId != null) {
    try { tab = await chrome.tabs.get(tabId); } catch {}
  }
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const payload = await reminderPayload();
  if (!payload) return { ok: false, reason: 'rewards' };
  payload.duration = Math.max(payload.duration, 6000);
  if (tab && isRegularPage(tab.url) && await chrome.permissions.contains(ALL_SITES) && await injectToast(tab.id, payload)) {
    return { ok: true };
  }
  return (await previewOnBingTab(payload, tab)) ? { ok: true, opened: true } : { ok: false, reason: 'blocked' };
}


const previewTabs = new Set();

async function previewOnBingTab(payload, fromTab) {
  const topic = await previewTopic();
  const url = topic ? `https://www.bing.com/search?q=${encodeURIComponent(topic)}` : HOME_URL;
  const created = await chrome.tabs.create(Object.assign(
    { url, active: true },
    fromTab ? { windowId: fromTab.windowId, index: fromTab.index + 1 } : {}
  ));
  previewTabs.add(created.id);
  try {
    const tab = await waitForSettled(created.id, Date.now() + READ_DEADLINE);
    if (!tab || !isRegularPage(tab.url)) return false;
    await sleep(400);
    for (let i = 0; i < 3; i++) {
      if (await injectToast(created.id, payload)) return true;
      await sleep(800);
    }
    return false;
  } finally {
    setTimeout(() => previewTabs.delete(created.id), 60000);
  }
}

chrome.runtime.onStartup.addListener(() => { ensureReminderTick(); armReminder(); });
chrome.windows.onCreated.addListener(w => {
  if (w.type !== 'normal') return;
  armReminder();
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') maybeShowReminder(tab);
});
chrome.permissions.onAdded.addListener(p => {
  if (p.origins && p.origins.includes('<all_urls>')) store({ reminderEnabled: true });
});
chrome.permissions.onRemoved.addListener(p => {
  if (p.origins && p.origins.includes('<all_urls>')) store({ reminderEnabled: false });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  /* 严格运行模式：运行期禁止刷新 / 同步 / 改设置 / 重复启动等影响运行的操作。 */
  if (strictRunActive && HSA_CORE.strictBlockedMessage(msg.type, true)) {
    sendResponse({ ok: false, reason: 'strictRun', message: HSA_CORE.TEXT.strictRunBlocked });
    return;
  }
  if (msg.type === 'start') {
    const count = Math.min(Math.max(parseInt(msg.count, 10) || 1, 1), 150);
    handleStart(count, msg);
  } else if (msg.type === 'stop') {
    handleStop();
  } else if (msg.type === 'runNow') {
    startAutoRun({ manual: true, count: msg.count, level: msg.level, time: msg.time || null })
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: 'error', message: err.message }));
    return true;
  } else if (msg.type === 'openEarn') {
    chrome.tabs.create({ url: EARN_URL, active: true });
  } else if (msg.type === 'previewReminder') {
    previewReminder(msg.tabId)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: 'error', message: err.message }));
    return true;
  } else if (msg.type === 'testSearch') {
    testHumanSearch({ level: msg.level })
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: 'error', message: err.message }));
    return true;
  } else if (msg.type === 'autoComplete') {
    runAutoComplete({ manual: true, level: msg.level, cap: msg.count })
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: 'error', message: err.message }));
    return true;
  } else if (msg.type === 'logUserAction') {
    /* 用户操作只追加日志（系统时间由共享核心补齐），不改变任何运行状态；
       严格运行期消息白名单放行，避免影响运行。 */
    hsaRunLog('user-action', {
      actor: 'user', category: 'user-action', level: 'info',
      event: 'user-action', name: String(msg.action || ''),
      zh: String(msg.action || ''), en: String(msg.action || ''),
      detail: String(msg.detail || ''), result: String(msg.result || ''),
      ok: msg.ok !== false, count: Number(msg.count) || 0
    }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  } else if (msg.type === 'exportRunLog') {
    /* 只读导出：严格运行期也允许，不触发抓取、不改运行状态。 */
    (async () => {
      const s = await load(['runLog']).catch(() => ({}));
      const entries = (s && Array.isArray(s.runLog)) ? s.runLog : [];
      const now = Date.now();
      return {
        ok: true, fileName: HSA_CORE.runLogFileName(now),
        content: HSA_CORE.runLogExport(entries, { now: now, platform: HSA_PLATFORM }),
        count: entries.length
      };
    })().then(sendResponse).catch(err => sendResponse({
      ok: false, reason: 'error', message: String(err && err.message || err)
    }));
    return true;
  } else if (msg.type === 'captureKeyPages') {
    /* 运行期由严格模式白名单拦截；空闲时实时抓取三页并导出 HTML 的 zip 包。 */
    (async () => {
      const now = Date.now();
      const policy = HSA_CORE.keyPagePolicy();
      const pages = await hsaCaptureKeyPages(policy);
      const okCount = pages.filter(p => p.ok).length;
      const built = HSA_CORE.keyPageZipFiles(pages, now, { platform: HSA_PLATFORM });
      const ZIP = globalThis.HSA_ZIP;
      if (!ZIP || typeof ZIP.buildZip !== 'function') throw new Error('zip builder unavailable');
      const zip = ZIP.buildZip(built.files, now);
      const summary = pages.map(p => p.name + ':' + (p.ok
        ? 'OK ' + p.bytes + 'B/' + p.durationMs + 'ms'
        : 'FAIL ' + (p.error || 'unknown'))).join(' | ');
      hsaRunLog('key-pages', {
        level: okCount ? 'info' : 'warn', actor: 'user',
        category: okCount ? 'result' : 'error', state: 'capture',
        zh: '实时抓取关键网页 ' + okCount + '/' + pages.length + ' 页并打包 HTML zip',
        en: 'Live key-page capture ' + okCount + '/' + pages.length + ' → HTML zip',
        page: policy.pages.map(p => p.path).join(','), count: okCount,
        ok: okCount > 0, detail: summary,
        result: 'zip ' + zip.length + ' bytes · ' + built.files.length + ' files',
        error: pages.filter(p => !p.ok).map(p => p.name + ':' + p.error).join(' | '),
        durationMs: Date.now() - now
      }).catch(() => {});
      return {
        ok: okCount > 0, fileName: HSA_CORE.keyPageFileName(now),
        content: ZIP.toBase64(zip), encoding: 'base64',
        count: okCount, total: pages.length,
        files: built.files.map(f => f.name), bytes: zip.length,
        fresh: true, source: policy.source, capturedAt: now,
        summary: summary
      };
    })().then(sendResponse).catch(err => sendResponse({
      ok: false, reason: 'error', message: String(err && err.message || err)
    }));
    return true;
  } else if (msg.type === HSA_CORE.SYNC_ON_OPEN.messageType) {
    /* v3.0 · 打开主界面同步一次：立即应答，同步完成后写 syncNotice。 */
    desktopSyncRewards({ fresh: true, noTabs: true,
      reason: HSA_CORE.SYNC_ON_OPEN.reason })
      .then(r => store({ syncNotice: {
        at: Date.now(), reason: HSA_CORE.SYNC_ON_OPEN.reason, ok: !!r.ok,
        changed: (r.changed || []).length
      } }))
      .catch(err => store({ syncNotice: {
        at: Date.now(), reason: HSA_CORE.SYNC_ON_OPEN.reason, ok: false,
        error: String(err && err.message || err)
      } }));
  } else if (msg.type === 'refreshTasks' || msg.type === 'refreshPoints') {
    /* v1.3.3：立即应答（后台同步可能要重新加载两页，不能让弹窗等 IPC 超时）；
       同步真正完成后写 syncNotice → storage.onChanged → 圆圈下方绿字
       「已同步积分」。整条刷新链路仍是唯一的 desktopSyncRewards。 */
    const reason = msg.type === 'refreshPoints' ? 'refreshPoints' : 'manual-refresh';
    desktopSyncRewards({ fresh: true, noTabs: true, reason: reason })
      .then(r => store({ syncNotice: {
        at: Date.now(), reason: reason, ok: !!r.ok,
        changed: (r.changed || []).length
      } }))
      .catch(err => store({ syncNotice: {
        at: Date.now(), reason: reason, ok: false,
        error: String(err && err.message || err)
      } }));
  } else if (msg.type === 'refreshToday') {
    refreshToday();
  } else if (msg.type === 'dumpSidebar') {
    dumpSidebarDom(msg.limit)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, message: err && err.message || String(err) }));
    return true;
  } else if (msg.type === 'dumpTaskList') {
    dumpTaskList()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, message: err && err.message || String(err) }));
    return true;
  } else if (msg.type === 'dumpClickProbe') {
    dumpClickProbe()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, message: err && err.message || String(err) }));
    return true;
  /* A7 · 桌面壳专用两个消息：侧栏展开 / 收起由主进程处理，上传版没有它们。 */
  } else if (msg.type === 'openOfficial') {
    try {
      const d = typeof window !== 'undefined' && window.__desktop;
      if (d && typeof d.openOfficial === 'function') d.openOfficial(msg.url || null);
      else if (typeof chrome.tabs !== 'undefined' && chrome.tabs.create) {
        chrome.tabs.create({ url: msg.url || DASHBOARD_URL, active: true });
      }
    } catch {}
  } else if (msg.type === 'hidePanel') {
    try {
      const d = typeof window !== 'undefined' && window.__desktop;
      if (d && typeof d.hidePanel === 'function') d.hidePanel();
    } catch {}
  /* v1.3.1 · 所有刷新入口共用的统一同步，必须挂在主监听器内。
     旧版另起一个 onMessage 监听器，但主监听器结尾无条件
     sendResponse({ok:true}) 会先 settle，shim 与真 Chrome 都只认第一个应答，
     第二个监听器永远收不到 → 登录后积分与任务列表不同步。 */
  } else if (msg.type === 'syncRewards') {
    /* 面板刚渲染完 / 登录跳回时，主进程刚写入的可见快照就是最新页面，
       直接复用（fresh=false）；手动刷新、开始与收尾同步强制实时读两页。 */
    const reason = msg.reason || 'login-return';
    const fresh = HSA_CORE.syncCachePolicy(reason).fresh;
    desktopSyncRewards({ fresh: fresh, reason: reason })
      .then(r => sendResponse({ ok: !!r.ok, reason: r.reason }))
      .catch(err => sendResponse({ ok: false, reason: 'error',
        message: String(err && err.message || err) }));
    return true;
  }
  sendResponse({ ok: true });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm && !HSA_CORE.strictAlarmAllowed(alarm.name, strictRunActive)) return;
  if (alarm.name === 'watchdog') resumeIfNeeded();
  else if (alarm.name === 'cleanUsedWords') store({ usedWords: [] });
  else if (alarm.name === 'reminderTick') armReminder();
  else if (alarm.name === 'cooldownEnd') endCooldown();
});

chrome.runtime.onInstalled.addListener(() => {
  armOneShot('cleanUsedWords', 24 * 60 * 60 * 1000);
  ensureReminderTick();
});

chrome.alarms.clear('scheduledRun');
chrome.alarms.clear('autoDailySet');
ensureReminderTick();
resumeIfNeeded();


/* ============================================================================
 * 自动完成任务（多时间点定时启动）
 *   · 配置存在 chrome.storage.local.autoTasks，由弹窗直接读写
 *   · 每分钟一个 tick alarm 比对 HH:MM，浏览器重启 / 休眠 / 改时间点都能自恢复
 *   · 当天已触发的「日期:时间点」记在 autoTaskLog，同一分钟不重复、跨天清空
 *   · 到点若已有运行在跑就跳过，不并发
 *   · 定时启动走后台标签页（openOrNavigate 默认 active:false），不抢用户焦点
 *   · 实际执行交给 runAutoComplete：点击未完成任务卡片 + 按剩余分数自动决定搜索次数
 * ========================================================================== */

const AUTO_DEFAULTS = { enabled: false, times: [], count: 30, level: 3 };
const AUTO_MAX_TIMES = 10;

function normalizeAutoTasks(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const times = [...new Set(
    (Array.isArray(src.times) ? src.times : [])
      .map(v => String(v || '').trim())
      .filter(v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v))
  )].sort().slice(0, AUTO_MAX_TIMES);
  const count = Math.min(150, Math.max(1, parseInt(src.count, 10) || AUTO_DEFAULTS.count));
  const level = clampInt(Number(src.level) || AUTO_DEFAULTS.level, 1, 3);
  return { enabled: !!src.enabled, times, count, level };
}

async function getAutoTasks() {
  const { autoTasks } = await load(['autoTasks']);
  return normalizeAutoTasks(autoTasks);
}

function autoTodayKey() { return new Date().toLocaleDateString('en-CA'); }
function autoHHMM(d = new Date()) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function getAutoLog() {
  const { autoTaskLog } = await load(['autoTaskLog']);
  const log = autoTaskLog && typeof autoTaskLog === 'object' ? autoTaskLog : null;
  if (!log || log.date !== autoTodayKey()) return { date: autoTodayKey(), fired: {} };
  return { date: log.date, fired: log.fired && typeof log.fired === 'object' ? log.fired : {} };
}

/** 每分钟一个持久 alarm；同名重复 create 只会覆盖，不会叠加。 */
/* A6 · 桌面壳适配：上传版每分钟一个持久 tick；桌面版改成「下一个设定时间点」
 * 的一次性 alarm，到点触发后重排，空闲时没有任何周期唤醒。 */
function rebuildAutoAlarm() {
  armOneShot('autoTaskTick', desktopNextAutoDelay());
}

/** 启动一次自动任务（manual=true 时来自首页按钮 / 任务列表的立即运行）。 */
async function startAutoRun(opts) {
  const o = opts || {};
  const st = await load(['running', 'phase']);
  if (flowActive || st.running) return { ok: false, reason: 'running' };
  const tasks = await getAutoTasks();
  const count = Math.min(150, Math.max(1, parseInt(o.count, 10) || tasks.count));
  const level = clampInt(Number(o.level) || tasks.level, 1, 3);
  const payload = {
    level, cap: count,
    manual: !!o.manual,
    time: o.time || null,
    source: o.manual ? 'manual' : 'schedule'
  };
  // 长流程不阻塞消息响应；与 start/runNow 一样 fire-and-forget
  runAutoComplete(payload).catch(err => console.warn('[AutoTask] 启动异常：', err && err.message));
  console.info('[AutoTask] ' + (o.manual ? '手动立即运行' : '定时启动 ' + (o.time || ''))
    + ' · 上限 ' + count + ' 次 · 强度 ' + level);
  return { ok: true, count, level, ...payload };
}

/** 每分钟检查：当前 HH:MM 命中某个时间点且今天还没触发过，就启动。 */
async function maybeRunAutoTasks() {
  const tasks = await getAutoTasks();
  if (!tasks.enabled || !tasks.times.length) return;
  const now = autoHHMM();
  const hit = tasks.times.find(t => t === now);
  if (!hit) return;

  const log = await getAutoLog();
  if (log.fired[hit]) return;                       // 同分钟不重复
  const st = await load(['running']);
  const busy = flowActive || !!st.running;
  log.fired[hit] = busy ? 'skipped' : 'started';
  await store({ autoTaskLog: log });

  if (busy) {
    console.info('[AutoTask] ' + hit + ' 已有任务在运行，本次跳过');
    return;
  }
  const res = await startAutoRun({ time: hit, count: tasks.count, level: tasks.level });
  if (!res.ok) {
    log.fired[hit] = 'skipped';
    await store({ autoTaskLog: log });
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm && !HSA_CORE.strictAlarmAllowed(alarm.name, strictRunActive)) return;
  if (alarm && alarm.name === 'autoTaskTick') {
    maybeRunAutoTasks().catch(err => console.warn('[AutoTask] tick 异常：', err && err.message));
  }
});

chrome.runtime.onInstalled.addListener(() => {
  rebuildAutoAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  rebuildAutoAlarm();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.uiLang) bgLang = changes.uiLang.newValue || 'zh';
  if (changes.autoTasks) rebuildAutoAlarm();
  if (changes.settings) {
    const v = changes.settings.newValue && changes.settings.newValue.runLogEnabled;
    runLogEnabled = v !== false;
  }
});

load(['uiLang']).then(s => { bgLang = s.uiLang || 'zh'; }).catch(() => {});
rebuildAutoAlarm();


/* ============================================================================
 * 今日任务 / 三项积分 / 自动完成任务（v1.6）
 *
 * 数据源固定为两个页面：https://rewards.bing.com/dashboard 与 /earn
 * 页面是 Next.js SSR DOM + RSC flight payload，按真实结构解析：
 *
 *  · 三项积分：积分卡 = <p class="text-labelControl">标签</p> …
 *              <p class="text-pageHeader">值</p>（含 RSC 转义形态）
 *  · 任务卡片：绿色徽章 bg-statusSuccessRewardsBg + 数字，
 *              RSC dailySetItems 或可见 DOM <a> 卡片。
 *              只保留「每日活动 daily / 日常任务 promo」，
 *              「任务」区的月度 punchcard、无积分推广卡一律不收。
 *  · 第一条固定是「今日 Bing 搜索」，分数取页面搜索进度。
 *
 * 自动完成任务：
 *  · 搜索次数按今日 Bing 搜索剩余分数 ÷ 每次搜索积分自动决定，
 *    不超过设置页的次数上限；已满则跳过搜索。
 *  · 模拟鼠标点击 dashboard 页面上未完成的任务卡片，已完成的跳过。
 *  · 定时触发与首页按钮都走同一流程。
 *
 * 兜底：真实页面卡片 → 注入读 DOM → 旧版今日进度表格 → 已有活动合成（标估算）。
 * 未登录页会识别，三项积分显示 —、不写假的 0 分。
 * ========================================================================== */

const SECTION_LABEL = {
  search: { zh: '搜索', en: 'Search' },
  daily: { zh: '每日活动', en: 'Daily activities' },
  promo: { zh: '日常任务', en: 'Daily tasks' }
};

function sectionLabel(key) {
  return (SECTION_LABEL[key] || SECTION_LABEL.promo)[bgLang === 'en' ? 'en' : 'zh'];
}

function isSignInPage(html) {
  const text = String(html || '');
  if (/登录到 Microsoft 帐户需要启用 JavaScript/.test(text)) return true;
  if (/使用你的 Microsoft 帐户/.test(text) && /创建帐户|忘记用户名/.test(text)) return true;
  if (/Sign in to your Microsoft account/i.test(text) && /Create (?:an? )?account|No account\?/i.test(text)) return true;
  // 未登录时 rewards.bing.com 会显示公开 About 页，不是积分面板
  if (/About\s*[–\-—]\s*Microsoft Rewards/i.test(text) && /\bSign in\b/i.test(text)) return true;
  if (/Gift cards for the win/i.test(text) && /\bSign in\b/i.test(text)) return true;
  if (/关于\s*[–\-—]\s*Microsoft Rewards/i.test(text) && /登录/i.test(text)) return true;
  return false;
}

/* -------------------------------------------------------------- 首页三项积分 */
const POINT_LABELS = {
  available: ['可用积分', '可用点数', 'Available points', 'Available'],
  today: ['今日积分', '今日已赚取', '今日赚取', 'Points earned today', "Today's points"],
  claimable: ['可领取', '可领取积分', '待领取积分', 'Points to claim', 'Claimable']
};

function numFrom(text) {
  const m = String(text || '').match(/-?[\d,\.\s]+\d|-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0].replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function pickNumber(clean, patterns) {
  for (const re of patterns) {
    const m = clean.match(re);
    if (!m) continue;
    const n = numFrom(m[1]);
    if (n !== null) return n;
  }
  return null;
}

/** 按页面上真实的积分卡「标签 → 相邻数值」解析。 */
function cardsPoints(html) {
  const clean = decodePayload(String(html || ''));
  const out = {};
  const put = (label, value) => {
    const n = numFrom(value);
    if (n === null) return;
    const text = String(label || '').trim();
    for (const [key, names] of Object.entries(POINT_LABELS)) {
      if (names.some(x => text === x || text.indexOf(x) >= 0)) {
        if (!Number.isFinite(out[key])) out[key] = n;
        return;
      }
    }
  };
  const domRe = /<p[^>]*text-labelControl[^>]*>\s*([^<]{1,30}?)\s*<\/p>[\s\S]{0,1500}?<p[^>]*text-pageHeader[^>]*>\s*([^<]{1,30}?)\s*<\/p>/g;
  for (const m of clean.matchAll(domRe)) put(m[1], m[2]);
  const rscRe = /"className":"text-labelControl","children":"([^"]{1,30})"[\s\S]{0,2000}?"className":"text-pageHeader","children":"([^"]{1,30})"/g;
  for (const m of clean.matchAll(rscRe)) put(m[1], m[2]);
  return out;
}

/** 卡片值优先，字段兜底；不再用任务合计推算。 */
function parsePointsTrio(html) {
  const clean = decodePayload(String(html || ''));
  const cards = cardsPoints(html);
  const field = pats => pickNumber(clean, pats);
  return {
    available: Number.isFinite(cards.available) ? cards.available : field([
      /"(?:availablePoints|balance|pointsBalance)"\s*:\s*"?(\d+)"?/i
    ]),
    today: Number.isFinite(cards.today) ? cards.today : field([
      /"(?:pointsEarnedToday|todayPoints|pointsToday|earnedToday|todayEarnedPoints)"\s*:\s*"?(\d+)"?/i
    ]),
    claimable: Number.isFinite(cards.claimable) ? cards.claimable : field([
      /"(?:claimablePoints|pointsToClaim|pointsAvailableToClaim|claimable)"\s*:\s*"?(\d+)"?/i
    ])
  };
}

function mergeTrio(a, b) {
  const out = {};
  for (const key of ['available', 'today', 'claimable']) {
    const av = a && a[key], bv = b && b[key];
    out[key] = Number.isFinite(av) ? av : (Number.isFinite(bv) ? bv : null);
  }
  return out;
}

async function fetchBothPages(opts) {
  const [dash, earn] = await Promise.all([
    fetchRewardsPage('/dashboard', opts),
    fetchRewardsPage('/earn', opts)
  ]);
  return {
    dash, earn,
    signedOut: isSignInPage(dash.html) && isSignInPage(earn.html),
    reachable: dash.ok || earn.ok
  };
}

async function refreshPointsSummary(pages) {
  pages = pages || await fetchBothPages();
  if (pages.signedOut) {
    await store({
      pointsSummary: { available: null, today: null, claimable: null, signedOut: true, updatedAt: Date.now() }
    });
    return true;
  }
  const trio = mergeTrio(
    pages.dash.ok ? parsePointsTrio(pages.dash.html) : null,
    pages.earn.ok ? parsePointsTrio(pages.earn.html) : null
  );
  const { pointsSummary: prev } = await load(['pointsSummary']);
  const keep = (v, key) => Number.isFinite(v) ? v
    : (prev && Number.isFinite(prev[key]) ? prev[key] : null);
  await store({
    pointsSummary: {
      available: keep(trio.available, 'available'),
      today: keep(trio.today, 'today'),
      claimable: keep(trio.claimable, 'claimable'),
      signedOut: false,
      updatedAt: Date.now(),
      sources: [pages.dash.ok && '/dashboard', pages.earn.ok && '/earn'].filter(Boolean)
    }
  });
  return false;
}

/* ------------------------------------------------------------------ 通用工具 */
function jsonArrayObjects(clean, key) {
  const at = clean.indexOf('"' + key + '"');
  if (at < 0) return [];
  const open = clean.indexOf('[', at);
  if (open < 0) return [];
  let depth = 0, end = -1;
  for (let i = open; i < clean.length && i < open + 200000; i++) {
    if (clean[i] === '[') depth++;
    else if (clean[i] === ']' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return [];
  const objs = [];
  let level = 0, from = -1;
  for (let i = open + 1; i < end; i++) {
    const ch = clean[i];
    if (ch === '{') { if (level++ === 0) from = i; }
    else if (ch === '}' && level > 0 && --level === 0) objs.push(clean.slice(from, i + 1));
  }
  return objs;
}

function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\u0026|&amp;/gi, '&')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/\\n|\\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function stripTags(s) { return cleanText(String(s || '').replace(/<[^>]+>/g, ' ')); }
function safeUrl(s) {
  const u = String(s || '').replace(/&amp;/g, '&').trim();
  return /^https?:\/\//i.test(u) ? u : '';
}

/* ------------------------------------------------------- 真实页面任务卡片解析 */
/** RSC 的 dailySetItems：标题 / 描述 / 积分 / 完成状态 / 链接。 */
function structuredItemsFrom(html) {
  const clean = decodePayload(String(html || ''));
  const out = [];
  const seen = new Set();
  const take = (obj, section) => {
    const str = re => { const m = obj.match(re); return m ? m[1] : null; };
    const title = cleanText(str(/"title"\s*:\s*"([^"]*)"/i));
    const points = Number(str(/"points"\s*:\s*"?(\d+)"?/i)) || 0;
    if (!title || !(points > 0)) return;
    const desc = cleanText(str(/"description"\s*:\s*"([^"]*)"/i));
    const dest = safeUrl(str(/"(?:destination|destinationUrl|url|href)"\s*:\s*"([^"]*)"/i));
    const completed = /"isCompleted"\s*:\s*true/i.test(obj);
    const key = title + '|' + desc + '|' + points;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: title, description: desc, section, category: sectionLabel(section),
      points, earned: completed ? points : 0, completed, url: dest, source: 'rsc'
    });
  };
  for (const obj of jsonArrayObjects(clean, 'dailySetItems')) take(obj, 'daily');
  return out;
}

/** 卡片前面最近的 <h2> 决定分组；「任务 / 升级活动 / 连续打卡」区一律排除。 */
function sectionBeforeHeading(html, index) {
  const heads = [...html.slice(0, index).matchAll(/<h2[^>]*>([\s\S]{1,80}?)<\/h2>/g)];
  const near = heads.length ? stripTags(heads[heads.length - 1][1]) : '';
  if (/日常任务|每日任务|Daily tasks|More activities/i.test(near)) return 'promo';
  if (/每日活动|Daily activities|Daily set/i.test(near)) return 'daily';
  return 'other';
}

/** 可见 DOM 里带绿色数字积分徽章的 <a> 卡片。 */
function visibleCardsFrom(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)) {
    const card = m[0];
    const badge = /bg-statusSuccessRewardsBg[\s\S]{0,500}?<p class="text-metadata text-fgCtrlOnImage">\s*(\d+)\s*<\/p>/.exec(card);
    if (!badge) continue;
    const points = parseInt(badge[1], 10);
    if (!(points > 0)) continue;
    const section = sectionBeforeHeading(html, m.index);
    if (section === 'other') continue;                 // 月度 punchcard 等「任务」区不计入今日任务
    const titleM = /<p class="line-clamp-3 text-globalBody2Strong">([^<]*)<\/p>/.exec(card)
      || /<h3[^>]*>([\s\S]{1,120}?)<\/h3>/.exec(card)
      || /<img[^>]*alt="([^"]*)"/.exec(card);
    const name = cleanText(titleM && titleM[1]);
    if (!name) continue;
    const descM = /<p class="line-clamp-3 text-fgCtrlNeutralSecondaryRest">([^<]*)<\/p>/.exec(card);
    const progress = /(\d+)\s*\/\s*(\d+)\s*个任务/.exec(stripTags(card));
    const completed = /已完成|已领取|Completed|Claimed/i.test(card)
      || (!!progress && progress[1] === progress[2]);
    const hrefM = /href="([^"]*)"/.exec(card);
    out.push({
      name, description: cleanText(descM && descM[1]), section,
      category: sectionLabel(section), points,
      earned: completed ? points : 0, completed,
      url: safeUrl(hrefM && hrefM[1]), source: 'dom'
    });
  }
  return out;
}

/** 一个页面的有积分任务：只含 daily / promo，去重后保持页面顺序。 */
function cardsFromRewardsHtml(html) {
  const out = [];
  const seen = new Set();
  for (const item of [...structuredItemsFrom(html), ...visibleCardsFrom(html)]) {
    if (!SECTION_LABEL[item.section]) continue;
    const key = item.name + '|' + item.description + '|' + item.points + '|' + item.section;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.filter(r => r.points > 0 && r.name);
}


/* v1.3.7：同步阶段建立任务点击索引。
 * 这里只保存可复用的任务身份/DOM 特征，不保存坐标或 DOM 引用；
 * 点击阶段按 href / data-bi-id / id / aria-label 快速定位，再读取实时坐标。
 */
function taskClickNormalizeText(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}
function taskClickAttr(attrs, name) {
  const m = new RegExp('(?:^|\\s)' + String(name || '') + '\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27|([^\\s>]+))', 'i').exec(String(attrs || ''));
  return m ? String(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || '')
    .replace(/&amp;/gi, '&').replace(/&#x27;|&#39;/gi, "'").trim() : '';
}
function taskClickResolveUrl(raw, pageUrl) {
  const value = normalizeTaskUrl(raw || '');
  if (!value) return '';
  try { return new URL(value, pageUrl).href; }
  catch { return /^https?:\/\//i.test(value) ? value : ''; }
}
function taskClickAnchorsFromHtml(html, pageUrl) {
  const source = decodePayload(String(html || ''));
  const out = [];
  let anchorIndex = 0;
  for (const m of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const rawHref = taskClickAttr(attrs, 'href');
    const href = taskClickResolveUrl(rawHref, pageUrl);
    const text = cleanText(body);
    const titleMatch = /<(?:h[2-6]|p)[^>]*(?:text-globalBody2Strong|line-clamp-3|title|Title)[^>]*>([\s\S]*?)<\/(?:h[2-6]|p)>/i.exec(body)
      || /<img[^>]*\balt=["']([^"']+)["']/i.exec(body);
    const title = cleanText(titleMatch && titleMatch[1]);
    const pointsMatch = /(?:\+|＋)\s*([\d,]{1,5})(?![\d,])/.exec(text);
    const points = pointsMatch ? Number(pointsMatch[1].replace(/,/g, '')) : 0;
    out.push({
      anchorIndex: anchorIndex++, href,
      dataBiId: taskClickAttr(attrs, 'data-bi-id'),
      dataOfferId: taskClickAttr(attrs, 'data-offer-id'),
      dataTestId: taskClickAttr(attrs, 'data-testid'),
      id: taskClickAttr(attrs, 'id'),
      ariaLabel: taskClickAttr(attrs, 'aria-label'),
      titleAttr: taskClickAttr(attrs, 'title'),
      target: taskClickAttr(attrs, 'target'),
      title: title,
      text: text.slice(0, 240),
      points: Number.isFinite(points) ? points : 0
    });
  }
  return out;
}
function taskClickBestAnchor(item, anchors) {
  const wantedUrl = taskClickResolveUrl(item && item.url, 'https://rewards.bing.com/');
  const wantedFp = wantedUrl ? taskUrlFp(wantedUrl) : '';
  const wantedTitle = taskClickNormalizeText(item && item.name);
  const wantedDesc = taskClickNormalizeText(item && item.description);
  const wantedPoints = Number(item && item.points) || 0;
  let best = null, bestScore = 0;
  for (const anchor of anchors || []) {
    if (wantedPoints && anchor.points > 0 && anchor.points !== wantedPoints
        && anchor.href !== wantedUrl) continue;
    let score = 0;
    if (wantedUrl && anchor.href) {
      if (anchor.href === wantedUrl) score += 120;
      else if (wantedFp && taskUrlFp(anchor.href) === wantedFp) score += 55;
    }
    const title = taskClickNormalizeText(anchor.title);
    const text = taskClickNormalizeText(anchor.text);
    if (wantedTitle && title === wantedTitle) score += 65;
    else if (wantedTitle && (text.includes(wantedTitle) || (title.length >= 5 && wantedTitle.includes(title)))) score += 45;
    if (wantedDesc && text.includes(wantedDesc)) score += 8;
    if (wantedPoints && anchor.points === wantedPoints) score += 22;
    else if (wantedPoints && anchor.points > 0) score -= 18;
    if (score > bestScore) { best = anchor; bestScore = score; }
  }
  return bestScore >= 38 ? best : null;
}
function buildTaskClickIndex(pages, allItems) {
  const entries = [], seen = new Set();
  const pageDefs = [
    { page: '/dashboard', url: DASHBOARD_URL, result: pages && pages.dash },
    { page: '/earn', url: EARN_URL, result: pages && pages.earn }
  ];
  for (const def of pageDefs) {
    const r = def.result;
    if (!r || !r.ok || !r.html) continue;
    let pageItems = cardsFromRewardsHtml(r.html);
    if (def.page === '/earn') {
      if (typeof desktopEarnCards === 'function') pageItems = pageItems.concat(desktopEarnCards(r.html));
      else if (typeof earnCardsFromHtml === 'function') pageItems = pageItems.concat(earnCardsFromHtml(r.html));
    }
    const anchors = taskClickAnchorsFromHtml(r.html, def.url);
    /* DOM 快照/注入补充项也从同一批同步结果尝试匹配；没有 href/DOM 锚点的估算项不进入点击索引。 */
    const parsedKeys = new Set(pageItems.map(it => [taskClickNormalizeText(it && it.name),
      taskClickNormalizeText(it && it.description), Number(it && it.points) || 0, it && it.section].join('|')));
    for (const extra of (Array.isArray(allItems) ? allItems : [])) {
      if (!extra || !(Number(extra.points) > 0) || !extra.name || !SECTION_LABEL[extra.section]
          || extra.section === 'search') continue;
      const extraKey = [taskClickNormalizeText(extra.name), taskClickNormalizeText(extra.description),
        Number(extra.points) || 0, extra.section].join('|');
      if (parsedKeys.has(extraKey)) continue;
      const extraMatch = taskClickBestAnchor(extra, anchors);
      const fallbackPage = extra.section === 'daily' ? '/dashboard' : '/earn';
      if (!extraMatch && (!extra.url || fallbackPage !== def.page)) continue;
      pageItems.push(extra);
      parsedKeys.add(extraKey);
    }
    for (const item of pageItems) {
      if (!item || !(Number(item.points) > 0) || !item.name || !SECTION_LABEL[item.section]
          || item.section === 'search') continue;
      const match = taskClickBestAnchor(item, anchors);
      const url = (match && match.href) || taskClickResolveUrl(item.url, def.url);
      const fp = url ? taskUrlFp(url) : '';
      const identity = (fp ? fp + '|' : '') + [taskClickNormalizeText(item.name), taskClickNormalizeText(item.description),
        Number(item.points) || 0, item.section].join('|');
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      const locator = {
        href: url,
        dataBiId: match && match.dataBiId || '',
        dataOfferId: match && match.dataOfferId || '',
        dataTestId: match && match.dataTestId || '',
        id: match && match.id || '',
        ariaLabel: match && match.ariaLabel || '',
        titleAttr: match && match.titleAttr || '',
        anchorText: match && match.text || '',
        anchorIndex: match ? match.anchorIndex : -1,
        title: String(item.name || '').slice(0, 100),
        description: String(item.description || '').slice(0, 160),
        points: Number(item.points) || 0,
        section: item.section
      };
      entries.push({
        key: identity,
        page: def.page,
        pageUrl: def.url,
        name: String(item.name || '').slice(0, 100),
        description: String(item.description || '').slice(0, 160),
        points: Number(item.points) || 0,
        section: item.section,
        completed: !!item.completed || Number(item.earned) >= Number(item.points),
        url: url,
        target: match && match.target || '',
        source: item.source || 'sync-html',
        locator: locator
      });
    }
  }
  entries.sort((a, b) => (a.section === b.section ? 0 : a.section === 'daily' ? -1 : 1)
    || (a.page === b.page ? 0 : a.page === '/dashboard' ? -1 : 1));
  return {
    schemaVersion: 1,
    source: 'sync-html',
    updatedAt: Date.now(),
    count: entries.length,
    pendingCount: entries.filter(x => !x.completed).length,
    items: entries
  };
}

/**
 * v2.0：注入到 Rewards 页面读取「今日任务」展示数据。
 * 与点击逻辑保持同一套识别规则：以 a[href] 为入口，积分走 +N / 徽章 <p> 双通道。
 * 旧版只遍历 bg-statusSuccessRewardsBg，在 /dashboard 上读到 0 张，
 * 会让今日任务列表失真，进而可能把「100% 已完成」误判成真而跳过整轮点击。
 */
function readTaskCardsFromDom() {
  const clean = el => (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  const hostOf = href => {
    const m = /^(?:https?:)?\/\/([^\/:?#]+)/i.exec(String(href || ''));
    return m ? m[1].toLowerCase() : '';
  };
  const NON_TASK = /\/redeem|\/referandearn|\/apps\/wallpaper|\/earn\/quest\/|\/rewardscdn\/|\/manifest\.webmanifest/i;
  const NAV_ONLY = /^https?:\/\/rewards\.bing\.com\/(?:dashboard|earn)?(?:[?#]|$)/i;
  const out = [];
  const seen = new Set();

  for (const card of document.querySelectorAll('a[href]')) {
    const href = card.getAttribute('href') || '';
    const host = hostOf(href);
    if (host && !/(^|\.)bing\.com$/i.test(host)) continue;
    if (NON_TASK.test(href) || NAV_ONLY.test(href)) continue;
    if (seen.has(card)) continue;
    const text = clean(card);
    if (!text || text.length > 400) continue;
    if (/可用积分|今日积分|可领取|还差|管理奖励|兑换/i.test(text)) continue;

    let points = 0;
    const badge = card.querySelector('[class*="bg-statusSuccessRewardsBg"]');
    if (badge) {
      const p = badge.querySelector('p');
      const m = /^\s*(\d{1,4})\s*$/.exec(p ? clean(p) : clean(badge));
      if (m) points = parseInt(m[1], 10);
    }
    if (!points) {
      const m = /\+\s*(\d{1,4})(?!\d)/.exec(text);
      if (m) points = parseInt(m[1], 10);
    }
    if (!(points > 0)) continue;
    seen.add(card);

    const titleEl = card.querySelector('[class*="text-globalBody2Strong"], h3, h4');
    const descEl = card.querySelector('[class*="text-fgCtrlNeutralSecondaryRest"]');
    const name = clean(titleEl) || clean(card.querySelector('img') && card.querySelector('img').alt);
    if (!name) continue;

    let near = '';
    for (const h of document.querySelectorAll('h2')) {
      if (h.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) near = clean(h);
      else break;
    }
    let section = 'promo';
    if (/每日活动|每日任务|每日福利|Daily activities|Daily set/i.test(near)) section = 'daily';
    else if (/日常任务|Daily tasks|More activities/i.test(near)) section = 'promo';

    const done = /已完成|已领取|Completed|Claimed/i.test(text);
    out.push({
      name, description: clean(descEl), section,
      points, earned: done ? points : 0, completed: done,
      url: /^https?:\/\//i.test(href) ? href : '',
      source: 'dom-inject'
    });
  }
  return out.length ? { ok: true, rows: out } : { ok: false };
}

/* -------------------------------------------------------------- 旧版表格兜底 */
function rowsFromProgressTable(html) {
  const source = decodePayload(String(html || ''));
  const out = [];
  for (const m of source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => ({
      text: cleanText(c[1]),
      checked: /type\s*=\s*["']?checkbox[^>]*\bchecked\b/i.test(c[1])
        || /aria-checked\s*=\s*["']true["']/i.test(c[1]) || /[✓✔√]/.test(c[1].replace(/<[^>]+>/g, ''))
    }));
    if (cells.length < 2) continue;
    let pi = -1, done = 0, total = 0;
    for (let i = 0; i < cells.length; i++) {
      const mm = cells[i].text.match(/^(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*(?:分|pts|points)?$/i);
      if (mm) { pi = i; done = parseInt(mm[1].replace(/,/g, ''), 10); total = parseInt(mm[2].replace(/,/g, ''), 10); break; }
    }
    if (pi < 0 || !(total > 0)) continue;
    const before = cells.slice(0, pi).filter(c => c.text
      && !/^[\d,.\/\s]+$/.test(c.text) && !/^[✓✔√\s]*$/.test(c.text));
    const name = before.length >= 2 ? before[before.length - 2].text : (before[0] && before[0].text);
    if (!name) continue;
    out.push({
      name, description: '', section: 'promo', category: sectionLabel('promo'),
      points: total, earned: Math.min(done, total),
      completed: cells.some(c => c.checked) || done >= total, url: '', source: 'table'
    });
  }
  return out.filter(r => r.points > 0);
}

async function fallbackTaskItems() {
  const { todayActivities } = await load(['todayActivities']);
  const out = [];
  for (const a of todayActivities || []) {
    const isPts = a.unit === 'pts' || /point|积分/i.test(String(a.unit || ''));
    if (isPts && a.total > 0) {
      const section = a.id === 'keepearning' ? 'promo' : 'daily';
      out.push({
        name: String(a.name || '').trim(), description: '', section,
        category: sectionLabel(section), points: a.total,
        earned: Math.min(a.done || 0, a.total), completed: (a.done || 0) >= a.total,
        url: '', source: 'fallback'
      });
    }
    for (const c of a.left || []) {
      const pts = Number(c.points) || 0, sub = String(c.title || c.name || '').trim();
      if (!sub || !(pts > 0)) continue;
      const section = a.id === 'keepearning' ? 'promo' : 'daily';
      out.push({
        name: sub, description: '', section, category: sectionLabel(section),
        points: pts, earned: c.done ? pts : 0, completed: !!c.done, url: '', source: 'fallback'
      });
    }
  }
  return out.filter(r => r.points > 0 && r.name);
}

/** 今日任务第一条：搜索任务，分数取页面「今日 Bing 搜索」进度。 */
async function searchTaskItem(pages) {
  const { todaySearch } = await load(['todaySearch']);
  let max = Number(todaySearch && todaySearch.max) || 0;
  let got = Number(todaySearch && todaySearch.progress) || 0;
  if (!max && pages && pages.earn && pages.earn.ok) {
    try {
      const c = parseSearchCounter(pages.earn.html);
      if (c && Number(c.max) > 0) { max = Number(c.max); got = Number(c.progress) || 0; }
    } catch { /* 用默认上限 */ }
  }
  if (!max) max = 60;                        // 金牌会员每日搜索上限（3 分/次）
  got = Math.max(0, Math.min(got, max));
  return {
    name: bgLang === 'en' ? 'Bing search today' : '今日 Bing 搜索',
    description: '', section: 'search', category: sectionLabel('search'),
    points: max, earned: got, completed: got >= max,
    url: '', source: 'search', kind: 'search'
  };
}

function summarizeTaskItems(items, extra) {
  const earned = items.reduce((s, r) => s + r.earned, 0);
  const total = items.reduce((s, r) => s + r.points, 0);
  return Object.assign({
    items, earned, total,
    percent: total ? (earned >= total ? 100 : Math.floor((earned / total) * 100)) : 0,
    updatedAt: Date.now()
  }, extra || {});
}

/** A displayed 100% is reserved for exact completion, not rounded-up progress. */
function isTaskSummaryComplete(summary) {
  if (!summary || summary.signedOut) return false;
  const total = Number(summary.total), earned = Number(summary.earned);
  return Number.isFinite(total) && total > 0 && Number.isFinite(earned) && earned >= total;
}

/** 一次刷新：任务列表（第一条搜索）+ 首页三项积分，共用两个页面抓取结果。
 *  v1.3.0：可传入 pages 复用开始时/收尾时那唯一一次抓取，避免重复请求；
 *  opts.skipInjection 跳过最长 25 秒的后台标签页注入兜底（预设流程不需要）。 */
async function refreshTodayTasks(token, pages, opts) {
  pages = pages || await fetchBothPages();
  const skipInjection = !!(opts && opts.skipInjection);

  if (pages.signedOut) {
    await store({
      todayTasks: { items: [], earned: 0, total: 0, percent: 0, signedOut: true, approx: false, updatedAt: Date.now() }
    });
    await refreshPointsSummary(pages);
    // 公开 About / 登录页不需要后台标签页，顺手清理遗留页面
    await closeTab('rewardsTabId').catch(() => {});
    return { ok: false, signedOut: true, count: 0 };
  }

  let items = [];
  const seen = new Set();
  for (const r of [pages.dash, pages.earn]) {
    if (!r.ok) continue;
    for (const it of cardsFromRewardsHtml(r.html)) {
      const key = it.name + '|' + it.description + '|' + it.points + '|' + it.section;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  }
  let approx = false;

  if (!items.length && pages.reachable && !skipInjection) {
    const r = await readRewardsPage(EARN_URL, url => pathStarts(url, '/earn'), readTaskCardsFromDom,
      token == null ? flowToken : token);
    if (r.ok && Array.isArray(r.rows)) {
      items = r.rows.map(x => Object.assign({}, x, { category: sectionLabel(x.section) }))
        .filter(x => x.points > 0 && SECTION_LABEL[x.section]);
    }
    // readRewardsPage 会打开后台标签页，用完即关，避免留在 rewards.bing.com
    await closeTab('rewardsTabId').catch(() => {});
  }
  if (!items.length && pages.earn.ok) {
    items = rowsFromProgressTable(pages.earn.html);
  }
  if (!items.length) { items = await fallbackTaskItems(); approx = true; }

  // 搜索任务永远排第一
  items = [await searchTaskItem(pages), ...items.filter(i => i.section !== 'search')];
  if (!items.length) return { ok: false, signedOut: false, count: 0 };

  await store({ todayTasks: summarizeTaskItems(items, { approx, signedOut: false }) });
  await refreshPointsSummary(pages);
  return { ok: true, signedOut: false, count: items.length };
}

async function refreshPointsOnly() {
  return refreshPointsSummary(await fetchBothPages());
}

/* ============================================================================
 * 自动完成任务：模拟鼠标点击 Rewards 页面的未完成任务卡片 + 按需拟人搜索
 * ========================================================================== */

/**
 * v2.0 注入区（在页面 DOM 上下文执行）。
 * 真实结构（2026-11 保存页）实测：
 *   /dashboard 每日活动卡：<a target="_blank" href="https://www.bing.com/search?q=…">
 *     内含 <p class="text-globalBody2Strong">标题</p> 与 <p>+10</p>，
 *     **没有** bg-statusSuccessRewardsBg 元素（那串字符只在 RSC payload 文本里）。
 *   /earn 日常任务卡：<a target="_blank" href="…/search?q=Bing Homepage quiz 或 /spotlight/imagepuzzle">
 *     内含 <div class="… bg-statusSuccessRewardsBg …"><svg/><p>5</p></div>，
 *     以及右下角「已完成」；punchcard 在 h2=「任务」下、href 含 /earn/quest/。
 * 因此统一以 a[href] 为入口，积分双通道（徽章 <p>纯数字 / 文本 +N）。
 */
/**
 * v2.2 统一注入入口 —— 必须是「单一自包含函数」。
 *
 * 为什么：chrome.scripting.executeScript 只把 func.toString() 注入页面，
 * 它引用的其它顶层函数（deepAll / sidebarClean / scanTaskAnchors …）在页面
 * 上下文里根本不存在 → ReferenceError → 结果被 catch 吞成空数组。
 * 这是 v2.0 / v2.1「只开页面、0 张卡片、不点击」的真正根因。
 *
 * 所有辅助逻辑内联在本函数体内，通过 action 分派：
 *   rewards.list / rewards.focus / rewards.activate
 *   sidebar.diagnose / sidebar.open / sidebar.frameInfo / sidebar.dump
 *   sidebar.scan / sidebar.scroll / sidebar.click
 */
/**
 * v2.2 统一注入入口 —— 必须是「单一自包含函数」。
 *
 * 为什么：chrome.scripting.executeScript 只把 func.toString() 注入页面，
 * 它引用的其它顶层函数（deepAll / sidebarClean / scanTaskAnchors …）在页面
 * 上下文里根本不存在 → ReferenceError → 结果被 catch 吞成空数组。
 * 这是 v2.0 / v2.1「只开页面、0 张卡片、不点击」的真正根因。
 *
 * 所有辅助逻辑内联在本函数体内，通过 action 分派：
 *   rewards.list / rewards.focus / rewards.activate
 *   sidebar.diagnose / sidebar.open / sidebar.frameInfo / sidebar.dump
 *   sidebar.scan / sidebar.scroll / sidebar.click
 */
/**
 * v2.2 统一注入入口 —— 必须是「单一自包含函数」。
 *
 * 为什么：chrome.scripting.executeScript 只把 func.toString() 注入页面，
 * 它引用的其它顶层函数（deepAll / sidebarClean / scanTaskAnchors …）在页面
 * 上下文里根本不存在 → ReferenceError → 结果被 catch 吞成空数组。
 * 这是 v2.0 / v2.1「只开页面、0 张卡片、不点击」的真正根因。
 *
 * 所有辅助逻辑内联在本函数体内，通过 action 分派：
 *   rewards.list / rewards.focus / rewards.activate
 *   sidebar.diagnose / sidebar.open / sidebar.frameInfo / sidebar.dump
 *   sidebar.scan / sidebar.scroll / sidebar.click
 */
/**
 * v2.2 统一注入入口 —— 必须是「单一自包含函数」。
 *
 * 为什么：chrome.scripting.executeScript 只把 func.toString() 注入页面，
 * 它引用的其它顶层函数（deepAll / sidebarClean / scanTaskAnchors …）在页面
 * 上下文里根本不存在 → ReferenceError → 结果被 catch 吞成空数组。
 * 这是 v2.0 / v2.1「只开页面、0 张卡片、不点击」的真正根因。
 *
 * 所有辅助逻辑内联在本函数体内，通过 action 分派：
 *   rewards.list / rewards.focus / rewards.activate
 *   sidebar.diagnose / sidebar.open / sidebar.frameInfo / sidebar.dump
 *   sidebar.scan / sidebar.scroll / sidebar.click
 */
/**
 * v2.2 统一注入入口 —— 必须是「单一自包含函数」。
 *
 * 为什么：chrome.scripting.executeScript 只把 func.toString() 注入页面，
 * 它引用的其它顶层函数（deepAll / sidebarClean / scanTaskAnchors …）在页面
 * 上下文里根本不存在 → ReferenceError → 结果被 catch 吞成空数组。
 * 这是 v2.0 / v2.1「只开页面、0 张卡片、不点击」的真正根因。
 *
 * 所有辅助逻辑内联在本函数体内，通过 action 分派：
 *   rewards.list / rewards.focus / rewards.activate
 *   sidebar.diagnose / sidebar.open / sidebar.frameInfo / sidebar.dump
 *   sidebar.scan / sidebar.scroll / sidebar.click
 */
/**
 * v2.2 统一注入入口 —— 必须是「单一自包含函数」。
 *
 * 为什么：chrome.scripting.executeScript 只把 func.toString() 注入页面，
 * 它引用的其它顶层函数（deepAll / sidebarClean / scanTaskAnchors …）在页面
 * 上下文里根本不存在 → ReferenceError → 结果被 catch 吞成空数组。
 * 这是 v2.0 / v2.1「只开页面、0 张卡片、不点击」的真正根因。
 *
 * 所有辅助逻辑内联在本函数体内，通过 action 分派：
 *   rewards.list / rewards.focus / rewards.activate
 *   sidebar.diagnose / sidebar.open / sidebar.frameInfo / sidebar.dump
 *   sidebar.scan / sidebar.scroll / sidebar.click
 */
/**
 * v2.2 统一注入入口 —— 必须是「单一自包含函数」。
 *
 * 为什么：chrome.scripting.executeScript 只把 func.toString() 注入页面，
 * 它引用的其它顶层函数（deepAll / sidebarClean / scanTaskAnchors …）在页面
 * 上下文里根本不存在 → ReferenceError → 结果被 catch 吞成空数组。
 * 这是 v2.0 / v2.1「只开页面、0 张卡片、不点击」的真正根因。
 *
 * 所有辅助逻辑内联在本函数体内，通过 action 分派：
 *   rewards.list / rewards.focus / rewards.activate
 *   sidebar.diagnose / sidebar.open / sidebar.frameInfo / sidebar.dump
 *   sidebar.scan / sidebar.scroll / sidebar.click
 */
/**
 * v2.2 统一注入入口 —— 必须是「单一自包含函数」。
 *
 * 为什么：chrome.scripting.executeScript 只把 func.toString() 注入页面，
 * 它引用的其它顶层函数（deepAll / sidebarClean / scanTaskAnchors …）在页面
 * 上下文里根本不存在 → ReferenceError → 结果被 catch 吞成空数组。
 * 这是 v2.0 / v2.1「只开页面、0 张卡片、不点击」的真正根因。
 *
 * 所有辅助逻辑内联在本函数体内，通过 action 分派：
 *   rewards.list / rewards.focus / rewards.activate
 *   sidebar.diagnose / sidebar.open / sidebar.frameInfo / sidebar.dump
 *   sidebar.scan / sidebar.scroll / sidebar.click
 */
/**
 * v2.2 统一注入入口 —— 必须是「单一自包含函数」。
 *
 * 为什么：chrome.scripting.executeScript 只把 func.toString() 注入页面，
 * 它引用的其它顶层函数（deepAll / sidebarClean / scanTaskAnchors …）在页面
 * 上下文里根本不存在 → ReferenceError → 结果被 catch 吞成空数组。
 * 这是 v2.0 / v2.1「只开页面、0 张卡片、不点击」的真正根因。
 *
 * 所有辅助逻辑内联在本函数体内，通过 action 分派：
 *   rewards.list / rewards.focus / rewards.activate
 *   sidebar.diagnose / sidebar.open / sidebar.frameInfo / sidebar.dump
 *   sidebar.scan / sidebar.scroll / sidebar.click
 */
/**
 * v2.2 统一注入入口 —— 必须是「单一自包含函数」。
 *
 * 为什么：chrome.scripting.executeScript 只把 func.toString() 注入页面，
 * 它引用的其它顶层函数（deepAll / sidebarClean / scanTaskAnchors …）在页面
 * 上下文里根本不存在 → ReferenceError → 结果被 catch 吞成空数组。
 * 这是 v2.0 / v2.1「只开页面、0 张卡片、不点击」的真正根因。
 *
 * 所有辅助逻辑内联在本函数体内，通过 action 分派：
 *   rewards.list / rewards.focus / rewards.activate
 *   sidebar.diagnose / sidebar.open / sidebar.frameInfo / sidebar.dump
 *   sidebar.scan / sidebar.scroll / sidebar.click
 */
function ybInject(action, payload) {
  var p = payload || {};
  var clean = function (el) {
    return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  };
  var deepAll = function (root, selector) {
    var out = [];
    var walk = function (node) {
      if (!node) return;
      try { out.push.apply(out, node.querySelectorAll(selector)); } catch (e) {}
      try {
        var all = node.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) if (all[i].shadowRoot) walk(all[i].shadowRoot);
      } catch (e) {}
    };
    walk(root);
    return out;
  };
  var absUrl = function (h) {
    if (!h) return '';
    try { return new URL(h, location.href).href; } catch (e) { return h; }
  };
  var doneWords = /已完成|已领取|Completed|Claimed/i;
  var bannedText = /可用积分|今日积分|可领取|兑换|还差|管理奖励|连续打卡|显示更多|重置|积分商城徽标/i;
  /* 任务链接指纹：取自用户提供的 dashboard / earn 两份真实保存页，不猜 class */
  var TASK_HREF = /(?:PUBL=RewardsDO|PROGRAMNAME=BingDailyOfferIN|OCID=ML2|form=ML2[A-Z0-9]*|CREA=ML2|rnoreward=1|BTEPOKey|REWARDSQUIZ_DailySet|\/spotlight\/imagepuzzle|rewards\.bing\.com\/earn)/i;
  var BAD_HREF = /(?:\/redeem|\/referandearn|\/apps\/wallpaper|\/earn\/quest\/|^javascript:|form=hpcapt|\/images\/|\/videos\/|\/maps|\/news\/)/i;
  var NAV_ONLY = /^https?:\/\/rewards\.bing\.com\/(?:dashboard|earn)?(?:[?#]|$)/i;

  var headersOf = function () {
    var words = /每日活动|每日任务|每日福利|日常任务|每日一题|Daily activities|Daily set|Daily tasks|More activities/i;
    var out = [];
    var els = deepAll(document, 'h1,h2,h3,h4,h5,div,span,p,button');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], t = clean(el);
      if (!t || t.length > 18 || !words.test(t)) continue;
      if (el.children && el.children.length) {
        var inner = el.querySelector('span,div');
        if (inner && words.test(clean(inner))) continue;
      }
      out.push({ el: el, text: t, top: el.getBoundingClientRect().top });
    }
    var seen = {}, res = [];
    for (var j = 0; j < out.length; j++) {
      var k = out[j].text + '|' + Math.round(out[j].top);
      if (seen[k]) continue;
      seen[k] = 1; res.push(out[j]);
    }
    return res;
  };
  var sectionOf = function (el, headers) {
    var top = el.getBoundingClientRect().top, best = null;
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i], ht = -1e9;
      try { ht = h.el.getBoundingClientRect().top; } catch (e) { continue; }
      if (ht <= top + 40 && (!best || ht > best.top)) best = { text: h.text, top: ht };
    }
    var t = best ? best.text : '';
    if (/每日活动|每日任务|每日福利|每日一题|Daily activities|Daily set/i.test(t)) return 'daily';
    if (/日常任务|Daily tasks|More activities/i.test(t)) return 'promo';
    return 'unknown';
  };
  var hrefOf = function (el) {
    var a = null;
    if (el.closest) a = el.closest('a[href]');
    if (!a && el.tagName === 'A') a = el;
    if (!a && el.querySelector) a = el.querySelector('a[href]');
    if (!a) return '';
    var h = a.getAttribute('href') || '';
    if (!h || /^javascript:/i.test(h)) return '';
    return absUrl(h);
  };
  var targetOf = function (el) {
    var a = el.closest ? el.closest('a[target]') : null;
    return a ? (a.getAttribute('target') || '') : '';
  };
  /* iframe 内元素要换算成顶层视口坐标，CDP 真鼠标才点得中 */
  var topRect = function (el) {
    var r = el.getBoundingClientRect(), ox = 0, oy = 0;
    try {
      if (window.top !== window && window.frameElement) {
        var fr = window.frameElement.getBoundingClientRect();
        ox = fr.left; oy = fr.top;
      }
    } catch (e) {}
    return {
      x: r.left + r.width / 2 + ox, y: r.top + r.height / 2 + oy,
      w: r.width, h: r.height, hasOffset: ox !== 0 || oy !== 0
    };
  };
  var fireMouse = function (el) {
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    var n = 0;
    var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var i = 0; i < types.length; i++) {
      try {
        var type = types[i];
        var ev = type.indexOf('pointer') === 0
          ? new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, view: window,
              clientX: cx, clientY: cy, button: 0, buttons: type.slice(-4) === 'down' ? 1 : 0, isPrimary: true })
          : new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window,
              clientX: cx, clientY: cy, button: 0, buttons: type === 'mousedown' ? 1 : 0, detail: 1 });
        el.dispatchEvent(ev); n++;
      } catch (e) {}
    }
    var native = false;
    try {
      var t = (el.closest && el.closest('a[href],button,[role="button"]')) || el;
      if (typeof t.click === 'function') { t.click(); native = true; }
    } catch (e) {}
    return { dispatched: n, native: native };
  };

  /* ---------------- Rewards 页面（dashboard / earn）---------------- */
  var scanRewardsAnchors = function () {
    var out = [], idx = 0;
    var anchors = deepAll(document, 'a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i], href = a.getAttribute('href') || '';
      if (!href || /^javascript:/i.test(href)) continue;
      if (BAD_HREF.test(href) || NAV_ONLY.test(absUrl(href))) continue;
      var text = clean(a);
      if (!text || text.length > 400 || bannedText.test(text)) continue;
      var points = 0;
      var badge = a.querySelector('[class*="bg-statusSuccessRewardsBg"]');
      if (badge) {
        var bp = badge.querySelector('p');
        var m = /^\s*(\d{1,4})\s*$/.exec(bp ? clean(bp) : clean(badge));
        if (m) points = parseInt(m[1], 10);
      }
      if (!points) {
        var pm = /\+\s*(\d{1,4})(?!\d)/.exec(text);
        if (pm) points = parseInt(pm[1], 10);
      }
      if (!points) {
        var dm = /(?:^|\s)(\d{1,4})\s*(?:已完成|已领取|Completed|Claimed)/i.exec(text);
        if (dm) points = parseInt(dm[1], 10);
      }
      if (!(points > 0)) continue;
      var titleEl = a.querySelector('[class*="text-globalBody2Strong"], h3, h4, strong');
      var img = a.querySelector('img[alt]');
      var name = clean(titleEl) || (img ? (img.getAttribute('alt') || '') : '') || text.split(/\s{2,}/)[0];
      if (!name) name = '任务' + idx;
      out.push({
        idx: idx++, anchor: a, key: name + '|' + points, name: name, points: points,
        done: doneWords.test(text), href: absUrl(href), target: targetOf(a),
        section: sectionOf(a, headersOf())
      });
    }
    return out;
  };
  var listRewards = function (exclude, forceCompleted) {
    var skip = {}, i;
    if (Object.prototype.toString.call(exclude) === '[object Array]') {
      for (i = 0; i < exclude.length; i++) skip[String(exclude[i])] = 1;
    }
    var bodyText = clean(document.body);
    var signedOut = /登录到 Microsoft 帐户|使用你的 Microsoft 帐户|需要启用 JavaScript|Sign in to your Microsoft account/i.test(bodyText)
      || !!document.querySelector('input[name="loginfmt"], input[type="email"], #i0116');
    if (signedOut) {
      return { items: [], anchorCount: 0, doneSkipped: 0, scanned: 0, signedOut: true,
        path: location.pathname, url: location.href, title: document.title || '' };
    }
    var anchors = scanRewardsAnchors(), items = [], doneSkipped = 0;
    for (i = 0; i < anchors.length; i++) {
      var x = anchors[i], k = x.idx + ':' + x.key;
      if (x.done && !forceCompleted) { doneSkipped++; continue; }
      if (skip[k]) continue;
      try { x.anchor.setAttribute('data-yb-task-idx', String(x.idx)); } catch (e) {}
      var tr = topRect(x.anchor);
      items.push({
        idx: x.idx, key: x.key, name: x.name, points: x.points, section: x.section,
        href: x.href, target: x.target, done: x.done,
        x: tr.x, y: tr.y, w: tr.w, h: tr.h
      });
    }
    /* 严格按截图任务列表的 DOM 顺序：不按分组 / 积分 / 完成态重排。 */
    items.sort(function (a, b) { return a.idx - b.idx; });
    return {
      items: items, anchorCount: anchors.length, doneSkipped: doneSkipped,
      scanned: anchors.length, signedOut: false,
      path: location.pathname, url: location.href, title: document.title || ''
    };
  };
  var findRewardsAnchor = function (idx, key) {
    var list = scanRewardsAnchors(), i, hit = null;
    for (i = 0; i < list.length; i++) if (list[i].idx === idx) { hit = list[i]; break; }
    if (!hit && key) for (i = 0; i < list.length; i++) if (list[i].key === key) { hit = list[i]; break; }
    return hit;
  };

  /* ---------------- Bing 侧栏（#rewid-f / iframe / shadow）---------------- */
  var sidebarPanel = function () {
    return document.querySelector('#rewid-f, [data-tag="RewardsHeader.Flyout"], [aria-label="Microsoft Rewards"][role="dialog"]');
  };
  var sidebarTrigger = function () {
    var sels = ['#id_rh_w', '[aria-controls="rewid-f"]', '#id_rh', '#id_rfob',
      '[aria-label*="Microsoft Rewards" i][role="button"]', '[aria-label*="Rewards" i][role="button"]',
      '[data-tag="RewardsHeader.RewardsLink"]'];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (!el) continue;
      var r = el.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1) return { el: el, sel: sels[i] };
    }
    return null;
  };
  var frameInfo = function () {
    var panel = sidebarPanel();
    var display = panel ? (window.getComputedStyle ? getComputedStyle(panel).display : (panel.style.display || '')) : '(no panel)';
    var iframes = [];
    var all = document.querySelectorAll('iframe');
    for (var i = 0; i < all.length; i++) {
      var f = all[i], r = f.getBoundingClientRect();
      iframes.push({
        src: absUrl(f.getAttribute('src') || f.src || ''),
        title: f.getAttribute('title') || '', id: f.id || '',
        w: r.width, h: r.height
      });
    }
    var t = sidebarTrigger();
    return {
      url: location.href, isTop: window.top === window,
      hasTrigger: !!t, triggerSelector: t ? t.sel : '',
      expanded: t && t.el.getAttribute ? t.el.getAttribute('aria-expanded') : '',
      panelDisplay: display, panelVisible: display !== 'none' && display !== '(no panel)',
      iframes: iframes,
      bodyHasDaily: /每日活动|每日任务|Daily activities|Daily set/i.test(clean(document.body)),
      bodyHasPromo: /日常任务|Daily tasks|More activities/i.test(clean(document.body))
    };
  };
  var openSidebar = function () {
    var info0 = frameInfo();
    if (info0.panelVisible && !/none/i.test(info0.panelDisplay)) {
      return { ok: true, alreadyOpen: true, info: frameInfo() };
    }
    var t = sidebarTrigger();
    if (!t) return { ok: false, reason: 'no-trigger', info: info0 };
    var r0 = fireMouse(t.el);
    var info = frameInfo();
    return {
      ok: !!(info.panelVisible || String(info.expanded) === 'true'),
      alreadyOpen: false, selector: t.sel, dispatched: r0.dispatched, native: r0.native,
      info: info
    };
  };
  var scanSidebar = function (exclude, forceCompleted) {
    var skip = {}, i;
    if (Object.prototype.toString.call(exclude) === '[object Array]') {
      for (i = 0; i < exclude.length; i++) skip[String(exclude[i])] = 1;
    }
    var headers = headersOf();
    var clickable = deepAll(document,
      'a[href],button,[role="button"],[role="link"],[tabindex],[data-react-aria-pressable]');
    var raw = [];
    for (i = 0; i < clickable.length; i++) {
      var el = clickable[i], text = clean(el);
      if (!text || text.length > 260 || bannedText.test(text)) continue;
      var href = hrefOf(el);
      var byHref = !!href && !BAD_HREF.test(href) && !NAV_ONLY.test(href) && TASK_HREF.test(href);
      var plusAll = text.match(/\+\s*\d{1,4}(?!\d)/g) || [];
      var pm = /\+\s*(\d{1,4})(?!\d)/.exec(text)
        || /(?:^|\s)(\d{1,4})\s*(?:分|积分|pts|points)/i.exec(text)
        || /(?:^|\s)(\d{1,4})\s*(?:已完成|已领取|Completed|Claimed)/i.exec(text);
      var byText = !!pm && plusAll.length <= 1 && !!href && !BAD_HREF.test(href);
      if (!byHref && !byText) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 16) continue;
      raw.push({
        el: el, text: text, href: href,
        points: pm ? parseInt(pm[1], 10) : 0,
        done: doneWords.test(text), section: sectionOf(el, headers)
      });
    }
    /* 保留最内层（链接本身），避免整块面板容器被当成一张卡 */
    var cards = raw.filter(function (x) {
      return !raw.some(function (o) { return o !== x && x.el.contains && x.el.contains(o.el); });
    });
    var items = [], candidates = 0;
    for (i = 0; i < cards.length; i++) {
      var c = cards[i], idx = candidates++;
      var k = idx + ':' + (c.text.slice(0, 30) + '|' + c.points);
      if (c.done && !forceCompleted) continue;
      if (skip[k]) continue;
      var titleEl = c.el.querySelector && c.el.querySelector('[class*="title" i],[class*="Strong" i],h3,h4,strong,p');
      var name = clean(titleEl) || c.text.split(/\s{2,}/)[0] || ('任务' + idx);
      name = name.replace(/\+\s*\d{1,4}(?!\d)/g, '').replace(doneWords, '').trim().slice(0, 60);
      if (!name) name = '任务' + idx;
      var tr = topRect(c.el);
      try { c.el.setAttribute('data-yb-side-idx', String(idx)); } catch (e) {}
      items.push({
        idx: idx, key: k, name: name, points: c.points, section: c.section, done: c.done,
        href: c.href, target: targetOf(c.el), tag: c.el.tagName,
        cls: String(c.el.className || '').slice(0, 90),
        x: tr.x, y: tr.y, w: tr.w, h: tr.h, hasFrameOffset: tr.hasOffset,
        text: c.text.slice(0, 120)
      });
    }
    /* 严格按截图任务列表的 DOM 顺序：不按分组 / 积分 / 完成态重排。 */
    items.sort(function (a, b) { return a.idx - b.idx; });
    return {
      items: items, candidates: candidates,
      headerHits: headers.map(function (h) { return h.text; }).slice(0, 8),
      isTop: window.top === window, path: location.pathname,
      url: location.href, title: document.title || ''
    };
  };
  var locateSide = function (idx) {
    var el = null;
    try { el = document.querySelector('[data-yb-side-idx="' + idx + '"]'); } catch (e) {}
    if (!el) {
      var all = deepAll(document, '[data-yb-side-idx]');
      for (var i = 0; i < all.length; i++) {
        if (all[i].getAttribute('data-yb-side-idx') === String(idx)) { el = all[i]; break; }
      }
    }
    return el;
  };
  var scrollSide = function (idx) {
    var el = locateSide(idx);
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    return topRect(el);
  };
  var clickSide = function (idx, key, href) {
    var el = locateSide(idx);
    if (!el && href) {
      var all = deepAll(document, 'a[href]');
      for (var i = 0; i < all.length; i++) {
        if (absUrl(all[i].getAttribute('href') || '') === href) { el = all[i]; break; }
      }
    }
    if (!el) return { ok: false, reason: 'not-found', href: href || '' };
    var r = fireMouse(el);
    return {
      ok: r.native || r.dispatched >= 5, dispatched: r.dispatched, native: r.native,
      href: hrefOf(el) || href || '', target: targetOf(el)
    };
  };
  var diagnose = function () {
    var plus = [];
    var els = deepAll(document, 'a[href],button,div,span,p');
    for (var i = 0; i < els.length; i++) {
      var t = clean(els[i]);
      if (t && t.length < 160 && /\+\s*\d{1,4}(?!\d)/.test(t) && plus.length < 12) plus.push(t);
    }
    var body = clean(document.body);
    var info = frameInfo();
    return {
      url: location.href, title: document.title || '', isTop: window.top === window,
      hasTrigger: info.hasTrigger, panelVisible: info.panelVisible,
      iframes: info.iframes.map(function (f) { return f.src.slice(0, 140); }),
      hasDaily: /每日活动|每日任务|Daily activities|Daily set/i.test(body),
      hasPromo: /日常任务|Daily tasks|More activities/i.test(body),
      hasRewards: /Microsoft Rewards/i.test(body),
      plusHits: plus,
      clickableCount: deepAll(document, 'a[href],button,[role="button"],[tabindex]').length,
      taskHrefCount: (function () {
        var n = 0, as = deepAll(document, 'a[href]');
        for (var j = 0; j < as.length; j++) {
          var h = absUrl(as[j].getAttribute('href') || '');
          if (h && !BAD_HREF.test(h) && TASK_HREF.test(h)) n++;
        }
        return n;
      })(),
      bodyHead: body.slice(0, 220)
    };
  };
  /* 一键导出：把侧栏里所有可点击元素的真实结构吐出来，便于对齐 DOM */
  var dump = function (limit) {
    var max = limit || 140, out = [];
    var els = deepAll(document, 'a[href],button,[role="button"],[role="link"],[tabindex],[data-react-aria-pressable]');
    for (var i = 0; i < els.length && out.length < max; i++) {
      var el = els[i], t = clean(el), r = el.getBoundingClientRect();
      if (!t && !el.getAttribute('href')) continue;
      var h = absUrl(el.getAttribute('href') || '');
      out.push({
        tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 100),
        role: el.getAttribute('role') || '', target: el.getAttribute('target') || '',
        text: t.slice(0, 90), href: h.slice(0, 220),
        taskHref: !!h && !BAD_HREF.test(h) && TASK_HREF.test(h),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
      });
    }
    return {
      url: location.href, isTop: window.top === window, frameInfo: frameInfo(),
      headers: headersOf().map(function (h) { return h.text; }),
      totalClickable: els.length, elements: out
    };
  };

  /* ------------------------------------------------------------------
   * v2.3：点击目标来自「获取任务列表」的解析结果（cardsFromRewardsHtml）。
   * 每个任务自带真实 url（RSC destination 或 DOM href），不再重新猜卡片。
   * 这里只做一件事：拿这个 url / name 在页面里找到对应 <a>，模拟鼠标点击。
   * ------------------------------------------------------------------ */

  /** RSC payload 里 URL 常含字面量 \u0026 / &amp;，必须先归一化才能和 DOM href 比。 */
  var normalizeUrl = function (u) {
    return String(u || '')
      .replace(/\\+u0026/gi, '&')
      .replace(/\\+u003d/gi, '=')
      .replace(/\\+u0025/gi, '%')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, '')
      .trim();
  };

  /**
   * URL 指纹：host + path + q 参数 + form 参数。
   * RSC 的 destination 可能被截断（如 "…&filters=sid:"），DOM 里是完整链接，
   * 用 q / form 比对即可命中同一个任务，不必逐字符相等。
   */
  var urlFp = function (u) {
    var h = normalizeUrl(u);
    try {
      var x = new URL(h);
      var q = (x.searchParams.get('q') || '').toLowerCase().replace(/\s+/g, '');
      var form = '';
      x.searchParams.forEach(function (v, k) { if (/^form$/i.test(k)) form = String(v).toLowerCase(); });
      return x.hostname.replace(/^www\./i, '') + x.pathname.replace(/\/$/, '')
        + '|' + q + '|' + form;
    } catch (e) {
      return h.split('#')[0].split('?')[0].toLowerCase();
    }
  };

  var taskAnchors = function () {
    var out = [];
    var as = deepAll(document, 'a[href]');
    for (var i = 0; i < as.length; i++) {
      var a = as[i];
      var h = normalizeUrl(absUrl(a.getAttribute('href') || ''));
      if (!/^https?:\/\//i.test(h)) continue;
      if (BAD_HREF.test(h) || NAV_ONLY.test(h)) continue;
      if (!TASK_HREF.test(h)) continue;
      var r = a.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) continue;
      out.push({ el: a, href: h, text: clean(a), fp: urlFp(h) });
    }
    return out;
  };

  /** 按任务列表里的 url / name / points 找对应 <a>；返回最内层元素。 */
  var findTaskAnchor = function (target) {
    var anchors = taskAnchors();
    var wantedFp = urlFp(target.url || '');
    var i, hits = [], by = '';
    // 1) URL 指纹精确命中（最可靠：直接来自任务列表解析结果）
    for (i = 0; i < anchors.length; i++) {
      if (wantedFp && anchors[i].fp === wantedFp) hits.push(anchors[i]);
    }
    if (hits.length) by = 'url';
    // 2) 完整 URL 前缀命中（q 相同但 form 大小写/多余参数不同）
    if (!hits.length && target.url) {
      var w = normalizeUrl(target.url);
      for (i = 0; i < anchors.length; i++) {
        var h = anchors[i].href;
        if (h === w || (w.length > 20 && (h.indexOf(w) === 0 || w.indexOf(h) === 0))) hits.push(anchors[i]);
      }
      if (hits.length) by = 'url-prefix';
    }
    // 3) 任务标题文本命中（RSC 无 url 或 url 被截断时）
    if (!hits.length && target.name) {
      var nm = String(target.name).replace(/\s+/g, '');
      for (i = 0; i < anchors.length; i++) {
        if (anchors[i].text.replace(/\s+/g, '').indexOf(nm) >= 0) hits.push(anchors[i]);
      }
      if (hits.length) by = 'name';
    }
    // 4) 积分 + 标题片段兜底
    if (!hits.length && target.name && target.points) {
      var frag = String(target.name).slice(0, 6).replace(/\s+/g, '');
      var pt = '+' + target.points;
      for (i = 0; i < anchors.length; i++) {
        var t = anchors[i].text.replace(/\s+/g, '');
        if (t.indexOf(frag) >= 0 && t.indexOf(pt) >= 0) hits.push(anchors[i]);
      }
      if (hits.length) by = 'name+points';
    }
    if (!hits.length) return null;
    // 多个命中时取最内层（页面外层容器也可能是 <a>）
    var best = hits[0];
    for (i = 1; i < hits.length; i++) {
      if (best.el.contains && best.el.contains(hits[i].el)) best = hits[i];
    }
    return { anchor: best.el, href: best.href, by: by, candidates: hits.length };
  };

  /** 只定位 + 滚动，返回顶层坐标（供 CDP 真鼠标）。 */
  var findTask = function (target) {
    var hit = findTaskAnchor(target);
    if (!hit) return { ok: false, reason: 'not-found', url: normalizeUrl(target.url || '') };
    try { hit.anchor.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    var tr = topRect(hit.anchor);
    return {
      ok: true, x: tr.x, y: tr.y, w: tr.w, h: tr.h,
      href: hit.href, by: hit.by, candidates: hit.candidates,
      target: targetOf(hit.anchor), text: clean(hit.anchor).slice(0, 80)
    };
  };

  /** 定位 + 完整指针/鼠标事件序列 + 原生 click()（触发 <a target=_blank>）。 */
  var clickTask = function (target) {
    var hit = findTaskAnchor(target);
    if (!hit) return { ok: false, reason: 'not-found', href: normalizeUrl(target.url || '') };
    var r = fireMouse(hit.anchor);
    return {
      ok: r.native || r.dispatched >= 5, dispatched: r.dispatched, native: r.native,
      href: hit.href, by: hit.by, target: targetOf(hit.anchor),
      targetBlank: /_blank/i.test(targetOf(hit.anchor)),
      text: clean(hit.anchor).slice(0, 80)
    };
  };

  /**
   * v2.4 诊断：导出本 frame 里所有任务型 <a>，并标注与任务列表指纹的匹配情况。
   * 用于「找不到卡片」时定位：是页面没渲染、URL 不同、还是卡片在另一个 frame。
   */
  var probeTasks = function (wantedFps) {
    var wanted = {};
    var i, k;
    if (Object.prototype.toString.call(wantedFps) === '[object Array]') {
      for (i = 0; i < wantedFps.length; i++) wanted[String(wantedFps[i])] = 1;
    }
    var anchors = taskAnchors();
    var out = [];
    for (i = 0; i < anchors.length; i++) {
      var a = anchors[i], tr = topRect(a.el);
      out.push({
        href: a.href, fp: a.fp, text: a.text.slice(0, 100),
        target: targetOf(a.el), tag: a.el.tagName,
        cls: String(a.el.className || '').slice(0, 90),
        x: tr.x, y: tr.y, w: tr.w, h: tr.h,
        wanted: !!wanted[a.fp]
      });
    }
    var body = clean(document.body);
    return {
      ok: true, url: location.href, title: document.title || '',
      isTop: window.top === window,
      signedOut: /登录到 Microsoft 帐户|使用你的 Microsoft 帐户|需要启用 JavaScript|Sign in to your Microsoft account/i.test(body),
      taskAnchors: out,
      bodyHead: body.slice(0, 200)
    };
  };

  /** 从当前页面 DOM 反推任务列表（任务列表解析为空时的补充数据源）。 */
  var collectTasks = function () {
    var anchors = taskAnchors();
    var out = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i], text = a.text;
      if (!text || bannedText.test(text)) continue;
      var pm = /\+\s*(\d{1,4})(?!\d)/.exec(text)
        || /(?:^|\s)(\d{1,4})\s*(?:分|积分|pts|points)/i.exec(text)
        || /(?:^|\s)(\d{1,4})\s*(?:已完成|已领取|Completed|Claimed)/i.exec(text);
      var badge = a.el.querySelector && a.el.querySelector('[class*="bg-statusSuccessRewardsBg"]');
      var points = pm ? parseInt(pm[1], 10) : 0;
      if (!points && badge) {
        var bm = /^\s*(\d{1,4})\s*$/.exec(clean(badge));
        if (bm) points = parseInt(bm[1], 10);
      }
      if (!(points > 0)) continue;
      var titleEl = a.el.querySelector && a.el.querySelector(
        '[class*="text-globalBody2Strong"],[class*="title" i],h3,h4,strong,p');
      var name = clean(titleEl) || text.split(/\s{2,}/)[0] || ('任务' + i);
      name = name.replace(/\+\s*\d{1,4}(?!\d)/g, '').replace(doneWords, '').trim().slice(0, 60);
      var tr = topRect(a.el);
      try { a.el.setAttribute('data-yb-task-idx', String(i)); } catch (e) {}
      out.push({
        idx: i, name: name, points: points,
        description: '', section: sectionOf(a.el, headersOf()),
        completed: doneWords.test(text), earned: doneWords.test(text) ? points : 0,
        url: a.href, href: a.href, source: 'dom-collect',
        x: tr.x, y: tr.y, w: tr.w, h: tr.h
      });
    }
    return { ok: out.length > 0, rows: out, total: anchors.length,
      url: location.href, title: document.title || '' };
  };

  /* ==================================================================
   * v2.5 · 就照人做的来：打开页面 → 滚动 → 鼠标点卡片
   * 不抓 HTML、不解析 RSC、不算 URL 指纹、不跨 frame 猜、不校验新标签页。
   * 页面里有什么卡片就点什么卡片，每点一张都滚到它、派发真实鼠标事件、
   * 最后调用 <a>.click() 让 target=_blank 自己开新标签页。
   * ================================================================== */

  /* 任务卡 = 带积分的、指向 Bing 任务链接的 <a>。真实页面里就是
     <a target="_blank" rel="noopener noreferrer" href="...PUBL=RewardsDO...">…<p>+10</p></a> */
  /* 参考项目 REWARDS_TRIGGERS：Bing 顶部积分入口在不同布局里的常见标记 */
  var PANEL_TRIGGERS = [
    '.points-container', '#id_rc', '#id_rh', '#id_rh_w', '#bingRewards',
    '[aria-label="Microsoft Rewards"]', '[title="Microsoft Rewards"]',
    '[data-testid="rewards-button"]'
  ];

  var openPanel = function () {
    var tried = [], i, j;
    for (i = 0; i < PANEL_TRIGGERS.length; i++) {
      var els = deepAll(document, PANEL_TRIGGERS[i]);
      for (j = 0; j < Math.min(els.length, 4); j++) {
        var el = els[j], r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        try {
          fireMouse(el);
          tried.push(PANEL_TRIGGERS[i]);
          return { ok: true, trigger: PANEL_TRIGGERS[i], tried: tried };
        } catch (e) {}
      }
    }
    return { ok: false, tried: tried, url: location.href };
  };

  /* v2.7：中文 cn.bing.com flyout 里任务卡是「标题+描述+蓝色 +10 徽章」的矩形容器，
     不是 <a href=PUBL=RewardsDO>，也不是三个圆形 Offer。按徽章反查卡片。 */
  /* v2.8：只点「能给分且未完成」的卡。
     之前 done 硬编码 false、禁词太少，把已领取 / 进度 / 打卡 / 推广卡也点了。 */
  var CARD_BAN = /已获得|已领取|已拿满|已完成|已结束|已过期|已用完|已达上限|不计分|不给分|全部查看|兑换|查看首页|我的积分|连续|连续打卡|Star bonus|bonus points|在 ?MICROSOFT|必应上搜索|搜索并|继续搜索|每天继续|最多 ?\d|奖励积分|打卡|punchcard|积分商城|帮助和反馈|on track|completed|claimed|already|congratulations/i;
  var DONE_CARD = /已完成|已领取|已拿满|已获得|已完成领取|completed|claimed|offer completed/i;

  /* 跳过原因分级：让用户一眼看出这张为什么不给分 */
  var banReason = function (t) {
    if (/已完成|已领取|已拿满|已获得/i.test(t)) return '已完成/已领取';
    if (/在 ?MICROSOFT|必应上搜索|搜索并|继续搜索|每天继续|奖励积分|最多 ?\d|Star bonus|bonus points|on track|打卡|punchcard/i.test(t))
      return '搜索进度/打卡/推广卡（不给分）';
    if (/兑换|查看首页|我的积分|全部查看|帮助和反馈|积分商城/i.test(t))
      return '头部/导航/兑换入口（不给分）';
    return '进度/推广/兑换等非任务卡';
  };
  /* 每日任务集固定 3 张；超出的一律跳过，避免点到「更多活动」里的推广/0 分卡 */
  var MAX_TASK_CARDS = 3;

  var sectionTops = function () {
    var all = deepAll(document, 'h1,h2,h3,h4,h5,div,span,p'), start = -1, end = 1e9, i;
    for (i = 0; i < all.length; i++) {
      var t = clean(all[i]);
      if (t.length > 30) continue;
      var top = all[i].getBoundingClientRect().top;
      if (/^(每日设置|每日活动|每日任务|Daily set|Daily activities)/i.test(t) && start < 0) start = top;
      if (/在 ?MICROSOFT|必应上搜索|You.re on track|Star bonus/i.test(t) && top > 0) end = Math.min(end, top);
    }
    return { start: start, end: end };
  };

  /**
   * 按 +N 徽章反查矩形卡片容器。
   * 返回 { cards, skipped }，skipped 带原因，让日志/可视化能解释「为什么没点」。
   */
  var badgeCards = function (includeDone) {
    var all = deepAll(document, '*');
    var zone = sectionTops();
    var badges = [], i, j;
    for (i = 0; i < all.length && i < 9000; i++) {
      var t = clean(all[i]);
      var m = /^\+\s*(\d{1,4})$/.exec(t);
      if (!m) continue;
      var r = all[i].getBoundingClientRect();
      if (r.width < 8 || r.width > 100 || r.height < 8 || r.height > 64) continue;
      badges.push({ el: all[i], points: parseInt(m[1], 10) });
    }
    var out = [], skipped = [], seen = [];
    for (i = 0; i < badges.length; i++) {
      var pts = badges[i].points, p = badges[i].el, hit = null, reason = '';
      for (var up = 0; up < 7 && p; up++, p = p.parentElement) {
        var pr = p.getBoundingClientRect();
        if (pr.width < 150 || pr.height < 55) continue;
        var pt = clean(p);
        if (!pt || pt.length > 170 || CARD_BAN.test(pt)) {
          if (!reason && CARD_BAN.test(pt)) reason = banReason(pt);
          continue;
        }
        if (!/[\u4e00-\u9fa5A-Za-z]{4}/.test(pt.replace(/\+\s*\d{1,4}/g, ''))) continue;
        hit = { el: p, text: pt, points: pts, r: pr };
        break;
      }
      if (!hit) {
        skipped.push({ title: (clean(badges[i].el.parentElement) || '').slice(0, 40),
          points: pts, reason: reason || '非任务卡（尺寸/文本不匹配）' });
        continue;
      }

      var title = hit.text.replace(/\+\s*\d{1,4}/g, '').replace(/\s+/g, ' ').trim().slice(0, 44);
      var dup = false;
      for (j = 0; j < seen.length; j++) if (seen[j] === hit.el) { dup = true; break; }
      if (dup) { skipped.push({ title: title, points: pts, reason: '重复卡片' }); continue; }
      seen.push(hit.el);

      /* 完成态：文本 / aria-label / 卡片内完成徽章，三处都查 */
      var aria = String(hit.el.getAttribute('aria-label') || '') + ' '
        + (function () { try { return clean(hit.el.querySelector('[class*="completed"],[class*="claimed"]')) || ''; } catch (e) { return ''; } })();
      var done = DONE_CARD.test(hit.text) || DONE_CARD.test(aria);
      if (done && !includeDone) {
        skipped.push({ title: title, points: pts, reason: '已完成/已领取' });
        continue;
      }
      if (!(pts > 0)) {
        skipped.push({ title: title, points: pts, reason: '0 分（不给积分）' });
        continue;
      }
      /* 分区：必须在「每日设置」之后、「在 MICROSOFT 必应上搜索」之前 */
      if (zone.start > 0 && hit.r.top < zone.start - 10) {
        skipped.push({ title: title, points: pts, reason: '在每日任务区之上（头部/积分概览）' });
        continue;
      }
      if (zone.end < 1e9 && hit.r.top > zone.end - 10) {
        skipped.push({ title: title, points: pts, reason: '在搜索进度/Star bonus 区（不给分）' });
        continue;
      }
      if (out.length >= MAX_TASK_CARDS) {
        skipped.push({ title: title, points: pts, reason: '超出每日任务集 3 张上限（推广/更多活动）' });
        continue;
      }
      out.push({
        idx: 2000 + i, el: hit.el, href: '', text: hit.text.slice(0, 100),
        title: title, points: pts, done: done,
        target: '', section: 'daily', kind: 'badge', badgeIndex: out.length
      });
    }
    return { cards: out, skipped: skipped, zone: zone, hasBadges: badges.length > 0 };
  };

  var OFFER_SELECTORS = [
    '#bingRewards .flyout_control_threeOffers div[aria-label*="Offer"]',
    '.flyout_control_threeOffers div[aria-label*="Offer"]'
  ];

  var humanCards = function (includeDone) {
    var out = [];
    /* v2.8：页面上只要出现 +N 徽章，就说明是「矩形卡片」布局（中文 flyout）。
       此时独占使用徽章卡结果，不再叠加 <a> / 圆形 Offer 两条路径 ——
       之前混用正是「同一张卡被点两次、顺带点到推广卡」的来源。 */
    var bdEarly = badgeCards(includeDone);
    if (bdEarly.hasBadges) {
      for (var be = 0; be < bdEarly.cards.length; be++) {
        var btr = topRect(bdEarly.cards[be].el);
        bdEarly.cards[be].x = btr.x; bdEarly.cards[be].y = btr.y;
        bdEarly.cards[be].w = btr.w; bdEarly.cards[be].h = btr.h;
      }
      return bdEarly.cards;
    }
    var as = deepAll(document, 'a[href]');
    for (var i = 0; i < as.length; i++) {
      var a = as[i];
      var href = absUrl(a.getAttribute('href') || '');
      if (!/^https?:\/\//i.test(href)) continue;
      if (BAD_HREF.test(href) || NAV_ONLY.test(href)) continue;
      if (!TASK_HREF.test(href)) continue;
      var text = clean(a);
      if (!text || bannedText.test(text)) continue;
      var r = a.getBoundingClientRect();
      if (r.width < 40 || r.height < 24) continue;          // 排除隐藏/零尺寸节点
      var done = doneWords.test(text);
      if (done && !includeDone) continue;
      var pm = /\+\s*(\d{1,4})(?!\d)/.exec(text);
      var badge = a.querySelector && a.querySelector('[class*="bg-statusSuccessRewardsBg"]');
      var points = pm ? parseInt(pm[1], 10) : 0;
      if (!points && badge) {
        var bm = /^\s*(\d{1,4})\s*$/.exec(clean(badge));
        if (bm) points = parseInt(bm[1], 10);
      }
      if (!(points > 0)) continue;
      var tr = topRect(a);
      out.push({
        idx: i, el: a, href: href, text: text.slice(0, 100), points: points,
        done: done, target: a.getAttribute('target') || '',
        section: sectionOf(a, headersOf()), kind: 'anchor',
        x: tr.x, y: tr.y, w: tr.w, h: tr.h
      });
    }

    /* 参考项目 activity_click.py：Bing 侧栏每日任务集常只显示三个圆形图标，
       没有文字标题、没有 +10。用 aria-label 的 'offer not completed' 判定，
       按 0/1/2 顺序点击；绝不用任务 URL 直接 goto 代替。 */
    for (var k = 0; k < OFFER_SELECTORS.length; k++) {
      var offers = deepAll(document, OFFER_SELECTORS[k]);
      if (offers.length !== 3) continue;
      for (var j = 0; j < 3; j++) {
        var o = offers[j];
        var label = String(o.getAttribute('aria-label') || '').toLowerCase();
        if (!/offer/.test(label)) continue;
        var odone = !/not completed/.test(label) || /offer completed/.test(label);
        if (odone && !includeDone) continue;
        var orc = o.getBoundingClientRect();
        if (orc.width < 8 || orc.height < 8) continue;
        var otr = topRect(o);
        out.push({
          idx: 1000 + j, el: o, href: '', text: '侧栏 Offer ' + (j + 1)
            + ' [' + label.slice(0, 60) + ']', points: 10, done: odone,
          target: '', section: 'daily', kind: 'offer', offerIndex: j,
          x: otr.x, y: otr.y, w: otr.w, h: otr.h
        });
      }
      break;
    }
    /* 矩形徽章卡：若容器内已有更精确的 <a> 卡，跳过避免重复点同一张 */
    return out;
  };

  /* 人打开页面后会先滚一滚：这里从顶到底分段滚，触发懒加载/ hydration */
  var humanScrollPage = function () {
    var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 800);
    var step = Math.max(300, Math.round(window.innerHeight * 0.7));
    var at = 0;
    try {
      for (var y = 0; y <= h; y += step) { window.scrollTo(0, y); at = y; }
      window.scrollTo(0, 0);
    } catch (e) {}
    return { ok: true, scrollHeight: h, step: step, last: at, y: window.scrollY || 0 };
  };

  /* 扫描结果（只回传可序列化字段） */
  var humanScan = function (includeDone) {
    var cards = humanCards(includeDone);
    var bd = badgeCards(includeDone);
    var body = clean(document.body);
    return {
      ok: true,
      url: location.href, title: document.title || '',
      signedOut: /登录到 Microsoft 帐户|使用你的 Microsoft 帐户|需要启用 JavaScript|Sign in to your Microsoft account/i.test(body),
      total: cards.length,
      pending: cards.filter(function (c) { return !c.done; }).length,
      done: cards.filter(function (c) { return c.done; }).length,
      cards: cards.map(function (c) {
        return { idx: c.idx, href: c.href, text: c.text, points: c.points,
          done: c.done, target: c.target, section: c.section,
          kind: c.kind, offerIndex: c.offerIndex, badgeIndex: c.badgeIndex,
          title: c.title || '', x: c.x, y: c.y, w: c.w, h: c.h };
      }),
      skipped: bd.skipped, zone: bd.zone,
      bodyHead: body.slice(0, 160)
    };
  };

  /* 从 humanCards 里按 idx / href / offerIndex / badgeIndex / 标题 / order 挑一张 */
  var pickCard = function (cards, payload) {
    var i, c = null;
    for (i = 0; i < cards.length; i++) {
      if (String(cards[i].el.getAttribute('data-yb-hidx') || '') === String(payload.idx)) { c = cards[i]; break; }
    }
    if (!c && payload.href) {
      for (i = 0; i < cards.length; i++) if (cards[i].href === payload.href) { c = cards[i]; break; }
    }
    if (!c && Number.isFinite(payload.offerIndex)) {
      for (i = 0; i < cards.length; i++)
        if (cards[i].kind === 'offer' && cards[i].offerIndex === payload.offerIndex) { c = cards[i]; break; }
    }
    if (!c && Number.isFinite(payload.badgeIndex)) {
      for (i = 0; i < cards.length; i++)
        if (cards[i].kind === 'badge' && cards[i].badgeIndex === payload.badgeIndex) { c = cards[i]; break; }
    }
    if (!c && payload.title) {
      var want = String(payload.title).replace(/\s+/g, '');
      for (i = 0; i < cards.length; i++) {
        var got = (cards[i].title || cards[i].text || '').replace(/\s+/g, '');
        if (got && (got.indexOf(want) >= 0 || want.indexOf(got.slice(0, 8)) >= 0)) { c = cards[i]; break; }
      }
    }
    if (!c && Number.isFinite(payload.order)) c = cards[payload.order] || null;
    return c;
  };

  /**
   * v2.7 关键：点击前「实时」把目标滚进视口并重读坐标。
   * 不能用扫描时缓存的坐标 —— 调试横幅出现、hydration、内部滚动容器、
   * 5s 等待、上一张点击后面板刷新，都会让旧坐标失效（点偏到空白处）。
   */
  var humanAim = function (payload) {
    var cards = humanCards(false);
    var c = pickCard(cards, payload);
    if (!c) return { ok: false, reason: 'not-found', total: cards.length,
      titles: cards.map(function (x) { return x.title || x.text.slice(0, 24); }).slice(0, 12) };
    try { c.el.setAttribute('data-yb-hidx', String(payload.idx)); } catch (e) {}
    try { c.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    // 重读实时 rect（含 iframe 偏移）
    var r = c.el.getBoundingClientRect();
    var ox = 0, oy = 0;
    try {
      if (window.top !== window && window.frameElement) {
        var fr = window.frameElement.getBoundingClientRect(); ox = fr.left; oy = fr.top;
      }
    } catch (e) {}
    var cx = r.left + r.width * 0.5 + ox, cy = r.top + r.height * 0.5 + oy;
    return {
      ok: true, x: cx, y: cy, w: r.width, h: r.height,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      text: c.text, title: c.title || '', points: c.points,
      kind: c.kind, href: c.href, tag: c.el.tagName,
      badgeIndex: c.badgeIndex, offerIndex: c.offerIndex,
      scrollY: window.scrollY || 0,
      vp: { w: window.innerWidth, h: window.innerHeight },
      url: location.href
    };
  };

  /* 按 idx 找到卡片 → 滚到它 → 真鼠标事件序列 → 原生 click() */
  var humanClick = function (payload) {
    var cards = humanCards(false);
    var c = pickCard(cards, payload);
    if (!c) return { ok: false, reason: 'not-found', total: cards.length };
    try { c.el.setAttribute('data-yb-hidx', String(payload.idx)); } catch (e) {}
    var res = fireMouse(c.el);              // 内含 scrollIntoView + 5 段事件 + a.click()
    return {
      ok: res.native || res.dispatched >= 5,
      dispatched: res.dispatched, native: res.native,
      href: c.href, text: c.text, points: c.points,
      target: c.target, kind: c.kind, x: c.x, y: c.y, title: c.title || '',
      scrolledTo: Math.round(c.el.getBoundingClientRect().top + window.scrollY)
    };
  };

  /* 找不到卡片时，把页面里所有链接列出来，一眼看出到底渲染了什么 */
  var humanProbe = function () {
    var out = [];
    var as = deepAll(document, 'a[href]');
    for (var i = 0; i < as.length && out.length < 120; i++) {
      var a = as[i], h = absUrl(a.getAttribute('href') || '');
      var r = a.getBoundingClientRect();
      out.push({ idx: i, href: h.slice(0, 180), text: clean(a).slice(0, 90),
        w: Math.round(r.width), h: Math.round(r.height) });
    }
    var bd = badgeCards(true), bc = bd.cards;
    return { ok: true, url: location.href, title: document.title || '',
      total: as.length, links: out, skipped: bd.skipped, zone: bd.zone,
      badgeCards: bc.map(function (b) {
        var r = b.el.getBoundingClientRect();
        return { title: b.title, points: b.points, text: b.text.slice(0, 90),
          w: Math.round(r.width), h: Math.round(r.height),
          x: Math.round(r.left), y: Math.round(r.top) };
      }),
      bodyHead: clean(document.body).slice(0, 200) };
  };

  /**
   * v2.8 best-effort：在已登录标签页内调官方 getuserinfo，拿当天任务列表。
   * 只用于「白名单增强」和「点完是否真计分」的核验；CORS / 失败一律静默回退，
   * 绝不阻塞本地启发式点击。参考项目 activity_worker.confirmed_completed。
   */
  var verifyTasks = function () {
    var url = 'https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest';
    var parse = function (data) {
      var dash = (data && data.dashboard) || {};
      var d = new Date(), pad = function (n) { return String(n).padStart(2, '0'); };
      var iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      var dsp = dash.dailySetPromotions || {};
      var items = dsp[iso]
        || dsp[pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear()] || [];
      if (!items.length) {
        for (var k in dsp) if (String(k).indexOf(iso) >= 0) { items = dsp[k]; break; }
      }
      return (items || []).map(function (it) {
        var mx = 0, cur = 0;
        try { mx = parseInt(it.pointProgressMax || it.pointsMax || 0, 10) || 0; } catch (e) {}
        try { cur = parseInt(it.pointProgress || 0, 10) || 0; } catch (e) {}
        return {
          offerId: String(it.offerId || it.id || ''),
          title: String(it.title || it.name || it.description || '').slice(0, 60),
          complete: !!it.complete || (mx > 0 && cur >= mx),
          pointsMax: mx, pointsEarned: cur
        };
      });
    };
    /* executeScript 会 await 返回的 Promise。2.5s 超时，失败/CORS 一律静默回退，
       不阻塞、不改变本地启发式点击结果。 */
    var timeout = new Promise(function (resolve) {
      setTimeout(function () { resolve({ ok: false, tasks: [], reason: '超时' }); }, 2500);
    });
    var job = fetch(url, { credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) { return { ok: true, tasks: parse(data), reason: '' }; })
      .catch(function (e) { return { ok: false, tasks: [], reason: '不可用：' + (e && e.message || e) }; });
    return Promise.race([job, timeout]);
  };

  switch (action) {
    case 'rewards.list':     return listRewards(p.exclude, p.force);
    case 'rewards.focus': {
      var rf = findRewardsAnchor(p.idx, p.key);
      if (!rf) return { ok: false, reason: 'not-found' };
      try { rf.anchor.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
      var rr = topRect(rf.anchor);
      return { ok: true, x: rr.x, y: rr.y, w: rr.w, h: rr.h,
        href: rf.href, target: rf.target };
    }
    case 'rewards.activate': {
      var ra = findRewardsAnchor(p.idx, p.key);
      if (!ra) return { ok: false, reason: 'not-found' };
      try { ra.anchor.click(); return { ok: true, href: ra.href, target: ra.target }; }
      catch (e) { return { ok: false, reason: String(e && e.message || e), href: ra.href }; }
    }
    case 'sidebar.frameInfo': return frameInfo();
    case 'sidebar.open':      return openSidebar();
    case 'sidebar.diagnose':  return diagnose();
    case 'sidebar.dump':      return dump(p.limit);
    case 'sidebar.scan':      return scanSidebar(p.exclude, p.force);
    case 'sidebar.scroll':    return scrollSide(p.idx);
    case 'sidebar.click':     return clickSide(p.idx, p.key, p.href);
    case 'task.list':         return collectTasks();
    case 'task.find':         return findTask(p.target || {});
    case 'task.click':        return clickTask(p.target || {});
    case 'task.probe':        return probeTasks(p.fps || []);
    case 'human.scan':        return humanScan(!!p.includeDone);
    case 'human.scroll':      return humanScrollPage();
    case 'human.click':       return humanClick(p);
    case 'human.probe':       return humanProbe();
    case 'human.openPanel':   return openPanel();
    case 'human.aim':         return humanAim(p);
    case 'human.verify':      return verifyTasks();
    default: return { ok: false, reason: 'unknown-action', action: action };
  }
}

async function tabIds() {
  try {
    const list = await chrome.tabs.query({});
    return Array.isArray(list) ? list.map(t => t.id) : null;
  } catch { return null; }
}

/** 目标路径匹配：/dashboard 与根路径互认，/earn 允许带 query / 尾斜杠。 */
function taskPageMatches(actualPath, wantPath) {
  const a = String(actualPath || '/').toLowerCase();
  const w = String(wantPath || '/').toLowerCase();
  if (w === '/dashboard') return a === '/dashboard' || a === '/' || a === '' || a.startsWith('/dashboard');
  return a === w || a.startsWith(w + '/') || a.startsWith(w + '?');
}

/* ==========================================================================
 * v2.1 · Bing 侧栏任务点击（替代 rewards.bing.com 两页模式）
 * ======================================================================== */
/**
 * v2.2 诊断入口：把 Bing 侧栏（顶层 + 所有 frame）的真实 DOM 结构导出。
 * 用法：在扩展 Service Worker 控制台执行
 *   chrome.runtime.sendMessage({type:'dumpSidebar'}, r => console.log(JSON.stringify(r, null, 2)))
 * 结果同时写入 chrome.storage.local.sidebarDump，方便复制。
 */
async function dumpSidebarDom(limit) {
  const tabId = await openSidebarTab();
  await inject(tabId, ybInject, ['sidebar.open', {}]);
  await nap(1600);
  const frameInfo = await inject(tabId, ybInject, ['sidebar.frameInfo', {}]);
  const frames = await injectAllFrames(tabId, ybInject, ['sidebar.dump', { limit: limit || 140 }]);
  const payload = {
    ok: true, at: Date.now(), tabId,
    frameInfo,
    frames: frames.map(f => ({ frameId: f.frameId, error: f.error || null, data: f.result || null }))
  };
  await store({ sidebarDump: payload });
  for (const f of payload.frames) {
    console.info('[dumpSidebar] frame ' + f.frameId + ' url=' + (f.data && f.data.url)
      + ' total=' + (f.data && f.data.totalClickable)
      + (f.error ? ' ERROR=' + f.error : ''));
  }
  console.info('[dumpSidebar] 完整结构已写入 storage.local.sidebarDump');
  return payload;
}

async function openSidebarTab() {
  const tabId = await openOrNavigate('sidebarTabId', SIDEBAR_URL, true);
  await ensureTabActive(tabId);
  return tabId;
}

/**
 * v2.2：等侧栏真正展开。
 * 真实保存页里入口是 #id_rh_w（aria-controls="rewid-f"），面板 #rewid-f 默认
 * display:none，内容在 <iframe> 中 —— 顶层 DOM 里没有「每日活动 / +10」等字样。
 * 旧版每轮换 URL 会重载页面、把刚点开的浮层又关掉，这里改为：
 * 固定一个 URL，反复精确点开入口并读 frameInfo，确认面板可见 / iframe 有 src。
 */
async function waitForSidebarReady(tabId, token, stat) {
  const urls = [SIDEBAR_URL, ...SIDEBAR_FALLBACK_URLS];
  let lastDiag = null;
  let frameInfo = null;
  let found = false;

  for (let u = 0; u < urls.length && !found; u++) {
    if (u > 0) {
      try { await chrome.tabs.update(Number(tabId), { url: urls[u] }); } catch {}
      await nap(2200, token);
    }
    for (let round = 0; round < SIDEBAR_WAIT_ROUNDS; round++) {
      bail(token);
      // 只在顶层 frame 点开入口（不在 iframe 里乱点）
      const opened = await inject(tabId, ybInject, ['sidebar.open', {}]);
      if (opened && opened.ok) {
        console.info('[AutoTask] Rewards 入口已点击：' + (opened.selector || '#id_rh_w')
          + (opened.alreadyOpen ? '（本来就是展开的）' : ''));
      }
      await nap(900, token);
      const info = await inject(tabId, ybInject, ['sidebar.frameInfo', {}]);
      frameInfo = info || frameInfo;
      const diagFrames = await injectAllFrames(tabId, ybInject, ['sidebar.diagnose', {}]);
      let best = null;
      for (const f of diagFrames) {
        const d = f.result;
        if (!d) continue;
        lastDiag = d;
        if (!best || (d.taskHrefCount || 0) > (best.taskHrefCount || 0)) best = d;
        console.info('[AutoTask] 侧栏诊断 u' + u + ' r' + round + ' frame=' + f.frameId
          + ' top=' + d.isTop + ' panel=' + d.panelVisible
          + ' taskHref=' + d.taskHrefCount + ' daily=' + d.hasDaily
          + ' promo=' + d.hasPromo + ' plus=' + (d.plusHits || []).length
          + ' clickable=' + d.clickableCount);
        if (d.panelVisible || d.taskHrefCount > 0 || d.hasDaily || d.hasPromo) found = true;
      }
      if (frameInfo && (frameInfo.panelVisible || (frameInfo.iframes || []).length)) found = true;
      if (found) break;
    }
  }

  stat.sidebarDiagnostics = lastDiag;
  stat.sidebarFrameInfo = frameInfo;
  if (!found) {
    console.warn('[AutoTask] 侧栏未展开：请把「一键导出侧栏 DOM」的日志发来，'
      + '或确认 Rewards 面板是网页 flyout 而非浏览器内置侧边栏 UI。');
  } else {
    await nap(SETTLE_MS, token);
  }
  return { found, diagnostics: lastDiag, frameInfo };
}

/**
 * v2.2：把 #rewid-f 里的 iframe 提升成独立标签页。
 * 返回新 tabId；拿不到 URL / 打开后扫不到卡片则返回 null（保留原页路径）。
 */
async function promoteSidebarIframe(tabId, token, stat) {
  if (!PROMOTE_SIDEBAR_IFRAME) return null;
  const info = await inject(tabId, ybInject, ['sidebar.frameInfo', {}]);
  const list = (info && info.iframes) || [];
  let url = '';
  for (const f of list) {
    if (!f.src || !/^https?:\/\//i.test(f.src)) continue;
    let host = '';
    try { host = new URL(f.src).hostname; } catch { continue; }
    if (!SIDEBAR_IFRAME_HOST.test(host)) continue;
    if (/Microsoft Rewards/i.test(f.title || '') || /rewid|rewards|flyout/i.test(f.src)) { url = f.src; break; }
    if (!url) url = f.src;
  }
  if (!url) {
    console.info('[AutoTask] 未读到可用的 iframe URL，走 allFrames 注入路径');
    return null;
  }
  console.info('[AutoTask] 侧栏 iframe URL：' + url.slice(0, 180));
  stat.sidebarIframeUrl = url;
  let t = null;
  try {
    t = await chrome.tabs.create({ url, active: false });
    await chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
    await waitForTab(t.id, () => true, PAGE_TIMEOUT, true);
    await nap(SETTLE_MS, token);
    const scan = await inject(t.id, ybInject,
      ['sidebar.scan', { exclude: [], force: FORCE_CLICK_COMPLETED }]);
    const n = scan && Array.isArray(scan.items) ? scan.items.length : 0;
    console.info('[AutoTask] iframe 独立页扫描：' + n + ' 张待点、候选 '
      + (scan ? scan.candidates : 0) + ' 个 · ' + (scan ? scan.title : ''));
    if (n > 0) {
      stat.sidebarPromoted = true;
      return t.id;
    }
    // 独立页没卡片：不关闭（任务页保留），退回原页 allFrames
    console.info('[AutoTask] iframe 独立页无卡片，退回 allFrames 注入路径');
    return null;
  } catch (err) {
    console.warn('[AutoTask] iframe 独立开页失败：' + (err && err.message || String(err)));
    return null;
  }
}

/** 合并所有 frame 的扫描结果，按 每日活动 → 日常任务 → 其它 排序。 */
async function mergeSidebarScans(tabId, token) {
  const frames = await injectAllFrames(tabId, ybInject,
      ['sidebar.scan', { exclude: [], force: FORCE_CLICK_COMPLETED }]);
  const items = [];
  let candidates = 0;
  const headerHits = new Set();
  for (const f of frames) {
    const r = f.result;
    if (!r || !Array.isArray(r.items)) continue;
    candidates += Number(r.candidates) || 0;
    for (const h of r.headerHits || []) headerHits.add(h);
    for (const it of r.items) {
      items.push(Object.assign({}, it, {
        frameId: f.frameId,
        gid: f.frameId + ':' + it.idx + ':' + it.key
      }));
    }
  }
  /* 严格按 DOM 顺序（frame → idx），不再按分组重排。 */
  items.sort((a, b) => a.frameId - b.frameId || a.idx - b.idx);
  return { items, frames: frames.length, candidates, headerHits: [...headerHits] };
}

function registerNewTabs(before, after, tabId, stat) {
  const fresh = (after || []).filter(id => !(before || []).includes(id) && id !== tabId);
  // 同一轮点击可能多次检查新标签页；按 tabId 去重，避免重复计数 / 误判"已弹出"
  stat._seenTabIds = stat._seenTabIds || new Set();
  const added = [];
  for (const id of fresh) {
    if (stat._seenTabIds.has(id)) continue;
    stat._seenTabIds.add(id);
    added.push(id);
    try {
      Promise.resolve(chrome.tabs.update(id, { active: false, autoDiscardable: false }))
        .catch(() => {});
      stat.openedTabs = (stat.openedTabs || 0) + 1;
    } catch {}
  }
  return added;
}

/**
 * 在侧栏里逐张点击任务卡。
 *  · 统一 5s 间隔（taskClickSpacing，按点击时刻对齐）
 *  · cdp-first：能算顶层坐标就用 CDP 真鼠标；没弹出新标签页再补页面内事件序列
 *  · 仍没弹出 → 按 href 兜底 chrome.tabs.create，任务标签页一律保留不关闭
 *  · 载体页 sidebarTabId 也保留（closeTab 对 TASK_TAB_KEYS 放行）
 */
async function clickCardsInSidebar(level, token, done, stat) {
  let tabId = null;
  try {
    tabId = await openSidebarTab();
    const ready = await waitForSidebarReady(tabId, token, stat);
    stat.sidebarPanelFound = ready.found;
    console.info('[AutoTask] 侧栏载体页 ' + SIDEBAR_URL + '（保留不关闭）');

    // v2.2：优先把 iframe 内容提升为顶层标签页，绕开跨域 frame 注入与坐标换算
    const promotedId = await promoteSidebarIframe(tabId, token, stat);
    if (promotedId) {
      tabId = promotedId;
      console.info('[AutoTask] 已切换到 iframe 独立页 ' + promotedId + '（顶层 DOM 扫描点击）');
    }

    let pageClicks = 0;
    let lastScan = null;
    for (let pass = 0; pass < 3 && isCurrent(token); pass++) {
      const scan = await mergeSidebarScans(tabId, token);
      lastScan = scan;
      console.info('[AutoTask] 侧栏扫描：' + scan.frames + ' 个 frame、' + scan.candidates
        + ' 个候选、' + scan.items.length + ' 张待点'
        + (scan.headerHits.length ? ' · 标题 ' + scan.headerHits.join('/') : ''));
      const items = scan.items.filter(x => !done.has(x.gid) && !x.done);
      if (!items.length) {
        if (pass < 2) { await nap(1400, token); continue; }
        break;
      }

      for (const item of items) {
        if (!isCurrent(token)) break;
        const before = await tabIds();
        await taskClickSpacing(token);           // ← 相邻点击固定 5s
        await ensureTabActive(tabId);            // 后台标签页点击可能不触发导航

        let method = 'dom';
        let domRes = null;
        if (SIDEBAR_CLICK_MODE === 'cdp-first' && Number.isFinite(item.x) && item.x > 0 && item.y > 0) {
          const real = await cdpAttach(tabId).catch(() => false);
          if (real) {
            try {
              const tr = await injectFrame(tabId, item.frameId, ybInject, ['sidebar.scroll', { idx: item.idx }]);
              const cx = tr && Number.isFinite(tr.x) ? tr.x : item.x;
              const cy = tr && Number.isFinite(tr.y) ? tr.y : item.y;
              await cdpClickAt(tabId, cx, cy);
              method = 'cdp';
            } catch { method = 'dom'; }
          }
        }
        if (method === 'dom') {
          domRes = await injectFrame(tabId, item.frameId, ybInject,
            ['sidebar.click', { idx: item.idx, key: item.key, href: item.href }]);
          stat.domClick = (stat.domClick || 0) + (domRes && domRes.ok ? 1 : 0);
        }

        await nap(STRICT.fixedNapMs, token);
        let fresh = registerNewTabs(before, await tabIds(), tabId, stat);

        // CDP 真鼠标没生效（坐标落在 iframe/shadow 外）→ 补页面内点击
        if (!fresh.length && method === 'cdp') {
          domRes = await injectFrame(tabId, item.frameId, ybInject,
            ['sidebar.click', { idx: item.idx, key: item.key, href: item.href }]);
          method = 'cdp+dom';
          stat.domClick = (stat.domClick || 0) + (domRes && domRes.ok ? 1 : 0);
          await nap(STRICT.fixedNapMs, token);
          fresh = registerNewTabs(before, await tabIds(), tabId, stat);
        }

        // 兜底：始终保证任务在新标签页打开，且保留
        // v2.4：绝不按 href 直接开页（直接导航不计 Rewards 完成）
        if (!fresh.length) {
          console.warn('[AutoTask] 「' + item.name + '」点击后未开出任务页；'
            + '按约束不直接打开 URL，请检查页面是否登录 / 卡片是否真的被按下');
        }

        stat.clicked++;
        pageClicks++;
        done.add(item.gid);
        console.info('[AutoTask] 侧栏点击 ' + pageClicks + '：' + item.name
          + '（+' + item.points + ' · ' + item.section + ' · frame' + item.frameId
          + ' · ' + method + '）');
      }
    }
    stat.pages = stat.pages || [];
    stat.pages.push({
      page: 'sidebar', clicked: pageClicks,
      anchors: lastScan ? lastScan.candidates : 0,
      frames: lastScan ? lastScan.frames : 0,
      panelFound: ready.found,
      promoted: !!stat.sidebarPromoted
    });
    console.info('[AutoTask] 侧栏共点击 ' + pageClicks + ' 张');
  } catch (err) {
    if (err !== STOP) stat.error = (err && err.message) || String(err);
  } finally {
    if (tabId != null) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
      cdpAttached.delete(Number(tabId));
      // 侧栏载体页与弹出的任务页都保留，不 remove、不清 sidebarTabId
    }
  }
}

/**
 * v2.0：等目标页面加载完成 + DOM 里出现锚点/标题（hydration 完成）再注入。
 * 超时不再直接判失败跳过整页，返回 ok:true + timeout，交由注入结果里的 path 复核，
 * 避免「tab.url 还是上一页」时把上一页的卡片又点一遍。
 */
async function waitForTaskPageReady(tabId, url, token) {
  const want = parseUrl(url);
  const wantPath = (want && want.pathname || '/').toLowerCase();
  const deadline = Date.now() + READ_DEADLINE;
  while (Date.now() < deadline) {
    bail(token);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.status === 'complete' && tab.url) {
      if (isLogin(tab.url)) return { ok: false, reason: 'login', tab };
      const u = parseUrl(tab.url);
      if (u && /(^|\.)bing\.com$/i.test(u.hostname) && taskPageMatches(u.pathname, wantPath)) {
        const probe = await inject(tabId, () => ({
          anchors: document.querySelectorAll('a[href]').length,
          headers: document.querySelectorAll('h2').length,
          title: document.title || ''
        }), []);
        if (probe && (probe.anchors > 0 || probe.headers > 0)) {
          await nap(SETTLE_MS, token);
          return { ok: true, tab, url: tab.url, title: probe.title };
        }
      }
    }
    await nap(400, token);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return { ok: true, timeout: true, tab, url: tab && tab.url };
}

/* T07=D：默认 10 秒；等待页面稳定后才允许下一次动作；范围仍为 1~60 秒。 */
async function waitForTaskPageStable(token) {
  const deadline = Date.now() + HSA_CORE.DEFAULTS.pageStableWaitMs;
  while (Date.now() < deadline) {
    try {
      const list = await chrome.tabs.query({ active: true });
      const tab = Array.isArray(list) ? list[0] : null;
      if (!tab || tab.status === 'complete') return true;
    } catch (err) {}
    await nap(250, token);
  }
  return false;
}
async function taskClickSpacing(token) {
  let seconds;
  try { const cfg = await getSettings(); seconds = Number(cfg.cardClickIntervalSec); }
  catch (err) {}
  const interval = HSA_CORE.clampIntervalSec(seconds) * 1000;
  const left = interval - (Date.now() - lastTaskClickAt);
  if (lastTaskClickAt && left > 0) await nap(left, token);
  if (token != null && !isCurrent(token)) throw STOP;
  await waitForTaskPageStable(token);
  lastTaskClickAt = Date.now();
}

/**
 * v2.0：在「一个」Rewards 页面里逐张模拟鼠标点击任务卡。
 *  · 卡片就是 <a target="_blank">，定位/点击都落在 <a> 本身 → 新标签页打开
 *  · 载体页临时置 active，避免后台标签页的 CDP 点击不触发 window.open
 *  · CDP 不可用时用 a.click() 降级（旧的合成 MouseEvent 对链接无效）
 *  · 点击后若无新标签页，按 href 兜底 chrome.tabs.create，保证任务一定被打开
 *  · 每轮注入结果带 path，与目标不符就等待重试，绝不误点上一页
 */
async function clickCardsOnPage(url, level, token, done, stat) {
  const want = parseUrl(url);
  const wantPath = (want && want.pathname || '/').toLowerCase();
  const pageLabel = wantPath || '/dashboard';
  let tabId = null;
  try {
    tabId = await openOrNavigate('taskClickTabId', url);
    const ready = await waitForTaskPageReady(tabId, url, token);
    if (!ready.ok) {
      stat.signedOut = true;
      console.warn('[AutoTask] ' + pageLabel + ' 跳到了 Microsoft 登录页，请先在浏览器登录 Rewards');
      stat.pages = stat.pages || [];
      stat.pages.push({ page: pageLabel, clicked: 0, reason: 'login' });
      return;
    }
    if (ready.timeout) stat.loadSlow = (stat.loadSlow || 0) + 1;

    const probeState = await inject(tabId, ybInject, ['rewards.list', { exclude: [], force: FORCE_CLICK_COMPLETED }]);
    if (probeState && probeState.signedOut) {
      stat.signedOut = true;
      console.warn('[AutoTask] ' + pageLabel + ' 显示的是登录页，跳过本页（另一页仍会继续）');
      stat.pages = stat.pages || [];
      stat.pages.push({ page: pageLabel, clicked: 0, reason: 'signedOut' });
      return;
    }
    console.info('[AutoTask] ' + pageLabel + ' 识别到 ' + (probeState ? probeState.anchorCount : 0)
      + ' 张任务卡，其中已完成跳过 ' + (probeState ? probeState.doneSkipped : 0)
      + ' 张，页面标题「' + (probeState ? probeState.title : '') + '」');

    const real = await cdpAttach(tabId).catch(() => false);
    stat.real = stat.real || real;
    let emptyRounds = 0;
    let pageClicks = 0;
    let lastRes = probeState;

    // 放宽到 5 轮 × 1.2s，等 Next.js hydration 把卡片渲染出来
    for (let pass = 0; pass < 5 && isCurrent(token); pass++) {
      const res = await inject(tabId, ybInject,
        ['rewards.list', { exclude: Array.from(done), force: FORCE_CLICK_COMPLETED }]);
      lastRes = res;
      if (!res) { await nap(1200, token); continue; }
      if (res.signedOut) { stat.signedOut = true; break; }
      // 关键：确认注入跑在目标页，而不是上一页的旧 DOM
      if (res.path && !taskPageMatches(res.path, wantPath)) {
        console.warn('[AutoTask] ' + pageLabel + ' 注入仍在 ' + res.path + '，等待页面切换…');
        await nap(1200, token);
        continue;
      }
      const items = Array.isArray(res.items) ? res.items : [];
      if (!items.length) {
        stat.skipped += Number(res.scanned) || 0;
        emptyRounds++;
        if (emptyRounds >= 3) break;
        await nap(1200, token);
        continue;
      }
      emptyRounds = 0;

      for (const item of items) {
        if (!isCurrent(token)) break;
        const found = await inject(tabId, ybInject, ['rewards.focus', { idx: item.idx, key: item.key }]);
        if (!found || !found.ok) {
          done.add(item.idx + ':' + item.key);
          continue;
        }
        const before = await tabIds();

        await taskClickSpacing(token);           // ← 统一 5s 间隔（点击时刻对齐）

        // 后台标签页的 CDP 点击可能不触发 target=_blank，临时置为 active
        if (KEEP_TASK_CLICK_ACTIVE) await ensureTabActive(tabId);

        const box = {
          x: found.x - found.w / 2, y: found.y - found.h / 2,
          w: found.w, h: found.h
        };
        /* 严格运行模式：固定中心点击，不使用拟人轨迹 / 过冲。 */
        const plan = strictClickPlan(box);
        let clicked = false;
        if (real) {
          await cdpClickAt(tabId, plan.center[0], plan.center[1]);
          clicked = true;
        } else {
          const act = await inject(tabId, ybInject, ['rewards.activate', { idx: item.idx, key: item.key }]);
          clicked = !!(act && act.ok);
          stat.domClick = (stat.domClick || 0) + (clicked ? 1 : 0);
        }
        stat.clicked++;
        pageClicks++;
        done.add(item.idx + ':' + item.key);
        console.info('[AutoTask] ' + pageLabel + ' 点击 ' + pageClicks + '：' + item.name
          + '（#' + item.idx + ' · ' + item.points + ' 分 · ' + item.section
          + (clicked ? '' : ' · [警告] 点击未生效') + '）');

        // 给新标签页一点时间弹出，再登记为「保留」
        await nap(STRICT.fixedNapMs, token);
        let newTabs = [];
        if (before) {
          const after = await tabIds();
          newTabs = (after || []).filter(id => !before.includes(id) && id !== tabId);
          for (const id of newTabs) {
            try {
              await chrome.tabs.update(id, { active: false, autoDiscardable: false });
              stat.openedTabs = (stat.openedTabs || 0) + 1;
            } catch {}
          }
        }
        // 兜底：模拟点击没弹出新标签页时，直接按 href 后台打开，保证任务落地
        // v2.4：绝不按 href 直接开页（直接导航不计 Rewards 完成）
        if (!newTabs.length) {
          console.warn('[AutoTask] 「' + item.name + '」点击后未开出任务页；'
            + '按约束不直接打开 URL，请检查页面是否登录 / 卡片是否真的被按下');
        }
        if (KEEP_TASK_CLICK_ACTIVE) await ensureTabActive(tabId);
      }
    }
    stat.pages = stat.pages || [];
    stat.pages.push({
      page: pageLabel, clicked: pageClicks,
      anchors: lastRes ? lastRes.anchorCount : 0,
      doneSkipped: lastRes ? lastRes.doneSkipped : 0,
      path: lastRes ? lastRes.path : ''
    });
    console.info('[AutoTask] ' + pageLabel + ' 本页共点击 ' + pageClicks + ' 张');
  } catch (err) {
    if (err !== STOP) stat.error = (err && err.message) || String(err);
  } finally {
    if (tabId != null) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
      cdpAttached.delete(Number(tabId));
      // 载体页与弹出的任务页都保留
    }
  }
}

/* ==========================================================================
 * v2.3 · 点击目标直接来自「获取任务列表」的解析链路
 *
 * 用户提示的思路：refreshTodayTasks 用 fetchBothPages() + cardsFromRewardsHtml()
 * 已经能拿到每个任务的 name / description / points / section / completed / **url**，
 * 弹窗「今日任务」显示正常就证明这条链路是通的。之前几版却另写一套 DOM 扫描器去
 * "猜"哪张是任务卡，扫描结果为空时整个点击循环直接不执行 —— 连兜底开页都没有。
 *
 * 现在：点击目标 = 任务列表里的条目（带真实任务 URL），定位按 URL 指纹精确匹配 <a>，
 * 三级降级（CDP 真鼠标 → 页面内事件序列 → 按任务 URL 直接开新标签页），
 * 最后一级不依赖任何页面注入，保证「任务卡片一定被打开」。
 * ======================================================================== */

/** RSC destination 里的 \u0026 / &amp; 归一化成真实 URL。 */
function normalizeTaskUrl(u) {
  return String(u || '')
    .replace(/\\+u0026/gi, '&')
    .replace(/\\+u003d/gi, '=')
    .replace(/\\+u0025/gi, '%')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, '')
    .trim();
}

/** 与注入侧 urlFp 完全一致的指纹，用于按任务 URL 给点击目标去重/排序。 */
function taskUrlFp(u) {
  const h = normalizeTaskUrl(u);
  try {
    const x = new URL(h);
    const q = (x.searchParams.get('q') || '').toLowerCase().replace(/\s+/g, '');
    let form = '';
    x.searchParams.forEach((v, k) => { if (/^form$/i.test(k)) form = String(v).toLowerCase(); });
    return x.hostname.replace(/^www\./i, '') + x.pathname.replace(/\/$/, '') + '|' + q + '|' + form;
  } catch { return h.split('#')[0].split('?')[0].toLowerCase(); }
}

/**
 * v2.4 诊断：导出两个载体页（含所有 frame）里实际存在的任务型 <a>，
 * 并与任务列表的 URL 指纹比对。用于定位「卡片到底在哪个 frame / 为什么没找到」。
 */
async function dumpClickProbe() {
  const built = await buildClickTargets();
  const fps = built.targets.map(t => t.fp);
  const carriers = [
    { key: 'taskListTabId', url: DASHBOARD_URL, label: 'rewards/dashboard', sidebar: false },
    { key: 'sidebarTabId', url: SIDEBAR_URL, label: 'bing/sidebar', sidebar: true }
  ];
  const tabs = [];
  for (const c of carriers) {
    let tabId = null;
    try {
      tabId = await openOrNavigate(c.key, c.url, true);
      await ensureTabActive(tabId);
      if (c.sidebar) await inject(tabId, ybInject, ['sidebar.open', {}]);
      await nap(1400);
      const frames = await injectAllFrames(tabId, ybInject, ['task.probe', { fps }]);
      tabs.push({
        label: c.label, url: c.url, tabId,
        frames: frames.map(f => ({ frameId: f.frameId, error: f.error || null, data: f.result || null }))
      });
    } catch (err) {
      tabs.push({ label: c.label, url: c.url, error: String(err && err.message || err) });
    }
  }
  const payload = {
    ok: true, at: Date.now(), signedOut: built.signedOut,
    targets: built.targets.map(t => ({ name: t.name, points: t.points, section: t.section,
      completed: t.completed, url: t.url, fp: t.fp, page: t.page })),
    tabs
  };
  await store({ clickProbe: payload });
  console.info('[dumpClickProbe] 完整结构已写入 storage.local.clickProbe');
  for (const tab of tabs) {
    for (const f of tab.frames || []) {
      const d = f.data;
      console.info('  ' + tab.label + ' frame' + f.frameId
        + ' url=' + (d && d.url) + ' signedOut=' + (d && d.signedOut)
        + ' taskAnchors=' + (d && d.taskAnchors ? d.taskAnchors.length : 0)
        + ' matched=' + (d && d.taskAnchors ? d.taskAnchors.filter(a => a.wanted).length : 0)
        + (f.error ? ' ERROR=' + f.error : ''));
    }
    if (tab.error) console.warn('  ' + tab.label + ' ERROR=' + tab.error);
  }
  return payload;
}

/** v2.3 诊断：导出「获取任务列表」解析出的每个任务及其真实 URL。 */
async function dumpTaskList() {
  const built = await buildClickTargets();
  const payload = {
    ok: true, at: Date.now(), signedOut: built.signedOut,
    pages: built.pages,
    count: built.targets.length,
    pending: built.targets.filter(t => !t.completed && /^https?:\/\//i.test(t.url)).length,
    targets: built.targets.map(t => ({
      name: t.name, description: t.description, points: t.points,
      section: t.section, completed: t.completed, page: t.page,
      source: t.source, url: t.url, fp: t.fp
    }))
  };
  await store({ taskListDump: payload });
  console.info('[dumpTaskList] ' + payload.count + ' 条任务 / ' + payload.pending + ' 条待点，完整结果写入 storage.local.taskListDump');
  for (const t of payload.targets) {
    console.info('  ' + (t.completed ? '✓' : '·') + ' [' + t.section + ' +' + t.points + '] '
      + t.name + '  ' + t.url.slice(0, 140));
  }
  return payload;
}

/** 复用 refreshTodayTasks 的同一份解析代码，产出「可点击任务」清单。 */
async function buildClickTargets() {
  const pages = await fetchBothPages();
  const out = [];
  const seen = new Set();
  for (const [page, r] of [['/dashboard', pages.dash], ['/earn', pages.earn]]) {
    if (!r.ok || isSignInPage(r.html)) continue;
    // RSC 的 destination 可能被流式 payload 截断（如 "…&filters=sid:"），
    // 从同一份 HTML 的可见 <a href> 里取指纹相同且更长的完整链接补全。
    const domLinks = [...String(r.html).matchAll(/<a\b[^>]*href="([^"]+)"/gi)]
      .map(m => normalizeTaskUrl(m[1]))
      .filter(h => /^https?:\/\//i.test(h) && h.length > 30);
    for (const it of cardsFromRewardsHtml(r.html)) {
      // 与 refreshTodayTasks 相同的去重键：保留每个任务条目（含同名同分的 ×2）
      const key = it.name + '|' + it.description + '|' + it.points + '|' + it.section;
      if (seen.has(key)) continue;
      seen.add(key);
      let url = normalizeTaskUrl(it.url);
      let fp = taskUrlFp(url);
      const full = domLinks.find(h => taskUrlFp(h) === fp && h.length > url.length);
      if (full) url = full;
      out.push({
        name: it.name, description: it.description || '', points: it.points,
        section: it.section, completed: !!it.completed,
        url, fp: taskUrlFp(url), page, source: it.source || 'rsc',
        enriched: !!full
      });
    }
  }
  /* 同步索引按官网 HTML 解析顺序（DOM 顺序）排，不按分组 / 积分重排。 */
  out.forEach((it, i) => { it.order = i; });
  out.sort((a, b) => (a.page === b.page ? 0 : a.page === '/dashboard' ? -1 : 1)
    || (Number(a.order) || 0) - (Number(b.order) || 0));
  return {
    targets: out,
    signedOut: pages.signedOut,
    pages: {
      dashboard: { ok: !!pages.dash.ok, status: pages.dash.status, bytes: (pages.dash.html || '').length, signedOut: isSignInPage(pages.dash.html) },
      earn: { ok: !!pages.earn.ok, status: pages.earn.status, bytes: (pages.earn.html || '').length, signedOut: isSignInPage(pages.earn.html) }
    }
  };
}

/** 任务列表为空时，打开真实页面用注入从 DOM 反推（带真实 href）。 */
async function collectTargetsFromLiveDom(token) {
  const out = [];
  for (const path of ['/dashboard', '/earn']) {
    if (!isCurrent(token)) break;
    const url = 'https://rewards.bing.com' + path;
    let tabId = null;
    try {
      tabId = await openOrNavigate('rewardsTabId', url, false);
      await nap(1800, token);
      const r = await inject(tabId, ybInject, ['task.list', {}]);
      if (r && Array.isArray(r.rows)) {
        for (const x of r.rows) {
          const u = normalizeTaskUrl(x.url || x.href);
          if (!/^https?:\/\//i.test(u)) continue;
          out.push({
            name: x.name, description: '', points: x.points,
            section: x.section === 'daily' ? 'daily' : 'promo',
            completed: !!x.completed, url: u, fp: taskUrlFp(u),
            page: path, source: 'live-dom'
          });
        }
      }
      console.info('[AutoTask] 实时 DOM 反推 ' + path + '：' + (r && r.rows ? r.rows.length : 0)
        + ' 张（候选 ' + (r && r.total ? r.total : 0) + '）');
    } catch (err) {
      console.warn('[AutoTask] 实时 DOM 反推失败 ' + path + '：' + (err && err.message || String(err)));
    }
  }
  // 任务标签页保留，不关闭
  return out;
}

/**
 * 按任务列表逐个点击。
 * 关键保证：任何一级失败，最后都按任务列表里的真实 URL 开新标签页，不会因为
 * "扫描结果为空" 而静默什么都不做（这正是前几版「打开页面但不点击」的根因）。
 */
/* ==========================================================================
 * v2.4 · 必须「点击对应的卡片」，不能按 URL 直接开页
 *
 * 用户实测：任务列表里的 url 是正确的，但 chrome.tabs.create(任务 URL) 打开后
 * Rewards 不计完成 —— 卡片点击会带上报/跳转上下文，直接导航没有。
 * 所以本版：
 *   · 任务列表只用来「定位」卡片（URL 指纹），不再作为打开目标
 *   · 候选载体页：任务来源页 dashboard/earn → Bing 侧栏（含 iframe，allFrames 注入）
 *   · 找到 <a> 后：CDP 真鼠标 → 页面内 5 段指针/鼠标事件 + 原生 click()
 *   · 点击后必须校验「新标签页确实是这个任务」才算成功，标签页保留不关
 *   · 找不到卡片 / 点击没开出任务页 → 明确失败 + 诊断，绝不直接开 URL
 * ======================================================================== */

/** 新标签页是否由「这张卡片」打开（按 q 关键词或 spotlight 路径比对）。 */
async function verifyTaskTab(id, t) {
  try {
    const tab = await chrome.tabs.get(id);
    const u = String((tab && (tab.url || tab.pendingUrl)) || '');
    if (!/^https?:\/\//i.test(u)) return false;
    const qOf = v => { try { return (new URL(v).searchParams.get('q') || '').toLowerCase().replace(/\s+/g, ''); } catch { return ''; } };
    const q1 = qOf(u), q2 = qOf(t.url);
    if (q1 && q2 && q1 === q2) return true;
    if (/spotlight\/imagepuzzle/i.test(u) && /spotlight\/imagepuzzle/i.test(t.url)) return true;
    return taskUrlFp(u) === t.fp;
  } catch { return false; }
}

/** 在两个候选载体页（含所有 frame）里按任务 URL 指纹找那张 <a>。 */
async function locateTaskCard(target, token, stat) {
  const carriers = [
    { key: 'taskListTabId', url: 'https://rewards.bing.com' + (target.page || '/dashboard'), label: 'rewards', sidebar: false },
  ];
  if (TASKLIST_TRY_SIDEBAR) {
    carriers.push({ key: 'sidebarTabId', url: SIDEBAR_URL, label: 'sidebar', sidebar: true });
  }
  for (const c of carriers) {
    let tabId = null;
    try {
      tabId = await openOrNavigate(c.key, c.url, true);
      stat.usedTabIds.add(Number(tabId));
      await ensureTabActive(tabId);
      if (c.sidebar) {
        // 侧栏面板默认 display:none，先精确点开 #id_rh_w
        await inject(tabId, ybInject, ['sidebar.open', {}]);
      } else {
        await waitForTaskPageReady(tabId, c.url, token);
      }
      const frames = await injectAllFrames(tabId, ybInject, ['task.find', { target }]);
      for (const f of frames) {
        if (f.result && f.result.ok) {
          return {
            ok: true, tabId, frameId: f.frameId, carrier: c.label,
            found: f.result, frames: frames.length
          };
        }
      }
    } catch (err) {
      console.warn('[AutoTask] 载体页 ' + c.label + ' 定位异常：' + (err && err.message || String(err)));
    }
  }
  return { ok: false };
}

/**
 * 按任务列表逐张「点击卡片」。
 * 成功判据：点击后弹出一个 URL 与该任务匹配的新标签页；没有就算失败，不开任何 URL。
 */
async function clickTargetsFromTaskList(token, stat) {
  const built = await buildClickTargets();
  let targets = built.targets;
  stat.taskListPages = built.pages;
  stat.taskListRaw = targets.length;
  stat.usedTabIds = stat.usedTabIds || new Set();
  stat.cardNotFound = 0;
  stat.clickFailed = 0;
  stat.signedOut = !!built.signedOut;
  console.info('[AutoTask] 任务列表解析：' + targets.length + ' 条'
    + '（dashboard ' + JSON.stringify(built.pages.dashboard) + ' / earn ' + JSON.stringify(built.pages.earn) + '）');

  if (!targets.length && !built.signedOut) {
    targets = await collectTargetsFromLiveDom(token);
    stat.taskListSource = 'live-dom';
    console.info('[AutoTask] 任务列表为空，实时 DOM 反推得到 ' + targets.length + ' 条');
  } else {
    stat.taskListSource = 'html-parse';
  }
  if (built.signedOut) {
    console.warn('[AutoTask] 抓到的是登录页：请先在浏览器登录 Microsoft Rewards，'
      + '否则页面上根本没有任务卡片可点。本轮不会直接打开任务 URL。');
  }

  const pending = targets.filter(t => !t.completed && /^https?:\/\//i.test(t.url));
  stat.taskPending = pending.length;
  console.info('[AutoTask] 待点击卡片 ' + pending.length + ' 张：'
    + pending.map(t => t.name + '(+' + t.points + ')').join('、'));

  let clicked = 0;
  const done = new Set();

  for (const t of pending) {
    if (!isCurrent(token)) break;
    const key = t.fp + '|' + t.name + '|' + t.points;
    if (done.has(key)) continue;
    done.add(key);

    await taskClickSpacing(token);          // 相邻点击统一 5s 间隔
    const target = { url: t.url, name: t.name, points: t.points, section: t.section, page: t.page };

    // 等卡片真正渲染出来（hydration / 侧栏展开都需要时间）
    let located = null;
    for (let round = 0; round < TASKLIST_CARD_WAIT_ROUNDS && !located; round++) {
      bail(token);
      located = await locateTaskCard(target, token, stat);
      if (located.ok) break;
      await nap(1200, token);
    }

    if (!located || !located.ok) {
      stat.cardNotFound++;
      console.warn('[AutoTask] ✗ 未找到「' + t.name + '」的卡片元素（已试'
        + TASKLIST_CARD_WAIT_ROUNDS + ' 轮 × rewards 页 / Bing 侧栏所有 frame）。'
        + '按约束不直接打开任务 URL。请跑 dumpClickProbe 看页面实际有哪些 <a>。');
      continue;
    }
    console.info('[AutoTask] 定位到「' + t.name + '」：' + located.carrier
      + ' frame' + located.frameId + ' · 匹配=' + located.found.by
      + ' · href=' + String(located.found.href || '').slice(0, 110));

    // 点击前取一次基线，避免把载体页误判成新开的任务页
    const before = await tabIds();
    let opened = false, method = 'none', lastRes = null;

    for (let attempt = 0; attempt < TASKLIST_CLICK_RETRIES && !opened && isCurrent(token); attempt++) {
      // 每次重试都重新定位（点击后面板可能收起 / DOM 重渲染）
      let loc = located;
      if (attempt > 0) {
        const again = await locateTaskCard(target, token, stat);
        if (again.ok) loc = again;
      }
      const tabId = loc.tabId, frameId = loc.frameId;

      // ① CDP 真鼠标：用卡片在顶层视口的坐标
      if (TASKLIST_CDP_FIRST && Number.isFinite(loc.found.x) && loc.found.x > 0) {
        const real = await cdpAttach(tabId).catch(() => false);
        if (real) {
          try {
            await ensureTabActive(tabId);
            await cdpClickAt(tabId, loc.found.x, loc.found.y);
            method = 'cdp';
          } catch (err) { method = 'cdp-failed'; }
        }
      }
      await nap(STRICT.fixedNapMs, token);
      let fresh = registerNewTabs(before, await tabIds(), tabId, stat);
      for (const id of fresh) {
        if (await verifyTaskTab(id, t)) { opened = true; break; }
      }

      // ② 没开出任务页 → 回到元素所在 frame，派发完整事件序列 + 原生 click()
      if (!opened) {
        const res = frameId != null
          ? await injectFrame(tabId, frameId, ybInject, ['task.click', { target }])
          : await inject(tabId, ybInject, ['task.click', { target }]);
        lastRes = res;
        if (res && res.ok) {
          method = method === 'cdp' || method === 'cdp-failed' ? 'cdp+dom' : 'dom';
          stat.domClick = (stat.domClick || 0) + 1;
        }
        await nap(STRICT.fixedNapMs, token);
        fresh = registerNewTabs(before, await tabIds(), tabId, stat);
        for (const id of fresh) {
          if (await verifyTaskTab(id, t)) { opened = true; break; }
        }
      }
      if (!opened && attempt < TASKLIST_CLICK_RETRIES - 1) {
        console.info('[AutoTask] 「' + t.name + '」第 ' + (attempt + 1) + ' 次点击未开出任务页，重试');
      }
    }

    if (opened) {
      stat.clicked++;
      clicked++;
      console.info('[AutoTask] ✓ 任务卡片 ' + clicked + '/' + pending.length + '：' + t.name
        + '（+' + t.points + ' · ' + located.carrier + ' · ' + method
        + ' · 已开任务标签页并保留）');
    } else {
      stat.clickFailed++;
      console.warn('[AutoTask] ✗ 「' + t.name + '」卡片已找到但 ' + TASKLIST_CLICK_RETRIES
        + ' 次点击都没开出任务页（method=' + method
        + (lastRes ? ' · last=' + JSON.stringify(lastRes).slice(0, 160) : '')
        + '）。按约束不直接打开 URL；请跑 dumpClickProbe / 查看控制台注入错误。');
    }
  }

  stat.pages = stat.pages || [];
  stat.pages.push({
    page: 'tasklist', clicked, anchors: targets.length,
    pending: pending.length, source: stat.taskListSource,
    cardNotFound: stat.cardNotFound, clickFailed: stat.clickFailed
  });
  // 只 detach 调试会话，载体页与弹出的任务标签页全部保留
  for (const id of stat.usedTabIds) {
    try { await chrome.debugger.detach({ tabId: id }); } catch {}
    cdpAttached.delete(id);
  }
  console.info('[AutoTask] 卡片点击完成：成功 ' + clicked + ' / 待点 ' + pending.length
    + '，未找到卡片 ' + stat.cardNotFound + '，点击失败 ' + stat.clickFailed
    + '（本版不直接打开任何任务 URL）');
}


/* ==========================================================================
 * v2.5 · 完全照人操作：打开相应页面 → 滚动 → 鼠标点击卡片
 *
 * 前几版把这三步拆成了 fetch HTML / RSC 解析 / URL 指纹 / 跨 frame 定位 /
 * CDP 调试会话 / 新标签页校验 / 多轮重试……任何一个环节返回空，整轮就静默不动。
 * 而且 fetch 拿到的是登录页（标签页里却是登录态），任务列表直接为空。
 *
 * 这版全部删掉：
 *   · 不 fetch 任何 HTML，任务卡就是当前这个真实标签页里看得见的 <a>
 *   · 不 attach chrome.debugger（调试横幅 / 授权 / 占用都可能让整轮卡死）
 *   · 不算指纹、不猜 iframe、不校验新标签页
 *   · 打开页面 → 滚一遍触发渲染 → 注入扫描 → 逐张滚到卡片 + 鼠标事件 + a.click()
 *   · 每步都打日志；0 张时把页面里所有 <a> 列出来，不再静默
 * ======================================================================== */

/* 官方返回的 title 有时是内部 ID，按「完成项数量 +1」兜底判分 */
function hitByCount(before, after) {
  try {
    const b = (before && before.tasks || []).filter(t => t.complete).length;
    const a = (after && after.tasks || []).filter(t => t.complete).length;
    return a > b;
  } catch { return false; }
}

async function humanWaitPage(tabId, token) {
  for (let i = 0; i < 24 && isCurrent(token); i++) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t && t.status === 'complete') break;
    await nap(400, token);
  }
  await nap(HUMAN_PAGE_SETTLE_MS, token);
}

async function humanClickTasks(token, stat) {
  const pages = FLYOUT_URLS.map((u, i) => ({ url: u, label: '侧栏 flyout ' + (i + 1), flyout: true }))
    .concat([
      { url: DASHBOARD_URL, label: '/dashboard' },
      { url: EARN_URL, label: '/earn' }
    ]);
  let clicked = 0, cardTotal = 0;
  stat.usedTabIds = stat.usedTabIds || new Set();
  stat.humanEmpty = [];
  stat.humanSignedOut = false;
  stat.skipped = 0;
  stat.officialVerified = 0;
  stat.officialUnconfirmed = 0;
  stat.officialAvailable = false;

  for (const pg of pages) {
    if (!isCurrent(token)) break;
    let tabId = null;
    try {
      // ① 打开相应页面（复用同一个标签页，保持你已有的登录态）
      tabId = await openOrNavigate('humanTabId', pg.url, true);
      stat.usedTabIds.add(Number(tabId));
      await ensureTabActive(tabId);
      await humanWaitPage(tabId, token);

      // v2.7 关键：chrome.debugger 一 attach，浏览器顶部会出现
      // 「已开始调试此浏览器」横幅，把整个网页视口下推约 80px。
      // 旧版先 scan 缓存坐标、点击时才 attach → 横幅出现后旧坐标全部点偏。
      // 所以这里先 attach，等布局稳定下来，后面所有扫描/坐标都基于同一布局。
      const earlyAttached = await cdpAttach(tabId).catch(() => false);
      if (earlyAttached) {
        console.info('[AutoTask] 调试会话已建立（横幅已出现），等待布局稳定后再定位卡片');
        await nap(900, token);
      }

      // 侧栏面板默认收起：先点顶部积分入口
      if (pg.flyout) {
        const opened = await inject(tabId, ybInject, ['human.openPanel', {}]);
        if (opened && opened.ok) { await nap(1200, token); }
      }
      // ② 滚动：先整页滚一遍触发懒加载 / hydration，再扫一次
      if (HUMAN_SCROLL_RESCAN) {
        await inject(tabId, ybInject, ['human.scroll', {}]);
        await nap(1200, token);
      }
      let scan = await inject(tabId, ybInject, ['human.scan', {}]);
      if ((!scan || !scan.total) && HUMAN_SCROLL_RESCAN) {
        await inject(tabId, ybInject, ['human.scroll', {}]);
        await nap(1600, token);
        scan = await inject(tabId, ybInject, ['human.scan', {}]);
      }
      let cards = (scan && Array.isArray(scan.cards)) ? scan.cards : [];
      const skipped = (scan && Array.isArray(scan.skipped)) ? scan.skipped : [];
      stat.skipped += skipped.length;
      cardTotal += cards.length;
      console.info('[AutoTask] ' + pg.label + '：滚动后看到 ' + cards.length + ' 张可点任务卡，'
        + '跳过 ' + skipped.length + ' 张不给分/已完成卡'
        + (scan && scan.title ? '，标题「' + scan.title + '」' : ''));
      for (const sk of skipped) {
        console.info('[AutoTask]   ↳ 跳过「' + (sk.title || '').slice(0, 28) + '」(+'
          + sk.points + ')：' + sk.reason);
      }

      /* 官方任务列表白名单增强：只保留接口里 !complete && pointsMax>0 的项。
         接口不可用 / 标题对不上（内部 ID）时保留本地白名单结果，只打日志。 */
      let official = null;
      let lastOfficial = null;      // 逐次核验的基线，每次点完更新
      if (HUMAN_VERIFY_OFFICIAL) {
        official = await inject(tabId, ybInject, ['human.verify', {}]);
        if (official && official.ok && Array.isArray(official.tasks) && official.tasks.length) {
          stat.officialAvailable = true;
          const pendingOfficial = official.tasks.filter(t => !t.complete && t.pointsMax > 0);
          lastOfficial = official;
          console.info('[AutoTask] 官方任务列表：' + official.tasks.length + ' 项，其中待完成且给分 '
            + pendingOfficial.length + ' 项（已完成/0 分项不计）');
          const readable = pendingOfficial.map(t => t.title.replace(/\s+/g, ''))
            .filter(t => t.length >= 4 && !/^dailyset:|^more:|^\d+$/.test(t));
          if (readable.length) {
            const beforeN = cards.length;
            const beforeCards = cards.slice();
            cards = cards.filter(c => {
              const ct = String(c.title || c.text || '').replace(/\s+/g, '');
              return readable.some(t => t.indexOf(ct.slice(0, 6)) >= 0 || ct.indexOf(t.slice(0, 6)) >= 0);
            });
            if (cards.length === 0 && beforeN > 0) {
              // 接口标题可能是英文 / 内部 ID，与页面中文标题对不上。
              // 绝不因为数据格式差异把整轮变成「一张都不点」。
              cards = beforeCards;
              console.warn('[AutoTask] 官方任务标题与页面卡片对不上（可能是英文/内部 ID），'
                + '撤销白名单过滤，保留本地严格白名单 ' + beforeN + ' 张');
            } else if (cards.length !== beforeN) {
              stat.skipped += beforeN - cards.length;
              console.info('[AutoTask] 官方白名单过滤：' + beforeN + ' → ' + cards.length
                + ' 张（其余不在今日给分任务列表里）');
            }
          }
        } else {
          console.info('[AutoTask] 官方接口不可用（'
            + ((official && official.reason) || '无返回') + '），采用本地严格白名单');
        }
      }

      if (scan && scan.signedOut) {
        stat.humanSignedOut = true;
        console.warn('[AutoTask] ' + pg.label + ' 当前显示的是 Microsoft 登录页。'
          + '请在这个标签页里登录 Rewards 后再点「自动完成任务」——脚本没法替你登录。');
      }
      if (!cards.length) {
        stat.humanEmpty.push(pg.label);
        const probe = await inject(tabId, ybInject, ['human.probe', {}]);
        console.warn('[AutoTask] ' + pg.label + ' 没扫到任务卡片。页面里共有 '
          + (probe && probe.total ? probe.total : 0) + ' 个 <a>、'
          + ((probe && probe.badgeCards) ? probe.badgeCards.length : 0) + ' 张 +N 徽章卡：');
        for (const sk of ((probe && probe.skipped) || []).slice(0, 12)) {
          console.warn('    [跳过] +' + sk.points + '  ' + (sk.title || '').slice(0, 30)
            + ' → ' + sk.reason);
        }
        for (const bc of ((probe && probe.badgeCards) || []).slice(0, 12)) {
          console.warn('    [徽章] +' + bc.points + '  ' + bc.w + 'x' + bc.h
            + ' @(' + bc.x + ',' + bc.y + ')  ' + (bc.title || '').slice(0, 40));
        }
        for (const l of ((probe && probe.links) || []).slice(0, 15)) {
          console.warn('    [链接] ' + l.w + 'x' + l.h + '  '
            + (l.text || '').slice(0, 50) + '  ' + (l.href || '').slice(0, 110));
        }
        continue;
      }

      // ③ 逐张：滚到卡片 → 鼠标事件序列 → 原生 click()（target=_blank 自己开新标签页）
      for (let order = 0; order < cards.length && isCurrent(token); order++) {
        const c = cards[order];
        await taskClickSpacing(token);            // 相邻点击固定 5s
        const before = await tabIds();
        let res = null, fresh = [], method = '', realMouse = false, aim = null;

        // ① 点击前一刻才取坐标：滚进视口 → 重读 rect → 返回顶层视口实时中心点。
        //    绝不用扫描时缓存的 c.x/c.y：调试横幅、hydration、内部滚动容器、
        //    5s 等待、上一张点击后面板刷新，都会让旧坐标失效（点偏到空白）。
        const aimPayload = {
          idx: c.idx, href: c.href, order,
          offerIndex: c.offerIndex, badgeIndex: c.badgeIndex, title: c.title || ''
        };
        aim = await inject(tabId, ybInject, ['human.aim', aimPayload]);
        if (!aim || !aim.ok) {
          // 面板可能在上一次点击后收起 / 刷新，展开后重新瞄准一次
          await inject(tabId, ybInject, ['human.openPanel', {}]);
          await nap(1000, token);
          aim = await inject(tabId, ybInject, ['human.aim', aimPayload]);
        }
        if (!aim || !aim.ok) {
          stat.aimFailed = (stat.aimFailed || 0) + 1;
          console.warn('[AutoTask] ✗ 无法定位「' + (c.title || c.text || '').slice(0, 30) + '」'
            + (aim ? '，当前页面卡片：' + JSON.stringify(aim.titles || []).slice(0, 200)
                   : '，注入无返回'));
          continue;
        }
        console.info('[AutoTask] 瞄准「' + (aim.title || aim.text || '').slice(0, 26) + '」'
          + ' tag=' + aim.tag + ' kind=' + aim.kind
          + ' rect=' + Math.round(aim.rect.left) + ',' + Math.round(aim.rect.top)
          + ' ' + Math.round(aim.w) + 'x' + Math.round(aim.h)
          + ' → 点击 (' + Math.round(aim.x) + ',' + Math.round(aim.y) + ')'
          + ' 视口 ' + aim.vp.w + 'x' + aim.vp.h + ' scrollY=' + Math.round(aim.scrollY));

        // ② 真实鼠标：chrome.debugger + Input.dispatchMouseEvent（isTrusted=true）
        if (Number.isFinite(aim.x) && aim.x > 0 && Number.isFinite(aim.y) && aim.y > 0) {
          const attached = await cdpAttach(tabId).catch(() => false);
          if (attached) {
            try {
              await ensureTabActive(tabId);
              await cdpClickAt(tabId, aim.x, aim.y);
              realMouse = true;
              method = 'CDP 真鼠标';
              await nap(900, token);
              fresh = registerNewTabs(before, await tabIds(), tabId, stat);
            } catch (err) {
              console.warn('[AutoTask] CDP 点击异常：' + (err && err.message || String(err)));
            }
          }
        }

        // ③ CDP 不可用或没开出任务页 → 页面内合成事件降级（明确标注，别当成成功）
        if (!fresh.length) {
          try {
            res = await inject(tabId, ybInject, ['human.click', aimPayload]);
          } catch (err) {
            console.warn('[AutoTask] 点击异常：' + (err && err.message || String(err)));
          }
          method = realMouse ? 'CDP+合成补点' : '合成事件(降级·可能不计分)';
          await nap(900, token);
          fresh = registerNewTabs(before, await tabIds(), tabId, stat);
        }

        if (realMouse) stat.realMouse = (stat.realMouse || 0) + 1;
        else stat.degraded = (stat.degraded || 0) + 1;
        stat.clicked++;
        clicked++;
        console.info('[AutoTask] ✓ ' + pg.label + ' 点击 ' + (order + 1) + '/' + cards.length
          + '：' + (aim.title || aim.text || '').slice(0, 34) + '（+' + aim.points + ' · ' + aim.kind + '）'
          + ' · ' + method + ' @(' + Math.round(aim.x) + ',' + Math.round(aim.y) + ')'
          + (res && res.ok ? ' · 合成事件 ' + res.dispatched + ' 段' : '')
          + ' · 新标签页 ' + fresh.length + ' 个（保留不关）');

        /* 点完核验：官方接口说 complete 变了才算真拿到分。
           参考项目 activity_worker 的 confirmed_completed —— 点击成功 ≠ 完成。 */
        if (HUMAN_VERIFY_OFFICIAL && stat.officialAvailable) {
          await nap(1800, token);
          const after = await inject(tabId, ybInject, ['human.verify', {}]);
          if (after && after.ok && Array.isArray(after.tasks)) {
            const name = String(aim.title || '').replace(/\s+/g, '');
            const hit = after.tasks.find(t =>
              String(t.title || '').replace(/\s+/g, '').slice(0, 6) === name.slice(0, 6));
            if (hit && (hit.complete || (hit.pointsMax > 0 && hit.pointsEarned >= hit.pointsMax))) {
              stat.officialVerified++;
              console.info('[AutoTask]   ✓ 官方已确认计分：' + (aim.title || '').slice(0, 26));
            } else {
              stat.officialUnconfirmed++;
              console.warn('[AutoTask]   ⚠ 官方未确认计分：' + (aim.title || '').slice(0, 26)
                + '（可能需要答题/进一步互动，或这张本身不给分）');
            }
          } else if (after && after.ok && hitByCount(lastOfficial, after)) {
            stat.officialVerified++;
            console.info('[AutoTask]   ✓ 官方完成项 +1：' + (aim.title || '').slice(0, 26));
          }
          if (after && after.ok) lastOfficial = after;
        }
      }

      // 参考项目 open_rewards_panel 是「找到即停」：flyout / dashboard / earn
      // 展示的是同一组每日任务，继续遍历会把同一张卡重复点三遍。
      console.info('[AutoTask] 已在 ' + pg.label + ' 找到并点击卡片，停止遍历其它候选页');
      break;
    } catch (err) {
      console.warn('[AutoTask] ' + pg.label + ' 出错：' + (err && err.message || String(err)));
    }
  }

  stat.pages = stat.pages || [];
  stat.pages.push({ page: 'human', clicked, anchors: cardTotal, pending: cardTotal });
  // 只 detach 调试会话，载体页 / 任务标签页全部保留
  for (const id of stat.usedTabIds) {
    try { await chrome.debugger.detach({ tabId: id }); } catch {}
    cdpAttached.delete(id);
  }
  console.info('[AutoTask] 人类式点击完成：共点 ' + clicked + ' 张卡片，'
    + '跳过 ' + (stat.skipped || 0) + ' 张不给分/已完成卡'
    + '（CDP 真鼠标 ' + (stat.realMouse || 0) + ' / 降级 ' + (stat.degraded || 0) + '）'
    + (stat.officialAvailable
        ? '，官方确认计分 ' + (stat.officialVerified || 0) + ' / 未确认 ' + (stat.officialUnconfirmed || 0)
        : '，官方核验不可用（以页面白名单为准）')
    + (stat.humanEmpty.length ? '，空页面：' + stat.humanEmpty.join('、') : ''));
}

/**
 * v2.5 主入口：默认 human —— 打开页面、滚动、鼠标点击卡片。
 * 其余模式只作可切换的回退，默认都不走。
 */
async function completePendingTaskCards(level, token) {
  lastTaskClickAt = 0;                      // 新一轮从零开始计时
  const stat = {
    clicked: 0, skipped: 0, real: false, openedTabs: 0, pages: [],
    signedOut: false, fallbackOpened: 0, domClick: 0
  };
  if (TASK_MODE === 'human') {
    console.info('[AutoTask] 任务模式：打开页面 → 滚动 → 鼠标点击卡片（不使用 CDP / 不抓 HTML）');
    await humanClickTasks(token, stat);
    return stat;
  }
  if (TASK_MODE === 'tasklist') {
    console.info('[AutoTask] 任务模式：任务列表驱动（解析 dashboard/earn → 按任务 URL 找元素点击）');
    await clickTargetsFromTaskList(token, stat);
    return stat;
  }
  if (TASK_MODE === 'sidebar') {
    console.info('[AutoTask] 任务模式：Bing 侧栏（' + SIDEBAR_URL + '）');
    const done = new Set();
    await clickCardsInSidebar(level, token, done, stat);
    return stat;
  }
  return completePendingTaskCardsOnRewards(level, token, stat);
}

/** v2.0 回退：dashboard 与 earn 两页都扫、都点，每页独立去重。 */
async function completePendingTaskCardsOnRewards(level, token, stat) {
  for (let i = 0; i < TASK_PAGES.length; i++) {
    if (!isCurrent(token)) break;
    const url = TASK_PAGES[i];
    console.info('[AutoTask] 扫描任务页 ' + (i + 1) + '/' + TASK_PAGES.length + '：' + url);
    const done = new Set();                // ← 本页独立的已点集合
    await clickCardsOnPage(url, level, token, done, stat);
  }
  return stat;
}

var autoCompleteActive = false;

/**
 * 一次完整的自动完成任务：
 *   ① 自动开始按键点击后先同步积分状态；积分与任务都已完成则零动作直接返回
 *      （唯一例外：开启「不跳过已完成任务卡」仍发起点击流程）
 *   ② 点击流程开启时主动重新加载 Bing Rewards 侧栏页面，按 DOM 顺序点击积分卡，
 *      结束时关闭页面；点哪张只取决于主界面任务状态，不看侧栏显示
 *      （默认关闭「不跳过」= 跳过已完成卡只点未完成；开启则点全部积分卡）
 *   ③ 再进行日常搜索（按剩余搜索分数决定次数）→ ④ 收尾同步
 * 侧栏读不到积分卡时才回退到 dashboard/earn 两页的索引点击。
 * 定时触发与首页按钮都走这里；与正式运行互斥，点「停止」可中断。
 */
/* ==========================================================================
 * v1.3.0 编排层：开始时一次同步 → 锁定搜索次数 → 点卡片 → 跑满搜索 → 收尾一次同步
 * ========================================================================== */

/** 搜索次数只由「开始时」那一次官方搜索配额决定，之后整轮不再重算。 */
async function presetSearchCount(pages, cap) {
  let max = 0, got = 0;
  if (pages && pages.earn && pages.earn.ok) {
    const c = parseSearchCounter(pages.earn.html);
    if (c && Number(c.max) > 0) {
      max = Number(c.max);
      got = Math.max(0, Math.min(Number(c.progress) || 0, max));
    }
  }
  if (!max) {
    const { todaySearch } = await load(['todaySearch']);
    max = Number(todaySearch && todaySearch.max) || 60;
    got = Number(todaySearch && todaySearch.progress) || 0;
  }
  const need = Math.ceil(Math.max(0, max - got) / POINTS_PER_SEARCH);
  const rawCap = Number(cap);
  const limit = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : (await getAutoTasks()).count;
  return { searches: Math.max(0, Math.min(need, limit)), max, got };
}

/**
 * 时机 ①：整轮唯一一次「开始时同步」。
 * 两页并行抓一次，同一份 HTML 同时喂给三项积分、任务列表、搜索配额与次数计算；
 * 未登录 / 两页都读不到时立即返回，绝不进入点击或搜索（修「未登录空跑」）。
 */
async function syncStart(token, cap) {
  /* v1.3.1：所有刷新入口共用的唯一同步函数 desktopSyncRewards（A10 层）。
     一次两页抓取 → 一次性原子写回三项积分 / 今日任务 / 登录态 / 搜索配额；
     刷新过程中 UI 保持上一次完整结果，绝不先清空。 */
  const sync = await desktopSyncRewards({ fresh: true, reason: 'start', token: token });
  const pages = sync.pages;
  if (!sync.ok) {
    /* 不清空已有积分与任务列表：未确认 / 页面抖动时 UI 保持上一次完整结果 */
    await store({
      todayStart: null, liveCheck: false,
      presetSearches: 0, runPreset: null
    });
    return { ok: false, reason: sync.reason, pages };
  }

  const dashHtml = pages.dash.ok ? pages.dash.html : '';
  const startPoints = dashHtml ? parseBalance(dashHtml) : null;
  const todaySearch = sync.todaySearch;
  const cnt = await presetSearchCount(pages, cap);

  await store({
    todayStart: todaySearch || null,
    startPoints: startPoints == null ? 0 : startPoints,
    startKnown: startPoints != null,
    liveCheck: false,                 // 搜索中间不读积分
    searchMaxedAtStart: !!(todaySearch && todaySearch.progress >= todaySearch.max),
    presetSearches: cnt.searches,
    runPreset: {
      mode: 'preset', at: Date.now(), searches: cnt.searches,
      start: startPoints, max: cnt.max, got: cnt.got
    }
  });

  const items = Array.isArray(sync.todayTasks.items) ? sync.todayTasks.items : [];
  /* T08=A：两版统一采用插件版严格完成条件；估算 / 缺配额 / 过期来源只显示待核实，
     不作自动跳过依据。 */
  const allDone = HSA_CORE.isAllDone(sync.todayTasks, {
    estimated: !!sync.todayTasks.approx,
    quotaMissing: !(todaySearch && Number.isFinite(todaySearch.max)),
    stale: !!(sync.pointsSummary &&
      Date.now() - Number(sync.pointsSummary.updatedAt || 0) > HSA_CORE.DEFAULTS.htmlCacheTtlMs)
  });

  return {
    ok: true, pages, startPoints, todaySearch,
    searches: cnt.searches, max: cnt.max, got: cnt.got, allDone,
    taskRes: { ok: true, signedOut: false, count: items.length }
  };
}

/**
 * 时机 ④：整轮唯一一次「收尾同步」。
 * 一次两页抓取，同一份 HTML 更新三项积分 + 任务列表 + 最终积分显示；
 * 不再像旧版那样分别读 dashboard、读 earn、再刷一次任务（三次重复请求）。
 */
async function presetSyncFinish(st, searches, start) {
  /* v1.3.1：收尾与开始、手动刷新走同一套 desktopSyncRewards，一次抓取一次原子写回 */
  const sync = await desktopSyncRewards({ fresh: true, reason: 'finish' });
  const finalPoints = sync.ok && sync.pages.dash.ok ? parseBalance(sync.pages.dash.html) : null;
  const finalToday = sync.ok ? sync.todaySearch : null;
  const exact = !!st.startKnown && finalPoints !== null;
  let earned;
  if (exact) earned = Math.max(0, finalPoints - (start || 0));
  else if (st.todayStart && finalToday) earned = Math.max(0, finalToday.progress - st.todayStart.progress);
  else earned = estimateEarned(searches, st.todayStart);
  const endPoints = finalPoints !== null ? finalPoints : (start || 0) + earned;
  await store({
    endPoints,
    finalEarned: earned,
    earnedIsEstimate: !exact,
    todaySearch: finalToday || st.todaySearch || null,
    lastRun: { at: Date.now(), searches, total: st.totalSearch || searches,
               start: start || 0, end: endPoints, earned, estimate: !exact },
    currentQuery: null, cooldownUntil: null,
    phase: 'completed', running: false, stopRequested: false,
    lastActivity: Date.now()
  });
  chrome.alarms.clear('watchdog');
  chrome.alarms.clear('cooldownEnd');
  await restoreUserFocus();
  await closeTab('rewardsTabId').catch(() => {});
  return { points: finalPoints, today: finalToday };
}

/**
 * 一次完整的自动完成任务（v1.3.0 流程 / v1.3.8-s2 侧栏点击）：
 *   ① 开始时同步一次积分与任务列表，并按官方搜索配额预先锁定搜索次数；
 *      积分与任务都完成则零动作返回（开启「不跳过已完成任务卡」除外）
 *   ② 通过 Bing Rewards 侧栏逐个点击积分卡片：流程开启主动重载页面、
 *      结束关闭页面；点哪张只看主界面任务状态，不看侧栏完成标记
 *      （默认跳过已完成卡；开启「不跳过」则点全部积分卡；不给分卡排除）
 *   ③ 再按锁定次数跑拟人搜索；搜索中间不读积分、不刷任务列表
 *   ④ 结束后同步一次，把最终结果显示到界面
 * 定时触发与首页按钮都走这里；与正式运行互斥，点「停止」可中断。
 */
async function runAutoComplete(opts) {
  const o = opts || {};
  /* 同步占位：开始时同步的 await 期间禁止重复点击 */
  if (autoCompleteActive || flowActive) return { ok: false, reason: 'running' };
  autoCompleteActive = true;
  const token = ++flowToken;
  try {
    if ((await load(['running'])).running) return { ok: false, reason: 'running' };
    const tasks = await getAutoTasks();
    /* v1.3.8-s2：「不跳过已完成任务卡」开启时，即使积分与任务全部完成也要发起点击流程 */
    const autoSettings = await getSettings();
    const notSkipCompletedCards = !!autoSettings.notSkipCompletedCards;
    const level = clampInt(Number(o.level) || tasks.level, 1, 3);
    await store({
      running: true, phase: 'completingTasks', stopRequested: false,
      error: null, warning: null, runLevel: level, lastActivity: Date.now(),
      runAuto: !o.manual, runAutoTime: o.time || null
    });
    if (RESTORE_FOCUS_ON_FINISH) {
      const cur = await load(['userActiveTabId']);
      if (cur.userActiveTabId == null) {
        const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
        const keep = Array.isArray(active) && active[0] && typeof active[0].id === 'number'
          ? active[0].id : null;
        await store({ userActiveTabId: keep });
      }
    }

    /* ① 唯一一次开始时同步：积分 + 任务列表 + 锁定搜索次数 */
    const sync = await syncStart(token, o.cap);
    if (!sync.ok) {
      await store({ running: false, phase: 'idle', stopRequested: false,
                    lastActivity: Date.now(), presetSearches: 0 });
      console.warn('[AutoTask] 开始时同步失败（' + sync.reason + '），未登录或页面不可读，零动作返回');
      return { ok: false, reason: sync.reason, clicked: 0, searches: 0 };
    }
    /* 自动开始按键 → 先同步积分；积分与任务都已完成时不做任何其他动作。
       唯一例外：开启「不跳过已完成任务卡」，此时仍要发起点击任务卡片流程。 */
    if (sync.allDone && !o.force && !notSkipCompletedCards) {
      console.info('[AutoTask] 同步后积分与任务均已全部完成，零动作：不重载页面、不点卡片、不搜索');
      await store({ running: false, phase: 'completed', stopRequested: false,
                    lastActivity: Date.now() });
      /* T09=D：ok:true + skipped:true + reason:allDone，界面显示「已完成，无需动作」。 */
      return HSA_CORE.allDoneResult({ source: 'start-sync' });
    }
    if (sync.allDone && notSkipCompletedCards) {
      console.info('[AutoTask] 积分与任务已完成，但「不跳过已完成任务卡」已开启：仍发起点击流程');
    }

    /* ② 点击任务卡片 */
    const clickRes = await completePendingTaskCards(level, token);

    /* ③ 搜索：次数在 ① 已锁定，中途不再同步积分 */
    const searches = sync.searches;
    if (searches > 0 && isCurrent(token)) {
      await handleStart(searches, {
        level, auto: !o.manual, time: o.time || null,
        source: o.manual ? 'manual' : 'schedule', preset: true
      });
    } else {
      const st = await load(['startKnown', 'todayStart', 'todaySearch']);
      /* 无搜索路径不经 handleStart，totalSearch 必须显式为 0，不能沿用上次残留 */
      await presetSyncFinish(Object.assign({}, st, { totalSearch: 0 }), 0, sync.startPoints || 0);
      await store({ running: false, phase: 'completed', stopRequested: false,
                    lastActivity: Date.now() });
    }
    /* handleStart 会推进 flowToken，收尾不复用旧 token */
    if (TASK_MODE === 'rewards') await closeTab('rewardsTabId').catch(() => {});
    const perPage = (clickRes.pages || []).map(p => p.page === 'human'
      ? p.page + '=' + p.clicked + '(卡片' + (p.anchors || 0) + ')'
      : p.page === 'tasklist'
      ? p.page + '=' + p.clicked + '(任务' + (p.anchors || 0) + '/待点' + (p.pending || 0)
        + '/源' + (p.source || '?') + ')'
      : p.page === 'sidebar'
        ? p.page + '=' + p.clicked + '(卡' + (p.anchors || 0) + '/frames' + (p.frames || 0)
          + (p.panelFound === false ? '/未找到面板' : '') + ')'
        : p.page + '=' + p.clicked + '(卡' + (p.anchors || 0) + '/完成' + (p.doneSkipped || 0) + ')'
    ).join(' / ') || '无';
    console.info('[AutoTask] 自动完成[先同步积分状态 → 侧栏点击积分卡 → 搜索]：共点击 ' + clickRes.clicked + ' 张（' + perPage
      + '），保留任务标签页 ' + (clickRes.openedTabs || 0) + ' 个'
      + '（DOM 降级点击 ' + (clickRes.domClick || 0)
      + '，真鼠标 ' + (clickRes.realMouse || 0) + '/降级 ' + (clickRes.degraded || 0)
      + '/瞄准失败 ' + (clickRes.aimFailed || 0)
      + '/跳过不给分 ' + (clickRes.skipped || 0)
      + '/官方确认 ' + (clickRes.officialVerified || 0)
      + '，未找到卡片 ' + (clickRes.cardNotFound || 0)
      + '，点击失败 ' + (clickRes.clickFailed || 0) + '）'
      + (TASK_MODE === 'sidebar' && clickRes.sidebarPanelFound === false
        ? '，[警告] 未在网页 DOM 找到侧栏，请看侧栏诊断日志' : '')
      + (clickRes.signedOut ? '，[警告] 检测到登录页，请确认已登录 Rewards' : '')
      + '，开始时锁定搜索次数 ' + searches + '（配额 ' + sync.got + '/' + sync.max
      + '，中间不同步积分）');
    return { ok: true, clicked: clickRes.clicked, skippedCards: clickRes.skipped,
             searches, level, preset: true,
             states: clickRes.states || null,
             manualLinks: (clickRes.manualLinks || []).slice(0, 20) };
  } finally {
    autoCompleteActive = false;
  }
}

/* autoComplete 由主消息路由统一处理并回传 {skipped} 等结果，这里不再重复监听 */

/* ---------------------------------------------------------------------------
 * 测试拟人搜索：独立后台标签页跑一次真实键鼠搜索，不写 running、
 * 不读积分、不影响自动任务日志。
 * ------------------------------------------------------------------------- */
async function testHumanSearch(opts) {
  const o = opts || {};
  const level = clampInt(Number(o.level) || 3, 1, 3);
  const st = await load(['running']);
  if (flowActive || autoCompleteActive || st.running) return { ok: false, reason: 'running' };

  const startedAt = Date.now();
  const savedHalt = haltFlag;
  haltFlag = false;
  let tabId = null;
  let realInput = false;
  let keyword = '';

  try {
    const built = await buildQueries(1, []);
    keyword = String((built.queries || [])[0] || '').trim();
    if (!keyword) throw new Error(bgMsg('topics'));

    const tab = await chrome.tabs.create({ url: HOME_URL, active: false });
    tabId = tab.id;
    const home = await waitForTab(tabId, isBingHome, PAGE_TIMEOUT, true);
    if (!home) throw new Error(bgMsg('network'));

    realInput = await cdpAttach(tabId);
    let box = await probe(tabId, SEARCH_INPUTS);
    if (!box) {
      await chrome.tabs.update(tabId, { url: HOME_URL });
      await waitForTab(tabId, isBingHome, PAGE_TIMEOUT, false);
      box = await probe(tabId, SEARCH_INPUTS);
    }
    if (!box) throw new Error('找不到 Bing 搜索框');

    /* 严格运行模式：固定中心点击与固定延时，不启用拟人轨迹 / 随机停留。 */
    const plan = strictClickPlan(box.box);
    if (realInput) {
      await cdpClickAt(tabId, plan.center[0], plan.center[1]);
      await sleep(STRICT.fixedNapMs);
      await cdpClearInput(tabId);
      await sleep(STRICT.fixedNapMs);
      await cdpInsertText(tabId, keyword);
      await sleep(STRICT.fixedNapMs);
      await cdpKey(tabId, 'Enter');
    } else {
      await domClick(tabId, plan.center[0], plan.center[1]);
      await sleep(STRICT.fixedNapMs);
      await domClearInput(tabId);
      await domInput(tabId, keyword);
      await sleep(STRICT.fixedNapMs);
      await domKey(tabId, 'Enter');
    }

    let result = await waitForTab(tabId, isBingSearch, 10000, true);
    if (!result || !isBingSearch(result.url)) {
      await chrome.tabs.update(tabId, { url: directSearchUrl(keyword) });
      result = await waitForTab(tabId, isBingSearch, PAGE_TIMEOUT, false);
    }
    if (!result || !isBingSearch(result.url)) throw new Error(bgMsg('network'));

    /* 严格运行模式：禁用拟人滚动，只保留固定等待。 */
    await sleep(STRICT.fixedNapMs);

    return {
      ok: true, keyword, level, realInput, mode: 'paste',
      trendCount: built.trendCount || 0, ms: Date.now() - startedAt
    };
  } catch (err) {
    return {
      ok: false, reason: 'error',
      message: (err && err.message) || String(err),
      keyword, level, realInput, ms: Date.now() - startedAt
    };
  } finally {
    if (tabId != null) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
      cdpAttached.delete(Number(tabId));
      try { await chrome.tabs.remove(tabId); } catch {}
    }
    // 测试是独立功能：遗留的 Rewards / 任务点击后台页强制清理（主流程仍按 v1.8 保留）
    await forceCloseTab('rewardsTabId').catch(() => {});
    await forceCloseTab('taskClickTabId').catch(() => {});
    haltFlag = savedHalt;
  }
}


/* ============================================================================
 * A9 · 桌面壳适配层（追加在上传版全文之后，不改任何上传版函数体）
 *
 *  · 零监控：上传版的 4 类 periodInMinutes alarm 已改一次性 when 排程；
 *    初始化与空闲不抓取、不刷新界面；界面重绘只由 storage.onChanged 驱动。
 *  · 抓取时机（v1.3.0）：整轮只有两次 —— syncStart(开始时) 与
 *    presetSyncFinish(收尾)；搜索中间零抓取、零积分同步。
 *  · debug：默认禁用，仅 HSA_DEBUG=1（npm run start:debug）时落盘 HTML。
 *  · 登录判定：完全沿用上传版 fetchBothPages / isSignInPage（两页都判登录页
 *    才算 signedOut），桌面版不再自造 classifyLogin / detectLogin / stickyLogin。
 * ========================================================================== */

/** 一次性 alarm：同名覆盖，绝不使用 periodInMinutes。 */
function armOneShot(name, delayMs) {
  try {
    const ms = Math.max(1000, Number(delayMs) || 60000);
    chrome.alarms.create(name, { when: Date.now() + ms });
  } catch {}
}

/** 到下一个用户设定的启动时间还有多少毫秒；没有设定就 24 小时后重排。 */
function desktopNextAutoDelay() {
  const day = 24 * 60 * 60 * 1000;
  try {
    const raw = (typeof window !== 'undefined' && window.__hsaAutoTasksTimes) || [];
    if (!Array.isArray(raw) || !raw.length) return day;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    let best = null;
    for (const t of raw) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
      if (!m) continue;
      const v = (parseInt(m[1], 10) % 24) * 60 + (parseInt(m[2], 10) % 60);
      const d = (v > cur ? v - cur : v + 1440 - cur) * 60000;
      if (best === null || d < best) best = d;
    }
    return best === null ? day : Math.max(60000, best);
  } catch { return day; }
}

/** 只在两个允许时机内部置位；初始化、空闲、未登录一律 false。 */
let desktopFetchGate = false;
function desktopFetchAllowed(reason) {
  return !!desktopFetchGate;
}
function desktopOpenFetchGate(reason) {
  desktopFetchGate = true;
  try { if (typeof window !== 'undefined' && window.__desktop &&
    typeof window.__desktop.debugLog === 'function')
    window.__desktop.debugLog('desktop', '抓取门控开启：' + reason, {}); } catch {}
}
function desktopCloseFetchGate() { desktopFetchGate = false; }

/* runAutoComplete 包装：整轮开启抓取门控，并写回桌面 UI 的 autoResult 字段。
   v1.3.0 起门控期间只允许开始 / 收尾两次同步，搜索阶段由 desktopSearchGuard 硬拦。 */
const desktopOriginalRunAutoComplete = runAutoComplete;
runAutoComplete = async function (opts) {
  desktopOpenFetchGate('autoComplete');
  try {
    const res = await desktopOriginalRunAutoComplete(opts);
    try {
      await store({ autoResult: Object.assign({}, res, { at: Date.now() }) });
    } catch {}
    return res;
  } finally {
    desktopCloseFetchGate();
  }
};

/* v1.3.0：删除「每完成一次搜索就刷新积分与任务列表」的 storage.onChanged 钩子。
   旧版监听 currentSearch 递增 → refreshTodayTasks（两页抓取），还会在
   handleStart 写 currentSearch:0 时多触发一次；既拖慢搜索，也违背新流程
   「搜索中间不进行积分同步」。现在整轮只有开始与收尾两次显式同步。 */

/* 一次性 alarm 触发后重排下一个，保证没有任何周期定时器。 */
chrome.alarms.onAlarm.addListener(alarm => {
  const n = alarm && alarm.name;
  if (!HSA_CORE.strictAlarmAllowed(n, strictRunActive)) return;
  if (n === 'watchdog') armOneShot('watchdog', 30 * 60 * 1000);
  else if (n === 'cleanUsedWords') armOneShot('cleanUsedWords', 24 * 60 * 60 * 1000);
  else if (n === 'reminderTick') armOneShot('reminderTick', REMINDER_TICK_MINUTES * 60 * 1000);
  else if (n === 'autoTaskTick') armOneShot('autoTaskTick', desktopNextAutoDelay());
});

/* 定时配置变化 → 重排一次性时间点（替换上传版 rebuildAutoAlarm 里的周期 tick）。 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.autoTasks) return;
  try {
    const v = changes.autoTasks.newValue;
    if (typeof window !== 'undefined') window.__hsaAutoTasksTimes = (v && v.times) || [];
  } catch {}
  armOneShot('autoTaskTick', desktopNextAutoDelay());
});

try {
  load(['autoTasks']).then(s => {
    if (typeof window !== 'undefined')
      window.__hsaAutoTasksTimes = (s && s.autoTasks && s.autoTasks.times) || [];
    armOneShot('autoTaskTick', desktopNextAutoDelay());
  }).catch(() => {});
} catch {}

/* ============================================================================
 * A10 · v1.3.1 统一同步层（刷新逻辑唯一入口）+ 桌面运行静默
 *
 *  · 所有刷新点（点击自动完成任务的开始同步、收尾同步、今日任务「刷新」、
 *    登录完成后、refreshPoints / refreshToday）都走 desktopSyncRewards：
 *    一次两页抓取 → 一次原子写回 → UI 只重绘一次。
 *  · 刷新过程中不写任何中间值，也不清空已有积分 / 任务列表；完全不可读时
 *    一个业务键都不写，界面保持上一次完整结果（修「先清空、体验差」）。
 *  · 登录态数据驱动：有积分或任务列表就是已登录，避免「有数据却显示未登录」。
 *  · 任务列表同时收 /dashboard 每日活动与 /earn 日常任务（补齐缺失的整组）。
 *  · 上传版所有函数体逐字节不动；这里只重新绑定入口，不改任务识别 / 点击 /
 *    搜索动作本身。
 * ======================================================================== */

/** /earn 页「日常任务」卡：放宽可见 DOM 徽章 + 补 RSC activityCards。
 *  上传版 visibleCardsFrom 要求 <p class="text-metadata..."> 且 h2 必须及时渲染，
 *  官网改版后徽章无 class、SSR 先出骨架屏 → 日常任务整组丢失。 */
function desktopEarnCards(html) {
  const src = String(html || '');
  const clean = decodePayload(src);
  const out = [];
  const seen = new Set();
  const put = (name, desc, points, href, completed) => {
    const key = name + '|' + desc + '|' + points;
    if (!name || !(points > 0) || seen.has(key)) return;
    seen.add(key);
    out.push({
      name: name, description: desc, section: 'promo',
      category: sectionLabel('promo'), points: points,
      earned: completed ? points : 0, completed: !!completed,
      url: safeUrl(href), source: 'earn-dom'
    });
  };
  /* 1) 可见 DOM：<a> 内徽章数字（<p> 任意 class），排除兑换 / 壁纸 / 月度 punchcard */
  for (const m of src.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)) {
    const card = m[0];
    const hrefM = /href="([^"]*)"/.exec(card);
    const href = hrefM ? hrefM[1] : '';
    if (/\/redeem|\/referandearn|\/apps\/wallpaper|\/earn\/quest\/|\/rewardscdn\//i.test(href)) continue;
    const badge = /bg-statusSuccessRewardsBg[\s\S]{0,500}?<p[^>]*>\s*(\d{1,4})\s*<\/p>/.exec(card);
    if (!badge) continue;
    const points = parseInt(badge[1], 10);
    if (!(points > 0) || points > 100) continue;       // 50 分月度 punchcard 不计入今日任务
    const sec = sectionBeforeHeading(src, m.index);
    if (sec === 'other' && !/日常任务|Daily tasks|More activities/i.test(
      src.slice(Math.max(0, m.index - 4000), m.index))) continue;
    const titleM = /<p class="line-clamp-3 text-globalBody2Strong">([^<]*)<\/p>/.exec(card)
      || /<h3[^>]*>([\s\S]{1,120}?)<\/h3>/.exec(card)
      || /<h4[^>]*>([\s\S]{1,120}?)<\/h4>/.exec(card)
      || /<img[^>]*alt="([^"]*)"/.exec(card);
    const descM = /<p class="line-clamp-3 text-fgCtrlNeutralSecondaryRest">([^<]*)<\/p>/.exec(card);
    const done = /已完成|已领取|Completed|Claimed/i.test(card)
      || /\d+\s*\/\s*\d+\s*个任务/.test(stripTags(card));
    put(cleanText(titleM && titleM[1]), cleanText(descM && descM[1]), points, href, done);
  }
  /* 2) RSC activityCards：只收有积分的非推广卡，与每日活动按标题去重 */
  for (const obj of jsonArrayObjects(clean, 'activityCards')) {
    const str = re => { const m = obj.match(re); return m ? m[1] : null; };
    const points = Number(str(/"points"\s*:\s*"?(\d+)"?/i)) || 0;
    if (!(points > 0) || points > 100) continue;
    if (/"isPromotional"\s*:\s*true/i.test(obj)) continue;
    const dest = str(/"destination"\s*:\s*"([^"]*)"/i) || '';
    if (/\/apps\/|\/redeem|\/earn\/quest\//i.test(dest)) continue;
    put(cleanText(str(/"title"\s*:\s*"([^"]*)"/i)),
        cleanText(str(/"description"\s*:\s*"([^"]*)"/i)), points, dest,
        /"isCompleted"\s*:\s*true/i.test(obj));
  }
  return out;
}

function desktopTaskItems(pages) {
  const out = [], seen = new Set();
  const add = it => {
    if (!it || !(it.points > 0) || !it.name || !SECTION_LABEL[it.section]) return;
    const key = it.name + '|' + it.description + '|' + it.points + '|' + it.section;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(it);
  };
  if (pages.dash.ok) for (const it of cardsFromRewardsHtml(pages.dash.html)) add(it);
  if (pages.earn.ok) {
    for (const it of cardsFromRewardsHtml(pages.earn.html)) add(it); // /earn 也含每日活动 RSC
    for (const it of desktopEarnCards(pages.earn.html)) add(it);     // 日常任务补齐全
  }
  return out;
}

/** 与上传版 searchTaskItem 等价，但只用本次实时 counter（不读上一轮 60/60 缓存）。 */
function desktopSearchItem(counter, prev) {
  let max = Number(counter && counter.max) || 0;
  let got = Number(counter && counter.progress) || 0;
  if (!max) { max = Number(prev && prev.max) || 60; got = Number(prev && prev.progress) || 0; }
  got = Math.max(0, Math.min(got, max));
  return {
    name: bgLang === 'en' ? 'Bing search today' : '今日 Bing 搜索',
    description: '', section: 'search', category: sectionLabel('search'),
    points: max, earned: got, completed: got >= max,
    url: '', source: 'search', kind: 'search'
  };
}

/* ==========================================================================
 * v1.3.1 · 可见面板快照 = 统一同步的「页面真实状态」数据源
 *
 * 上传版的 parsePointsTrio / cardsFromRewardsHtml 只认官方 RSC 字段与 class。
 * 真机中文官网常把它们放在纯中文可见文本 / 自定义 DOM 里，且 /earn 偶尔
 * 返回登录页（用户提交的 https://rewards.bing.com/earn 文本即如此），于是：
 *   · 三项积分全 null、任务卡 0 张 → 退回「估算」只有一条搜索
 *   · isSignInPage(outerHTML) 被 JS bundle 里的登录文案误命中 → 显示未登录
 * 主进程 readVisibleNow() 早已在同一页面读出 points / cards / 可见文本登录态，
 * 这里把它作为权威补充：官方解析优先，快照补缺；登录态以可见文本为准。
 * ======================================================================== */
async function desktopVisibleSnapshots() {
  const snaps = [];
  /* v1.3.3：只认「本次同步期间」由 desktopFetchFromPanel 实时读到的可见面板。
     5 分钟前的旧快照会把已经完成的任务卡按未完成状态补回列表，正是
     「完成部分日常任务后点刷新不更新」的第二个来源。 */
  if (desktopLastVisible && Date.now() - desktopLastVisibleAt <= 20000 &&
      /^https:\/\/rewards\.bing\.com\//i.test(String(desktopLastVisible.url || ''))) {
    snaps.push(desktopLastVisible);
  }
  try {
    const got = await load(['visibleRewardsSnapshot', 'visibleRewardsEarnSnapshot']);
    for (const k of ['visibleRewardsSnapshot', 'visibleRewardsEarnSnapshot']) {
      const s = got && got[k];
      if (!s || !Number.isFinite(s.at) || Date.now() - s.at > 45000) continue;
      if (!/^https:\/\/rewards\.bing\.com\//i.test(String(s.url || ''))) continue;
      if (!snaps.some(x => x.url === s.url && x.at === s.at)) snaps.push(s);
    }
  } catch {}
  return snaps;
}

function desktopSnapshotTrio(snaps) {
  const out = { available: null, today: null, claimable: null };
  for (const s of snaps) {
    const p = (s && s.points) || {};
    for (const k of Object.keys(out)) {
      if (!Number.isFinite(out[k]) && Number.isFinite(p[k])) out[k] = p[k];
    }
  }
  return out;
}

function desktopSnapshotItems(snaps) {
  const out = [], seen = new Set();
  for (const s of snaps) {
    for (const c of (s && Array.isArray(s.cards)) ? s.cards : []) {
      const section = SECTION_LABEL[c.section] ? c.section : 'promo';
      const item = {
        name: String(c.name || '').trim(),
        description: String(c.description || ''),
        section: section, category: sectionLabel(section),
        points: Number(c.points) || 0,
        earned: Number(c.earned) || 0,
        completed: !!c.completed,
        url: String(c.url || ''), source: 'visible-panel'
      };
      if (!(item.points > 0) || !item.name || !SECTION_LABEL[section]) continue;
      const key = [item.name, item.description, item.points, item.section].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/* v1.3.2：语义指纹比较，只把「真正变了的业务值」写进 storage。
   忽略 updatedAt / syncAt / reason 等元数据；值没变就一次 store 都不做，
   UI 完全不动 —— 用户要求「刷新时不要先清空，而是仅改变变化的值」。 */
function desktopFingerprint(v) {
  if (Array.isArray(v)) return v.map(desktopFingerprint);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (/^(updatedAt|checkedAt|fetchedAt|ts|timestamp|capturedAt|at|reason|sources)$/.test(k)) continue;
      o[k] = desktopFingerprint(v[k]);
    }
    return o;
  }
  return v;
}
function desktopSame(a, b) {
  try { return JSON.stringify(desktopFingerprint(a)) === JSON.stringify(desktopFingerprint(b)); }
  catch { return Object.is(a, b); }
}

/** 唯一同步入口：一次抓取、一次原子写回，刷新期间 UI 完全不动。 */
async function desktopSyncRewards(opts) {
  const o = opts || {};
  /* D06=D：刷新 / 开始 / 收尾强制新数据；后台展示允许短期缓存并显示采集时间。 */
  const policy = HSA_CORE.syncCachePolicy(o.reason);
  const fresh = !!o.fresh || policy.fresh;
  const pages = o.pages || await fetchBothPages(fresh
    ? { fresh: true, reason: o.reason, noTabs: o.noTabs }
    : { reason: o.reason, noTabs: o.noTabs });
  const prev = await load(['pointsSummary', 'todayTasks', 'todaySearch', 'loginStatus', 'taskClickIndex']);
  const prevPs = prev.pointsSummary || {};
  const prevTt = prev.todayTasks || {};
  const prevSearch = prev.todaySearch || null;
  const prevLogin = prev.loginStatus || null;

  const snaps = await desktopVisibleSnapshots();
  const official = mergeTrio(
    pages.dash.ok ? parsePointsTrio(pages.dash.html) : null,
    pages.earn.ok ? parsePointsTrio(pages.earn.html) : null
  );
  const trio = mergeTrio(official, desktopSnapshotTrio(snaps));
  const snapSignedOut = snaps.length > 0 && snaps.every(s => !!s.signedOut);
  const snapSignedIn = snaps.some(s => !!s.signedIn && !s.signedOut);
  const snapMeta = {
    at: Math.max(0, ...snaps.map(s => Number(s.at) || 0)),
    url: snaps.length ? String(snaps[0].url || '') : '',
    signedOut: snapSignedOut
  };
  /* D04=B：三态登录判断，以可解析余额 / 可见面板 / 明确登出信号为主，
     不把临时加载页文案当成确凿登出。 */
  const evidence = {
    available: Number.isFinite(trio.available) ? trio.available : null,
    panelSignedIn: snapSignedIn,
    panelSignedOut: snaps.length ? snapSignedOut : undefined,
    pageTextSignedOut: !!pages.signedOut || snapSignedOut,
    explicitLogout: !!pages.signedOut && snapSignedOut && !snapSignedIn,
    hasFreshData: !!pages.reachable
  };
  /* D05=D：确认登出 → 隐藏当前可用余额，历史 / 今日值标「上次记录」，不删记录。 */
  if (evidence.explicitLogout && !Number.isFinite(trio.available)) {
    const out = HSA_CORE.logoutPresentation(prevPs);
    await store({ pointsSummary: out.pointsSummary, loginStatus: 'out',
                  loginCheckedAt: Date.now() });
    return {
      ok: false, pages: pages, signedOut: true, reachable: !!pages.reachable,
      reason: 'signedOut', pointsSummary: out.pointsSummary, todayTasks: prevTt,
      todaySearch: prevSearch, loginStatus: 'out', taskClickIndex: prev.taskClickIndex || null,
      items: [], changed: ['pointsSummary', 'loginStatus']
    };
  }
  const keep = (v, key) => Number.isFinite(v) ? v
    : (Number.isFinite(prevPs[key]) ? prevPs[key] : null);

  let cards = desktopTaskItems(pages);
  /* D02=D：新鲜页面快照补缺，官网本次已确认的卡片状态优先，旧快照不覆盖。 */
  const merged = HSA_CORE.mergeSnapshotCards(cards, desktopSnapshotItems(snaps), {
    now: Date.now(), snapshotAt: snapMeta.at, snapshotUrl: snapMeta.url,
    snapshotSignedOut: snapSignedOut
  });
  cards = merged.cards;
  let approx = false;
  if (!cards.length && pages.earn.ok) cards = rowsFromProgressTable(pages.earn.html);
  if (!cards.length) { cards = await fallbackTaskItems(); approx = true; }

  const counter = pages.earn.ok ? parseSearchCounter(pages.earn.html) : null;
  const items = [desktopSearchItem(counter, prevSearch),
                 ...cards.filter(i => i.section !== 'search')];
  /* D03=B：两页失败但当前账号的新鲜可见页面有数据时允许降级同步，标注「页面数据」。 */
  const degrade = HSA_CORE.degradedSync(snapMeta, {
    pagesReachable: !!pages.reachable, now: Date.now()
  });
  const pointsSummary = {
    available: keep(trio.available, 'available'),
    today: keep(trio.today, 'today'),
    claimable: keep(trio.claimable, 'claimable'),
    signedOut: false,
    updatedAt: Date.now(),
    collectedAt: Math.max(Number(pages.dash.collectedAt) || 0,
      Number(pages.earn.collectedAt) || 0, snapMeta.at) || Date.now(),
    dataSourceLabel: degrade.label,
    dataSourceLabelEn: degrade.labelEn,
    degraded: !!degrade.degraded,
    sources: [pages.dash.ok && '/dashboard', pages.earn.ok && '/earn',
      snaps.length && 'visible-panel', degrade.degraded && 'fresh-page-snapshot'].filter(Boolean)
  };
  const signedIn = Number.isFinite(pointsSummary.available);
  const hasRealTasks = cards.length > 0 && !approx;
  const loginStatus = HSA_CORE.loginStateFromEvidence(Object.assign({}, evidence, {
    available: signedIn ? pointsSummary.available : evidence.available,
    panelSignedIn: signedIn || snapSignedIn,
    hasFreshData: degrade.ok
  }));
  const todayTasks = summarizeTaskItems(items, { approx: approx, signedOut: false });
  const todaySearch = counter || prevSearch || null;
  const taskClickIndex = buildTaskClickIndex(pages, cards);

  const candidate = {
    pointsSummary: pointsSummary, todayTasks: todayTasks,
    todaySearch: todaySearch, loginStatus: loginStatus,
    taskClickIndex: taskClickIndex
  };
  const patch = Object.assign({}, o.extra || {});
  for (const [k, v] of Object.entries(candidate)) {
    const before = k === 'pointsSummary' ? prevPs : k === 'todayTasks' ? prevTt
      : k === 'todaySearch' ? prevSearch : k === 'taskClickIndex' ? prev.taskClickIndex : prevLogin;
    if (k === 'taskClickIndex' ? (!before || before.updatedAt !== v.updatedAt) : !desktopSame(before, v)) patch[k] = v;
  }
  if (Object.keys(patch).length) await store(patch);
  const readData = degrade.ok;
  const outOnly = loginStatus === 'out' && !signedIn && !hasRealTasks;
  const ok = readData && !outOnly && !pages.signedOut;
  return {
    ok: ok, pages: pages, signedOut: loginStatus === 'out',
    reachable: readData,
    degraded: !!degrade.degraded, dataSourceLabel: degrade.label,
    snapshotApplied: !!merged.snapshotApplied, snapshotAdded: merged.added,
    reason: ok ? (o.reason || 'manual')
      : (pages.signedOut || loginStatus === 'out' ? 'signedOut' : 'unreachable'),
    pointsSummary: pointsSummary,
    todayTasks: todayTasks, todaySearch: todaySearch,
    loginStatus: loginStatus, taskClickIndex: taskClickIndex,
    items: items, changed: Object.keys(patch)
  };
}

/* 上传版里所有旧刷新入口统一落到同一套逻辑（函数体不动，只换绑定）。 */
refreshTodayTasks = async function (token, pages, opts) {
  const r = await desktopSyncRewards({
    pages: pages || undefined, fresh: true, reason: 'refreshTasks',
    token: token, skipInjection: !!(opts && opts.skipInjection)
  });
  return { ok: r.ok, signedOut: r.signedOut, count: (r.todayTasks.items || []).length };
};
refreshPointsOnly = async function () {
  return desktopSyncRewards({ fresh: true, reason: 'refreshPoints' });
};
refreshPointsSummary = async function (pages) {
  const r = await desktopSyncRewards({ pages: pages || undefined, fresh: true, reason: 'points' });
  return !!r.signedOut;
};
refreshToday = async function () {
  return desktopSyncRewards({ fresh: true, reason: 'refreshToday' });
};

/* ==========================================================================
 * 桌面版任务点击：专用任务侧栏保持扫描页不变，点击弹出的任务页落到结果视图，
 * 跨 /dashboard 与 /earn 两页、按稳定 key 去重逐张点击。
 * T01=D：按宿主能力优先 CDP 真鼠标，不可用时降级页面真实交互，并逐卡记录触发方式；
 * T06=D：已发出点击 / 已打开页面 / 官网已确认完成 三态独立统计，互不冒充。
 * ======================================================================== */
completePendingTaskCards = async function (level, token) {
  const stat = {
    clicked: 0, skipped: 0, real: false, realMouse: 0,
    openedTabs: 0, pages: [], signedOut: false,
    fallbackOpened: 0, domClick: 0, degraded: 0, clickFailed: 0,
    states: HSA_CORE.newClickResult()
  };
  const panel = (typeof chrome !== 'undefined' && chrome.taskPanel &&
                 typeof chrome.taskPanel.clickAll === 'function') ? chrome.taskPanel
    : (typeof window !== 'undefined' && window.__desktop &&
       typeof window.__desktop.taskClickAll === 'function')
      ? { clickAll: window.__desktop.taskClickAll } : null;
  if (!panel) {
    stat.clickFailed = 1;
    stat.reason = 'desktop-task-panel-unavailable';
    console.warn('[AutoTask] 桌面任务侧栏不可用；为保证真实鼠标点击，不回退到 DOM.click()');
    return stat;
  }

  /* v1.3.8-s1：开始时已由 desktopSyncRewards 同步积分状态（todayTasks）与
     任务定位索引；侧栏只用来枚举卡片与定位坐标，点哪张由主界面任务状态决定。
     把同步结果挂在 clickIndex 上透传，主进程不再要求索引非空。 */
  const clickState = await load(['taskClickIndex', 'todayTasks']);
  const clickIndex = Object.assign({}, (clickState && clickState.taskClickIndex) || {}, {
    sidebarFirst: true,
    taskSummary: (clickState && clickState.todayTasks) || null
  });

  const clickSettings = await getSettings();
  /* 设置项已反转为「不跳过已完成任务卡」：默认关闭 → 默认跳过已完成卡。
     下发给主进程的仍是内部指令 skipCompletedCards（是否跳过）。 */
  const notSkipCompletedCards = !!clickSettings.notSkipCompletedCards;
  const skipCompletedCards = !notSkipCompletedCards;
  let r = null;
  try {
    r = await Promise.race([
      panel.clickAll(clickIndex, { skipCompletedCards: skipCompletedCards, cardClickIntervalSec: clickSettings.cardClickIntervalSec }),
      sleep(Math.max(180000, ((Array.isArray(clickIndex.items) ? clickIndex.items.length : 8) + 10) *
        Math.min(60, Math.max(1, Number(clickSettings.cardClickIntervalSec) || 10)) * 1000 + 120000))
        .then(() => ({ ok: false, reason: 'timeout' }))
    ]);
  } catch (err) {
    stat.clickFailed = 1;
    stat.reason = String(err && err.message || err);
    console.warn('[AutoTask] CDP 任务鼠标点击失败：' + stat.reason);
    return stat;
  }
  if (!r || !r.ok) {
    stat.clickFailed = Number(r && r.failed) || 1;
    stat.reason = r && r.reason || 'cdp-task-click-failed';
    console.warn('[AutoTask] CDP 任务鼠标点击未完成：' + stat.reason
      + '；不执行 DOM 合成点击兜底');
    return stat;
  }

  for (const p of (r.pages || [])) {
    stat.pages.push({
      page: p.source === 'sidebar-flyout' ? 'sidebar'
        : /\/earn/.test(p.url || '') ? 'earn' : 'dashboard',
      clicked: Number(p.clicked) || 0,
      anchors: Number(p.found) || 0,
      doneSkipped: Number(p.skipped) || 0,
      failed: Number(p.failed) || 0,
      skipped: Number(p.skipped) || 0
    });
    stat.clicked += Number(p.clicked) || 0;
    stat.skipped += Number(p.skipped) || 0;
    stat.clickFailed += Number(p.failed) || 0;
  }
  /* 只有主进程实际完成 CDP mousePressed + mouseReleased 才计入 realMouse。 */
  stat.realMouse = Number(r.clicked) || stat.clicked;
  /* T06=D：主进程已按三态返回结果；这里只做汇总，不把「打开页面」计成完成。 */
  const st = r.states || {};
  stat.states = HSA_CORE.newClickResult();
  stat.states.clickSent = Number(st.clickSent != null ? st.clickSent : r.clicked) || stat.clicked;
  stat.states.pageOpened = Number(st.pageOpened != null ? st.pageOpened : r.opened) || 0;
  stat.states.officialConfirmed = Number(st.officialConfirmed) || 0;
  stat.states.unconfirmed = Number(st.unconfirmed != null ? st.unconfirmed : r.clickUnconfirmed) || 0;
  stat.states.failed = Number(st.failed != null ? st.failed : r.failed) || 0;
  stat.states.manualLinks = Array.isArray(r.manualLinks) ? r.manualLinks.slice(0, 20) : [];
  stat.states.triggerMethods = Array.isArray(r.triggerMethods) ? r.triggerMethods.slice(0, 64) : [];
  stat.clickSent = stat.states.clickSent;
  stat.pageOpened = stat.states.pageOpened;
  stat.officialConfirmed = stat.states.officialConfirmed;
  stat.unconfirmed = stat.states.unconfirmed;
  stat.manualLinks = stat.states.manualLinks;
  stat.triggerMethods = stat.states.triggerMethods;
  stat.clickUnconfirmed = Number(r.clickUnconfirmed) || 0;
  stat.real = stat.realMouse > 0;
  stat.skipped += Number(r.skipped) || 0;
  stat.openedTabs = Number(r.opened) || 0;
  stat.domClick = 0;
  stat.degraded = Number(st.pageInteractionClicks) || 0;
  console.info('[AutoTask] 结果三态：已发出点击 ' + stat.states.clickSent
    + ' / 已打开页面 ' + stat.states.pageOpened
    + ' / 官网确认 ' + stat.states.officialConfirmed
    + ' / 未确认 ' + stat.states.unconfirmed);
  return stat;
};

/* 桌面运行静默：保留 CDP 焦点模拟（页面自认为有焦点、不暂停），
   但不再 active 标签页 / focused 窗口 / Page.bringToFront —— 不把界面弹到前台。 */
ensureTabActive = async function (tabId) {
  await cdpEmulateFocus(tabId);
  return true;
};
keepSearchTabAwake = async function (tabId) {
  await cdpEmulateFocus(tabId);
};
cdpBringToFront = async function () { return false; };
restoreUserFocus = async function () { /* 桌面版不抢回系统焦点 */ };

/* v1.3.1：syncRewards 已并入上方主消息监听器（A7 分支），此处不再重复注册。
   独立监听器会被主监听器结尾的 sendResponse({ok:true}) 抢先应答而收不到消息。 */

/* ==========================================================================
 * v1.3.8 · 精简运行详情 + 积分历史（只追加包装与监听，不改任何核心函数体）
 *
 *  · 详情是单行双语文本，直接显示在 popup 原有的状态行（绿色字位置），
 *    不再新增文本框。文案只保留「做什么 / 在哪 / 下一步 / 多久」。
 *  · 延迟动作写 until（= at + delayMs），popup 把 {s} 替换为剩余秒数倒计时。
 *  · 每次同步把「今日积分」按本地日期写入 pointsHistory，供日历按日/周/月汇总。
 *  · 静默开关只由桌面主进程用于视图 bounds；后台业务链路完全不感知，
 *    因此静默模式与正常模式的同步、点击、搜索、详情写入完全一致。
 * ========================================================================== */
let desktopActivityLast = { key: '', at: 0 };
function desktopActivityFmt(n) {
  return Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '—';
}
function desktopActivityShort(u) {
  return String(u || '').replace(/^https?:\/\/(www\.|cn\.)?/, '')
    .replace('rewards.bing.com', 'Rewards').slice(0, 42);
}
async function desktopActivityWrite(info) {
  const o = info || {};
  const zh = Array.isArray(o.zh) ? o.zh.join(' · ') : String(o.zh || '');
  const en = Array.isArray(o.en) ? o.en.join(' · ') : String(o.en || '');
  const now = Date.now();
  const delayMs = Math.max(0, Math.round(Number(o.delayMs) || 0));
  const payload = {
    at: now, until: delayMs ? now + delayMs : 0,
    state: o.state || 'running', zh: zh, en: en,
    page: o.page || '', card: o.card || '', next: o.next || '',
    delayMs: delayMs, query: o.query || ''
  };
  const key = payload.state + '|' + delayMs + '|' + zh + '|' + en;
  if (key === desktopActivityLast.key && now - desktopActivityLast.at < 1000) {
    return Promise.resolve();
  }
  desktopActivityLast = { key: key, at: now };
  const patch = { activityDetail: payload };
  if (runLogEnabled) {
    try {
      const cur = await load(['runLog']);
      patch.runLog = HSA_CORE.runLogAppend(desktopTrimLog(cur && cur.runLog), {
        at: now, event: 'activity', level: payload.state === 'error' ? 'error' : 'info',
        state: payload.state, zh: payload.zh, en: payload.en,
        page: payload.page, card: payload.card, next: payload.next,
        query: payload.query, delayMs: delayMs
      }, now);
    } catch (err) {}
  }
  try { await store(patch); } catch (err) {}
}
function desktopActivityDayKey(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0')
    + '-' + String(x.getDate()).padStart(2, '0');
}
async function desktopActivityRecordHistory(sync) {
  try {
    const snap = await load(['pointsHistory', 'pointsSummary']);
    const hist = (snap && snap.pointsHistory && typeof snap.pointsHistory === 'object')
      ? Object.assign({}, snap.pointsHistory) : {};
    const ps = (sync && sync.pointsSummary) || (snap && snap.pointsSummary) || {};
    const key = desktopActivityDayKey();
    const prev = hist[key] || {};
    const today = Number.isFinite(ps.today)
      ? Math.max(Number(prev.today) || 0, Number(ps.today))
      : (Number(prev.today) || 0);
    const available = Number.isFinite(ps.available) ? ps.available : (Number(prev.available) || 0);
    const claimable = Number.isFinite(ps.claimable) ? ps.claimable : (Number(prev.claimable) || 0);
    if (prev.today === today && prev.available === available && prev.claimable === claimable) return;
    hist[key] = { today: today, available: available, claimable: claimable, at: Date.now() };
    const keys = Object.keys(hist).sort();
    while (keys.length > 400) delete hist[keys.shift()];
    await store({ pointsHistory: hist });
  } catch {}
}
function desktopActivityTaskNames(items, limit) {
  const out = [];
  for (const it of (items || [])) {
    const n = String((it && it.name) || '').trim().slice(0, 28);
    if (n && out.indexOf(n) < 0) out.push(n);
    if (out.length >= (limit || 2)) break;
  }
  return out.join('、');
}

/* ① 同步：正在同步 → 同步完成（绿色字），并落下当日积分历史 */
const desktopActivityOrigSync = desktopSyncRewards;
desktopSyncRewards = async function (opts) {
  await desktopActivityWrite({
    state: 'syncing', page: '/dashboard, /earn',
    zh: '正在同步 · /dashboard + /earn 读取积分',
    en: 'Syncing · reading /dashboard + /earn'
  });
  const r = await desktopActivityOrigSync(opts);
  await desktopActivityRecordHistory(r);
  const ps = (r && r.pointsSummary) || {};
  await desktopActivityWrite({
    state: (r && r.ok) ? 'synced' : 'syncFailed', page: '/dashboard, /earn',
    zh: (r && r.ok)
      ? '同步完成 · 今日 ' + desktopActivityFmt(ps.today) + ' 分 / 可用 ' + desktopActivityFmt(ps.available) + ' 分'
      : '同步未完成 · 保留上次积分数据',
    en: (r && r.ok)
      ? 'Synced · today ' + desktopActivityFmt(ps.today) + ' / ' + desktopActivityFmt(ps.available) + ' pts available'
      : 'Sync incomplete · kept last points'
  });
  return r;
};

/* ② 自动执行任务：开始 / 结束，文案精简为一行 */
const desktopActivityOrigAuto = runAutoComplete;
runAutoComplete = async function (opts) {
  await desktopActivityWrite({
    state: 'autoStart',
    zh: '开始自动任务 · 同步积分 → 侧栏点击卡片 → 补全搜索',
    en: 'Auto-start · sync points → sidebar cards → searches'
  });
  const r = await desktopActivityOrigAuto(opts);
  const skipped = !!(r && (r.skipped === true || r.reason === 'allDone'));
  await desktopActivityWrite({
    state: skipped ? 'allDone' : 'done',
    zh: skipped ? '全部完成 · 今日任务已做满，无需额外动作'
      : '任务完成 · 点击 ' + desktopActivityFmt(r && r.clicked) + ' 张卡片 / 搜索 '
        + desktopActivityFmt(r && r.searches) + ' 次',
    en: skipped ? 'All done · daily tasks are complete'
      : 'Done · ' + desktopActivityFmt(r && r.clicked) + ' cards / '
        + desktopActivityFmt(r && r.searches) + ' searches'
  });
  return r;
};

/* ③ 任务卡片：点哪张、下一步 */
const desktopActivityOrigCards = completePendingTaskCards;
completePendingTaskCards = async function (level, token) {
  const snap = await load(['taskClickIndex']).catch(() => ({}));
  const idxItems = (snap && snap.taskClickIndex && snap.taskClickIndex.items) || [];
  /* 严格按任务列表顺序：不截断成前两张，逐项记下顺序供运行日志核对。 */
  const ordered = HSA_CORE.taskListNames(HSA_CORE.taskListOrder(idxItems));
  const names = ordered.join('、');
  const listDetail = ordered.map((n, i) => (i + 1) + '.' + n).join(' → ') || '(空)';
  await desktopActivityWrite({
    state: 'clicking', page: '/dashboard, /earn', card: names,
    zh: '任务列表 ' + ordered.length + ' 张（按顺序）：' + (names || '/dashboard + /earn') + ' · 依次打开确认',
    en: 'Task list ' + ordered.length + ' (in order): ' + (names || '/dashboard + /earn') + ' · open in order'
  });
  hsaRunLog('task-list', {
    actor: 'system', category: 'run-step', level: 'info', state: 'clicking',
    zh: '任务列表顺序 ' + ordered.length + ' 张', en: 'Task list order: ' + ordered.length + ' cards',
    detail: listDetail, count: ordered.length, order: 0
  }).catch(() => {});
  const r = await desktopActivityOrigCards(level, token);
  const clicked = Number(r && r.clicked) || 0;
  const skippedNote = clicked === 0 ? '（无可执行卡片：已全部完成或侧栏不可用）' : '';
  const skippedNoteEn = clicked === 0 ? ' (nothing to click: all done or panel unavailable)' : '';
  await desktopActivityWrite({
    state: 'clicking', card: names,
    zh: '已按列表顺序点击 ' + desktopActivityFmt(clicked) + '/' + ordered.length
      + ' 张卡片' + skippedNote + ' · 下一步：按剩余分数搜索',
    en: 'Clicked ' + desktopActivityFmt(clicked) + '/' + ordered.length
      + ' cards in list order' + skippedNoteEn + ' · Next: search'
  });
  hsaRunLog('task-list-result', {
    actor: 'system', category: 'result', level: clicked ? 'info' : 'warn',
    state: 'done', result: clicked > 0 ? 'ok' : 'skipped',
    zh: '任务卡执行结果 ' + clicked + '/' + ordered.length,
    en: 'Task card result ' + clicked + '/' + ordered.length,
    detail: listDetail, count: clicked, order: 0,
    error: clicked === 0 ? skippedNote : ''
  }).catch(() => {});
  return r;
};

/* ④ 打开页面：只写简短页面名 */
const desktopActivityOrigOpen = openOrNavigate;
openOrNavigate = async function (key, url, active) {
  await desktopActivityWrite({
    state: 'opening', page: String(url || ''),
    zh: '打开页面 · ' + desktopActivityShort(url) + ' · 等待任务卡渲染',
    en: 'Opening · ' + desktopActivityShort(url) + ' · waiting for cards'
  });
  return desktopActivityOrigOpen(key, url, active);
};

/* ⑤ 延迟动作：{s} 由 popup 替换为剩余秒数倒计时，到点自动停 */
const desktopActivityOrigNap = nap;
nap = async function (ms, token) {
  const wait = Math.max(0, Math.round(Number(ms) || 0));
  if (wait >= 800) {
    await desktopActivityWrite({
      state: 'waiting', delayMs: wait, next: '继续下一步',
      zh: '{s} 秒后继续 · 下一步：核对积分',
      en: 'Continuing in {s}s · Next: check points'
    });
  }
  return desktopActivityOrigNap(ms, token);
};

/* ⑥ 搜索信息 / 收尾：订阅已有业务键，不改动搜索循环本身 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes) return;
  const cq = changes.currentQuery;
  if (cq && typeof cq.newValue === 'string' && cq.newValue.trim()) {
    const q = cq.newValue.trim();
    load(['currentSearch', 'totalSearch', 'phase']).then(s => {
      const cur = Number(s && s.currentSearch) || 0;
      const total = Number(s && s.totalSearch) || 0;
      return desktopActivityWrite({
        state: 'searching', query: q, page: 'Bing /search',
        zh: '搜索 ' + (cur || 1) + '/' + (total || '?') + ' · 关键词「' + q + '」· 之后核对积分',
        en: 'Search ' + (cur || 1) + '/' + (total || '?') + ' · "' + q + '" · then check points'
      });
    }).catch(() => {});
  }
  const ph = changes.phase;
  if (ph && ph.newValue === 'completed') {
    desktopActivityWrite({
      state: 'synced',
      zh: '同步完成 · 积分与任务状态已刷新',
      en: 'Synced · points and tasks refreshed'
    }).catch(() => {});
  }
});
