/* 拟人搜索配置 v4.1：只有两项可设置
 *   repeat       搜索次数（1~60，默认 12）
 *   autoRunTimes 每日定时启动时间点（最多 10 个，HH:MM）+ 总开关
 * 其余全部固化，不提供设置选项卡（配置项直接放在弹窗里）。 */
import { clamp } from "./util.js";
import { HOT_SOURCES } from "./keywords.js";
export { HOT_SOURCES };

/** 起始页 = Bing 搜索官网 */
export const OFFICIAL_HOME = "https://www.bing.com/?mkt=zh-CN";

export const SEARCH_ROUNDS = 12;
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 60;
export const MAX_TIMES = 10;

export const DEFAULT_SETTINGS = {
  repeat: SEARCH_ROUNDS,        // 可设置
  autoRunEnabled: false,        // 可设置：定时总开关
  autoRunTimes: [],             // 可设置：["09:00", "21:30"]

  level: 3,                    // 固化
  officialHome: OFFICIAL_HOME,
  useRealInput: true,
  forceSingleTab: true,
  closeTabAfterRun: false,
  roundSeconds: [16, 29],
  gapSeconds: [3, 12],
  clickProb: 0.35,
  enterRate: 0.5,
  scrollScreens: 1.2,
  keywordSources: HOT_SOURCES, // 随机真实热搜，无本地词库
  rewriteQueries: false,
  sessionChain: false,
};

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** 去重、排序、限 10 个；非法项直接丢弃。 */
export function normalizeTimes(times) {
  if (!Array.isArray(times)) return [];
  const good = times
    .map((t) => String(t ?? "").trim())
    .filter((t) => TIME_RE.test(t));
  return [...new Set(good)].sort().slice(0, MAX_TIMES);
}

export function normalizeRange(pair, fallback, lo, hi) {
  const a = Number(pair?.[0]), b = Number(pair?.[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [...fallback];
  return [clamp(Math.min(a, b), lo, hi), clamp(Math.max(a, b), lo, hi)];
}

export function normalizeRepeat(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return SEARCH_ROUNDS;
  return clamp(Math.round(n), MIN_ROUNDS, MAX_ROUNDS);
}

export function mergeSettings(patch = {}) {
  const p = patch && typeof patch === "object" ? patch : {};
  const out = { ...DEFAULT_SETTINGS, ...p };
  out.repeat = normalizeRepeat(out.repeat);
  out.autoRunEnabled = Boolean(out.autoRunEnabled);
  out.autoRunTimes = normalizeTimes(out.autoRunTimes);
  // 没有时间点时开关自动失效，避免空跑一个无效的定时轮询
  if (!out.autoRunTimes.length) out.autoRunEnabled = false;
  out.level = 3;
  out.officialHome = OFFICIAL_HOME;
  out.keywordSources = [...HOT_SOURCES];
  out.rewriteQueries = false;
  out.sessionChain = false;
  out.useRealInput = Boolean(out.useRealInput);
  out.forceSingleTab = Boolean(out.forceSingleTab);
  out.closeTabAfterRun = Boolean(out.closeTabAfterRun);
  out.roundSeconds = normalizeRange(out.roundSeconds, [16, 29], 3, 600);
  out.gapSeconds = normalizeRange(out.gapSeconds, [3, 12], 0.5, 120);
  out.clickProb = clamp(Number(out.clickProb) || 0.35, 0, 1);
  out.enterRate = clamp(Number(out.enterRate) || 0.5, 0, 1);
  out.scrollScreens = clamp(Number(out.scrollScreens) || 1.2, 0, 4);
  return out;
}
