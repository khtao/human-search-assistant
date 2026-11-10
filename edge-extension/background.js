/* 共享核心：插件版与桌面版共用的决策与纯逻辑（单一真源见 shared/） */
importScripts('shared/hsa-core.js');
const HSA_CORE = globalThis.HSA_CORE;

const DASHBOARD_URL = 'https://rewards.bing.com/dashboard';
const EARN_URL = 'https://rewards.bing.com/earn';
const HOME_URL = 'https://www.bing.com/?mkt=zh-CN';
const POINTS_PER_SEARCH = 3;
const RESULT_HOLD_MIN = 16000;   
const RESULT_HOLD_MAX = 29000;   
const PAGE_TIMEOUT = 20000;
const READ_DEADLINE = 25000;
const DIRECT_TIMEOUT = 12000;
const SETTLE_MS = 1500;
const LOGIN_GRACE_MS = 15000;
const ABOUT_GRACE_MS = 4000;
const MAX_FAILURES = 3;
const ACTIVE_PHASES = ['fetchingStartPoints', 'checkingLimit', 'searching', 'fetchingEndPoints'];

let searchGuard = false;           
let guardBlocks = 0;

const TASK_CLICK_INTERVAL_MS = HSA_CORE.DEFAULTS.cardClickIntervalSec * 1000;
const FLYOUT_SCAN_STEP_MS = 420;       
const FLYOUT_SCAN_MAX_SEGMENTS = 24;   
const FLYOUT_SCAN_SETTLE_MS = 900;     
const FLYOUT_INNER_MAX_SEGMENTS = 48;  
const KEEP_TASK_TABS = true;            
const KEEP_SEARCH_TAB_FOCUSED = true;   
const FOCUS_WINDOW_TOO = true;          
const RESTORE_FOCUS_ON_FINISH = true;   
const TASK_TAB_KEYS = new Set(['rewardsTabId', 'taskClickTabId', 'sidebarTabId', 'taskListTabId', 'humanTabId']);
let lastTaskClickAt = 0;                

const HUMAN_PAGE_SETTLE_MS = 1500;
const HUMAN_VERIFY_OFFICIAL = true;
const PRIMARY_FLYOUT_URL = 'https://cn.bing.com/rewards/panelflyout?channel=bingflyout&partnerId=BingRewards';

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
const USE_REAL_INPUT = true;          
const GO_HOME_RATE = 0.38;
const RELATED_RATE = 0.42;
const ENTER_RATE = 0.5;
const CLICK_RESULT_RATE = 0.35;
const STOP = Symbol('stopped');

const HUMAN_PROFILES = {
  1: { steps: [4, 10], overshoot: 0, scroll: [0.2, 0.8], screens: 0.6, round: 0.7 },
  2: { steps: [12, 30], overshoot: 0.22, scroll: [0.4, 1.6], screens: 1.0, round: 0.85 },
  3: { steps: [24, 52], overshoot: 0.4, scroll: [0.6, 2.8], screens: 1.2, round: 1.0 }
};
const profileOf = level => HUMAN_PROFILES[clampInt(Number(level) || 3, 1, 3)] || HUMAN_PROFILES[3];
function clampInt(v, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(v))); }

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

function cleanKeyword(s) {
  return String(s || '')
    .replace(/[#\[\]【】「」"'“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim(' -—·|');
}

function validKeyword(s) {
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

async function searchLoop(token) {
  let failures = 0;

  let tabId = null;
  let realInput = false;
  let lastQuery = '';
  let lastXY = [120, 140];
  const modeCount = { paste: 0, related: 0, home: 0, stay: 0 };
  const runLevel = clampInt((await load(['runLevel'])).runLevel || 3, 1, 3);
  const profile = profileOf(runLevel);
  const settings = await getSettings();
  const [holdMin, holdMax] = holdRange(settings);
  console.info('[HumanSearch] 拟人强度：' + runLevel);

  try {
    tabId = await openOrNavigate('searchTabId', HOME_URL, true);
    bail(token);
    await keepSearchTabAwake(tabId);          
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
    await keepSearchTabAwake(tabId);
    bail(token);
    const st = await load(['currentSearch', 'totalSearch', 'searchQueue', 'stopRequested']);
    const current = st.currentSearch || 0;
    if (st.stopRequested || current >= st.totalSearch) return;
    const baseQuery = st.searchQueue && st.searchQueue[current];
    if (!baseQuery) return;

    const roundTotal = rand(holdMin, holdMax) * profile.round;
    const roundStart = Date.now();
    const goHome = Math.random() < GO_HOME_RATE;
    const useRelated = Math.random() < RELATED_RATE;
    let keyword = baseQuery;
    let method = '';
    let searched = false;

    try {
      if (useRelated) {
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

    if (current + 1 < st.totalSearch && !haltFlag) {
      await nap(rand(3000, 12000), token);   
    }
  }

  console.info('[HumanSearch] 方式混合：粘贴 ' + modeCount.paste + ' / 改词 ' + modeCount.related
    + ' · 回首页 ' + modeCount.home + ' / 留在结果页 ' + modeCount.stay);
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

async function forceCloseTab(key) {
  const data = await load([key]);
  if (data[key] != null) {
    try { await chrome.tabs.remove(data[key]); } catch {}
  }
  await store({ [key]: null });
}

async function closeTab(key) {
  if (KEEP_TASK_TABS && TASK_TAB_KEYS.has(key)) return;
  return forceCloseTab(key);
}

async function ensureTabActive(tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab) return false;
  try {
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    if (FOCUS_WINDOW_TOO && typeof tab.windowId === 'number') {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
    }
  } catch {}
  return true;
}

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

async function keepSearchTabAwake(tabId) {
  if (!KEEP_SEARCH_TAB_FOCUSED) return;
  await ensureTabActive(tabId);
  await cdpBringToFront(tabId);
  await cdpEmulateFocus(tabId);
}

async function restoreUserFocus() {
  if (!RESTORE_FOCUS_ON_FINISH) return;
  const { userActiveTabId } = await load(['userActiveTabId']);
  if (userActiveTabId == null) return;
  try { await chrome.tabs.update(Number(userActiveTabId), { active: true }); } catch {}
  await store({ userActiveTabId: null });
}

let lastInjectError = null;

async function inject(tabId, func, args) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
    lastInjectError = null;
    return res ? res.result : null;
  } catch (err) {
    lastInjectError = err && err.message ? err.message : String(err);
    console.warn('[Inject] executeScript 失败：' + lastInjectError);
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

let fetchCount = 0;
let lastFetchAt = 0;

/* D01=A：优先官网原始网络数据；D06=D：后台展示允许 120 秒短期缓存并标记采集时间，
   用户刷新 / 开始 / 收尾一律强制新数据。缓存有条目数与字节上限，避免常驻大 HTML。 */
const hsaHtmlCache = new Map();
function hsaCacheTrim(now) {
  for (const [k, v] of hsaHtmlCache) {
    if (!v || now - v.at > HSA_CORE.DEFAULTS.htmlCacheTtlMs) hsaHtmlCache.delete(k);
  }
  while (hsaHtmlCache.size > HSA_CORE.DEFAULTS.htmlCacheMaxEntries) {
    const oldest = hsaHtmlCache.keys().next().value;
    if (oldest == null) break;
    hsaHtmlCache.delete(oldest);
  }
}
async function fetchRewardsPage(path, opts) {
  if (searchGuard) {
    guardBlocks++;
    return { ok: false, status: 0, url: null, html: '', error: 'mid-search sync blocked' };
  }
  const policy = HSA_CORE.syncCachePolicy((opts && opts.reason) || 'background');
  const fresh = !!(opts && opts.fresh) || policy.fresh;
  const key = 'https://rewards.bing.com' + path;
  const now = Date.now();
  hsaCacheTrim(now);
  if (!fresh) {
    const hit = hsaHtmlCache.get(key);
    if (hit && now - hit.at <= HSA_CORE.DEFAULTS.htmlCacheTtlMs) {
      return Object.assign({}, hit.value, { source: 'cache', collectedAt: hit.at });
    }
  }
  fetchCount++;
  lastFetchAt = now;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DIRECT_TIMEOUT);
  try {
    const res = await fetch(key, {
      credentials: 'include',
      cache: 'no-store',
      signal: ctrl.signal
    });
    const html = (await res.text()).slice(0, HSA_CORE.DEFAULTS.htmlCacheMaxBytes);
    const value = { ok: res.ok, status: res.status, url: res.url, html,
                    collectedAt: Date.now(), source: 'official-network' };
    if (res.ok && html.length > 800) {
      hsaHtmlCache.delete(key);
      hsaHtmlCache.set(key, { at: Date.now(), value: value });
      hsaCacheTrim(Date.now());
    }
    return value;
  } catch (err) {
    return {
      ok: false, status: 0, url: null, html: '',
      error: err && err.name === 'AbortError' ? 'timed out' : String(err && err.message || err)
    };
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
  reduceMotion: false,
  dontSkipCompletedCards: false,
  cardClickIntervalSec: HSA_CORE.DEFAULTS.cardClickIntervalSec
};

async function getSettings() {
  const { settings } = await load(['settings']);
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

async function getRunTaskStates() {
  const { runTaskStates } = await load(['runTaskStates']);
  return Array.isArray(runTaskStates) ? runTaskStates : [];
}
function withTaskStates(payload, taskStates) {
  return Object.assign({}, payload || {}, { taskStates: taskStates || [] });
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
      searchGuard = true;
      try { await searchLoop(token); }
      finally { searchGuard = false; }
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
  chrome.alarms.create('watchdog', { periodInMinutes: 1 });
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
    searchQueue: [],
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
    chrome.alarms.create('watchdog', { periodInMinutes: 1 });
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
    chrome.alarms.create('watchdog', { periodInMinutes: 1 });
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'stop') {
    handleStop();
  } else if (msg.type === 'autoComplete') {
    runAutoComplete({ manual: true, level: msg.level, cap: msg.count })
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: 'error', message: err.message }));
    return true;
  } else if (msg.type === 'refreshTasks' || msg.type === 'refreshPoints') {
    const reason = msg.type === 'refreshPoints' ? 'refreshPoints' : 'manual-refresh';
    syncRewardsUnified({ fresh: true, reason: reason })
      .then(r => store({ syncNotice: {
        at: Date.now(), reason: reason, ok: !!r.ok,
        changed: (r.changed || []).length
      } }))
      .catch(err => store({ syncNotice: {
        at: Date.now(), reason: reason, ok: false,
        error: String(err && err.message || err)
      } }));
  } else if (msg.type === 'openOfficial' || msg.type === 'hidePanel' ||
             msg.type === 'togglePanel' || msg.type === 'panelState') {
    handlePanelMessage(msg)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, message: String(err && err.message || err) }));
    return true;
  }
  sendResponse({ ok: true });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (!alarm) return;
  if (alarm.name === 'watchdog') resumeIfNeeded();
  else if (alarm.name === 'cooldownEnd') endCooldown();
  else if (alarm.name === SCHEDULED_ALARM) onScheduledRun().catch(() => rebuildAutoAlarm().catch(() => {}));
});

chrome.runtime.onInstalled.addListener(() => rebuildAutoAlarm().catch(() => {}));

for (const legacy of ['autoTaskTick', 'reminderTick', 'cleanUsedWords', 'scheduledRun', 'autoDailySet']) {
  chrome.alarms.clear(legacy);
}
resumeIfNeeded();

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

const SCHEDULED_ALARM = 'hsaScheduledRun';
const toMinutes = hhmm => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
};

function nextScheduledAt(times) {
  const list = [...new Set(times)].map(toMinutes).filter(v => v != null).sort((a, b) => a - b);
  if (!list.length) return null;
  const now = Date.now();
  const base = new Date(now + 60000);
  for (let day = 0; day < 2; day++) {
    for (const m of list) {
      const d = new Date(base);
      d.setHours(Math.floor(m / 60), m % 60, 0, 0);
      d.setDate(d.getDate() + day);
      if (d.getTime() > now + 30000) {
        return { when: d.getTime(),
          time: String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') };
      }
    }
  }
  return null;
}

async function rebuildAutoAlarm() {
  const tasks = await getAutoTasks();
  const next = (tasks.enabled && tasks.times.length) ? nextScheduledAt(tasks.times) : null;
  await chrome.alarms.clear(SCHEDULED_ALARM);
  if (!next) {
    await store({ scheduledRunTime: null });
    return;
  }
  await chrome.alarms.create(SCHEDULED_ALARM, { when: next.when });
  await store({ scheduledRunTime: next.time });
}

async function onScheduledRun() {
  try {
    const { scheduledRunTime } = await load(['scheduledRunTime']);
    await maybeRunAutoTasks(scheduledRunTime || autoHHMM());
  } catch (err) {
    console.warn('[AutoTask] 定时运行异常：' + String(err && err.message || err));
  } finally {
    await rebuildAutoAlarm().catch(() => {});
  }
}

const bootstrapSchedule = () => { rebuildAutoAlarm().catch(() => {}); };
chrome.runtime.onStartup.addListener(bootstrapSchedule);

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
  runAutoComplete(payload).catch(err => console.warn('[AutoTask] 启动异常：', err && err.message));
  console.info('[AutoTask] ' + (o.manual ? '手动立即运行' : '定时启动 ' + (o.time || ''))
    + ' · 上限 ' + count + ' 次 · 强度 ' + level);
  return { ok: true, count, level, ...payload };
}

