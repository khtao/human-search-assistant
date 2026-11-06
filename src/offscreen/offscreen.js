/* 运行引擎（offscreen document）：v4 只有拟人搜索。
 * 所有导航、注入、CDP 输入通过 RPC 交给 service worker，且都带同一个 scopeTabId。
 *
 * 「立即停止」：ENGINE_STOP 到达的同一帧设置 stopFlag 并 controller.abort()，
 * 所有 sleep 通过 AbortSignal 立刻 resolve；后台同时 halt() 掉 cdp/collector/scope，
 * 任何 in-flight 页面操作都会被拒绝。两者叠加，停止后不会再有一次搜索动作。 */
import { call } from "../lib/rpc.js";
import { MSG, STATE } from "../lib/messages.js";
import { Rng, sleep, clamp } from "../lib/util.js";
import { mergeSettings, OFFICIAL_HOME } from "../lib/settings.js";
import { Budget } from "../lib/budget.js";
import { Human } from "../lib/human.js";
import { quality } from "../lib/queries.js";
import { getKeywordPool, excludeUsed, HOT_SOURCES } from "../lib/keywords.js";
import { Cadence, Circadian } from "../lib/entropy.js";

const SEARCH_INPUTS = ["#sb_form_q", "textarea[name='q']", "input[name='q']", "#q"];
const SEARCH_BUTTONS = ["#sb_form_go", "input[type='submit']", "#sb_form_submit", "label#search_icon"];
const RESULTS = ["li.b_algo h2 a", "#b_results > li h2 a", ".b_algo a", "#b_results li a"];
const HOME = OFFICIAL_HOME;
/** 直接改词模式：不经搜索框，直接把查询词换到地址上 */
const searchUrl = (q) => `https://www.bing.com/search?q=${encodeURIComponent(String(q))}&form=QBLH`;
const STOP = Symbol("stopped");

let running = false;
let stopFlag = false;
let controller = null;
let enginePort = null;

const bail = () => { if (stopFlag) throw STOP; };

try {
  enginePort = chrome.runtime.connect({ name: "mra-engine" });
  enginePort.onMessage.addListener((msg) => {
    if (msg?.type === MSG.ENGINE_STOP) requestStop();
    if (msg?.type === MSG.ENGINE_START) start(msg);
  });
} catch (_) { /* SW 重启后重连即可 */ }

// 告诉后台「监听已注册」，后台确认后再发启动指令，避免早期消息丢失
chrome.runtime.sendMessage({ type: MSG.ENGINE_READY }).catch(() => {});

// 心跳：保证运行期间 service worker 不会因为空闲被回收
setInterval(() => {
  try { chrome.runtime.sendMessage({ type: MSG.PING }).catch(() => {}); } catch (_) { /* ignore */ }
}, 15000);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.ENGINE_STOP) requestStop();
  if (msg?.type === MSG.ENGINE_START) start(msg);
});

function requestStop() {
  if (!running) return;
  stopFlag = true;
  try { controller?.abort(); } catch (_) { /* ignore */ }
}

