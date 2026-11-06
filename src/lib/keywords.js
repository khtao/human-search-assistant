/* 关键词池：随机使用各种真实热搜源。
 * 禁止本地词库：任何源都抓不到时如实返回空，不编词、不 fallback。
 * 不引用 chrome.* —— 抓取函数可注入 fetch 便于自检。 */
import { Rng } from "./util.js";

/** 固化的热搜源，不写进设置选项 */
export const HOT_SOURCES = ["bing", "baidu", "weibo", "toutiao", "zhihu", "sina"];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

export function cleanKeyword(s) {
  return String(s || "").replace(/[#\[\]【】「」"'“”]/g, "")
    .replace(/\s+/g, " ").trim(" -—·|");
}

export function validKeyword(s) {
  // JS 的 \W 不认 Unicode：中文会全部落进 \W，不能照搬 Python 版写法。
  return s.length >= 2 && s.length <= 30 && /[a-zA-Z0-9\u3400-\u9fff]/.test(s);
}

function textOf(html, patterns) {
  const out = [];
  for (const re of patterns) {
    for (const m of String(html || "").matchAll(re)) out.push(cleanKeyword(m[1]));
    if (out.length) break;
  }
  return out;
}

export const SOURCES = {
  bing: async (fetchImpl) => {
    const r = await fetchImpl("https://www.bing.com/news/trendingtopics?form=HPNTOP",
      { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const list = textOf(html, [
      /<a[^>]+class="[^"]*title[^"]*"[^>]*>([^<]{2,60})<\/a>/g,
      /"text"\s*:\s*"([^"\\]{2,60})"/g,
    ]);
    return list.map((text, i) => ({ text, source: "bing", rank: i + 1 }));
  },

  baidu: async (fetchImpl) => {
    const r = await fetchImpl("https://top.baidu.com/board?tab=realtime",
      { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    return textOf(html, [
      /"query"\s*:\s*"([^"\\]{2,60})"/g,
      /class="c-single-text-ellipsis"[^>]*>([^<]{2,60})</g,
    ]).map((text, i) => ({ text, source: "baidu", rank: i + 1 }));
  },

  weibo: async (fetchImpl) => {
    const r = await fetchImpl("https://weibo.com/ajax/side/hotSearch",
      { headers: { "User-Agent": UA, Referer: "https://weibo.com/" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return ((data?.data || {}).realtime || [])
      .map((it, i) => ({ text: cleanKeyword(it.word || it.note || ""), source: "weibo", rank: i + 1 }));
  },

  toutiao: async (fetchImpl) => {
    const r = await fetchImpl("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
      { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return (data?.data || []).map((it, i) => ({
      text: cleanKeyword(it.Title || it.title || ""), source: "toutiao", rank: i + 1,
    }));
  },

  zhihu: async (fetchImpl) => {
    const r = await fetchImpl("https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true",
      { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return (data?.data || []).map((it, i) => ({
      text: cleanKeyword(it?.target?.title || it?.title || ""), source: "zhihu", rank: i + 1,
    }));
  },

  sina: async (fetchImpl) => {
    const r = await fetchImpl("https://rss.sina.com.cn/news/marquee/ddt.xml",
      { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    return [...String(xml).matchAll(/<title>(?:<!\[CDATA\[)?([^<\]]{2,80})/g)]
      .map((m, i) => ({ text: cleanKeyword(m[1]), source: "sina", rank: i + 1 }));
  },
};

/**
 * 随机挑 2~4 个热搜源抓取，合并去重后洗牌。
 * 全部失败时 items=[] / how="none" —— 绝不回退到本地词库。
 */
export async function getKeywordPool({ sources = HOT_SOURCES, limit = 40,
                                       timeout = 8000, fetchImpl, rng = new Rng() } = {}) {
  const fetcher = fetchImpl || ((url, opts) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  });
  const pool = [...(sources.length ? sources : HOT_SOURCES)];
  const count = Math.min(pool.length, 2 + Math.floor(rng.uniform(0, 3)));
  const chosen = rng.shuffle(pool).slice(0, count);
  const errors = [];
  const collected = [];
  for (const name of chosen) {
    const fn = SOURCES[name];
    if (!fn) continue;
    try {
      const got = (await fn(fetcher)).filter((k) => validKeyword(k.text));
      collected.push(...got);
    } catch (e) {
      errors.push(`${name}: ${e?.message || e}`);
    }
  }
  const seen = new Set();
  const unique = collected.filter((k) => {
    const key = k.text.toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const items = rng.shuffle(unique).slice(0, Math.max(1, limit));
  return {
    items,
    how: items.length ? chosen.join("+") : "none",
    sources: chosen,
    errors,
  };
}

/** 同日去重：返回本轮可用词，并输出应记入 used_terms 的新词。 */
export function excludeUsed(items, used) {
  const usedSet = new Set((used || []).map(String));
  return items.filter((k) => !usedSet.has(k.text));
}

export function estimateRounds(pointsLeft, pointsPerSearch = 5) {
  return Math.max(0, Math.ceil(Math.max(0, pointsLeft) / Math.max(1, pointsPerSearch)));
}
