/* 后台总控（v4）：唯一持有特权浏览器操作的地方。
 * popup / offscreen 通过 RPC 调用；所有标签页操作都经 scope.assertScope 校验。
 *
 * 「停止」不依赖 offscreen 自己走完循环：收到 RPC 的同一时刻就
 *   scope.halt() + collector.halt() + cdp.halt() + releaseScope() + finishState(IDLE)，
 * 再向 offscreen 发 ENGINE_STOP 让它收尾。任何 in-flight 页面操作都会被拒绝。 */
import { MSG, STATE, BUSY_STATES } from "../lib/messages.js";
import { rpcOk, rpcFail } from "../lib/rpc.js";
import * as store from "./store.js";
import * as state from "./state.js";
import * as scope from "./scope.js";
import * as collector from "./collector.js";
import * as cdp from "./cdp.js";
import * as scheduler from "./scheduler.js";
import * as suggest from "./suggest.js";

let engineRunning = false;
let enginePort = null;
let engineReady = false;
let stopHandled = false;   // 用户已点停止：延迟到达的 ENGINE_DONE 不得覆盖状态

/* ----------------------------------------------------------- offscreen 引擎 */
async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts && contexts.length) return;
  } catch (_) { /* 老版本没有 getContexts，直接尝试创建 */ }
  try {
    await chrome.offscreen.createDocument({
      url: "src/offscreen/offscreen.html",
      reasons: ["WORKERS"],
      justification: "拟人搜索是长跑会话，需要稳定定时器，避免 service worker 30 秒空闲回收",
    });
  } catch (e) {
    if (!/already|exists|document/i.test(String(e?.message || e))) throw e;
  }
}

async function waitEngineReady(ms = 2500) {
  if (engineReady) return true;
  for (let i = 0; i < Math.ceil(ms / 150); i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (engineReady) return true;
  }
  return false;   // 复用旧文档不会重发 READY：靠 port + message 双发兜底
}

async function startEngine(params = {}) {
  const run = await state.currentState();
  const age = run.updatedAt ? Date.now() - new Date(run.updatedAt).getTime() : Infinity;
  const stale = age > 120000 && !engineRunning;   // SW 回收后的残留状态
  if (engineRunning && age < 1800000) throw new Error("已在运行中，请先停止");
  if (!stale && BUSY_STATES.includes(run.state)) throw new Error("已在运行中，请先停止");

  stopHandled = false;
  scope.resume(); collector.resume(); cdp.resume();
  engineRunning = false;
  await state.setState(STATE.IDLE, { detail: "准备运行…", progress: null });
  const settings = await store.getSettings();
  // auto 透传给 offscreen：定时触发走红色图标，手动点击走蓝色图标
  params = { ...params, auto: Boolean(params.auto) };
  await ensureOffscreen();
  await waitEngineReady();
  engineRunning = true;
  const payload = { type: MSG.ENGINE_START, params, settings };
  try { enginePort?.postMessage(payload); } catch (_) { /* 端口可能刚断开 */ }
  await chrome.runtime.sendMessage(payload).catch(() => {});
  return { ok: true };
}

/** 立即停止：所有页面操作在这一帧内被撤销，不等引擎自己跑完。 */
async function stopEngine() {
  const wasRunning = engineRunning;
  engineRunning = false;
  stopHandled = true;

  // ① 先通知 offscreen（双通道，任一到达即中止）
  try { enginePort?.postMessage({ type: MSG.ENGINE_STOP }); } catch (_) { /* ignore */ }
  chrome.runtime.sendMessage({ type: MSG.ENGINE_STOP }).catch(() => {});

  // ② 后台硬闸：三个 halt() 的布尔标记都是同步生效的，页面操作当帧被拒
  scope.halt();
  collector.halt();
  const detaching = cdp.halt();   // halted=true 已同步设置，detach 可稍后完成

  // ③ 先把状态/图标复位（弹窗立刻看到「已停止」），保留已完成轮数，再做耗时清理
  const run = await state.currentState();
  await state.finishState({
    state: STATE.IDLE, detail: "已停止", progress: run.progress ?? null,
  });
  await detaching;
  const tabId = await scope.getScope();
  if (tabId != null) await scope.releaseScope({ closeTab: false, tabId });
  await state.log("stop", "已停止搜索：所有页面操作已撤销");
  return { ok: true, stopped: wasRunning };
}

async function handleEngineDone(msg) {
  engineRunning = false;
  const s = await store.getSettings();
  const tabId = msg.scopeTabId ?? await scope.getScope();
  const cur = await scope.getScope();
  await cdp.halt();
  // 只有本次运行的作用域仍是当前作用域时才释放，避免旧运行覆盖新一轮
  if (cur == null || Number(tabId) === Number(cur)) {
    if (tabId != null) await scope.releaseScope({ closeTab: s.closeTabAfterRun, tabId });
    if (!stopHandled) {
      await state.finishState({
        state: msg.error ? STATE.ERROR : STATE.DONE,
        detail: msg.summary || (msg.stopped ? "已停止" : "运行结束"),
        progress: msg.progress ?? null,
      });
    }
  }
}