async function start({ params = {}, settings } = {}) {
  if (running) return;
  running = true;
  stopFlag = false;
  controller = new AbortController();
  const signal = controller.signal;
  const s = mergeSettings(settings);
  // 定时触发 → 红色图标；手动点击 → 蓝色图标
  const stateKind = params.auto ? STATE.AUTO : STATE.SEARCH;
  const total = s.repeat;
  const rng = new Rng(params.seed);
  let tabId = null;
  let ok = 0, fail = 0, clicked = 0, completed = 0;
  let error = "";
  const progress = { done: 0, total, current: "" };

  const setState = (detail, patch = {}) => {
    if (stopFlag) return Promise.resolve();
    return call("state.set", stateKind, {
      detail, scopeTabId: tabId, progress: { ...progress, ...patch },
    }).catch(() => {});
  };

  try {
    tabId = await call("scope.ensure", { background: Boolean(params.auto) });
    bail();
    await setState("准备热搜词…", { done: 0, current: "" });

    // 随机使用各种真实热搜源；禁止本地词库，全失败就明确报错，不编词
    const pool = await getKeywordPool({
      sources: HOT_SOURCES, limit: Math.max(24, total * 3), rng,
    });
    bail();
    if (!pool.items.length) {
      await call("log.append", "keywords",
        `热搜源全部不可用（${(pool.errors || []).join(" / ").slice(0, 180)}）`).catch(() => {});
      throw new Error("所有热搜源均不可用，请检查网络后重试（不使用本地词库）");
    }
    const used = await call("store.used");
    bail();
    let words = excludeUsed(pool.items, used);
    if (!words.length) words = pool.items.slice();
    const seen = new Set();
    words = words.filter((w) => {
      const t = typeof w === "string" ? w : w.text;
      if (!t || seen.has(t)) return false;
      seen.add(t);
      return true;
    });

    // 每轮直接用一条热搜词：不改写、不接会话链，搜索词不会越来越长
    const queries = [];
    for (let i = 0; i < total; i++) {
      const w = words[(i * 7 + 1) % words.length];
      queries.push(String((typeof w === "string" ? w : w.text) || "").trim().slice(0, 30));
    }
    const q = quality(queries);
    await call("log.append", "keywords",
      `随机热搜源 ${pool.sources.join("+")} · 词池 ${pool.items.length} 条`
      + ` · 热搜词 ${queries.length} 条 · 平均 ${q.avgLen} 字 / 最长 ${q.maxLen} 字`
      + `（每轮随机混合粘贴/改词/回首页 · 无本地词库 / 无会话链）`).catch(() => {});
    bail();

    const realInput = s.useRealInput && Boolean(await call("cdp.attach", tabId).catch(() => false));
    bail();
    if (!realInput) await call("log.append", "input", "真实输入不可用，本轮改用页面内合成事件").catch(() => {});
    const human = new Human(s.level, rng, new Circadian(null));
    const cadence = new Cadence(rng, { sessionLen: total });
    let lastXY = [120, 140];

    let lastQuery = queries[0] || "";
    const usedThisRun = [];
    const modeCount = { paste: 0, related: 0, home: 0, stay: 0 };

    for (let i = 0; i < total && !stopFlag; i++) {
      const roundTotal = clamp(rng.uniform(...s.roundSeconds), 5, 60);
      const budget = new Budget(roundTotal, rng, { reserve: 1 });
      const wait = (a, b, extra) => budget.sleepRange(a, b,
        { ...extra, stop: () => stopFlag, signal });
      // 每轮独立掷骰：回首页与否 × 粘贴关键词 / 直接改词，四种组合混合出现
      const goHome = rng.bool(0.38);
      const useRelated = rng.bool(0.42);
      let keyword = queries[i];
      let method = "";
      let roundOk = true, reason = "", results = false;

      await setState(`第 ${i + 1}/${total} 轮 · 准备中`, { done: i, current: "" });
      try {
        if (useRelated) {
          /* ---- 直接改词模式：关键词必须来自相关延伸搜索 ---- */
          let related = await call("collect.related", tabId).catch(() => []);
          bail();
          if (!related.length) {
            related = await call("suggest.related", lastQuery || queries[i]).catch(() => []);
          }
          bail();
          if (related.length) {
            keyword = String(rng.pick(related)).trim().slice(0, 30);
            method = "改词·相关延伸";
          } else {
            keyword = queries[i];
            method = "改词·热搜回退";
          }
          if (goHome) { await call("scope.navigate", tabId, HOME); bail(); }
          // 不经搜索框粘贴，直接把查询词改到地址上
          await call("scope.navigate", tabId, searchUrl(keyword));
          bail();
          modeCount.related++;
        } else {
          /* ---- 粘贴关键词模式：先清空搜索框，再输入 ---- */
          method = "粘贴关键词";
          if (goHome) { await call("scope.navigate", tabId, HOME); bail(); }
          let box = await call("collect.probe", tabId, SEARCH_INPUTS);
          bail();
          if (!box) {
            await call("scope.navigate", tabId, HOME);
            bail();
            box = await call("collect.probe", tabId, SEARCH_INPUTS);
            bail();
          }
          if (!box) throw new Error("no-input");

          const plan = human.clickPlan(box.box, lastXY, { lowTime: budget.left < 8 });
          lastXY = plan.center;
          if (realInput) await call("cdp.clickPlan", tabId, plan);
          else await call("collect.domClick", tabId, ...plan.center);
          bail();
          await wait(0.15, 0.6);
          bail();

          // 关键：粘贴前清空，避免上一轮的词残留被拼接成越来越长的查询
          if (realInput) await call("cdp.clearInput", tabId);
          else await call("collect.clearInput", tabId);
          bail();
          await wait(0.1, 0.35);
          bail();

          const paste = human.pastePlan(keyword, {
            seconds: Math.max(0.4, Math.min(3, budget.left * 0.2)),
          });
          await wait(paste.pre, paste.pre + 0.05);
          bail();
          if (realInput) await call("cdp.insertText", tabId, keyword);
          else await call("collect.domInput", tabId, keyword);
          bail();
          await wait(paste.gap, paste.gap + 0.05);
          bail();

          if (rng.bool(s.enterRate)) {
            if (realInput) await call("cdp.key", tabId, "Enter");
            else await call("collect.domKey", tabId, "Enter");
          } else {
            const btn = await call("collect.probe", tabId, SEARCH_BUTTONS);
            bail();
            if (btn && realInput) {
              await call("cdp.clickAt", tabId, btn.box.x + btn.box.w / 2, btn.box.y + btn.box.h / 2);
            } else if (realInput) await call("cdp.key", tabId, "Enter");
            else await call("collect.domKey", tabId, "Enter");
          }
          bail();
          modeCount.paste++;
        }

        if (goHome) modeCount.home++; else modeCount.stay++;
        lastQuery = keyword;
        usedThisRun.push(keyword);
        await setState(`第 ${i + 1}/${total} 轮 · ${keyword}`, { done: i, current: keyword });
        await call("log.append", "search_start",
          `[${i + 1}/${total}] ${keyword} · ${method}${goHome ? " · 回首页" : " · 留在结果页"}`)
          .catch(() => {});
        bail();

        /* ---- 公共：等结果、滚动、按概率点结果 ---- */
        await wait(0.8, 2.5);
        bail();
        const hit = await call("collect.probe", tabId, RESULTS);
        bail();
        results = Boolean(hit);

        const scroll = human.scrollPlan(s.scrollScreens, {
          maxSeconds: Math.max(0.5, budget.left - 1.5),
        });
        for (const st of scroll) {
          if (stopFlag || !budget.fits(0.4)) break;
          if (realInput) await call("cdp.wheel", tabId, st.dy);
          else await call("collect.domWheel", tabId, st.dy);
          bail();
          await wait(st.dt, st.dt + 0.15);
          bail();
        }

        if (rng.bool(s.clickProb) && budget.fits(6) && results) {
          const link = await call("collect.probe", tabId, RESULTS);
          bail();
          if (link) {
            const cx = link.box.x + link.box.w * 0.3;
            const cy = link.box.y + link.box.h * 0.5;
            if (realInput) await call("cdp.clickAt", tabId, cx, cy);
            else await call("collect.domClick", tabId, cx, cy);
            clicked++;
            await wait(1.0, Math.min(4, Math.max(1, budget.left - 1)));
            bail();
            await call("scope.goBack", tabId);
            bail();
          }
        }
        if (budget.left > 1.2 && !stopFlag) {
          await budget.sleepExact(budget.left * 0.6, () => stopFlag, signal);
          bail();
        }
      } catch (e) {
        if (e === STOP || stopFlag) { roundOk = true; reason = "stopped"; }
        else { roundOk = false; reason = String(e?.message || e); }
      }

      if (stopFlag) break;
      if (roundOk) ok++; else fail++;
      completed = i + 1;
      progress.done = completed;
      progress.current = keyword;
      await call("log.append", "search_end",
        `[${i + 1}/${total}] ${reason === "stopped" ? "已停止" : (roundOk ? "完成" : "失败 " + reason)}`
        + ` · ${method} · ${budget.elapsed.toFixed(1)}s${results ? " · 有结果" : ""}`).catch(() => {});

      if (i < total - 1 && !stopFlag) {
        const gap = clamp(rng.uniform(...s.gapSeconds) + cadence.interval(0.6) - 0.6, 0.5, 60);
        await setState(`轮间等待 ${gap.toFixed(1)}s`, { done: completed });
        await sleep(gap * 1000, () => stopFlag, signal);
      }
    }

    await call("log.append", "modes",
      `方式混合：粘贴 ${modeCount.paste} / 改词 ${modeCount.related}`
      + ` · 回首页 ${modeCount.home} / 留在结果页 ${modeCount.stay}`).catch(() => {});
    if (!stopFlag) await call("store.addUsed", [...new Set([...queries, ...usedThisRun])]).catch(() => {});
  } catch (e) {
    if (e !== STOP && !stopFlag) {
      error = String(e?.message || e);
      await call("log.append", "error", error).catch(() => {});
    }
  } finally {
    const stopped = stopFlag;
    const summary = stopped
      ? `已停止 · 完成 ${completed}/${total} 轮`
      : (error ? `出错：${error}` : `完成 ${ok}/${total} 轮 · 失败 ${fail} · 点击结果 ${clicked}`);
    await call("log.append", stopped ? "stop" : "done", summary).catch(() => {});
    try {
      await chrome.runtime.sendMessage({
        type: MSG.ENGINE_DONE,
        summary, stopped, error,
        scopeTabId: tabId,
        progress: { done: completed, total, current: "" },
      });
    } catch (_) { /* ignore */ }
    running = false;
  }
}
