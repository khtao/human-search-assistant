/* 只在「作用域标签页」里定位搜索框 / 结果链接，或派发 DOM 合成事件。
 * v4 不再注入任何内容脚本、不再采集任务卡片。
 * halt() 之后所有页面操作立即被拒绝，保证点「停止」立即生效。 */
import { assertScope } from "./scope.js";
import { cleanKeyword, validKeyword } from "../lib/keywords.js";

let halted = false;
export function resume() { halted = false; }
export function halt() { halted = true; }
function guard() { if (halted) throw new Error("运行已停止"); }

/** 在主 frame 查询元素矩形（搜索框 / 搜索按钮 / 结果链接）。 */
export async function probe(tabId, selectors) {
  guard();
  await assertScope(tabId);
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), frameIds: [0] },
    func: (sels) => {
      for (const s of sels) {
        let el = null;
        try { el = document.querySelector(s); } catch (_) { continue; }
        if (!el) continue;
        const b = el.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) continue;
        return {
          selector: s,
          box: { x: b.x, y: b.y, w: b.width, h: b.height },
          text: (el.innerText || el.textContent || "").trim().slice(0, 80),
          href: el.href || "",
        };
      }
      return null;
    },
    args: [selectors],
  });
  return r?.result ?? null;
}

/**
 * 粘贴关键词模式：先把当前搜索框清空，再输入新词。
 * 这一步是「搜索词不会越来越长」的关键——上一轮的词残留在框里会被拼接。
 */
export async function clearInput(tabId) {
  guard();
  await assertScope(tabId);
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), frameIds: [0] },
    func: () => {
      const el = document.activeElement;
      if (!el) return false;
      try {
        el.focus();
        if (typeof el.select === "function") el.select();
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch (_) { return false; }
    },
  });
  return r?.result ?? false;
}

/**
 * 直接改词模式：从当前 Bing 结果页抓「相关搜索 / 也有人搜」的延伸词。
 * 只读可见链接文本与 href 里的 q=，不编词、不回退本地词库。
 */
export async function relatedSearches(tabId) {
  guard();
  await assertScope(tabId);
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), frameIds: [0] },
    func: (sels) => {
      const out = [];
      const seen = new Set();
      const add = (raw) => {
        const t = String(raw || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        if (!t || t.length > 30 || t.length < 2 || seen.has(t)) return;
        if (/^(https?:|www\.|bing\.com|microsoft)/i.test(t)) return;
        if (!/[a-zA-Z0-9\u3400-\u9fff]/.test(t)) return;
        seen.add(t);
        out.push(t);
      };
      for (const s of sels) {
        let nodes = [];
        try { nodes = [...document.querySelectorAll(s)]; } catch (_) { continue; }
        for (const a of nodes) {
          const b = a.getBoundingClientRect();
          if (b.width < 1 || b.height < 1) continue;
          add(a.innerText || a.textContent);
          try {
            const href = a.getAttribute("href") || "";
            const m = href.match(/[?&]q=([^&]+)/);
            if (m) add(decodeURIComponent(m[1].replace(/\+/g, " ")));
          } catch (_) { /* ignore */ }
        }
      }
      return out.slice(0, 24);
    },
    args: [[
      ".b_rs a", "#b_rs a", ".b_related a", "[class*='related' i] a",
      "[class*='Related' ] a", ".b_ans a[href*='/search']",
      "a[href*='/search?q=']", "a[href*='search?q=']",
    ]],
  });
  const raw = Array.isArray(r?.result) ? r.result : [];
  return [...new Set(raw.map(cleanKeyword).filter(validKeyword))].slice(0, 20);
}

/** useRealInput=false 时的 DOM 合成事件（仅作用于作用域页）。 */
export async function domInput(tabId, text) {
  guard();
  await assertScope(tabId);
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), frameIds: [0] },
    func: (value) => {
      const el = document.activeElement;
      if (!el) return false;
      try {
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch (_) { return false; }
    },
    args: [text],
  });
  return r?.result ?? false;
}
export async function domClick(tabId, x, y) {
  guard();
  await assertScope(tabId);
  await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), frameIds: [0] },
    func: (cx, cy) => {
      const el = document.elementFromPoint(cx, cy) || document.activeElement;
      if (!el) return false;
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0,
        }));
      }
      return true;
    },
    args: [x, y],
  }).catch(() => {});
}
export async function domKey(tabId, key = "Enter") {
  guard();
  await assertScope(tabId);
  await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), frameIds: [0] },
    func: (k) => {
      const el = document.activeElement;
      if (!el) return false;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true }));
      if (k === "Enter" && el.form && typeof el.form.requestSubmit === "function") {
        el.form.requestSubmit();
      }
      return true;
    },
    args: [key],
  }).catch(() => {});
}
export async function domWheel(tabId, dy) {
  guard();
  await assertScope(tabId);
  await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), frameIds: [0] },
    func: (d) => window.scrollBy({ top: d, behavior: "smooth" }),
    args: [dy],
  }).catch(() => {});
}