async function maybeRunAutoTasks(time) {
  const tasks = await getAutoTasks();
  if (!tasks.enabled || !tasks.times.includes(time)) return;
  const log = await getAutoLog();
  if (log.fired[time]) return;
  const st = await load(['running']);
  const busy = flowActive || !!st.running;
  log.fired[time] = busy ? 'skipped' : 'started';
  await store({ autoTaskLog: log });
  if (busy) {
    console.info('[AutoTask] ' + time + ' 已有任务在运行，本次跳过');
    return;
  }
  const res = await startAutoRun({ time: time, count: tasks.count, level: tasks.level });
  if (!res.ok) {
    log.fired[time] = 'skipped';
    await store({ autoTaskLog: log });
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.uiLang) bgLang = changes.uiLang.newValue || 'zh';
  if (changes.autoTasks) rebuildAutoAlarm().catch(() => {});
});

load(['uiLang']).then(s => { bgLang = s.uiLang || 'zh'; }).catch(() => {});
rebuildAutoAlarm();

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
  if (/About\s*[–\-—]\s*Microsoft Rewards/i.test(text) && /\bSign in\b/i.test(text)) return true;
  if (/Gift cards for the win/i.test(text) && /\bSign in\b/i.test(text)) return true;
  if (/关于\s*[–\-—]\s*Microsoft Rewards/i.test(text) && /登录/i.test(text)) return true;
  return false;
}

function isRewardsShell(html) {
  const t = String(html || '');
  if (!/flyoutViewModel|isRewardsUser|availablePoints/i.test(t)) return false;
  if (/"isRewardsUser"\s*:\s*false/i.test(t)) return true;
  if (/"nonuser"\s*:\s*"True"/i.test(t)) return true;
  return false;
}

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
  const o = opts || {};
  const [dash, earn] = await Promise.all([
    fetchRewardsPage('/dashboard', o),
    fetchRewardsPage('/earn', o)
  ]);
  return {
    dash, earn,
    signedOut: (isSignInPage(dash.html) && isSignInPage(earn.html))
      || (isRewardsShell(dash.html) && isRewardsShell(earn.html)),
    shellSignedOut: isRewardsShell(dash.html) || isRewardsShell(earn.html),
    reachable: dash.ok || earn.ok,
    collectedAt: Math.max(Number(dash.collectedAt) || 0, Number(earn.collectedAt) || 0)
  };
}

/* D02/D03：读取当前账号已打开官网页面的新鲜快照（只读，用完即释放）。
   快照只用于补缺和降级同步，绝不覆盖官网本次已确认的任务状态。 */
async function readVisibleRewardsSnapshot() {
  try {
    const list = await chrome.tabs.query({ url: 'https://rewards.bing.com/*' });
    const tab = (Array.isArray(list) ? list : []).find(t =>
      t && t.id != null && /\/(?:dashboard|earn)(?:\/|[?#]|$)/i.test(String(t.url || '')));
    if (!tab) return null;
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const text = String(document.body && document.body.innerText || '').slice(0, 30000);
        const rows = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const name = String(a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          const m = /(\d+)\s*(?:分|points|pts)/i.exec(name);
          rows.push({ name, points: m ? Number(m[1]) : 0, earned: 0,
                      completed: /已完成|complete/i.test(name), section: 'daily' });
        }
        return {
          url: location.href,
          html: document.documentElement.outerHTML.slice(0, 600 * 1024),
          text: text,
          rows: rows.slice(0, 60),
          signedOut: /Sign in to your Microsoft account|登录到 Microsoft 帐户/i.test(text),
          at: Date.now()
        };
      }
    });
    const d = Array.isArray(res) ? res[0] && res[0].result : null;
    if (!d || !HSA_CORE.isFreshSnapshot(d, Date.now())) return null;
    return d;
  } catch (err) { return null; }
}

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

function sectionBeforeHeading(html, index) {
  const heads = [...html.slice(0, index).matchAll(/<h2[^>]*>([\s\S]{1,80}?)<\/h2>/g)];
  const near = heads.length ? stripTags(heads[heads.length - 1][1]) : '';
  if (/日常任务|每日任务|Daily tasks|More activities/i.test(near)) return 'promo';
  if (/每日活动|Daily activities|Daily set/i.test(near)) return 'daily';
  return 'other';
}

