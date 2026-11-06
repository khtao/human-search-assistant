/* 相关延伸搜索：为「直接改词」模式提供与上一轮查询相关的联想词。
 *
 * 页面里抓不到「相关搜索」链接时（例如刚回首页、或 SERP 结构改版），
 * 用 Bing 官方 autosuggest 接口按上一轮词取联想词；失败返回空数组，
 * 由引擎回退到热搜词，绝不编造本地词库。只在 service worker 里 fetch，
 * host_permissions 已含 https://*.bing.com/*。 */
import { cleanKeyword, validKeyword } from "../lib/keywords.js";

const ENDPOINT = "https://www.bing.com/AS/Suggestions";

export async function related(query, { timeout = 5000, fetchImpl = null } = {}) {
  const q = cleanKeyword(query);
  if (!validKeyword(q)) return [];
  const url = `${ENDPOINT}?pt=page.home&mkt=zh-CN&q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(500, timeout));
  try {
    const doFetch = fetchImpl || ((u, o) => fetch(u, o));
    const res = await doFetch(url, {
      signal: ctrl.signal,
      headers: { "Accept-Language": "zh-CN,zh;q=0.9" },
      credentials: "omit",
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out = [];
    // autosuggest 返回 HTML 片段（<a>词</a>）或内嵌 JSON（"query":"词"）
    for (const re of [/<a\b[^>]*>([\s\S]*?)<\/a>/gi,
      /"query"\s*:\s*"([^"\\]{2,60})"/g,
      /"text"\s*:\s*"([^"\\]{2,60})"/g]) {
      for (const m of String(html).matchAll(re)) out.push(m[1]);
    }
    return [...new Set(out.map(cleanKeyword).filter(validKeyword))]
      .filter((t) => t.toLowerCase() !== q.toLowerCase())
      .slice(0, 12);
  } catch (_) {
    return [];   // 超时 / 网络失败都只是少了延伸词，不阻断搜索
  } finally {
    clearTimeout(timer);
  }
}
