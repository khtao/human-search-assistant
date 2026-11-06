/* 运行状态机：图标 / badge / 标题 / 广播。
 * 定时自动搜索（auto）用红色 4 帧动画；其它任何状态都保持蓝色。
 * 运行时给作用域标签页单独设置徽标，其它标签页不做任何页面操作。 */
import { MSG, STATE, STATE_META, ANIMATED_STATES, iconPaths } from "../lib/messages.js";
import { isoNow } from "../lib/util.js";
import { getRunState, setRunState, appendLog } from "./store.js";

let animTimer = null;
let animFrame = 0;

export function broadcast(msg) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { /* no receivers */ }
}

export async function currentState() { return getRunState(); }

async function applyIcon(state, frame = 0) {
  const meta = STATE_META[state] || STATE_META.idle;
  const path = iconPaths(state, frame);
  try {
    await chrome.action.setIcon({ path });
    await chrome.action.setBadgeText({ text: meta.badge });
    await chrome.action.setBadgeBackgroundColor({ color: meta.color });
    await chrome.action.setTitle({ title: `拟人搜索助手 · ${meta.label}` });
  } catch (_) { /* 浏览器版本差异不应影响主流程 */ }
  const run = await getRunState();
  if (run.scopeTabId != null && ANIMATED_STATES.includes(state)) {
    try {
      await chrome.action.setIcon({ tabId: run.scopeTabId, path });
      await chrome.action.setBadgeText({ tabId: run.scopeTabId, text: meta.badge });
      await chrome.action.setBadgeBackgroundColor({ tabId: run.scopeTabId, color: meta.color });
      await chrome.action.setTitle({ tabId: run.scopeTabId,
        title: `拟人搜索助手 · ${meta.label}（仅此标签页）` });
    } catch (_) { /* 标签页可能已关闭 */ }
  }
}

function stopAnimation() {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  animFrame = 0;
}
function startAnimation(state) {
  stopAnimation();
  if (!String(STATE_META[state]?.icon || "").endsWith("_f")) return;
  animTimer = setInterval(() => {
    animFrame = (animFrame + 1) % 4;
    applyIcon(state, animFrame);
  }, 420);
}

export async function setState(state, { detail = "", scopeTabId, progress, auto = false,
  error = "" } = {}) {
  const prev = await getRunState();
  // auto 只在本次运行由定时触发时为 true；非运行状态一律清空
  const isAuto = state === STATE.AUTO ? true
    : state === STATE.SEARCH ? Boolean(auto || prev.auto)
    : false;
  const next = {
    state,
    detail,
    auto: isAuto,
    progress: progress === undefined ? (prev.progress ?? null) : progress,
    scopeTabId: scopeTabId === undefined ? (prev.scopeTabId ?? null) : scopeTabId,
    error,
    updatedAt: isoNow(),
  };
  await setRunState(next);
  await applyIcon(state, 0);
  if (ANIMATED_STATES.includes(state)) startAnimation(state);
  else stopAnimation();
  broadcast({ type: MSG.STATE, state, ...next });
  return next;
}

/** 结束：清掉作用域标签页专属图标，回到 idle（蓝色）。不延时——停止必须立刻生效。 */
export async function finishState({ state = STATE.DONE, detail = "", progress = null } = {}) {
  const run = await getRunState();
  if (run.scopeTabId != null) {
    try {
      await chrome.action.setIcon({ tabId: run.scopeTabId, path: iconPaths(STATE.IDLE, 0) });
      await chrome.action.setBadgeText({ tabId: run.scopeTabId, text: "" });
      await chrome.action.setTitle({ tabId: run.scopeTabId, title: "拟人搜索助手 · 空闲" });
    } catch (_) { /* ignore */ }
  }
  await setState(state, { detail, progress, scopeTabId: null });
}

export async function restoreState() {
  const run = await getRunState();
  await applyIcon(run.state || STATE.IDLE, 0);
  if (ANIMATED_STATES.includes(run.state)) startAnimation(run.state);
  // 浏览器/SW 重启后不自动续跑（运行环境已变），标记为可安全重试
  if (ANIMATED_STATES.includes(run.state)) {
    await setState(STATE.IDLE, { detail: "上次运行已中断，可重新开始", progress: null, scopeTabId: null });
    await appendLog({ ts: isoNow(), action: "recover", detail: "后台重启，已清理中断状态" });
  }
}

export async function log(action, detail = "", extra = {}) {
  const rec = { ts: isoNow(), action: String(action), detail: String(detail), ...extra };
  await appendLog(rec);
  broadcast({ type: MSG.LOG, record: rec });
}
