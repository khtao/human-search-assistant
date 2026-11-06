/* 真实键鼠输入：chrome.debugger 只 attach 到作用域标签页。
 * halt() 是「立即停止」的硬闸：一旦调用，detach 所有调试会话，
 * 之后任何 cmd() 都直接抛错，不会因为 in-flight 调用重新 attach 而复活。 */
import { assertScope } from "./scope.js";

const attached = new Set();
let halted = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function resume() { halted = false; }
export function isHalted() { return halted; }
export async function halt() {
  halted = true;
  await detachAll();
}

export async function attach(tabId) {
  if (halted) return false;
  await assertScope(tabId);
  if (attached.has(Number(tabId))) return true;
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab || !/^https:\/\/[^\/]*bing\.com\//i.test(String(tab.url || ""))) return false;
  try {
    await chrome.debugger.attach({ tabId: Number(tabId) }, "1.3");
    if (halted) {                       // attach 期间被停止：立刻撤销
      try { await chrome.debugger.detach({ tabId: Number(tabId) }); } catch (_) { /* ignore */ }
      return false;
    }
    attached.add(Number(tabId));
    return true;
  } catch (_) { return false; }
}

export async function detach(tabId) {
  if (!attached.has(Number(tabId))) return;
  try { await chrome.debugger.detach({ tabId: Number(tabId) }); } catch (_) { /* ignore */ }
  attached.delete(Number(tabId));
}
export async function detachAll() {
  for (const tabId of [...attached]) await detach(tabId);
}

async function cmd(tabId, method, params = {}) {
  if (halted) throw new Error("运行已停止");
  await assertScope(tabId);
  if (!attached.has(Number(tabId))) {
    const ok = await attach(tabId);
    if (!ok || halted) throw new Error("运行已停止或真实输入不可用");
  }
  if (halted) throw new Error("运行已停止");
  return chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params);
}

/** path: [{x,y,dt(ms)}] —— 贝塞尔轨迹 + 最小急动度步间隔。 */
export async function mousePath(tabId, path) {
  for (const p of path || []) {
    await cmd(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0,
    });
    if (p.dt > 0) await sleep(Math.min(p.dt, 120));
  }
}
export async function clickPlan(tabId, plan) {
  await mousePath(tabId, plan.path);
  await sleep(plan.beforeMs || 0);
  const [x, y] = plan.center;
  await cmd(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await sleep(plan.downMs || 60);
  await cmd(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
}
export async function clickAt(tabId, x, y) {
  await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await sleep(70);
  await cmd(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await sleep(65);
  await cmd(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
}
/**
 * 粘贴关键词前用真实按键清空搜索框：Ctrl+A 全选 → Backspace 删除。
 * rawKeyDown 不带 text，避免 Ctrl+A 把字母 a 插进框里。
 */
export async function clearInput(tabId) {
  const ctrlA = {
    key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
    modifiers: 2,   // Alt=1, Ctrl=2, Meta=4, Shift=8
  };
  await cmd(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...ctrlA });
  await sleep(30);
  await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...ctrlA });
  await sleep(40);
  await pressKey(tabId, "Backspace");
  await sleep(50);
}

export async function insertText(tabId, text) {
  await cmd(tabId, "Input.insertText", { text: String(text) });
}
export async function pressKey(tabId, key = "Enter") {
  const map = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
    Control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 },
  };
  const k = map[key] || map.Enter;
  await cmd(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
  await sleep(35);
  await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...k });
}
export async function wheel(tabId, dy, x = 700, y = 450) {
  await cmd(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel", x, y, deltaX: 0, deltaY: dy, button: "none",
  });
}