/* ------------------------------------------------------------------ RPC 表 */
const OPS = {
  "state.get": () => state.currentState(),
  // 停止后引擎里可能还有一帧延迟到达的「运行中」状态，直接忽略
  "state.set": (st, opts) => (stopHandled && BUSY_STATES.includes(st))
    ? state.currentState() : state.setState(st, opts || {}),
  "config.get": () => store.getSettings(),
  "config.save": async (patch) => {
    const next = await store.saveSettings(patch || {});
    await scheduler.rebuild();   // 定时点或开关改了，立刻重建 tick
    return next;
  },

  "logs.get": () => store.getLogs(),
  "logs.clear": () => store.clearLogs(),

  "scope.label": () => scope.scopeLabel(),
  "scope.ensure": (opts) => scope.ensureScope(opts || {}),
  "scope.navigate": (tabId, url) => scope.navigate(tabId, url),
  "scope.goBack": (tabId) => scope.goBack(tabId),
  "scope.release": () => scope.releaseScope(),

  "collect.probe": (tabId, selectors) => collector.probe(tabId, selectors),
  "collect.clearInput": (tabId) => collector.clearInput(tabId),
  "collect.related": (tabId) => collector.relatedSearches(tabId),
  "suggest.related": (query) => suggest.related(query),
  "collect.domInput": (tabId, text) => collector.domInput(tabId, text),
  "collect.domClick": (tabId, x, y) => collector.domClick(tabId, x, y),
  "collect.domKey": (tabId, key) => collector.domKey(tabId, key),
  "collect.domWheel": (tabId, dy) => collector.domWheel(tabId, dy),

  "cdp.attach": (tabId) => cdp.attach(tabId),
  "cdp.detach": (tabId) => cdp.detach(tabId),
  "cdp.mousePath": (tabId, path) => cdp.mousePath(tabId, path),
  "cdp.clickPlan": (tabId, plan) => cdp.clickPlan(tabId, plan),
  "cdp.clickAt": (tabId, x, y) => cdp.clickAt(tabId, x, y),
  "cdp.clearInput": (tabId) => cdp.clearInput(tabId),
  "cdp.insertText": (tabId, text) => cdp.insertText(tabId, text),
  "cdp.key": (tabId, key) => cdp.pressKey(tabId, key),
  "cdp.wheel": (tabId, dy) => cdp.wheel(tabId, dy),

  "store.used": () => store.getUsed(),
  "store.addUsed": (terms) => store.addUsed(terms),
  "log.append": (action, detail, extra) => state.log(action, detail, extra || {}),

  "engine.start": (params) => startEngine(params || {}),
  "engine.stop": () => stopEngine(),
  "engine.running": () => Boolean(engineRunning),
};

async function dispatch(op, args) {
  const fn = OPS[op];
  if (!fn) throw new Error(`未知操作：${op}`);
  return fn(...(args || []));
}

/* ---------------------------------------------------------------- 事件入口 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === MSG.ENGINE_READY) { engineReady = true; return false; }
  if (msg?.type === MSG.PING || msg?.type === MSG.ENGINE_STOP) return false;
  if (msg?.type === MSG.ENGINE_DONE) {
    handleEngineDone(msg).catch(() => {});
    return false;
  }
  if (msg?.type === MSG.RPC) {
    dispatch(msg.op, msg.args).then(rpcOk).catch(rpcFail).then(sendResponse);
    return true;
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "mra-engine") return;
  enginePort = port;
  port.onDisconnect.addListener(() => {
    if (enginePort === port) enginePort = null;
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  scope.handleCreatedTab(tab).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const cur = await scope.getScope();
  if (cur !== tabId) return;
  await stopEngine();
  await scope.setScope(null);
  await state.finishState({
    state: STATE.ERROR, detail: "作用域标签页被关闭，运行已中止", progress: null,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  scheduler.handleAlarm(alarm, {
    run: (params) => startEngine(params),
  }).catch((e) => state.log("schedule", `定时检查异常：${e?.message || e}`));
});

/* 只在浏览器会话首次启动时恢复状态；SW 被消息唤醒时不能重跑 */
let initPromise = null;
function initOnce() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { mraInit } = await chrome.storage.session.get("mraInit");
    if (!mraInit) {
      await state.restoreState().catch(() => {});
      await chrome.storage.session.set({ mraInit: true });
    }
    await scheduler.rebuild().catch(() => {});
  })();
  return initPromise;
}
chrome.runtime.onInstalled.addListener(() => { initOnce(); });
chrome.runtime.onStartup.addListener(() => { initOnce(); });
initOnce();
