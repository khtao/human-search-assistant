/* 弹窗 v4.1：搜索次数 + 多个每日定时启动点 + 开始/立即停止。
 * 「立即停止」点击瞬间先把界面切回空闲，再发 RPC；后台会同步拉闸。 */
import { call } from "../lib/rpc.js";
import { MSG, BUSY_STATES } from "../lib/messages.js";
import { normalizeRepeat, normalizeTimes, MAX_TIMES } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);
let busy = false;
let times = [];
let autoEnabled = false;
let scheduleSig = "";

/* ------------------------------------------------------------------ 状态 */
/** 运行期间只禁用「搜索次数」；定时相关控件统一交给 renderSchedule 管理。 */
function applyDisabled(b) {
  for (const id of ["repeat", "btnMinus", "btnPlus"]) {
    const el = $(id);
    if (el) el.disabled = b;
  }
}

function renderState(run) {
  busy = BUSY_STATES.includes(run.state);
  $("app").dataset.state = run.state;
  const detail = run.detail || (busy ? "搜索中" : "空闲");
  $("stateText").textContent = run.auto ? `自动 · ${detail}` : detail;

  const p = run.progress || { done: 0, total: normalizeRepeat($("repeat").value) };
  const total = Number(p.total) || normalizeRepeat($("repeat").value);
  const done = Math.min(Number(p.done) || 0, total);
  $("done").textContent = done;
  $("total").textContent = total;
  $("heroFill").style.width = `${total ? Math.round(done / total * 100) : 0}%`;
  $("heroSub").textContent = busy
    ? (p.current ? `${run.auto ? "自动搜索" : "正在搜索"}：${p.current}` : "正在准备热搜词…")
    : (done > 0 ? `上轮完成 ${done}/${total} 轮` : "设置搜索次数后点「开始搜索」");

  $("btnStart").disabled = busy;
  $("btnStop").hidden = !busy;
  applyDisabled(busy);
  renderSchedule();   // busy 变化时同步定时开关/时间输入/删除按钮的禁用态
}

/* ------------------------------------------------------------------ 定时 */
function renderSchedule(force = false) {
  const sig = JSON.stringify([times, autoEnabled, busy]);
  if (!force && sig === scheduleSig) return;
  scheduleSig = sig;
  const list = $("timeList");
  list.replaceChildren();
  list.hidden = times.length === 0;
  for (const t of times) {
    const chip = document.createElement("span");
    chip.className = "time-chip";
    chip.append(document.createTextNode(t));
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = `删除 ${t}`;
    x.setAttribute("aria-label", `删除 ${t}`);
    x.addEventListener("click", () => removeTime(t));
    chip.appendChild(x);
    list.appendChild(chip);
  }
  $("autoEnabled").checked = autoEnabled;
  const tip = $("scheduleTip");
  tip.classList.toggle("on", autoEnabled);
  if (autoEnabled && times.length) {
    tip.textContent = `已开启 · 每天 ${times.join("、")} 自动开始`;
  } else if (times.length) {
    tip.textContent = `已添加 ${times.length} 个时间点，打开右侧开关生效`;
  } else {
    tip.textContent = "关闭中，可先添加时间点";
  }
  // 定时控件：运行中禁用；时间点已满 10 个时添加入口也禁用
  const full = times.length >= MAX_TIMES;
  $("autoEnabled").disabled = busy;
  $("timeInput").disabled = busy || full;
  $("btnAddTime").disabled = busy || full;
  for (const btn of list.querySelectorAll("button")) btn.disabled = busy;
}

async function saveSchedule(patch) {
  const cfg = await call("config.save", patch);
  times = normalizeTimes(cfg.autoRunTimes);
  autoEnabled = Boolean(cfg.autoRunEnabled);
  renderSchedule(true);
  return cfg;
}

async function addTime() {
  const v = String($("timeInput").value || "").trim();
  if (!/^\d{2}:\d{2}$/.test(v)) return feedback("请选择有效时间", true);
  if (times.includes(v)) return feedback(`${v} 已存在`, true);
  if (times.length >= MAX_TIMES) return feedback(`最多 ${MAX_TIMES} 个时间点`, true);
  try {
    await saveSchedule({ autoRunTimes: [...times, v] });
    feedback(`已添加 ${v}`);
  } catch (e) { feedback(`✗ ${e.message}`, true); }
}

