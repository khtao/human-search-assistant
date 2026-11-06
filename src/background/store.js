/* chrome.storage 封装：只保留拟人搜索需要的数据。
 * local 存搜索次数与日志；session 存「本次运行」状态（SW 重启后可安全复位）。 */
import { mergeSettings } from "../lib/settings.js";
import { dayStr, isoNow } from "../lib/util.js";

const MAX_LOGS = 200;

async function local(key, fallback) {
  const got = await chrome.storage.local.get(key);
  return got[key] ?? fallback;
}

export async function getSettings() {
  return mergeSettings(await local("settings", {}));
}

export async function saveSettings(patch) {
  const next = mergeSettings({ ...(await local("settings", {})), ...patch });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function appendLog(rec) {
  const logs = await local("logs", []);
  logs.push(rec);
  while (logs.length > MAX_LOGS) logs.shift();
  await chrome.storage.local.set({ logs });
}
export async function getLogs() { return local("logs", []); }
export async function clearLogs() { await chrome.storage.local.set({ logs: [] }); }

/** 同日已用热搜词去重。 */
export async function getUsed(day = dayStr()) {
  const all = await local("usedTerms", {});
  return all[day] || [];
}
export async function addUsed(terms, day = dayStr()) {
  const all = await local("usedTerms", {});
  const set = new Set(all[day] || []);
  for (const t of terms) set.add(String(t));
  all[day] = [...set];
  const keys = Object.keys(all).sort();
  while (keys.length > 7) delete all[keys.shift()];
  await chrome.storage.local.set({ usedTerms: all });
}

/** 当天已经触发过的定时点，防止同一分钟重复启动；跨天自动清空。 */
export async function getFired(day = dayStr()) {
  const got = await local("fired", { day: "", keys: [] });
  return got.day === day ? { day: got.day, keys: got.keys || [] } : { day, keys: [] };
}
export async function markFired(key, day = dayStr()) {
  const cur = await getFired(day);
  const keys = [...new Set([...cur.keys, String(key)])];
  await chrome.storage.local.set({ fired: { day, keys } });
  return { day, keys };
}

export async function getRunState() {
  return (await chrome.storage.session.get("runState")).runState
    || { state: "idle", detail: "", progress: null, scopeTabId: null, error: "", updatedAt: "" };
}
export async function setRunState(v) {
  await chrome.storage.session.set({ runState: v });
}
