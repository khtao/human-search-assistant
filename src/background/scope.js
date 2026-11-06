/* 作用域：所有导航、注入、CDP 输入都严格绑定到唯一 tabId。
 * 这是「运行时只影响单个页面」的硬约束：任何越界 tabId 都会被拒绝。
 * halt() 会立即打断导航等待，保证点「停止」后不残留任何页面动作。 */
import { BUSY_STATES } from "../lib/messages.js";
import { getSettings, getRunState, setRunState } from "./store.js";

let cachedScope = null;
let previousActiveTabId = null;

/* ------------------------------------------------------------ 停止中断 */
let halted = false;
const haltListeners = new Set();
export function resume() { halted = false; }
export function halt() {
  halted = true;
  for (const fn of [...haltListeners]) { try { fn(); } catch (_) { /* ignore */ } }
  haltListeners.clear();
}
export function isHalted() { return halted; }
function onHalt(fn) {
  if (halted) { fn(); return () => {}; }
  haltListeners.add(fn);
  return () => haltListeners.delete(fn);
}
/** 可被 halt() 立即打断的延时（无 abort 时等价于 setTimeout）。 */
function delay(ms) {
  return new Promise((resolve) => {
    let off = () => {};
    const timer = setTimeout(done, Math.max(0, ms));
    off = onHalt(done);
    function done() { clearTimeout(timer); off(); resolve(); }
  });
}

/* ------------------------------------------------------------ 作用域 */
export async function getScope() {
  if (cachedScope != null) return cachedScope;
  const run = await getRunState();
  cachedScope = run.scopeTabId ?? null;
  return cachedScope;
}
export async function setScope(tabId) {
  cachedScope = tabId ?? null;
  const run = await getRunState();
  await setRunState({ ...run, scopeTabId: cachedScope });
  return cachedScope;
}
export async function assertScope(tabId) {
  const cur = await getScope();
  if (cur == null || Number(tabId) !== Number(cur)) {
    throw new Error(`作用域校验失败：本次运行只允许操作标签页 #${cur ?? "未设置"}（收到 #${tabId}）`);
  }
  return cur;
}

/* ------------------------------------------- MAIN world 单页守卫 */
function installGuard() {
  if (window.__mraGuard) return true;
  const state = { open: window.open, observer: null };
  window.__mraGuard = state;
  window.open = function (url) {
    if (url) {
      try { window.location.href = String(url); return null; } catch (_) { /* fallthrough */ }
    }
    return state.open.apply(window, arguments);
  };
  const fix = () => {
    try {
      for (const a of document.querySelectorAll('a[target="_blank"]')) {
        if (!a.hasAttribute("data-mra-target")) {
          a.setAttribute("data-mra-target", a.getAttribute("target") || "_blank");
        }
        a.setAttribute("target", "_self");
      }
    } catch (_) { /* ignore */ }
  };
  fix();
  try {
    state.observer = new MutationObserver(fix);
    state.observer.observe(document.documentElement,
      { subtree: true, childList: true, attributes: true, attributeFilter: ["target"] });
  } catch (_) { /* ignore */ }
  return true;
}
function removeGuard() {
  const state = window.__mraGuard;
  if (!state) return true;
  try { window.open = state.open; } catch (_) { /* ignore */ }
  try { state.observer && state.observer.disconnect(); } catch (_) { /* ignore */ }
  try {
    for (const a of document.querySelectorAll("a[data-mra-target]")) {
      a.setAttribute("target", a.getAttribute("data-mra-target") || "_blank");
      a.removeAttribute("data-mra-target");
    }
  } catch (_) { /* ignore */ }
  delete window.__mraGuard;
  return true;
}
export async function applyGuard(tabId, enabled) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN", func: enabled ? installGuard : removeGuard,
    });
  } catch (_) { /* 页面可能正在导航 */ }
}

