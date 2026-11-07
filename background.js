const DASHBOARD_URL = 'https://rewards.bing.com/';
const EARN_URL = 'https://rewards.bing.com/earn';
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
const COOLDOWN_STALL = 3;
const MAX_COOLDOWNS = 6;

/* 后台错误文案也跟随界面语言（uiLang 由弹窗写入 storage.local） */
var bgLang = 'zh';
const BG_TEXT = {
  zh: {
    signIn: '请先在浏览器中登录 Microsoft Rewards（rewards.bing.com），然后重新开始。',
    topics: '所有热搜源均不可用，请检查网络后重试（不使用本地词库）。',
    network: 'Bing 没有响应，请检查网络连接。',
    stale: '上次运行被中断（浏览器关闭或电脑休眠），请重新点击开始。',
    runStopped: m => '运行已中止：' + m,
    startFailed: m => '启动失败：' + m
  },
  en: {
    signIn: 'Sign in to Microsoft Rewards (rewards.bing.com) in this browser, then press Start again.',
    topics: 'All trending sources are unavailable. Check your connection (no local word list).',
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
const store = obj => chrome.storage.local.set(obj);
const load = keys => chrome.storage.local.get(keys);
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
const SOURCE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const SOURCE_TIMEOUT = 8000;
const USE_REAL_INPUT = true;          // 关掉即全程使用页面内合成事件
const GO_HOME_RATE = 0.38;
const RELATED_RATE = 0.42;
const ENTER_RATE = 0.5;
const CLICK_RESULT_RATE = 0.35;
const STOP = Symbol('stopped');

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
  // JS 的 \W 不认 Unicode，中文不能照搬 \w 写法
  return s.length >= 2 && s.length <= 30 && /[a-zA-Z0-9\u3400-\u9fff]/.test(s);
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
      { headers: { 'User-Agent': SOURCE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return textOf(await r.text(), [
      /<a[^>]+class="[^"]*title[^"]*"[^>]*>([^<]{2,60})<\/a>/g,
      /"text"\s*:\s*"([^"\\]{2,60})"/g
    ]);
  },
  baidu: async () => {
    const r = await fetchSource('https://top.baidu.com/board?tab=realtime',
      { headers: { 'User-Agent': SOURCE_UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return textOf(await r.text(), [
      /"query"\s*:\s*"([^"\\]{2,60})"/g,
      /class="c-single-text-ellipsis"[^>]*>([^<]{2,60})</g
    ]);
  },
  weibo: async () => {
    const r = await fetchSource('https://weibo.com/ajax/side/hotSearch',
      { headers: { 'User-Agent': SOURCE_UA, Referer: 'https://weibo.com/' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return ((data && data.data && data.data.realtime) || [])
      .map(it => cleanKeyword((it && (it.word || it.note)) || ''));
  },
  toutiao: async () => {
    const r = await fetchSource('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
      { headers: { 'User-Agent': SOURCE_UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return ((data && data.data) || []).map(it => cleanKeyword((it && (it.Title || it.title)) || ''));
  },
  zhihu: async () => {
    const r = await fetchSource('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true',
      { headers: { 'User-Agent': SOURCE_UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return ((data && data.data) || []).map(it => cleanKeyword(
      (it && ((it.target && it.target.title) || it.title)) || ''
    ));
  },
  sina: async () => {
    const r = await fetchSource('https://rss.sina.com.cn/news/marquee/ddt.xml',
      { headers: { 'User-Agent': SOURCE_UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return [...String(await r.text()).matchAll(/<title>(?:<!\[CDATA\[)?([^<\]]{2,80})/g)]
      .map(m => cleanKeyword(m[1]));
  }
};

/** 随机挑 2~4 个热搜源抓取，合并去重后洗牌。 */
async function getKeywordPool(limit) {
  const chosen = shuffle(HOT_SOURCES).slice(0, 2 + Math.floor(Math.random() * 3));
  const collected = [];
  const errors = [];
  for (const name of chosen) {
    try {
      const list = await HOT_SOURCE_FNS[name]();
      for (const text of list) if (validKeyword(text)) collected.push({ text, source: name });
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
    items: shuffle(unique).slice(0, Math.max(1, limit)),
    sources: chosen,
    errors
  };
}

/** 接口与原版一致：返回 { queries, usedWords, trendCount } */
async function buildQueries(count, usedList) {
  const used = new Set((usedList || []).map(String));
  const pool = await getKeywordPool(Math.max(24, count * 3));
  if (!pool.items.length) {
    throw new Error(bgMsg('topics') + ' (' + pool.errors.join(' / ').slice(0, 180) + ')');
  }
  const fresh = pool.items.filter(k => !used.has(k.text));
  const words = fresh.length ? fresh : pool.items.slice();
  const queries = [];
  for (let i = 0; i < count; i++) {
    const w = words[(i * 7 + 1) % words.length];
    queries.push(String(w.text).trim().slice(0, 30));
  }
  console.info('[HumanSearch] 热搜源 ' + pool.sources.join('+') + ' · 词池 ' + pool.items.length + ' 条');
  return {
    queries,
    usedWords: [...used, ...queries].slice(-1000),
    trendCount: pool.items.length
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
  let stalled = 0;
  let lastProgress = null;
  {
    const { todaySearch } = await load(['todaySearch']);
    if (todaySearch && typeof todaySearch.progress === 'number') lastProgress = todaySearch.progress;
  }

  let tabId = null;
  let realInput = false;
  let lastQuery = '';
  let lastXY = [120, 140];
  const modeCount = { paste: 0, related: 0, home: 0, stay: 0 };
  const runLevel = clampInt((await load(['runLevel'])).runLevel || 3, 1, 3);
  const profile = profileOf(runLevel);
  console.info('[HumanSearch] 拟人强度：' + runLevel);

  try {
    tabId = await openOrNavigate('searchTabId', HOME_URL);
    bail(token);
    await waitForTab(tabId, isBingHome, PAGE_TIMEOUT, true);
    bail(token);
    realInput = await cdpAttach(tabId);
    console.info('[HumanSearch] 输入方式：' + (realInput ? 'CDP 真实键鼠' : '页面内合成事件'));
  } catch (err) {
    if (err === STOP) throw err;
    tabId = await openOrNavigate('searchTabId', HOME_URL);
    realInput = false;
  }

  while (isCurrent(token) && !haltFlag) {
    const st = await load(['currentSearch', 'totalSearch', 'searchQueue', 'stopRequested']);
    const current = st.currentSearch || 0;
    if (st.stopRequested || current >= st.totalSearch) return;
    const baseQuery = st.searchQueue && st.searchQueue[current];
    if (!baseQuery) return;

    const settings = await getSettings();
    const [holdMin, holdMax] = holdRange(settings);
    const roundTotal = rand(holdMin, holdMax) * profile.round;
    const roundStart = Date.now();
    const goHome = Math.random() < GO_HOME_RATE;
    const useRelated = Math.random() < RELATED_RATE;
    let keyword = baseQuery;
    let method = '';
    let searched = false;

    try {
      if (useRelated) {
        /* 直接改词：关键词必须来自相关延伸搜索，不碰搜索框 */
        let related = await relatedSearches(tabId);
        bail(token);
        if (!related.length) related = await suggestRelated(lastQuery || baseQuery);
        bail(token);
        if (related.length) {
          keyword = String(pickOne(related)).trim().slice(0, 30);
          method = '改词·相关延伸';
        } else {
          keyword = baseQuery;
          method = '改词·热搜回退';
        }
        if (goHome) await navigateSearch(tabId, HOME_URL, isBingHome, token);
        await navigateSearch(tabId, directSearchUrl(keyword), isBingSearch, token);
        const afterDirect = await chrome.tabs.get(tabId).catch(() => null);
        searched = !!afterDirect && isBingSearch(afterDirect.url);
        modeCount.related++;
      } else {
        /* 粘贴关键词：先清空搜索框，再输入，避免词越拼越长 */
        method = '粘贴关键词';
        if (goHome) await navigateSearch(tabId, HOME_URL, isBingHome, token);
        let box = await probe(tabId, SEARCH_INPUTS);
        bail(token);
        if (!box) {
          await navigateSearch(tabId, HOME_URL, isBingHome, token);
          box = await probe(tabId, SEARCH_INPUTS);
          bail(token);
        }
        if (!box) throw new Error('找不到 Bing 搜索框');

        const plan = humanClickPlan(box.box, lastXY, runLevel);
        lastXY = plan.center;
        if (realInput) await cdpClickPlan(tabId, plan);
        else await domClick(tabId, plan.center[0], plan.center[1]);
        await nap(rand(150, 600), token);

        // 关键一步：粘贴前清空
        if (realInput) await cdpClearInput(tabId);
        else await domClearInput(tabId);
        await nap(rand(100, 350), token);

        if (realInput) await cdpInsertText(tabId, keyword);
        else await domInput(tabId, keyword);
        await nap(rand(150, 500), token);

        if (Math.random() < ENTER_RATE) {
          if (realInput) await cdpKey(tabId, 'Enter');
          else await domKey(tabId, 'Enter');
        } else {
          const btn = await probe(tabId, SEARCH_BUTTONS);
          bail(token);
          if (btn && realInput) {
            await cdpClickAt(tabId, btn.box.x + btn.box.w / 2, btn.box.y + btn.box.h / 2);
          } else if (realInput) {
            await cdpKey(tabId, 'Enter');
          } else {
            await domKey(tabId, 'Enter');
          }
        }
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

      if (goHome) modeCount.home++; else modeCount.stay++;
      lastQuery = keyword;
      await store({ currentQuery: keyword });
      console.info(`[HumanSearch] [${current + 1}/${st.totalSearch}] ${keyword} · ${method}`
        + (goHome ? ' · 回首页' : ' · 留在结果页'));
      bail(token);
    } catch (err) {
      if (err === STOP || haltFlag) throw STOP;
      console.warn('[HumanSearch] 本轮异常：', err && err.message ? err.message : String(err));
    }

    if (!isCurrent(token) || haltFlag) return;

    if (!searched) {
      failures++;
      if (failures >= MAX_FAILURES) throw new Error(bgMsg('network'));
      await nap(rand(1000, 2000), token);
      continue;
    }
    failures = 0;

    /* 公共拟人动作：等结果 → 滚动 → 按概率点结果并返回 */
    try {
      await nap(rand(800, 2500), token);
      const hit = await probe(tabId, RESULT_LINKS);
      bail(token);
      const hasResults = !!hit;
      for (const step of scrollPlan(runLevel)) {
        bail(token);
        if (realInput) await cdpWheel(tabId, step.dy);
        else await domWheel(tabId, step.dy);
        await nap(step.dt * 1000, token);
      }
      if (Math.random() < CLICK_RESULT_RATE && hasResults) {
        const link = await probe(tabId, RESULT_LINKS);
        bail(token);
        if (link) {
          const cx = link.box.x + link.box.w * 0.3;
          const cy = link.box.y + link.box.h * 0.5;
          if (realInput) await cdpClickAt(tabId, cx, cy);
          else await domClick(tabId, cx, cy);
          await nap(rand(1000, 4000), token);
          await goBackSearch(tabId, token);
        }
      }
      const left = roundTotal - (Date.now() - roundStart);
      if (left > 800) await nap(left * 0.6, token);
    } catch (err) {
      if (err === STOP || haltFlag) throw STOP;
    }

    if (!isCurrent(token) || haltFlag) return;
    await store({ currentSearch: current + 1, lastActivity: Date.now() });

    /* 原版积分 / 每日上限 / 冷却检测，保持不变 */
    if ((await load(['liveCheck'])).liveCheck) {
      const { today, activities } = await directToday();
      if (!isCurrent(token)) return;
      if (activities) await store({ todayActivities: activities });
      if (today) {
        await store({ todaySearch: today });
        if (today.progress >= today.max && settings.autoStop) {
          await store({ stoppedEarly: true });
          return;
        }
        const noGain = lastProgress !== null && today.progress <= lastProgress && today.progress < today.max;
        stalled = noGain ? stalled + 1 : 0;
        lastProgress = today.progress;
        if (settings.cooldownAware && stalled >= COOLDOWN_STALL) {
          await enterCooldown(settings);
          return;
        }
      }
    }

    if (current + 1 < st.totalSearch && !haltFlag) {
      await nap(rand(3000, 12000), token);   // 轮间 3~12 秒
    }
  }

  console.info('[HumanSearch] 方式混合：粘贴 ' + modeCount.paste + ' / 改词 ' + modeCount.related
    + ' · 回首页 ' + modeCount.home + ' / 留在结果页 ' + modeCount.stay);
}

/* 提醒预览用的主题词也改走真实热搜池（失败时不编词，退回 Bing 首页）。 */
async function previewTopic() {
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

async function closeTab(key) {
  const data = await load([key]);
  if (data[key] != null) {
    try { await chrome.tabs.remove(data[key]); } catch {}
  }
  await store({ [key]: null });
}

let lastInjectError = null;

async function inject(tabId, func, args) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
    lastInjectError = null;
    return res ? res.result : null;
  } catch (err) {
    lastInjectError = err && err.message ? err.message : String(err);
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

async function openOrNavigate(key, url) {
  const existing = await getTab(key);
  if (existing) {
    await chrome.tabs.update(existing.id, { url });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url, active: false });
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

async function fetchRewardsPage(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DIRECT_TIMEOUT);
  try {
    const res = await fetch('https://rewards.bing.com' + path, {
      credentials: 'include',
      cache: 'no-store',
      signal: ctrl.signal
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, html };
  } catch (err) {
    return { ok: false, status: 0, url: null, html: '', error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
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
  cooldownAware: true,
  cooldownMinutes: 15
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

async function refreshToday() {
  const { running } = await load(['running']);
  if (running) return;
  const { today, activities } = await directToday();
  const update = { todayCheckedAt: Date.now() };
  if (today) update.todaySearch = today;
  if (activities) update.todayActivities = activities;
  await store(update);
  // 任务 + 三项积分一起刷新；不阻塞积分主流程
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
      await searchLoop(token);
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
}

async function enterCooldown(settings) {
  const { cooldownCycles } = await load(['cooldownCycles']);
  const cycles = (cooldownCycles || 0) + 1;
  if (cycles > MAX_COOLDOWNS) {
    await store({ cooldownGaveUp: true });
    return false;
  }
  const waitMs = Math.max(5, Number(settings.cooldownMinutes) || 15) * 60 * 1000;
  const until = Date.now() + waitMs;
  await store({ phase: 'cooldown', cooldownUntil: until, cooldownWaitMs: waitMs, cooldownCycles: cycles, currentQuery: null });
  chrome.alarms.create('cooldownEnd', { when: until });
  return true;
}

async function endCooldown() {
  const st = await load(['running', 'phase']);
  if (!st.running || st.phase !== 'cooldown') return;
  chrome.alarms.clear('cooldownEnd');
  await store({ phase: 'searching', cooldownUntil: null });
  chrome.alarms.create('watchdog', { periodInMinutes: 0.5 });
  if (!flowActive) runFlow(++flowToken);
}


function estimateEarned(searches, todayStart) {
  const est = searches * POINTS_PER_SEARCH;
  return todayStart ? Math.min(est, Math.max(0, todayStart.max - todayStart.progress)) : est;
}

async function finishRun(token) {
  await cdpDetachAll();
  await closeTab('searchTabId');
  const st = await load(['startPoints', 'startKnown', 'currentSearch', 'totalSearch', 'todaySearch', 'todayStart']);
  const searches = st.currentSearch || 0;
  const start = st.startPoints || 0;

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
}

async function finishWithError(message) {
  await cdpDetachAll();
  await store({ phase: 'error', running: false, stopRequested: false, error: message });
  chrome.alarms.clear('watchdog');
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
      runAutoTime: params.time || null
    });
    chrome.alarms.create('watchdog', { periodInMinutes: 0.5 });
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
    chrome.alarms.create('watchdog', { periodInMinutes: 0.5 });
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
  chrome.alarms.get('reminderTick', alarm => {
    if (!alarm) chrome.alarms.create('reminderTick', { periodInMinutes: REMINDER_TICK_MINUTES });
  });
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
  } else if (msg.type === 'refreshTasks') {
    // 立即响应，结果通过 storage.onChanged 送达弹窗；注入兜底可能较慢，不让按钮一直禁用
    refreshTodayTasks(flowToken).catch(() => {});
  } else if (msg.type === 'refreshPoints') {
    refreshPointsOnly().catch(() => {});
  } else if (msg.type === 'refreshToday') {
    refreshToday();
  }
  sendResponse({ ok: true });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'watchdog') resumeIfNeeded();
  else if (alarm.name === 'cleanUsedWords') store({ usedWords: [] });
  else if (alarm.name === 'reminderTick') armReminder();
  else if (alarm.name === 'cooldownEnd') endCooldown();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('cleanUsedWords', { periodInMinutes: 1440 });
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
function rebuildAutoAlarm() {
  chrome.alarms.create('autoTaskTick', { periodInMinutes: 1 });
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

async function fetchBothPages() {
  const [dash, earn] = await Promise.all([
    fetchRewardsPage('/dashboard'),
    fetchRewardsPage('/earn')
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

/** 注入到 Rewards 页面执行的兜底读取器（按真实 class 读带积分徽章的卡片）。 */
function readTaskCardsFromDom() {
  const clean = el => (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  const out = [];
  const seen = new Set();
  for (const badge of document.querySelectorAll('[class*="bg-statusSuccessRewardsBg"]')) {
    const p = badge.querySelector('p');
    const m = /^\s*(\d{1,4})\s*$/.exec(p ? clean(p) : clean(badge));
    if (!m) continue;
    const points = parseInt(m[1], 10);
    if (!(points > 0)) continue;
    const card = badge.closest('a[href], [class*="rounded-cornerCardDefault"], [role="listitem"]');
    if (!card || seen.has(card)) continue;
    seen.add(card);
    const text = clean(card);
    if (/已完成|已领取|Completed|Claimed/i.test(text)) { /* 仍收，状态由字段表达 */ }
    const titleEl = card.querySelector('[class*="text-globalBody2Strong"], h3, h4');
    const descEl = card.querySelector('[class*="text-fgCtrlNeutralSecondaryRest"]');
    const name = clean(titleEl) || clean(card.querySelector('img') && card.querySelector('img').alt);
    if (!name) continue;
    let section = 'promo';
    let near = '';
    for (const h of document.querySelectorAll('h2')) {
      if (h.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) near = clean(h);
      else break;
    }
    if (/每日活动|Daily activities|Daily set/i.test(near)) section = 'daily';
    else if (/日常任务|每日任务|Daily tasks|More activities/i.test(near)) section = 'promo';
    else continue;                          // 其它版块一律不收
    const link = card.matches('a[href]') ? card : card.querySelector('a[href]');
    out.push({
      name, description: clean(descEl), section, points,
      earned: /已完成|已领取|Completed|Claimed/i.test(text) ? points : 0,
      completed: /已完成|已领取|Completed|Claimed/i.test(text),
      url: link && /^https?:\/\//i.test(link.href) ? link.href : '',
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
    percent: total ? Math.round((earned / total) * 100) : 0,
    updatedAt: Date.now()
  }, extra || {});
}

/** 一次刷新：任务列表（第一条搜索）+ 首页三项积分，共用两个页面抓取结果。 */
async function refreshTodayTasks(token) {
  const pages = await fetchBothPages();

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

  if (!items.length && pages.reachable) {
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

/** 搜索次数由今日 Bing 搜索剩余分数自动决定，不超过设置页上限。 */
async function autoSearchCount(cap) {
  const { todaySearch, todayTasks } = await load(['todaySearch', 'todayTasks']);
  const item = todayTasks && Array.isArray(todayTasks.items)
    ? todayTasks.items.find(i => i.section === 'search') : null;
  const max = Number(item && item.points) || Number(todaySearch && todaySearch.max) || 60;
  const got = Number.isFinite(item && item.earned) ? item.earned
    : (Number(todaySearch && todaySearch.progress) || 0);
  const need = Math.ceil(Math.max(0, max - got) / POINTS_PER_SEARCH);
  const limit = Number(cap) || (await getAutoTasks()).count;
  return Math.max(0, Math.min(need, limit));
}

/**
 * 注入执行：找出第一张「未完成且有积分」的任务卡片，滚动到视口中央并返回坐标。
 * 已完成（已完成 / 已领取）的卡片直接跳过；exclude 用来避免重复点击同一张。
 */
function focusPendingCard(exclude) {
  const skip = new Set(Array.isArray(exclude) ? exclude : []);
  const clean = el => (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  // 只点「每日活动 / 日常任务」版块的卡片，不碰升级活动、月度 punchcard、连续打卡等
  const sectionOf = card => {
    let near = '';
    for (const h of document.querySelectorAll('h2')) {
      if (h.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) near = clean(h);
      else break;
    }
    if (/每日活动|Daily activities|Daily set/i.test(near)) return 'daily';
    if (/日常任务|每日任务|Daily tasks|More activities/i.test(near)) return 'promo';
    return 'other';
  };
  let scanned = 0;
  for (const badge of document.querySelectorAll('[class*="bg-statusSuccessRewardsBg"]')) {
    const p = badge.querySelector('p');
    const m = /^\s*(\d{1,4})\s*$/.exec(p ? clean(p) : clean(badge));
    if (!m) continue;
    const points = parseInt(m[1], 10);
    if (!(points > 0)) continue;
    const card = badge.closest('a[href], [class*="rounded-cornerCardDefault"], [role="listitem"]');
    if (!card) continue;
    scanned++;
    const text = clean(card);
    if (/可用积分|今日积分|可领取/.test(text)) continue;
    if (/已完成|已领取|Completed|Claimed/i.test(text)) continue;   // 已完成 → 跳过
    if (sectionOf(card) === 'other') continue;                      // 非今日任务版块 → 跳过
    const titleEl = card.querySelector('[class*="text-globalBody2Strong"], h3, h4');
    const name = clean(titleEl) || clean(card.querySelector('img') && card.querySelector('img').alt);
    if (!name || skip.has(name + '|' + points)) continue;
    try { card.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
    const r = card.getBoundingClientRect();
    return {
      ok: true, name, points,
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      w: r.width, h: r.height, scanned
    };
  }
  return { ok: false, scanned };
}

async function tabIds() {
  try {
    const list = await chrome.tabs.query({});
    return Array.isArray(list) ? list.map(t => t.id) : null;
  } catch { return null; }
}

/** 在一个 Rewards 页面里逐张点击未完成卡片；已完成 / 非今日任务版块的跳过。 */
async function clickCardsOnPage(url, level, token, done, stat) {
  let tabId = null;
  try {
    tabId = await openOrNavigate('taskClickTabId', url);
    const real = await cdpAttach(tabId).catch(() => false);
    stat.real = stat.real || real;
    let emptyRounds = 0;

    for (let pass = 0; pass < 12 && isCurrent(token); pass++) {
      const found = await inject(tabId, focusPendingCard, [Array.from(done)]);
      if (!found || !found.ok) {
        stat.skipped += Number(found && found.scanned) || 0;
        emptyRounds++;
        if (emptyRounds >= 2) break;        // 页面已加载且没有待完成卡片
        await sleep(900);
        continue;
      }
      emptyRounds = 0;
      const before = await tabIds();
      const box = {
        x: found.x - found.w / 2, y: found.y - found.h / 2,
        w: found.w, h: found.h
      };
      const plan = humanClickPlan(box, [120 + rand(-40, 40), 140 + rand(-40, 40)], level);
      if (real) await cdpClickPlan(tabId, plan);
      else await domClick(tabId, plan.center[0], plan.center[1]);
      stat.clicked++;
      done.add(found.name + '|' + found.points);
      await sleep(rand(900, 1800));

      // 关闭点击后弹出的新标签页，保留 Rewards 页面本身
      if (before) {
        const after = await tabIds();
        for (const id of after || []) {
          if (!before.includes(id) && id !== tabId) {
            try { await chrome.tabs.remove(id); } catch {}
          }
        }
      }
    }
  } catch (err) {
    stat.error = (err && err.message) || String(err);
  } finally {
    if (tabId != null) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
      cdpAttached.delete(Number(tabId));
      try { await chrome.tabs.remove(tabId); } catch {}
      try { await store({ taskClickTabId: null }); } catch {}
    }
  }
}

/** dashboard 与 earn 两页都扫一遍，覆盖「每日活动」和「日常任务」的卡片。 */
async function completePendingTaskCards(level, token) {
  const done = new Set();
  const stat = { clicked: 0, skipped: 0, real: false };
  for (const url of [DASHBOARD_URL, EARN_URL]) {
    if (!isCurrent(token)) break;
    await clickCardsOnPage(url, level, token, done, stat);
  }
  return stat;
}

var autoCompleteActive = false;

/**
 * 一次完整的自动完成任务：
 *   刷新任务 → 点击未完成卡片（已完成跳过）→ 按剩余搜索分数自动决定次数跑拟人搜索 → 刷新
 * 定时触发与首页按钮都走这里；与正式运行互斥，点「停止」可中断。
 */
async function runAutoComplete(opts) {
  const o = opts || {};
  const st = await load(['running', 'todayTasks', 'todaySearch']);
  // 今日任务已全部完成：不刷新、不打开页面、不点卡片、不搜索、不改状态
  const tt = st.todayTasks;
  const allDone = tt && Array.isArray(tt.items) && tt.items.length > 0
    && Number(tt.percent) >= 100
    && tt.items.every(i => !!i.completed || Number(i.earned) >= Number(i.points));
  if (allDone && !o.force) {
    console.info('[AutoTask] 今日任务已完成（100%），本次不执行任何操作');
    return { ok: true, skipped: true, reason: 'allDone', clicked: 0, searches: 0 };
  }
  if (autoCompleteActive || flowActive || st.running) return { ok: false, reason: 'running' };
  autoCompleteActive = true;
  const token = ++flowToken;
  try {
    const tasks = await getAutoTasks();
    const level = clampInt(Number(o.level) || tasks.level, 1, 3);
    await store({
      running: true, phase: 'completingTasks', stopRequested: false,
      error: null, warning: null, runLevel: level, lastActivity: Date.now(),
      runAuto: !o.manual, runAutoTime: o.time || null
    });
    await refreshTodayTasks(token).catch(() => {});
    const clickRes = await completePendingTaskCards(level, token);
    const searches = isCurrent(token) ? await autoSearchCount(o.cap) : 0;

    if (searches > 0 && isCurrent(token)) {
      await handleStart(searches, {
        level, auto: !o.manual, time: o.time || null,
        source: o.manual ? 'manual' : 'schedule'
      });
    } else {
      await store({ running: false, phase: 'completed', stopRequested: false, lastActivity: Date.now() });
    }
    // handleStart 会推进 flowToken，收尾刷新不复用旧 token
    await refreshTodayTasks().catch(() => {});
    await closeTab('rewardsTabId').catch(() => {});
    console.info('[AutoTask] 自动完成：点击 ' + clickRes.clicked + ' 张卡片，搜索 ' + searches + ' 次');
    return { ok: true, clicked: clickRes.clicked, skipped: clickRes.skipped, searches, level };
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

    const plan = humanClickPlan(box.box, [120, 140], level);
    if (realInput) {
      await cdpClickPlan(tabId, plan);
      await sleep(rand(150, 500));
      await cdpClearInput(tabId);
      await sleep(rand(80, 250));
      await cdpInsertText(tabId, keyword);
      await sleep(rand(150, 450));
      await cdpKey(tabId, 'Enter');
    } else {
      await domClick(tabId, plan.center[0], plan.center[1]);
      await sleep(200);
      await domClearInput(tabId);
      await domInput(tabId, keyword);
      await sleep(300);
      await domKey(tabId, 'Enter');
    }

    let result = await waitForTab(tabId, isBingSearch, 10000, true);
    if (!result || !isBingSearch(result.url)) {
      await chrome.tabs.update(tabId, { url: directSearchUrl(keyword) });
      result = await waitForTab(tabId, isBingSearch, PAGE_TIMEOUT, false);
    }
    if (!result || !isBingSearch(result.url)) throw new Error(bgMsg('network'));

    for (const step of scrollPlan(level).slice(0, 2)) {
      if (realInput) await cdpWheel(tabId, step.dy);
      else await domWheel(tabId, step.dy);
      await sleep(Math.min(900, step.dt * 350));
    }
    await sleep(600);

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
    // 测试期间因刷新任务可能打开的 Rewards / 任务点击后台页一并关闭
    await closeTab('rewardsTabId').catch(() => {});
    await closeTab('taskClickTabId').catch(() => {});
    haltFlag = savedHalt;
  }
}