function visibleCardsFrom(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)) {
    const card = m[0];
    const badge = /bg-statusSuccessRewardsBg[\s\S]{0,500}?<p class="text-metadata text-fgCtrlOnImage">\s*(\d+)\s*<\/p>/.exec(card);
    if (!badge) continue;
    const points = parseInt(badge[1], 10);
    if (!(points > 0)) continue;
    const section = sectionBeforeHeading(html, m.index);
    if (section === 'other') continue;                 
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

function summarizeTaskItems(items, extra) {
  const earned = items.reduce((s, r) => s + r.earned, 0);
  const total = items.reduce((s, r) => s + r.points, 0);
  return Object.assign({
    items, earned, total,
    percent: total ? Math.round((earned / total) * 100) : 0,
    updatedAt: Date.now()
  }, extra || {});
}

function ybInject(action, payload) {
  var p = payload || {};
  var MAIN_TASK_STATES = (function () {
    var arr = p.taskStates;
    if (!Array.isArray(arr)) return null;
    return arr.map(function (st) {
      return { name: String((st && st.name) || ''), completed: !!(st && st.completed) };
    }).filter(function (st) { return !!st.name; });
  })();
  var normTaskName = function (s) {
    return String(s || '').toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 60);
  };
  var mainTaskMatch = function (title) {
    if (!MAIN_TASK_STATES) return null;
    var t = normTaskName(title);
    if (t.length < 2) return null;
    var loose = null;
    for (var i = 0; i < MAIN_TASK_STATES.length; i++) {
      var st = MAIN_TASK_STATES[i], n = normTaskName(st.name);
      if (!n) continue;
      if (n === t) return st;
      if (!loose && (n.indexOf(t) >= 0 || t.indexOf(n) >= 0)) loose = st;
    }
    return loose;
  };
  var mainTaskDone = function (title) {
    var st = mainTaskMatch(title);
    return st ? !!st.completed : false;
  };
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
    var rank = function (s) { return s === 'daily' ? 0 : s === 'promo' ? 1 : 2; };
    items.sort(function (a, b) { return rank(a.section) - rank(b.section) || a.idx - b.idx; });
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
    var rank = function (s) { return s === 'daily' ? 0 : s === 'promo' ? 1 : 2; };
    items.sort(function (a, b) { return rank(a.section) - rank(b.section) || a.idx - b.idx; });
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

  var normalizeUrl = function (u) {
    return String(u || '')
      .replace(/\\+u0026/gi, '&')
      .replace(/\\+u003d/gi, '=')
      .replace(/\\+u0025/gi, '%')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, '')
      .trim();
  };

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

  var findTaskAnchor = function (target) {
    var anchors = taskAnchors();
    var wantedFp = urlFp(target.url || '');
    var i, hits = [], by = '';
    for (i = 0; i < anchors.length; i++) {
      if (wantedFp && anchors[i].fp === wantedFp) hits.push(anchors[i]);
    }
    if (hits.length) by = 'url';
    if (!hits.length && target.url) {
      var w = normalizeUrl(target.url);
      for (i = 0; i < anchors.length; i++) {
        var h = anchors[i].href;
        if (h === w || (w.length > 20 && (h.indexOf(w) === 0 || w.indexOf(h) === 0))) hits.push(anchors[i]);
      }
      if (hits.length) by = 'url-prefix';
    }
    if (!hits.length && target.name) {
      var nm = String(target.name).replace(/\s+/g, '');
      for (i = 0; i < anchors.length; i++) {
        if (anchors[i].text.replace(/\s+/g, '').indexOf(nm) >= 0) hits.push(anchors[i]);
      }
      if (hits.length) by = 'name';
    }
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
    var best = hits[0];
    for (i = 1; i < hits.length; i++) {
      if (best.el.contains && best.el.contains(hits[i].el)) best = hits[i];
    }
    return { anchor: best.el, href: best.href, by: by, candidates: hits.length };
  };

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

  var POINTS_RE = /\+\s*(\d[\d,]*)(?!\d)/;                       
  var POINTS_WORD_RE = /(\d[\d,]*)\s*(?:个|点|分)?\s*(?:积分|点数|points?)/i;  
  var POINTS_EARN_RE = /(?:领取|赚取|获得|获取|赢取|奖励|解锁|earn|get)\s*(\d[\d,]*)\s*(?:个|点)?\s*(?:积分|点数|points?)/i;
  var pointsIn = function (t) {
    var str = String(t || '');
    var m = POINTS_RE.exec(str) || POINTS_WORD_RE.exec(str) || POINTS_EARN_RE.exec(str);
    if (!m) return 0;
    var n = parseInt(String(m[1]).replace(/,/g, ''), 10);
    return (n > 0 && n <= 99999) ? n : 0;
  };
  var FL_CONTROLS = ['UserProfileCard', 'HighValueActionCard', 'HalfUnitCard',
    'ThreeOffersCard', 'BingTrialStreakWrapper', 'OneTimeStreakWrapper',
    'DailyCheckInCard', 'ExploreOnBingEngagementCard', 'ExploreOnOutlookEngagementCard',
    'SearchEarningCard', 'BrowseStreakCard', 'EdgeHVACardList', 'BalanceCard',
    'EdgeCoreHVACard', 'AcquisitionCard', 'EdgeUserProfileCard', 'SearchStreakCard',
    'EdgeSurveyCard', 'VersusCard', 'AutoRedeemCard', 'PointClaimCard',
    'NewLevelInfoCard', 'BingOnboardingCard'];

  var scoreCards = function (includeDone) {
    var EX_URL = /(?:referandearn|\/refer(?:andearn)?(?:\/|[?#]|$)|rewards\.bing\.com\/redeem|rewards\.microsoft\.com\/redeem|aka\.ms|form=RWSE01|form=ML2PCO|form=perbnr)/i;
    var EX_TITLE = /(?:你已获得|是时候兑换|将推荐|推荐好友|准备推荐|兑换|签到|连续奖励|即时赢奖|^\s*搜索\s*$|SE_Earning|DailyCheckIn|Win_Promo)/i;
    var pBoxes = deepAll(document, 'div.promo_cont');
    if (!pBoxes.length) {
      var pLinks = deepAll(document, 'a.block[href]'), pTmp = [];
      for (var pl = 0; pl < pLinks.length; pl++)
        if (pLinks[pl].parentElement) pTmp.push(pLinks[pl].parentElement);
      pBoxes = pTmp;
    }
    var pCards = [], pSkipped = [], pSeen = {};
    for (var pb = 0; pb < pBoxes.length; pb++) {
      var pBox = pBoxes[pb], pA = null;
      try {
        pA = pBox.tagName === 'A' ? pBox
          : (pBox.querySelector('a.block[href]') || pBox.querySelector('a[href]'));
      } catch (eA) { continue; }
      if (!pA) continue;
      var pHref = absUrl(pA.getAttribute('href') || '');
      var pTitleEl = null;
      try { pTitleEl = pBox.querySelector('.promo-title,[class*="promo-title"]'); } catch (eT) {}
      var pTitle = clean(pTitleEl || pBox).slice(0, 80)
        .replace(/\s*[-—]\s*Offer.*$/i, '').trim();
      if (!pTitle || pTitle.length < 2) continue;
      if (!/^https?:\/\//i.test(pHref) || EX_URL.test(pHref) || EX_TITLE.test(pTitle)) continue;
      var pAria = String(pBox.getAttribute('aria-label') || pA.getAttribute('aria-label') || '');
      var pDone = mainTaskDone(pTitle);
      if (pDone && !includeDone) {
        pSkipped.push({ title: pTitle.slice(0, 40), points: 0, reason: '主界面显示已完成' });
        continue;
      }
      var pKey = pTitle.replace(/\s+/g, '') + '|' + pHref, pHash = 5381;
      for (var ph = 0; ph < pKey.length; ph++) pHash = ((pHash << 5) + pHash + pKey.charCodeAt(ph)) | 0;
      var pIdx = 'yb-task-' + (pHash >>> 0).toString(36);
      if (pSeen[pIdx]) continue;
      pSeen[pIdx] = 1;
      try { pA.setAttribute('data-yb-hidx', pIdx); } catch (eI) {}
      var pPts = 0;
      try {
        var pBadge = pBox.querySelector('.shortPoint');
        pPts = parseInt(String(clean(pBadge) || '').replace(/[^\d]/g, ''), 10) || 0;
      } catch (eP) {}
      var pTr = topRect(pA);
      if ((pTr.w || 0) < 2 && (pTr.h || 0) < 2) continue;
      pCards.push({
        idx: pIdx, el: pA, href: pHref, text: pTitle, title: pTitle,
        points: pPts, done: pDone, target: pA.getAttribute('target') || '',
        section: 'daily', kind: 'task', order: pb,
        x: pTr.x, y: pTr.y, w: pTr.w, h: pTr.h
      });
    }
    if (pCards.length || pSkipped.length)
      return { cards: pCards, skipped: pSkipped,
        zone: { start: -1, end: 1e9 }, hasBadges: pCards.length > 0 };
    var all = deepAll(document, '*');
    var out = [], skipped = [], seen = [];
    for (var i = 0; i < all.length && i < 12000; i++) {
      var el = all[i];
      var tag0 = String(el.tagName || '').toUpperCase();
      if (tag0 === 'SCRIPT' || tag0 === 'STYLE' || tag0 === 'NOSCRIPT'
          || tag0 === 'TEMPLATE' || tag0 === 'SVG') continue;
      var own = '';
      try {
        for (var n = 0; n < el.childNodes.length; n++) {
          var nd = el.childNodes[n];
          if (nd && nd.nodeType === 3) own += nd.nodeValue;
        }
      } catch (e) { continue; }
      var pts = pointsIn(String(own).replace(/\s+/g, ' '));
      if (!(pts > 0)) continue;

      var card = null, p = el;
      for (var up = 0; up < 8 && p; up++, p = p.parentElement) {
        if (p === document.body || p === document.documentElement) break;
        var tag = p.tagName || '';
        if (tag === 'A' || tag === 'BUTTON' || p.getAttribute('role') === 'button'
            || p.getAttribute('onclick')) { card = p; break; }
      }
      if (!card) {
        p = el;
        for (var up2 = 0; up2 < 8 && p; up2++, p = p.parentElement) {
          if (p === document.body || p === document.documentElement) break;
          var pr0 = p.getBoundingClientRect();
          if (pr0.width < 40 || pr0.height < 24) continue;
          try {
            if (/pointer/i.test(window.getComputedStyle(p).cursor)) { card = p; break; }
          } catch (e2) {}
        }
      }
      if (!card) card = el.parentElement || el;
      var dup = false;
      for (var j = 0; j < seen.length; j++) if (seen[j] === card) { dup = true; break; }
      if (dup) continue;
      seen.push(card);

      var text = clean(card);
      var aria = String(card.getAttribute('aria-label') || '');
      var legacyHref = '';
      try {
        legacyHref = card.tagName === 'A'
          ? absUrl(card.getAttribute('href') || '')
          : (card.querySelector('a[href]')
              ? absUrl(card.querySelector('a[href]').getAttribute('href') || '') : '');
      } catch (eH) {}
      if ((legacyHref && /^https?:\/\//i.test(legacyHref) && EX_URL.test(legacyHref))
          || EX_TITLE.test(text)) continue;
      var done = mainTaskDone(text);
      if (done && !includeDone) {
        skipped.push({ title: text.slice(0, 40), points: pts, reason: '主界面显示已完成' });
        continue;
      }
      var tr = topRect(card);
      if ((tr.w || 0) < 2 && (tr.h || 0) < 2) continue;   
      var href0 = card.tagName === 'A' ? absUrl(card.getAttribute('href') || '') : '';
      var stable = String(href0 || text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      var idx = 'yb-' + stable;
      if (stable) { try { card.setAttribute('data-yb-hidx', idx); } catch (e3) {} }
      out.push({
        idx: idx, el: card,
        href: card.tagName === 'A' ? absUrl(card.getAttribute('href') || '') : '',
        text: text.slice(0, 120),
        title: text.replace(/\+\s*\d[\d,]*/g, '').replace(/\s+/g, ' ').trim().slice(0, 48),
        points: pts, done: done,
        target: card.getAttribute('target') || '',
        section: 'daily', kind: 'badge', badgeIndex: out.length, order: i,
        x: tr.x, y: tr.y, w: tr.w, h: tr.h
      });
    }

    var offers = deepAll(document, '[aria-label*="Offer"],[aria-label*="offer"]');
    for (var k = 0; k < offers.length && k < 60; k++) {
      var o = offers[k];
      var label = String(o.getAttribute('aria-label') || '');
      if (!/offer/i.test(label)) continue;
      var oTitle = label.replace(/\s*[-—]\s*Offer.*$/i, '').trim();
      var oMatch = mainTaskMatch(oTitle);
      if (!oMatch) continue;
      var odone = !!oMatch.completed;
      if (odone && !includeDone) {
        skipped.push({ title: oTitle.slice(0, 40), points: 10, reason: '主界面显示已完成' });
        continue;
      }
      var otr = topRect(o);
      var oidx = 'yb-offer-' + label.replace(/\s+/g, ' ').trim().slice(0, 120) + '-' + k;
      try { o.setAttribute('data-yb-hidx', oidx); } catch (e4) {}
      out.push({
        idx: oidx, el: o, href: '', text: label.slice(0, 100), title: label.slice(0, 48),
        points: 10, done: odone, target: '', section: 'daily', kind: 'offer',
        offerIndex: k, x: otr.x, y: otr.y, w: otr.w, h: otr.h
      });
    }
    return { cards: out, skipped: skipped, zone: { start: -1, end: 1e9 },
      hasBadges: out.length > 0 };
  };

  var badgeCards = scoreCards;

  var humanCards = function (includeDone, full) {
    return scoreCards(!!includeDone).cards;
  };

  var readViewModel = function () {
    try { if (window.flyoutViewModel && window.flyoutViewModel.flyoutResult)
      return window.flyoutViewModel.flyoutResult; } catch (e0) {}
    var scripts = [];
    try { scripts = deepAll(document, 'script'); } catch (eS) { return null; }
    for (var i = 0; i < scripts.length; i++) {
      try {
        var t = String(scripts[i].textContent || '');
        var at = t.indexOf('flyoutViewModel');
        if (at < 0) continue;
        var eqSign = t.indexOf('=', at);
        if (eqSign < 0 || eqSign - at > 60) continue;
        var eq = t.indexOf('{', eqSign);
        if (eq < 0) continue;
        var depth = 0, k = eq, instr = false, esc = false;
        while (k < t.length) {
          var c = t.charAt(k);
          if (instr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') instr = false;
          } else {
            if (c === '"') instr = true;
            else if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { k++; break; } }
          }
          k++;
        }
        if (depth !== 0) continue;
        var obj = JSON.parse(t.slice(eq, k));
        if (obj && obj.flyoutResult) return obj.flyoutResult;
      } catch (eParse) { continue; }   
    }
    return null;
  };

  var humanDiag = function () {
    var fr = readViewModel();
    var official = [], seenIds = {};
    if (fr) {
      var walk = function (o, depth) {
        if (!o || depth > 7 || official.length > 200) return;
        if (Array.isArray(o)) {
          for (var i = 0; i < o.length && i < 100; i++) walk(o[i], depth + 1);
          return;
        }
        if (typeof o !== 'object') return;
        var mx = Number(o.pointProgressMax || o.pointsMax || 0);
        var hasId = !!(o.offerId || o.destinationUrl || o.hash);
        if (hasId && (mx > 0 || o.title || o.description)) {
          var id = String(o.offerId || o.hash || o.destinationUrl || o.title || '');
          if (!seenIds[id]) {
            seenIds[id] = 1;
            official.push({
              offerId: String(o.offerId || ''),
              title: String(o.title || o.description || '').slice(0, 70),
              max: mx, earned: Number(o.pointProgress || 0),
              complete: !!o.complete,
              url: String(o.destinationUrl || '').slice(0, 180),
              hidden: !!o.isHidden
            });
          }
          return;   
        }
        for (var key in o) {
          if (!Object.prototype.hasOwnProperty.call(o, key)) continue;
          walk(o[key], depth + 1);
        }
      };
      walk(fr, 0);
    }
    var controls = [];
    for (var i = 0; i < FL_CONTROLS.length; i++) {
      var name = FL_CONTROLS[i];
      var els = deepAll(document, '[class*="' + name + '"],[data-bi-id*="' + name
        + '"],[data-control*="' + name + '"]');
      if (els.length) controls.push({ name: name, count: els.length });
    }
    var scrollers = innerScrollers();
    var snap = scoreCards(true);
    var samples = [];
    var allEls = deepAll(document, '*');
    for (var j = 0; j < allEls.length && samples.length < 12; j++) {
      var tag = String(allEls[j].tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      var own2 = '';
      try {
        for (var n = 0; n < allEls[j].childNodes.length; n++) {
          var nd = allEls[j].childNodes[n];
          if (nd && nd.nodeType === 3) own2 += nd.nodeValue;
        }
      } catch (e2) { continue; }
      var t2 = String(own2).replace(/\s+/g, ' ').trim();
      if (t2.length > 2 && t2.length < 90 && pointsIn(t2) > 0) samples.push(t2);
    }
    return {
      ok: true, url: location.href, title: document.title || '',
      hasViewModel: !!fr,
      shellSignedOut: (function () {
        try {
          var ss = deepAll(document, 'script'), raw = '';
          for (var z = 0; z < ss.length; z++) raw += String(ss[z].textContent || '');
          return /"isRewardsUser"\s*:\s*false|"nonuser"\s*:\s*"True"/i.test(raw);
        } catch (e3) { return false; }
      })(),
      officialCount: official.length,
      officialPending: official.filter(function (x) { return !x.complete; }).length,
      official: official.slice(0, 40),
      domCards: snap.cards.length,
      controls: controls,
      scrollers: scrollers.scrollers || [],
      pointTextSamples: samples,
      layout: fr && fr.layout ? String(fr.layout.layoutName || '') : ''
    };
  };

  var humanWake = function () {
    var fired = [];
    try {
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      fired.push('document.visibilitychange');
    } catch (e0) {}
    try {
      window.dispatchEvent(new Event('focus'));
      fired.push('window.focus');
    } catch (e1) {}
    try {
      window.dispatchEvent(new Event('pageshow'));
      fired.push('window.pageshow');
    } catch (e2) {}
    return { ok: true, fired: fired, visibility: document.visibilityState || '' };
  };

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

  var humanScrollTo = function (y) {
    var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 800);
    try { window.scrollTo(0, y); } catch (e) {}
    return { ok: true, y: window.scrollY || 0, scrollHeight: h,
      viewport: window.innerHeight || 700, url: location.href };
  };

  var scrollerEls = function () {
    var all = deepAll(document, '*'), out = [];
    for (var i = 0; i < all.length && i < 6000; i++) {
      var el = all[i];
      if (!el || el === document.body || el === document.documentElement) continue;
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      var st = null;
      try { st = window.getComputedStyle(el); } catch (e) { continue; }
      if (!st || !/auto|scroll/i.test(st.overflowY || '')) continue;
      try { el.setAttribute('data-yb-scroller', String(out.length)); } catch (e5) {}
      out.push(el);
    }
    return out;
  };
  var findScroller = function (idx) {
    var all = deepAll(document, '[data-yb-scroller]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-yb-scroller') === String(idx)) return all[i];
    }
    var els = scrollerEls();
    return els[idx] || null;
  };
  var innerScrollers = function () {
    var els = scrollerEls(), out = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i], max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (max <= 0) continue;
      out.push({ idx: i, max: max, view: el.clientHeight || 400,
        scrollTop: el.scrollTop || 0,
        top: Math.round(el.getBoundingClientRect().top),
        w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) });
    }
    return { ok: true, scrollers: out, url: location.href };
  };
  var scrollInner = function (idx, y) {
    var el = findScroller(idx);
    if (!el) return { ok: false, reason: 'no-scroller', idx: idx };
    try {
      el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, y));
    } catch (e) {}
    return { ok: true, idx: idx, y: el.scrollTop,
      max: Math.max(0, el.scrollHeight - el.clientHeight) };
  };

  var humanScan = function (includeDone, full) {
    var res = scoreCards(!!includeDone);
    var cards = res.cards;
    var bd = res;
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

  var humanAim = function (payload) {
    var cards = humanCards(!!(payload && payload.includeDone), !!(payload && payload.full));
    var c = pickCard(cards, payload);
    if (!c) return { ok: false, reason: 'not-found', total: cards.length,
      titles: cards.map(function (x) { return x.title || x.text.slice(0, 24); }).slice(0, 12) };
    try { c.el.setAttribute('data-yb-hidx', String(payload.idx)); } catch (e) {}
    try { c.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
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

  var humanClick = function (payload) {
    var cards = humanCards(!!(payload && payload.includeDone), !!(payload && payload.full));
    var c = pickCard(cards, payload);
    if (!c) return { ok: false, reason: 'not-found', total: cards.length };
    try { c.el.setAttribute('data-yb-hidx', String(payload.idx)); } catch (e) {}
    var res = fireMouse(c.el);              
    return {
      ok: res.native || res.dispatched >= 5,
      dispatched: res.dispatched, native: res.native,
      href: c.href, text: c.text, points: c.points,
      target: c.target, kind: c.kind, x: c.x, y: c.y, title: c.title || '',
      scrolledTo: Math.round(c.el.getBoundingClientRect().top + window.scrollY)
    };
  };

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
    case 'human.scan':        return humanScan(!!p.includeDone, !!p.full);
    case 'human.scroll':      return humanScrollPage();
    case 'human.scrollTo':    return humanScrollTo(Number(p.y) || 0);
    case 'human.diag':        return humanDiag();
    case 'human.wake':        return humanWake();
    case 'human.scrollers':   return innerScrollers();
    case 'human.scrollInner': return scrollInner(Number(p.idx) || 0, Number(p.y) || 0);
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

function registerNewTabs(before, after, tabId, stat) {
  const fresh = (after || []).filter(id => !(before || []).includes(id) && id !== tabId);
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

/* T07：等待当前页面加载稳定后才允许下一次点击动作，避免网页未加载完盲目继续。 */
async function waitForTaskPageStable(token) {
  const deadline = Date.now() + HSA_CORE.DEFAULTS.pageStableWaitMs;
  while (isCurrent(token) && Date.now() < deadline) {
    try {
      const list = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = Array.isArray(list) ? list[0] : null;
      if (!tab || tab.status === 'complete') return true;
    } catch (err) {}
    await nap(250, token);
  }
  return false;
}

async function taskClickSpacing(token) {
  let seconds;
  try {
    const cfg = await getSettings();
    seconds = Number(cfg.cardClickIntervalSec);
  } catch (err) {}
  const interval = HSA_CORE.clampIntervalSec(seconds) * 1000;
  const left = interval - (Date.now() - lastTaskClickAt);
  if (left > 0) {
    hsaActivityPush({ state: 'waiting', delayMs: left,
      zh: '等待 {s} 秒后点击下一张任务卡',
      en: 'Wait {s}s before the next card' }).catch(() => {});
    await nap(left, token);
  }
  await waitForTaskPageStable(token);
  lastTaskClickAt = Date.now();
}

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

async function collectFlyoutCardsFull(tabId, token, stat, needPanel, includeDone, taskStates) {
  const merged = [];
  const seen = new Set();
  let segments = 0, height = 800, viewport = 700;
  let lastTitle = '', lastSignedOut = false, lastSkipped = [];

  const keyOf = c => String(c.idx || c.title || '').slice(0, 220)
    || String(c.href || '').split('#')[0].trim().slice(0, 220);
  const add = list => {
    for (const c of (Array.isArray(list) ? list : [])) {
      const k = keyOf(c);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      merged.push(c);
    }
  };

  if (needPanel !== false) {
    const opened = await inject(tabId, ybInject, ['human.openPanel', {}]);
    if (opened && opened.ok) await nap(1200, token);
    const wake = await inject(tabId, ybInject, ['human.wake', {}]);
    if (wake && wake.ok) await nap(FLYOUT_SCAN_SETTLE_MS, token);
  }

  const first = await inject(tabId, ybInject, ['human.scrollTo', { y: 0 }]);
  if (first && Number(first.scrollHeight) > height) height = Number(first.scrollHeight);
  if (first && Number(first.viewport) > 0) viewport = Number(first.viewport);
  const step = Math.max(280, Math.round(viewport * 0.7));

  for (let y = 0; y <= height && segments < FLYOUT_SCAN_MAX_SEGMENTS && isCurrent(token); y += step) {
    await inject(tabId, ybInject, ['human.scrollTo', { y: y }]);
    await nap(FLYOUT_SCAN_STEP_MS, token);
    const snap = await inject(tabId, ybInject,
      ['human.scan', withTaskStates({ full: true, includeDone }, taskStates)]);
    if (snap && Array.isArray(snap.cards)) add(snap.cards);
    if (snap && snap.title) lastTitle = snap.title;
    if (snap && snap.signedOut) lastSignedOut = true;
    if (snap && Array.isArray(snap.skipped)) lastSkipped = snap.skipped;
    segments++;
  }

  const info = await inject(tabId, ybInject, ['human.scrollers', {}]);
  const scrollers = (info && Array.isArray(info.scrollers)) ? info.scrollers : [];
  let innerSegments = 0;
  for (const sc of scrollers) {
    const max = Number(sc.max) || 0;
    if (max <= 0) continue;
    const stepInner = Math.max(120, Math.round((Number(sc.view) || 400) * 0.7));
    for (let y = 0; y <= max && innerSegments < FLYOUT_INNER_MAX_SEGMENTS
         && isCurrent(token); y += stepInner) {
      await inject(tabId, ybInject, ['human.scrollInner', { idx: sc.idx, y: y }]);
      await nap(FLYOUT_SCAN_STEP_MS, token);
      const snap = await inject(tabId, ybInject,
        ['human.scan', withTaskStates({ full: true, includeDone }, taskStates)]);
      if (snap && Array.isArray(snap.cards)) add(snap.cards);
      if (snap && snap.title) lastTitle = snap.title;
      if (snap && snap.signedOut) lastSignedOut = true;
      if (snap && Array.isArray(snap.skipped)) lastSkipped = snap.skipped;
      innerSegments++;
    }
    await inject(tabId, ybInject, ['human.scrollInner', { idx: sc.idx, y: max }]);
    await nap(FLYOUT_SCAN_STEP_MS, token);
    const tail = await inject(tabId, ybInject,
      ['human.scan', withTaskStates({ full: true, includeDone }, taskStates)]);
    if (tail && Array.isArray(tail.cards)) add(tail.cards);
    if (tail && Array.isArray(tail.skipped)) lastSkipped = tail.skipped;
    if (tail && tail.title) lastTitle = tail.title;
    if (tail && tail.signedOut) lastSignedOut = true;
    await inject(tabId, ybInject, ['human.scrollInner', { idx: sc.idx, y: 0 }]);
  }

  await inject(tabId, ybInject, ['human.scrollTo', { y: 0 }]);
  await nap(FLYOUT_SCAN_SETTLE_MS, token);
  const final = await inject(tabId, ybInject,
    ['human.scan', withTaskStates({ full: true, includeDone }, taskStates)]);
  if (final && Array.isArray(final.cards)) add(final.cards);
  if (final && Array.isArray(final.skipped)) lastSkipped = final.skipped;
  if (final && final.title) lastTitle = final.title;
  if (final && final.signedOut) lastSignedOut = true;

  const diag = await inject(tabId, ybInject, ['human.diag', {}]);
  if (diag && diag.ok) {
    stat.diag = stat.diag || [];
    stat.diag.push({
      page: diag.url, layout: diag.layout, hasViewModel: diag.hasViewModel,
      officialCount: diag.officialCount, officialPending: diag.officialPending,
      domCards: diag.domCards, controls: diag.controls,
      scrollers: diag.scrollers, pointTextSamples: diag.pointTextSamples
    });
    console.info('[AutoTask] 运行时诊断（' + (diag.layout || '页面') + '）：'
      + 'DOM 收 ' + merged.length + ' 张 / 官方 flyoutViewModel '
      + (diag.hasViewModel ? diag.officialCount + ' 项（待完成 ' + diag.officialPending + '）' : '不可读')
      + '，真实控件 ' + (diag.controls || []).length + ' 类，内部滚动条 '
      + (diag.scrollers || []).length + ' 个');
    if (diag.hasViewModel && diag.officialPending > merged.length) {
      console.warn('[AutoTask] ⚠ 官方待完成任务（' + diag.officialPending
        + '）多于本页 DOM 收集（' + merged.length
        + '），可能有卡片未渲染 / 文案格式未覆盖。把下面诊断贴给我即可定位：');
      console.warn('[AutoTask] 积分文案样本：'
        + JSON.stringify(diag.pointTextSamples || []));
      console.warn('[AutoTask] 官方任务：'
        + JSON.stringify((diag.official || []).slice(0, 12)));
    }
  }

  return {
    cards: merged, skipped: lastSkipped, segments: segments, height: height,
    innerScrollers: scrollers.length, innerSegments: innerSegments,
    title: lastTitle, signedOut: lastSignedOut,
    diag: diag && diag.ok ? diag : null
  };
}

async function humanClickTasks(token, stat) {
  /* T03=B：侧栏不可用时统一回退到官网 /dashboard 与 /earn，用索引与实时卡片定位。 */
  const pages = HSA_CORE.fallbackPages().map(p => ({
    url: 'https://rewards.bing.com' + p,
    label: p,
    page: p.replace(/^\//, ''),
    flyout: false
  }));
  let clicked = 0, cardTotal = 0;
  const cfg = await getSettings();
  const includeDone = !!cfg.dontSkipCompletedCards;
  const taskStates = await getRunTaskStates();
  console.info('[AutoTask] 卡片策略：主界面任务状态 ' + taskStates.length + ' 项（待完成 '
    + taskStates.filter(s => !s.completed).length + ' 项）'
    + (includeDone ? '；不跳过已完成卡（点全部）' : '；只点主界面未完成的任务卡'));
  const seen = new Set();
  const normUrl = h => String(h || '').split('#')[0].trim().slice(0, 220);
  const keyOf = c => HSA_CORE.taskCardKey(c);
  stat.usedTabIds = stat.usedTabIds || new Set();
  stat.humanEmpty = [];
  stat.humanSignedOut = false;
  stat.skipped = 0;
  stat.officialVerified = 0;
  stat.officialUnconfirmed = 0;
  stat.officialAvailable = false;
  stat.states = stat.states || HSA_CORE.newClickResult();

  for (const pg of pages) {
    if (!isCurrent(token)) break;
    let tabId = null;
    const pageStart = clicked;
    let pageAnchors = 0;
    try {
      tabId = await openOrNavigate('humanTabId', pg.url, true);
      stat.usedTabIds.add(Number(tabId));
      await ensureTabActive(tabId);
      await humanWaitPage(tabId, token);
      try { await chrome.tabs.reload(tabId); } catch {}
      await humanWaitPage(tabId, token);

      const earlyAttached = await cdpAttach(tabId).catch(() => false);
      if (earlyAttached) {
        console.info('[AutoTask] 调试会话已建立（横幅已出现），等待布局稳定后再定位卡片');
        await nap(900, token);
      }

      const collected = await collectFlyoutCardsFull(
        tabId, token, stat, !!pg.flyout, includeDone, taskStates);
      const skipped = collected.skipped;
      stat.skipped += skipped.length;
      const cards = collected.cards.filter(c => {
        const k = keyOf(c);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      cards.sort((a, b) => (Number(a.order) || (Number(a.domOrder) || 0))
        - (Number(b.order) || (Number(b.domOrder) || 0)));
      cardTotal += collected.cards.length;
      pageAnchors = collected.cards.length;
      console.info('[AutoTask] ' + pg.label + '：从头到尾滚动 ' + collected.segments
        + ' 段（页面高 ' + collected.height + 'px）+ 内部滚动条 '
        + collected.innerScrollers + ' 个 / ' + collected.innerSegments + ' 段，本页 '
        + collected.cards.length
        + ' 张 / 跨页去重后待点 ' + cards.length
        + ' 张，跳过 ' + skipped.length + ' 张不给分/已完成卡'
        + (collected.title ? '，标题「' + collected.title + '」' : '')
        + '；逐张打开间隔 ' + TASK_CLICK_INTERVAL_MS + 'ms');
      for (const sk of skipped) {
        console.info('[AutoTask]   ↳ 跳过「' + (sk.title || '').slice(0, 28) + '」(+'
          + sk.points + ')：' + sk.reason);
      }

      let lastOfficial = null;      
      if (HUMAN_VERIFY_OFFICIAL) {
        const official = await inject(tabId, ybInject, ['human.verify', {}]);
        if (official && official.ok && Array.isArray(official.tasks) && official.tasks.length) {
          stat.officialAvailable = true;
          lastOfficial = official;
          console.info('[AutoTask] 官方任务列表 ' + official.tasks.length
            + ' 项（仅用于计分核验，不删减待点卡片）');
        } else {
          console.info('[AutoTask] 官方接口不可用（'
            + ((official && official.reason) || '无返回') + '），按页面实际卡片全量打开');
        }
      }

      if (collected.signedOut) {
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
        stat.pages = stat.pages || [];
        stat.pages.push({ page: pg.page, clicked: 0,
          anchors: pageAnchors, doneSkipped: skipped.length });
        continue;
      }

      for (let order = 0; order < cards.length && isCurrent(token); order++) {
        const c = cards[order];
        await taskClickSpacing(token);            
        const before = await tabIds();
        let res = null, fresh = [], method = '', realMouse = false, aim = null;

        const aimPayload = {
          idx: c.idx, href: c.href, order, full: true, includeDone: includeDone,
          offerIndex: c.offerIndex, badgeIndex: c.badgeIndex, title: c.title || '',
          taskStates: taskStates   
        };
        aim = await inject(tabId, ybInject, ['human.aim', aimPayload]);
        if (!aim || !aim.ok) {
          await inject(tabId, ybInject, ['human.openPanel', {}]);
          await nap(1000, token);
          aim = await inject(tabId, ybInject, ['human.aim', aimPayload]);
        }
        if (!aim || !aim.ok) {
          stat.aimFailed = (stat.aimFailed || 0) + 1;
          console.warn('[AutoTask] ✗ 无法定位「' + (c.title || c.text || '').slice(0, 30) + '」'
            + '（第 ' + (order + 1) + '/' + cards.length + ' 张，继续检查下一张）'
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
        /* T06=D：已发出点击 / 已打开页面 / 官网已确认完成 三个状态互不冒充。 */
        HSA_CORE.recordClick(stat.states, 'clickSent');
        if (fresh.length) HSA_CORE.recordClick(stat.states, 'pageOpened', fresh.length);
        HSA_CORE.recordTrigger(stat.states, realMouse ? 'cdp' : 'page-interaction',
          realMouse ? 'CDP 可用，官网卡片真实鼠标路径' : 'CDP 不可用，页面真实交互');
        stat.clicked = stat.states.clickSent;
        clicked = stat.states.clickSent;
        console.info('[AutoTask] ✓ ' + pg.label + ' 点击 ' + (order + 1) + '/' + cards.length
          + '：' + (aim.title || aim.text || '').slice(0, 34) + '（+' + aim.points + ' · ' + aim.kind + '）'
          + ' · ' + method + ' @(' + Math.round(aim.x) + ',' + Math.round(aim.y) + ')'
          + (res && res.ok ? ' · 合成事件 ' + res.dispatched + ' 段' : '')
          + ' · 新标签页 ' + fresh.length + ' 个（保留不关）');

        if (HUMAN_VERIFY_OFFICIAL && stat.officialAvailable) {
          await nap(1800, token);
          const after = await inject(tabId, ybInject, ['human.verify', {}]);
          if (after && after.ok && Array.isArray(after.tasks)) {
            const name = String(aim.title || '').replace(/\s+/g, '');
            const hit = after.tasks.find(t =>
              String(t.title || '').replace(/\s+/g, '').slice(0, 6) === name.slice(0, 6));
            if (hit && (hit.complete || (hit.pointsMax > 0 && hit.pointsEarned >= hit.pointsMax))) {
              stat.officialVerified++;
              HSA_CORE.recordClick(stat.states, 'officialConfirmed');
              console.info('[AutoTask]   ✓ 官方已确认计分：' + (aim.title || '').slice(0, 26));
            } else {
              stat.officialUnconfirmed++;
              HSA_CORE.recordClick(stat.states, 'unconfirmed');
              console.warn('[AutoTask]   ⚠ 官方未确认计分：' + (aim.title || '').slice(0, 26)
                + '（可能需要答题/进一步互动，或这张本身不给分）');
            }
          } else if (after && after.ok && hitByCount(lastOfficial, after)) {
            stat.officialVerified++;
            HSA_CORE.recordClick(stat.states, 'officialConfirmed');
            console.info('[AutoTask]   ✓ 官方完成项 +1：' + (aim.title || '').slice(0, 26));
          }
          if (after && after.ok) lastOfficial = after;
        }
      }

      const pageClicks = clicked - pageStart;
      stat.pages = stat.pages || [];
      stat.pages.push({ page: pg.page, clicked: pageClicks,
        anchors: pageAnchors, doneSkipped: skipped.length });
      console.info('[AutoTask] ' + pg.label + ' 已从头到尾检查并逐张打开 '
        + pageClicks + ' 张卡片，继续下一个任务页（共 ' + pages.length + ' 页）');
    } catch (err) {
      console.warn('[AutoTask] ' + pg.label + ' 出错：' + (err && err.message || String(err)));
    }
  }

  stat.pages = stat.pages || [];
  stat.real = true;
  stat.clicked = stat.states.clickSent;
  stat.openedTabs = stat.states.pageOpened;
  stat.domClick = stat.states.clickSent;
  stat.officialConfirmed = stat.states.officialConfirmed;
  stat.unconfirmed = stat.states.unconfirmed;
  stat.manualLinks = stat.states.manualLinks;
  stat.triggerMethods = stat.states.triggerMethods;
  console.info('[AutoTask] 结果三态：已发出点击 ' + stat.states.clickSent
    + ' / 已打开页面 ' + stat.states.pageOpened
    + ' / 官网确认 ' + stat.states.officialConfirmed
    + ' / 未确认 ' + stat.states.unconfirmed);
  for (const id of stat.usedTabIds) {
    try { await chrome.debugger.detach({ tabId: id }); } catch {}
    cdpAttached.delete(id);
  }
  await forceCloseTab('humanTabId').catch(() => {});
  console.info('[AutoTask] 点击任务卡片流程结束：已关闭扫描载体页');
  console.info('[AutoTask] 独立标签页回退流程完成：' + pages.length
    + ' 页共点 ' + clicked + ' 张卡片（共扫到 ' + cardTotal + ' 张，跨页去重）'
    + '，跳过 ' + (stat.skipped || 0) + ' 张已完成/不给分卡'
    + '（CDP 真鼠标 ' + (stat.realMouse || 0) + ' / 降级 ' + (stat.degraded || 0) + '）'
    + (stat.officialAvailable
        ? '，官方确认计分 ' + (stat.officialVerified || 0) + ' / 未确认 ' + (stat.officialUnconfirmed || 0)
        : '，官方核验不可用（以页面白名单为准）')
    + (stat.humanEmpty.length ? '，空页面：' + stat.humanEmpty.join('、') : ''));
}

async function completePendingTaskCards(level, token) {
  lastTaskClickAt = 0;                      
  const stat = {
    clicked: 0, skipped: 0, real: false, openedTabs: 0, pages: [],
    signedOut: false, fallbackOpened: 0, domClick: 0
  };
  const embedded = await runEmbeddedPanelTasks(token, stat);
  if (embedded.ok) {
    console.info('[AutoTask] 内部侧栏完成：点击 ' + embedded.clicked + ' 张（宿主 '
      + embedded.mode + '，任务页保留 ' + (stat.openedTabs || 0) + ' 个）');
    return stat;
  }
  console.warn('[AutoTask] 内部侧栏不可用（' + embedded.reason + '），回退独立标签页流程');
  await humanClickTasks(token, stat);
  return stat;
}

var autoCompleteActive = false;

async function presetSearchCount(counter, cap) {
  let max = 0, got = 0;
  if (counter && Number(counter.max) > 0) {
    max = Number(counter.max);
    got = Math.max(0, Math.min(Number(counter.progress) || 0, max));
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

async function syncStart(token, cap) {
  const sync = await syncRewardsUnified({ fresh: true, reason: 'start', token: token });
  if (!sync.ok) {
    await store({
      todayStart: null, liveCheck: false,
      presetSearches: 0, runPreset: null
    });
    return { ok: false, reason: sync.reason };
  }

  const startPoints = sync.balance;
  const todaySearch = sync.todaySearch;
  const cnt = await presetSearchCount(sync.counter, cap);

  await store({
    todayStart: todaySearch || null,
    startPoints: startPoints == null ? 0 : startPoints,
    startKnown: startPoints != null,
    liveCheck: false,                 
    searchMaxedAtStart: !!(todaySearch && todaySearch.progress >= todaySearch.max),
    presetSearches: cnt.searches,
    runPreset: {
      mode: 'preset', at: Date.now(), searches: cnt.searches,
      start: startPoints, max: cnt.max, got: cnt.got
    }
  });

  const items = sync.todayTasks.items || [];
  const searchItem = items.find(i => i.section === 'search');
  const searchPending = !searchItem || Number(searchItem.earned) < Number(searchItem.points);
  /* T08=A：两版统一采用插件版严格完成条件（非估算 / 至少 3 项 / 搜索项完成 /
     总进度 100% / 逐项完成）；估算、缺失配额、过期来源都只显示「待核实」。 */
  const allDone = HSA_CORE.isAllDone(sync.todayTasks, {
    estimated: !!sync.todayTasks.approx,
    quotaMissing: !(todaySearch && Number.isFinite(todaySearch.max)),
    stale: !!(sync.pointsSummary &&
      Date.now() - Number(sync.pointsSummary.updatedAt || 0) > HSA_CORE.DEFAULTS.htmlCacheTtlMs)
  });

  return {
    ok: true, startPoints, todaySearch,
    searches: cnt.searches, max: cnt.max, got: cnt.got, allDone,
    todayTasks: sync.todayTasks,
    taskRes: { ok: true, signedOut: false, count: items.length }
  };
}

async function presetSyncFinish(st, searches, start) {
  const sync = await syncRewardsUnified({ fresh: true, reason: 'finish' });
  const finalPoints = sync.ok ? sync.balance : null;
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
    currentQuery: null, cooldownUntil: null, searchQueue: [],
    phase: 'completed', running: false, stopRequested: false,
    lastActivity: Date.now()
  });
  chrome.alarms.clear('watchdog');
  chrome.alarms.clear('cooldownEnd');
  await restoreUserFocus();
  await closeTab('rewardsTabId').catch(() => {});
  return { points: finalPoints, today: finalToday };
}

/* S01=B：与桌面 activityDetail 同结构的精简运行详情，写入状态行显示。 */
async function hsaActivityPush(info) {
  const o = info || {};
  const now = Date.now();
  const delayMs = Math.max(0, Math.round(Number(o.delayMs) || 0));
  const payload = {
    at: now, until: delayMs ? now + delayMs : 0,
    state: o.state || 'running',
    zh: Array.isArray(o.zh) ? o.zh.join(' · ') : String(o.zh || ''),
    en: Array.isArray(o.en) ? o.en.join(' · ') : String(o.en || ''),
    page: o.page || '', card: o.card || '', query: o.query || ''
  };
  try { await store({ activityDetail: payload }); } catch (err) {}
}

async function runAutoComplete(opts) {
  const o = opts || {};
  if (autoCompleteActive || flowActive) return { ok: false, reason: 'running' };
  hsaActivityPush({ state: 'running',
    zh: '正在同步积分状态并准备点击任务卡…',
    en: 'Syncing points and preparing task cards…' }).catch(() => {});
  autoCompleteActive = true;
  const token = ++flowToken;
  try {
    if ((await load(['running'])).running) return { ok: false, reason: 'running' };
    const tasks = await getAutoTasks();
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

    const sync = await syncStart(token, o.cap);
    if (!sync.ok) {
      await store({ running: false, phase: 'idle', stopRequested: false,
                    lastActivity: Date.now(), presetSearches: 0 });
      console.warn('[AutoTask] 开始时同步失败（' + sync.reason + '），未登录或页面不可读，零动作返回');
      return { ok: false, reason: sync.reason, clicked: 0, searches: 0 };
    }
    if (o.manual) {
      await store({ syncNotice: { at: Date.now(), reason: 'auto-start', ok: true, changed: 0 } })
        .catch(() => {});
    }

    const taskStates = (((sync.todayTasks || {}).items) || []).map(it => ({
      name: String(it.name || ''),
      completed: !!it.completed || Number(it.earned) >= Number(it.points),
      points: Number(it.points) || 0
    })).filter(x => x.name);
    await store({ runTaskStates: taskStates }).catch(() => {});

    const cfg = await getSettings();
    const includeDone = !!cfg.dontSkipCompletedCards;

    if (sync.allDone && !includeDone) {
      await store({ running: false, phase: 'completed', stopRequested: false,
                    lastActivity: Date.now(), presetSearches: 0 });
      console.info('[AutoTask] 积分与任务均已完成，且「不跳过已完成任务卡」未开启：零动作返回');
      /* T09=D：无需运行是成功的幂等结果，不能与真正报错混淆。 */
      hsaActivityPush({ state: 'allDone', zh: HSA_CORE.TEXT.allDone,
        en: HSA_CORE.TEXT.allDoneEn }).catch(() => {});
      return HSA_CORE.allDoneResult({ level, preset: true });
    }
    if (sync.allDone)
      console.info('[AutoTask] 积分与任务均已完成，但已开启「不跳过已完成任务卡」：仍发起点击任务卡片流程');

    const clickRes = await completePendingTaskCards(level, token);

    const searches = sync.allDone ? 0 : sync.searches;
    if (searches > 0 && isCurrent(token)) {
      await handleStart(searches, {
        level, auto: !o.manual, time: o.time || null,
        source: o.manual ? 'manual' : 'schedule', preset: true
      });
    } else {
      const st = await load(['startKnown', 'todayStart', 'todaySearch']);
      await presetSyncFinish(Object.assign({}, st, { totalSearch: 0 }), 0, sync.startPoints || 0);
      await store({ running: false, phase: 'completed', stopRequested: false,
                    lastActivity: Date.now() });
    }
    console.info('[AutoTask] 自动完成：点击 ' + clickRes.clicked + ' 张，跳过 '
      + (clickRes.skipped || 0) + ' 张，保留任务页 ' + (clickRes.openedTabs || 0)
      + ' 个，搜索 ' + searches + ' 次（配额 ' + sync.got + '/' + sync.max + '）'
      + (clickRes.signedOut ? '，[警告] 检测到登录页，请确认已登录 Rewards' : ''));
    hsaActivityPush({ state: 'done', zh: '本轮自动完成已结束',
      en: 'Auto-complete round finished' }).catch(() => {});
    /* T05/T06：未确认卡片的手动链接与三态结果透传给界面。 */
    return { ok: true, clicked: clickRes.clicked, skippedCards: clickRes.skipped,
             searches, level, preset: true,
             manualLinks: (clickRes.manualLinks || []).slice(0, 20),
             states: clickRes.states || null };
  } finally {
    autoCompleteActive = false;
    const st = await load(['running']).catch(() => ({}));
    if (st.running && !flowActive) {
      chrome.alarms.clear('watchdog');
      chrome.alarms.clear('cooldownEnd');
      await store({ running: false, phase: 'idle', stopRequested: false,
                    searchQueue: [], currentQuery: null }).catch(() => {});
      await cdpDetachAll().catch(() => {});
    }
  }
}
const baseRunAutoComplete = runAutoComplete;
runAutoComplete = async function (opts) {
  const res = await baseRunAutoComplete(opts);
  try { await store({ autoResult: Object.assign({}, res, { at: Date.now() }) }); } catch {}
  return res;
};

function earnCardsFromHtml(html) {
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
  for (const m of src.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)) {
    const card = m[0];
    const hrefM = /href="([^"]*)"/.exec(card);
    const href = hrefM ? hrefM[1] : '';
    if (/\/redeem|\/referandearn|\/apps\/wallpaper|\/earn\/quest\/|\/rewardscdn\//i.test(href)) continue;
    const badge = /bg-statusSuccessRewardsBg[\s\S]{0,500}?<p[^>]*>\s*(\d{1,4})\s*<\/p>/.exec(card);
    if (!badge) continue;
    const points = parseInt(badge[1], 10);
    if (!(points > 0) || points > 100) continue;       
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

function taskItemsFromPages(pages) {
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
    for (const it of cardsFromRewardsHtml(pages.earn.html)) add(it); 
    for (const it of earnCardsFromHtml(pages.earn.html)) add(it);     
  }
  return out;
}

function searchItemFromCounter(counter, prev) {
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

function businessFingerprint(v) {
  if (Array.isArray(v)) return v.map(businessFingerprint);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (/^(updatedAt|checkedAt|fetchedAt|ts|timestamp|capturedAt|at|reason|sources)$/.test(k)) continue;
      o[k] = businessFingerprint(v[k]);
    }
    return o;
  }
  return v;
}
function sameBusiness(a, b) {
  try { return JSON.stringify(businessFingerprint(a)) === JSON.stringify(businessFingerprint(b)); }
  catch { return Object.is(a, b); }
}

async function syncRewardsUnified(opts) {
  const o = opts || {};
  /* D06：用户刷新 / 开始 / 收尾强制新数据；后台展示允许短期缓存。 */
  const policy = HSA_CORE.syncCachePolicy(o.reason);
  const fresh = !!o.fresh || policy.fresh;
  hsaActivityPush({ state: 'syncing',
    zh: '正在读取官网 /dashboard 与 /earn…', en: 'Reading /dashboard and /earn…' }).catch(() => {});
  const pages = await fetchBothPages({ fresh: fresh, reason: o.reason });
  const snap = await readVisibleRewardsSnapshot();
  const prev = await load(['pointsSummary', 'todayTasks', 'todaySearch', 'loginStatus']);
  const prevPs = prev.pointsSummary || {};
  const prevTt = prev.todayTasks || {};
  const prevSearch = prev.todaySearch || null;
  const prevLogin = prev.loginStatus || null;

  const official = mergeTrio(
    pages.dash.ok ? parsePointsTrio(pages.dash.html) : null,
    pages.earn.ok ? parsePointsTrio(pages.earn.html) : null
  );
  const trio = official;
  const shellSignedOut = !!(
    (pages.dash.ok && isRewardsShell(pages.dash.html))
    || (pages.earn.ok && isRewardsShell(pages.earn.html))
    || pages.shellSignedOut
  ) && !(Number(trio.available) > 0);
  /* D04=B：以可解析积分余额 / 可见面板信号为主，页面文案单独出现不判登出。 */
  const evidence = {
    available: Number.isFinite(trio.available) ? trio.available : null,
    panelSignedIn: !!(snap && !snap.signedOut && snap.rows && snap.rows.length),
    panelSignedOut: snap ? !!snap.signedOut : undefined,
    pageTextSignedOut: !!pages.signedOut || shellSignedOut,
    shellSignedOut: shellSignedOut,
    explicitLogout: false,
    hasFreshData: !!pages.reachable
  };
  /* D05=D：确认登出 → 隐藏当前可用余额，历史 / 今日值标「上次记录」，不删记录。 */
  if (HSA_CORE.isConfirmedLogout(evidence)) {
    const out = HSA_CORE.logoutPresentation(prevPs);
    await store({ pointsSummary: out.pointsSummary, loginStatus: 'out',
                  loginCheckedAt: Date.now() });
    return {
      ok: false, balance: null, counter: null, signedOut: true, reachable: !!pages.reachable,
      reason: 'signedOut', pointsSummary: out.pointsSummary, todayTasks: prevTt,
      todaySearch: prevSearch, loginStatus: 'out', items: [], changed: ['pointsSummary', 'loginStatus']
    };
  }
  const keep = (v, key) => Number.isFinite(v) ? v
    : (Number.isFinite(prevPs[key]) ? prevPs[key] : null);

  let cards = taskItemsFromPages(pages);
  if (!cards.length && pages.reachable && !(o.skipInjection)) {
    const r = await readRewardsPage(EARN_URL, url => pathStarts(url, '/earn'),
      readTaskCardsFromDom, o.token == null ? flowToken : o.token);
    if (r && r.ok && Array.isArray(r.rows)) {
      cards = r.rows.map(x => Object.assign({}, x, { category: sectionLabel(x.section) }))
        .filter(x => x.points > 0 && SECTION_LABEL[x.section]);
    }
    await closeTab('rewardsTabId').catch(() => {});
  }
  /* D02=D：总是允许新鲜页面快照补缺；官网本次已确认的卡片状态优先，旧快照不覆盖。 */
  const merged = HSA_CORE.mergeSnapshotCards(cards, snap && snap.rows, {
    now: Date.now(), snapshotAt: snap && snap.at,
    snapshotUrl: snap && snap.url, snapshotSignedOut: snap && snap.signedOut
  });
  cards = merged.cards;
  let approx = false;
  if (!cards.length && pages.earn.ok) cards = rowsFromProgressTable(pages.earn.html);
  if (!cards.length) { cards = await fallbackTaskItems(); approx = true; }

  const counter = pages.earn.ok ? parseSearchCounter(pages.earn.html) : null;
  const items = [searchItemFromCounter(counter, prevSearch),
                 ...cards.filter(i => i.section !== 'search')];
  /* D03=B：两页失败但当前账号的新鲜可见页面有数据时允许降级同步，界面标注「页面数据」。 */
  const degrade = HSA_CORE.degradedSync(snap, { pagesReachable: !!pages.reachable, now: Date.now() });
  const pointsSummary = {
    available: keep(trio.available, 'available'),
    today: keep(trio.today, 'today'),
    claimable: keep(trio.claimable, 'claimable'),
    signedOut: false,
    updatedAt: Date.now(),
    collectedAt: pages.collectedAt || (snap && snap.at) || Date.now(),
    dataSourceLabel: degrade.label,
    dataSourceLabelEn: degrade.labelEn,
    degraded: !!degrade.degraded,
    sources: [pages.dash.ok && '/dashboard', pages.earn.ok && '/earn',
      degrade.degraded && 'fresh-visible-page'].filter(Boolean)
  };
  const signedIn = Number.isFinite(pointsSummary.available) && !shellSignedOut;
  const hasRealTasks = cards.length > 0 && !approx;
  const loginStatus = HSA_CORE.loginStateFromEvidence(Object.assign({}, evidence, {
    available: signedIn ? pointsSummary.available : evidence.available,
    panelSignedIn: !!signedIn || evidence.panelSignedIn,
    hasFreshData: degrade.ok
  }));
  const todayTasks = summarizeTaskItems(items, { approx: approx, signedOut: false });
  const todaySearch = counter || prevSearch || null;

  const candidate = {
    pointsSummary: pointsSummary, todayTasks: todayTasks,
    todaySearch: todaySearch, loginStatus: loginStatus
  };
  const patch = Object.assign({}, o.extra || {});
  for (const [k, v] of Object.entries(candidate)) {
    const before = k === 'pointsSummary' ? prevPs : k === 'todayTasks' ? prevTt
      : k === 'todaySearch' ? prevSearch : prevLogin;
    if (!sameBusiness(before, v)) patch[k] = v;
  }
  if (Object.keys(patch).length) await store(patch);
  const readData = degrade.ok;
  const outOnly = loginStatus === 'out' && !signedIn && !hasRealTasks;
  const ok = readData && !outOnly && !pages.signedOut && !shellSignedOut;
  return {
    ok: ok, balance: pages.dash.ok ? parseBalance(pages.dash.html) : null,
    counter: counter, signedOut: loginStatus === 'out',
    reachable: readData,
    degraded: !!degrade.degraded, dataSourceLabel: degrade.label,
    snapshotApplied: !!merged.snapshotApplied, snapshotAdded: merged.added,
    reason: ok ? (o.reason || 'manual')
      : (shellSignedOut ? 'shellSignedOut'
         : (pages.signedOut || loginStatus === 'out' ? 'signedOut' : 'unreachable')),
    pointsSummary: pointsSummary,
    todayTasks: todayTasks, todaySearch: todaySearch,
    loginStatus: loginStatus, items: items, changed: Object.keys(patch)
  };
}

const refreshTodayTasks = async function (token) {
  const r = await syncRewardsUnified({ fresh: true, reason: 'refreshTasks', token: token });
  return { ok: r.ok, signedOut: r.signedOut, count: (r.todayTasks.items || []).length };
};

const OFFICIAL_PANEL_URL = 'https://rewards.bing.com/dashboard';
let panelOpInFlight = null;
let lastPanelSyncAt = 0;

async function getPanelTabId() {
  if (panelTabIdCache) return panelTabIdCache;
  const s = await load(['officialPanelTabId']);
  panelTabIdCache = s.officialPanelTabId || null;
  syncPanelTabWatchers();
  return panelTabIdCache;
}
async function setPanelOpenState(open) {
  await store({ panelOpen: !!open });
}
async function openOfficialTab(url) {
  const target = (url && /^https:\/\/(rewards\.bing\.com|login\.live\.com|account\.live\.com|account\.microsoft\.com)\//i.test(url))
    ? url : OFFICIAL_PANEL_URL;
  if (panelOpInFlight) return panelOpInFlight;
  panelOpInFlight = (async () => {
    let id = await getPanelTabId();
    const cur = id ? await chrome.tabs.get(id).catch(() => null) : null;
    if (cur) {
      await chrome.tabs.update(id, { active: true, url: target }).catch(() => {});
    } else {
      const tab = await chrome.tabs.create({ url: target, active: true });
      id = tab && tab.id;
    }
    panelTabIdCache = id || null;
    await store({ officialPanelTabId: panelTabIdCache });
    syncPanelTabWatchers();
    await setPanelOpenState(true);
    return { ok: true, open: true, tabId: id };
  })();
  try { return await panelOpInFlight; }
  finally { panelOpInFlight = null; }
}
async function hideOfficialTab() {
  const id = await getPanelTabId();
  if (id) await chrome.tabs.remove(id).catch(() => {});
  panelTabIdCache = null;
  syncPanelTabWatchers();
  await store({ officialPanelTabId: null });
  await setPanelOpenState(false);
  return { ok: true, open: false };
}
async function handlePanelMessage(msg) {
  const id = await getPanelTabId();
  const tab = id ? await chrome.tabs.get(id).catch(() => null) : null;
  if (msg.type === 'panelState') {
    const open = !!tab;
    const cur = await load(['panelOpen']);
    if (!!cur.panelOpen !== open) await setPanelOpenState(open);
    return { ok: true, open };
  }
  if (msg.type === 'hidePanel') return hideOfficialTab();
  if (msg.type === 'togglePanel') return tab ? hideOfficialTab() : openOfficialTab(msg.url);
  return openOfficialTab(msg.url);   
}

let panelTabIdCache = null;
let panelWatchersOn = false;

function onPanelTabRemoved(tabId) {
  if (!panelTabIdCache || tabId !== panelTabIdCache) return;
  panelTabIdCache = null;
  syncPanelTabWatchers();
  store({ officialPanelTabId: null }).catch(() => {});
  setPanelOpenState(false).catch(() => {});
}

function onPanelTabUpdated(tabId, info, tab) {
  if (info.status !== 'complete' || !panelTabIdCache || tabId !== panelTabIdCache) return;
  if (!/^https:\/\/rewards\.bing\.com\//i.test(String(tab && tab.url || ''))) return;
  if (Date.now() - lastPanelSyncAt < 5000) return;
  lastPanelSyncAt = Date.now();
  syncRewardsUnified({ reason: 'login-return' })
    .then(r => store({ syncNotice: { at: Date.now(), reason: 'login-return',
      ok: !!r.ok, changed: (r.changed || []).length } }))
    .catch(() => {});
}

/* 只有官网面板标签页存在时才挂载 tabs 监听；空闲时 SW 完全不被标签事件唤醒。 */
function syncPanelTabWatchers() {
  const want = !!panelTabIdCache;
  if (want === panelWatchersOn) return;
  if (want) {
    chrome.tabs.onRemoved.addListener(onPanelTabRemoved);
    chrome.tabs.onUpdated.addListener(onPanelTabUpdated);
  } else {
    chrome.tabs.onRemoved.removeListener(onPanelTabRemoved);
    chrome.tabs.onUpdated.removeListener(onPanelTabUpdated);
  }
  panelWatchersOn = want;
}

load(['officialPanelTabId']).then(s => {
  panelTabIdCache = s.officialPanelTabId || null;
  syncPanelTabWatchers();
}).catch(() => {});

chrome.debugger.onDetach.addListener(source => {
  if (source && Number.isFinite(source.tabId)) cdpAttached.delete(Number(source.tabId));
});

const EMBEDDED_PANEL_FILE = 'sidepanel.html';
const EMBEDDED_PANEL_READY_MS = 9000;      
const EMBEDDED_PANEL_RPC_MS = 8000;        
const EMBEDDED_PANEL_WIDTH = 430;
const EMBEDDED_PANEL_HEIGHT = 820;

let embeddedPanelWindowId = null;
const flyoutPorts = new Map();             
const sidePanelPorts = new Set();          
let hsaRpcSeq = 0;
const hsaRpcWaiters = new Map();

chrome.runtime.onConnect.addListener(port => {
  if (port && port.name === 'hsa-flyout') {
    const rec = { url: '', inIframe: false, at: Date.now() };
    flyoutPorts.set(port, rec);
    port.onMessage.addListener(msg => {
      if (!msg) return;
      if (msg.__hsaRpc === 'ready') {
        rec.url = String(msg.url || '');
        rec.inIframe = !!msg.inIframe;
        rec.at = Date.now();
        return;
      }
      if (msg.__hsaRpcId != null) {
        const w = hsaRpcWaiters.get(msg.__hsaRpcId);
        if (w) {
          hsaRpcWaiters.delete(msg.__hsaRpcId);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });
    port.onDisconnect.addListener(() => flyoutPorts.delete(port));
    return;
  }
  if (port && port.name === 'hsa-sidepanel') {
    sidePanelPorts.add(port);
    port.onMessage.addListener(() => {  });
    port.onDisconnect.addListener(() => sidePanelPorts.delete(port));
  }
});

function hsaRpc(port, action, payload, ms) {
  return new Promise(resolve => {
    const id = ++hsaRpcSeq;
    const timer = setTimeout(() => {
      hsaRpcWaiters.delete(id);
      resolve({ ok: false, reason: 'timeout', action });
    }, ms || EMBEDDED_PANEL_RPC_MS);
    hsaRpcWaiters.set(id, { resolve, timer });
    try { port.postMessage({ __hsaRpcId: id, action, payload: payload || {} }); }
    catch (err) {
      clearTimeout(timer); hsaRpcWaiters.delete(id);
      resolve({ ok: false, reason: 'post-failed:' + String(err && err.message || err) });
    }
  });
}

function pickFlyoutPort() {
  let best = null;
  for (const [port, rec] of flyoutPorts) {
    if (!/\/rewards\/panelflyout/i.test(rec.url || '')) continue;
    if (!best || rec.at > best.at) best = { port, at: rec.at, inIframe: rec.inIframe };
  }
  return best ? best.port : null;
}

async function waitForFlyoutPort(ms, token) {
  const deadline = Date.now() + (Number(ms) || 0);
  while (Date.now() < deadline && isCurrent(token)) {
    const port = pickFlyoutPort();
    if (port) return port;
    await sleep(220);
  }
  return pickFlyoutPort();
}

let lastPanelStatusText = '';
let lastPanelStatusAt = 0;

function broadcastPanelStatus(text, cls) {
  const t = String(text || '');
  const now = Date.now();
  if (cls !== 'done' && (t === lastPanelStatusText || now - lastPanelStatusAt < 800)) return;
  lastPanelStatusText = t;
  lastPanelStatusAt = now;
  const msg = { __hsaPanel: 'status', text: t, cls: cls || '' };
  for (const port of sidePanelPorts) {
    try { port.postMessage(msg); } catch {}
  }
  try { chrome.runtime.sendMessage(Object.assign({ type: 'hsa.sidepanel.status' }, msg)).catch(() => {}); } catch {}
}

async function ensureEmbeddedPanel(token) {
  if (sidePanelPorts.size) return { mode: 'sidePanel', tabId: null, windowId: null, reused: true };

  if (typeof chrome !== 'undefined' && chrome.sidePanel
      && typeof chrome.sidePanel.open === 'function') {
    try {
      const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active && active[0] && active[0].id != null) {
        await chrome.sidePanel.open({ tabId: active[0].id });
        await sleep(700);
        if (sidePanelPorts.size)
          return { mode: 'sidePanel', tabId: null, windowId: null, reused: false };
      }
    } catch (err) {
      console.info('[AutoTask] 原生侧栏需用户手势，改用扩展内部侧栏窗口：'
        + String(err && err.message || err).slice(0, 90));
    }
  }

  if (embeddedPanelWindowId != null) {
    try {
      const w = await chrome.windows.get(embeddedPanelWindowId);
      if (w && w.id != null) {
        const tabs = await chrome.tabs.query({ windowId: w.id });
        if (tabs && tabs[0] && tabs[0].id != null)
          return { mode: 'window', tabId: tabs[0].id, windowId: w.id, reused: true };
      }
    } catch {}
    embeddedPanelWindowId = null;
  }

  let left, top;
  try {
    const cur = await chrome.windows.getCurrent();
    if (cur && Number.isFinite(cur.width) && Number.isFinite(cur.left)) {
      left = Math.max(0, cur.left + cur.width - EMBEDDED_PANEL_WIDTH);
      top = Number.isFinite(cur.top) ? cur.top : 0;
    }
  } catch {}
  const opts = {
    url: chrome.runtime.getURL(EMBEDDED_PANEL_FILE),
    type: 'popup', width: EMBEDDED_PANEL_WIDTH, height: EMBEDDED_PANEL_HEIGHT,
    focused: false                      
  };
  if (Number.isFinite(left)) { opts.left = left; opts.top = top; }
  const win = await chrome.windows.create(opts);
  embeddedPanelWindowId = win && win.id != null ? win.id : null;
  let tabId = null;
  try {
    const tabs = await chrome.tabs.query({ windowId: win.id });
    if (tabs && tabs[0]) tabId = tabs[0].id;
  } catch {}
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch {}
  console.info('[AutoTask] 已打开插件内部侧栏窗口（windowId=' + win.id
    + ', tabId=' + tabId + '），iframe 加载 ' + PRIMARY_FLYOUT_URL);
  return { mode: 'window', tabId, windowId: win.id, reused: false };
}

async function injectFlyoutBridgeFallback(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, files: ['flyout-bridge.js'], allFrames: true
    });
    console.info('[AutoTask] 已向侧栏 iframe 主动注入 flyout-bridge.js');
    return true;
  } catch (err) {
    console.warn('[AutoTask] 主动注入失败：' + String(err && err.message || err).slice(0, 120));
    return false;
  }
}

async function closeEmbeddedPanel(panel) {
  if (!panel) return;
  if (panel.mode === 'window' && panel.windowId != null) {
    try { await chrome.windows.remove(panel.windowId); } catch {}
    if (embeddedPanelWindowId === panel.windowId) embeddedPanelWindowId = null;
    console.info('[AutoTask] 点击任务卡片流程结束：已关闭插件内部侧栏窗口');
  } else if (panel.mode === 'sidePanel') {
    try {
      if (chrome.sidePanel && typeof chrome.sidePanel.close === 'function')
        await chrome.sidePanel.close();
    } catch {}
    try { chrome.runtime.sendMessage({ type: 'hsa.sidepanel.close' }).catch(() => {}); } catch {}
    for (const p of sidePanelPorts) {
      try { p.postMessage({ __hsaPanel: 'close' }); } catch {}
    }
    console.info('[AutoTask] 点击任务卡片流程结束：已请求关闭原生侧栏页面');
  }
}

async function reloadFlyoutPage(port, panel, token) {
  const oldPort = port;
  const startedAt = Date.now();
  if (panel && panel.tabId != null) {
    try { await chrome.tabs.reload(panel.tabId); } catch {}
  } else {
    try { await hsaRpc(port, 'reload', {}, 1000); } catch {}
  }
  const deadline = startedAt + (EMBEDDED_PANEL_READY_MS || 9000);
  while (Date.now() < deadline && isCurrent(token)) {
    let best = null;
    for (const [p, rec] of flyoutPorts) {
      if (p === oldPort) continue;
      if (!/\/rewards\/panelflyout/i.test(rec.url || '')) continue;
      if (rec.at < startedAt) continue;      
      if (!best || rec.at > best.at) best = { port: p, at: rec.at };
    }
    if (best) return best.port;
    await sleep(220);
  }
  return null;   
}

async function releasePanelRuntime() {
  for (const port of flyoutPorts.keys()) { try { port.disconnect(); } catch {} }
  flyoutPorts.clear();
  for (const port of sidePanelPorts) { try { port.disconnect(); } catch {} }
  sidePanelPorts.clear();
  for (const w of hsaRpcWaiters.values()) clearTimeout(w.timer);
  hsaRpcWaiters.clear();
  lastPanelStatusText = '';
  await cdpDetachAll().catch(() => {});
}

async function runEmbeddedPanelTasks(token, stat) {
  const holder = { panel: null };
  try {
    return await runEmbeddedPanelTasksFlow(token, stat, holder);
  } finally {
    if (holder.panel) await closeEmbeddedPanel(holder.panel).catch(() => {});
    await releasePanelRuntime();
  }
}

async function runEmbeddedPanelTasksFlow(token, stat, holder) {
  const cfg = await getSettings();
  const includeDone = !!cfg.dontSkipCompletedCards;
  const taskStates = await getRunTaskStates();
  broadcastPanelStatus('正在打开插件内部侧栏…', 'running');

  let panel;
  try { panel = await ensureEmbeddedPanel(token); }
  catch (err) {
    return { ok: false, reason: 'panel-open:' + String(err && err.message || err).slice(0, 100) };
  }
  holder.panel = panel;

  let port = await waitForFlyoutPort(EMBEDDED_PANEL_READY_MS, token);
  if (!port && panel.tabId != null) {
    await injectFlyoutBridgeFallback(panel.tabId);
    port = await waitForFlyoutPort(4000, token);
  }
  if (!port) return { ok: false, reason: 'no-flyout-bridge', mode: panel.mode };

  broadcastPanelStatus('正在重新加载侧栏页面…', 'running');
  port = await reloadFlyoutPage(port, panel, token);
  if (!port) return { ok: false, reason: 'reload-no-bridge', mode: panel.mode };
  const stateRes = await hsaRpc(port, 'setTaskStates', { tasks: taskStates });
  if (!stateRes || !stateRes.ok)
    return { ok: false, reason: 'task-states-failed', mode: panel.mode };
  console.info('[AutoTask] 已下发主界面任务状态 ' + (stateRes.states || 0)
    + ' 项（待完成 ' + (stateRes.pending || 0) + ' 项）'
    + (includeDone ? '；不跳过已完成卡' : '；跳过主界面已完成的卡'));

  const infoRes = await hsaRpc(port, 'info', {});
  if (!infoRes || !infoRes.ok)
    return { ok: false, reason: 'info-failed', mode: panel.mode };
  if (infoRes.signedOut) {
    console.warn('[AutoTask] 插件内部侧栏显示未登录（'
      + (infoRes.shellSignedOut ? '页面内联 isRewardsUser:false 空壳'
         : '第三方 Cookie 限制 / 登录页文案')
      + '），回退到独立标签页流程。可在侧栏点「在标签页登录」。');
    return { ok: false, reason: infoRes.shellSignedOut
      ? 'shell-signed-out-in-iframe' : 'signed-out-in-iframe', mode: panel.mode };
  }

  console.info('[AutoTask] 插件内部侧栏已加载（宿主 ' + panel.mode
    + '，iframe=' + !!infoRes.inIframe + '，flyoutRoot=' + infoRes.hasFlyoutRoot
    + '，当前卡片 ' + infoRes.cardsNow + '（含目标链接 ' + (infoRes.withTarget || 0)
    + '，官方活动 ' + (infoRes.officialTasks || 0) + '），页高 ' + infoRes.scrollHeight + 'px）'
    + (includeDone ? '，不跳过已完成卡（点全部）' : '，只点主界面显示未完成的任务卡'));
  /* T01=D：按宿主能力优先真实交互路径；扩展内部 iframe 无法 attach debugger，
     因此这里明确记录使用页面真实交互，不把 CDP 当作成功条件。 */
  console.info('[AutoTask] 触发方式：' + HSA_CORE.triggerPlan(false).label
    + '（扩展内部 iframe 不支持 CDP attach；实际方式逐卡记录）');
  stat.states = stat.states || HSA_CORE.newClickResult();
  HSA_CORE.recordTrigger(stat.states, 'page-interaction', 'embedded iframe 无 CDP 权限');

  const merged = [], seen = new Set();
  const keyOf = c => HSA_CORE.taskCardKey(c);
  const add = list => {
    for (const c of (Array.isArray(list) ? list : [])) {
      const k = keyOf(c);
      if (!k || seen.has(k)) continue;
      seen.add(k); merged.push(c);
    }
  };
  let skippedTotal = 0;
  const skippedSeen = new Set();   

  const first = await hsaRpc(port, 'scrollOuter', { y: 0 });
  let height = Number(first && first.scrollHeight) || 800;
  const viewport = Number(first && first.viewport) || 700;
  const step = Math.max(280, Math.round(viewport * 0.7));
  let segments = 0;
  for (let y = 0; y <= height && segments < FLYOUT_SCAN_MAX_SEGMENTS
       && isCurrent(token); y += step) {
    await hsaRpc(port, 'scrollOuter', { y });
    await nap(FLYOUT_SCAN_STEP_MS, token);
    const snap = await hsaRpc(port, 'scan', { includeDone });
    if (snap && Array.isArray(snap.cards)) add(snap.cards);
    if (snap && Array.isArray(snap.skipped)) {
      for (const sk of snap.skipped) {
        const k = String(sk.title || '');
        if (k && !skippedSeen.has(k)) { skippedSeen.add(k); skippedTotal++; }
      }
    }
    segments++;
    broadcastPanelStatus('滚动侧栏 ' + (segments) + ' 段，已收集 ' + merged.length + ' 张积分卡…', 'running');
    if (snap && Number(snap.scrollHeight) > height) height = Number(snap.scrollHeight);
  }

  await hsaRpc(port, 'scrollOuter', { y: 0 });
  const scRes = await hsaRpc(port, 'scrollers', {});
  const scrollers = (scRes && Array.isArray(scRes.scrollers)) ? scRes.scrollers : [];
  let innerSegments = 0;
  for (const sc of scrollers) {
    const max = Number(sc.max) || 0;
    if (max <= 0) continue;
    const stepInner = Math.max(120, Math.round((Number(sc.view) || 400) * 0.7));
    for (let y = 0; y <= max && innerSegments < FLYOUT_INNER_MAX_SEGMENTS
         && isCurrent(token); y += stepInner) {
      await hsaRpc(port, 'scrollInner', { idx: sc.idx, y });
      await nap(FLYOUT_SCAN_STEP_MS, token);
      const snap = await hsaRpc(port, 'scan', { includeDone });
      if (snap && Array.isArray(snap.cards)) add(snap.cards);
      if (snap && Array.isArray(snap.skipped)) {
      for (const sk of snap.skipped) {
        const k = String(sk.title || '');
        if (k && !skippedSeen.has(k)) { skippedSeen.add(k); skippedTotal++; }
      }
    }
      innerSegments++;
    }
    await hsaRpc(port, 'scrollInner', { idx: sc.idx, y: max });
    await nap(FLYOUT_SCAN_STEP_MS, token);
    const tail = await hsaRpc(port, 'scan', { includeDone });
    if (tail && Array.isArray(tail.cards)) add(tail.cards);
    await hsaRpc(port, 'scrollInner', { idx: sc.idx, y: 0 });
  }
  await nap(FLYOUT_SCAN_SETTLE_MS, token);

  merged.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  if (merged.length) {
    console.info('[AutoTask] 待点任务卡（按侧栏顺序）：'
      + merged.map((c, i) => (i + 1) + '.' + (c.title || '').slice(0, 18)).join(' → '));
  }

  console.info('[AutoTask] 插件内部侧栏滚动完成：外层 ' + segments
    + ' 段（页高 ' + height + 'px）+ 内部滚动条 ' + scrollers.length
    + ' 个 / ' + innerSegments + ' 段，共收集 ' + merged.length
    + ' 张含积分卡片，跳过 ' + skippedTotal + ' 张'
    + '；逐张点击间隔 ' + TASK_CLICK_INTERVAL_MS + 'ms');

  const tabSnapshot = async () => {
    try {
      const list = await chrome.tabs.query({});
      return new Set((list || []).map(t => t.id));
    } catch { return new Set(); }
  };
  let clicked = 0, openedTabs = 0, aimFailed = 0, noTarget = 0;
  let selfOpened = 0;
  const follow = HSA_CORE.followupPolicy();
  for (let i = 0; i < merged.length && isCurrent(token); i++) {
    const c = merged[i];
    await taskClickSpacing(token);
    broadcastPanelStatus('处理第 ' + (i + 1) + '/' + merged.length + ' 张：'
      + (c.title || '').slice(0, 22) + ' (+' + c.points + ')', 'running');
    const payload = { idx: c.idx, href: c.href, title: c.title, includeDone };
    const aim = await hsaRpc(port, 'aim', payload);
    if (!aim || !aim.ok) {
      aimFailed++;
      HSA_CORE.recordClick(stat.states, 'failed');
      console.warn('[AutoTask] ✗ 侧栏内无法定位「' + (c.title || '').slice(0, 26) + '」');
      continue;
    }
    const before = await tabSnapshot();
    const res = await hsaRpc(port, 'click', payload);
    if (!res || !res.ok) {
      HSA_CORE.recordClick(stat.states, 'failed');
      console.warn('[AutoTask] ✗ 侧栏内点击失败「' + (c.title || '').slice(0, 26) + '」：'
        + ((res && res.reason) || '无返回'));
      continue;
    }
    await nap(1500, token);
    const after = await tabSnapshot();
    let created = 0;
    for (const id of after) if (!before.has(id)) created++;
    const url = String(res.targetUrl || res.href || c.targetUrl || c.href || '');
    /* T05=D：点击没出现新任务页时先重新定位一次，仍无反馈绝不代开链接、
       也不把「打开网页」冒充「官网确认完成」。 */
    if (!created && follow.relocateRetries > 0) {
      const reAim = await hsaRpc(port, 'aim', payload);
      if (reAim && reAim.ok) {
        const reClick = await hsaRpc(port, 'click', payload);
        if (reClick && reClick.ok) await nap(1200, token);
      }
      const after2 = await tabSnapshot();
      for (const id of after2) if (!before.has(id)) created++;
    }
    HSA_CORE.recordClick(stat.states, 'clickSent');
    HSA_CORE.recordTrigger(stat.states, 'page-interaction', '侧栏 iframe 页面原生交互');
    if (created > 0) {
      HSA_CORE.recordClick(stat.states, 'pageOpened', created);
      selfOpened++;
      clicked = stat.states.clickSent;
      openedTabs = stat.states.pageOpened;
      console.info('[AutoTask] ✓ 第 ' + (i + 1) + '/' + merged.length + ' 张「'
        + (res.title || '').slice(0, 30) + '」：页面自身真实打开 ' + created
        + ' 个任务页（+' + res.points + '）');
    } else {
      HSA_CORE.recordClick(stat.states, 'unconfirmed');
      noTarget++;
      if (follow.showManualLink && /^https?:\/\//i.test(url) &&
          stat.states.manualLinks.length < 20) {
        stat.states.manualLinks.push({ title: String(c.title || res.title || '未确认任务'), url: url });
      }
      console.warn('[AutoTask] ✗ 第 ' + (i + 1) + '/' + merged.length + ' 张「'
        + (c.title || '').slice(0, 26) + '」重定位后仍无任务页反馈：标记为未确认'
        + (follow.showManualLink ? '，已提供可手动打开的链接' : ''));
    }
    broadcastPanelStatus('已打开 ' + stat.states.pageOpened + ' 个任务页 / 处理 '
      + (i + 1) + '/' + merged.length + ' 张', 'running');
    await nap(400, token);
  }


  stat.pages = stat.pages || [];
  stat.pages.push({ page: 'embedded-flyout', clicked: stat.states.clickSent,
    anchors: merged.length, doneSkipped: skippedTotal, aimFailed,
    selfOpened, noTarget, unconfirmed: stat.states.unconfirmed });
  stat.real = true;
  /* T06=D：三者互不冒充，界面分别显示「已发出点击 / 已打开页面 / 官网确认」。 */
  stat.clicked = stat.states.clickSent;
  stat.openedTabs = stat.states.pageOpened;
  stat.domClick = stat.states.clickSent;
  stat.officialConfirmed = stat.states.officialConfirmed;
  stat.unconfirmed = stat.states.unconfirmed;
  stat.manualLinks = stat.states.manualLinks;
  stat.triggerMethods = stat.states.triggerMethods;
  stat.noTarget = noTarget;
  stat.aimFailed = (stat.aimFailed || 0) + aimFailed;
  console.info('[AutoTask] 结果三态：已发出点击 ' + stat.states.clickSent
    + ' / 已打开页面 ' + stat.states.pageOpened
    + ' / 官网确认 ' + stat.states.officialConfirmed
    + ' / 未确认 ' + stat.states.unconfirmed);
  broadcastPanelStatus('完成：实际打开 ' + stat.states.pageOpened + ' 个任务页，共 '
    + merged.length + ' 张，未确认 ' + stat.states.unconfirmed + ' 张', 'done');


  return { ok: true, clicked: stat.states.clickSent, openedTabs: stat.states.pageOpened,
    selfOpened, noTarget, states: stat.states,
    mode: panel.mode, ready: true,
    segments, innerSegments, scrollers: scrollers.length };
}

function hsaHistoryDayKey(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0')
    + '-' + String(x.getDate()).padStart(2, '0');
}
async function recordPointsHistory(sync) {
  try {
    const snap = await load(['pointsHistory', 'pointsSummary']);
    const hist = (snap && snap.pointsHistory && typeof snap.pointsHistory === 'object')
      ? Object.assign({}, snap.pointsHistory) : {};
    const ps = (sync && sync.pointsSummary) || (snap && snap.pointsSummary) || {};
    const key = hsaHistoryDayKey();
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
const baseSyncRewardsUnifiedForHistory = syncRewardsUnified;
syncRewardsUnified = async function (opts) {
  const r = await baseSyncRewardsUnifiedForHistory(opts);
  try { await recordPointsHistory(r); } catch {}
  return r;
};