/* ------------------------------------------------------------ 建立 / 释放 */
export async function ensureScope(options = {}) {
  const s = options.settings || await getSettings();
  // 定时自动启动在后台标签页运行，不打断用户当前正在看的页面
  const background = Boolean(options.background);
  const cur = await getScope();
  if (cur != null) {
    try {
      const tab = await chrome.tabs.get(cur);
      if (tab && !tab.discarded) {
        if (s.forceSingleTab) await applyGuard(cur, true);
        return cur;
      }
    } catch (_) { /* 标签页已关闭，重新创建 */ }
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  previousActiveTabId = background ? null : (active?.id ?? null);
  const tab = await chrome.tabs.create({ url: s.officialHome, active: !background });
  await delay(500);
  await setScope(tab.id);
  if (s.forceSingleTab) await applyGuard(tab.id, true);
  return tab.id;
}

export async function waitForLoad(tabId, timeoutMs = 12000) {
  if (halted) return;
  await assertScope(tabId);
  return new Promise((resolve) => {
    let finished = false;
    let offHalt = () => {};
    let handler = null;
    let timer = null;
    const done = () => {
      if (finished) return;
      finished = true;
      if (handler) chrome.tabs.onUpdated.removeListener(handler);
      offHalt();
      if (timer) clearTimeout(timer);
      resolve();
    };
    handler = (id, info) => {
      if (id === Number(tabId) && info.status === "complete") done();
    };
    offHalt = onHalt(done);
    timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(handler);
  });
}

export async function navigate(tabId, url) {
  if (halted) return;
  await assertScope(tabId);
  const current = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (current && current.url === url) {
    await delay(1100);   // 已在该页面，避免等一个不会触发的 complete 事件
    return;
  }
  await chrome.tabs.update(Number(tabId), { url });
  await delay(450);
  await waitForLoad(tabId);
  await delay(450);
}

export async function reload(tabId) {
  if (halted) return;
  await assertScope(tabId);
  await chrome.tabs.reload(Number(tabId));
  await delay(450);
  await waitForLoad(tabId);
}

export async function goBack(tabId) {
  if (halted) return;
  await assertScope(tabId);
  try { await chrome.tabs.goBack(Number(tabId)); } catch (_) { /* ignore */ }
  await delay(900);
}

/** 运行期间由作用域页触发的新标签页：关掉，并把地址收敛回作用域页。 */
export async function handleCreatedTab(tab) {
  const cur = await getScope();
  if (cur == null || tab.id === cur || tab.openerTabId !== cur) return;
  const run = await getRunState();
  if (!BUSY_STATES.includes(run.state)) return;
  const s = await getSettings();
  if (!s.forceSingleTab) return;
  try {
    const url = tab.pendingUrl || tab.url;
    await chrome.tabs.remove(tab.id);
    if (url && /^https?:/i.test(url)) await chrome.tabs.update(cur, { url });
  } catch (_) { /* 标签可能已被用户关闭 */ }
}

export async function releaseScope({ closeTab = false, tabId = null } = {}) {
  const cur = await getScope();
  const target = tabId == null ? cur : Number(tabId);
  if (target == null) return;
  // 竞态保护：旧运行的延迟清理不能覆盖新一轮已经建立的作用域。
  if (cur != null && Number(target) !== Number(cur)) return;
  await applyGuard(target, false);
  try {
    if (closeTab) await chrome.tabs.remove(target);
    else if (previousActiveTabId != null) {
      const prev = await chrome.tabs.get(previousActiveTabId);
      await chrome.tabs.update(prev.id, { active: true });
    }
  } catch (_) { /* 原标签页可能已关闭 */ }
  previousActiveTabId = null;
  await setScope(null);
}

export async function scopeLabel() {
  const cur = await getScope();
  if (cur == null) return "未设置";
  try {
    const t = await chrome.tabs.get(cur);
    return `#${cur} · ${(t.title || t.url || "").slice(0, 40)}`;
  } catch (_) { return `#${cur} · 已关闭`; }
}