async function removeTime(t) {
  try {
    await saveSchedule({ autoRunTimes: times.filter((x) => x !== t) });
    feedback(`已删除 ${t}`);
  } catch (e) { feedback(`✗ ${e.message}`, true); }
}

/* ------------------------------------------------------------------ 日志 */
function line(rec) {
  const row = document.createElement("div");
  row.className = "log-line";
  row.dataset.kind = /error|stop|keywords|done|schedule|auto/.test(rec.action) ? rec.action : "";
  const t = document.createElement("span");
  t.className = "log-time";
  const d = new Date(rec.ts);
  t.textContent = Number.isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8);
  const x = document.createElement("span");
  x.className = "log-text";
  x.textContent = rec.detail || rec.action;
  x.title = rec.detail || "";
  row.append(t, x);
  return row;
}
function renderLogs(records) {
  const list = $("logList");
  list.replaceChildren();
  const recent = (records || []).slice(-8).reverse();
  if (!recent.length) {
    const e = document.createElement("div");
    e.className = "log-empty";
    e.textContent = "暂无日志";
    list.appendChild(e);
    return;
  }
  for (const r of recent) list.appendChild(line(r));
}

/* ------------------------------------------------------------------ 交互 */
function feedback(text, bad = false) {
  const el = $("feedback");
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("bad", bad);
}
async function action(fn, label) {
  try {
    if (label) feedback(label);
    await fn();
    await refresh();
    $("feedback").hidden = true;
  } catch (e) {
    feedback(`✗ ${e.message}`, true);
  }
}

function setRepeat(v) {
  const n = normalizeRepeat(v);
  $("repeat").value = n;
  $("total").textContent = n;
  return n;
}
async function saveRepeat() {
  const n = setRepeat($("repeat").value);
  await call("config.save", { repeat: n });
  return n;
}

async function refresh() {
  try {
    const [run, cfg, logs] = await Promise.all([
      call("state.get"), call("config.get"), call("logs.get"),
    ]);
    if (document.activeElement !== $("repeat")) setRepeat(cfg.repeat);
    times = normalizeTimes(cfg.autoRunTimes);
    autoEnabled = Boolean(cfg.autoRunEnabled);
    renderSchedule();
    renderState(run);
    renderLogs(logs);
  } catch (e) {
    feedback(`读取状态失败：${e.message}`, true);
  }
}

$("btnMinus").addEventListener("click", () =>
  setRepeat(normalizeRepeat($("repeat").value) - 1));
$("btnPlus").addEventListener("click", () =>
  setRepeat(normalizeRepeat($("repeat").value) + 1));
$("repeat").addEventListener("change", () => {
  const n = setRepeat($("repeat").value);
  call("config.save", { repeat: n }).catch(() => {});
});
$("repeat").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("repeat").blur(); }
});

$("autoEnabled").addEventListener("change", (e) => {
  const on = Boolean(e.target.checked);
  if (on && !times.length) {
    e.target.checked = false;
    feedback("请先添加至少一个时间点", true);
    return;
  }
  action(() => saveSchedule({ autoRunEnabled: on }), on ? "定时已开启" : "定时已关闭");
});
$("btnAddTime").addEventListener("click", addTime);
$("timeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addTime(); }
});

$("btnStart").addEventListener("click", () =>
  action(async () => {
    await saveRepeat();
    await call("engine.start", {});
  }, "正在启动…"));

// 点下去的这一帧就把界面切回空闲：后台 stopEngine 同时撤销所有页面操作
$("btnStop").addEventListener("click", () => {
  busy = false;
  $("app").dataset.state = "idle";
  $("stateText").textContent = "已停止";
  $("btnStart").disabled = false;
  $("btnStop").hidden = true;
  applyDisabled(false);
  renderSchedule(true);   // 立刻解禁定时控件，不等 3 秒轮询
  feedback("正在停止…");
  call("engine.stop").then(async () => {
    await refresh();
    $("feedback").hidden = true;
  }).catch((e) => feedback(`✗ ${e.message}`, true));
});

$("btnClearLogs").addEventListener("click", () =>
  action(async () => { await call("logs.clear"); }, "已清空日志"));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.STATE) renderState(msg);
  if (msg?.type === MSG.LOG) {
    const list = $("logList");
    const empty = list.querySelector(".log-empty");
    if (empty) empty.remove();
    list.prepend(line(msg.record));
    while (list.children.length > 8) list.lastChild.remove();
  }
});

(async () => {
  await refresh();
  setInterval(refresh, 3000);
})();
