/* 全扩展共用的消息协议与状态定义。
 * 配色规则（针对工具栏 chrome.action 扩展图标）：
 *   搜索进行中（手动 search / 定时 auto）= 红色；其它任何时间 = 蓝色。
 * 形状仍区分空闲 / 搜索 / 完成 / 出错，手动与自动搜索各带 4 帧动画与不同徽标。 */
export const MSG = {
  RPC: "mra:rpc",
  STATE: "mra:state",
  LOG: "mra:log",
  ENGINE_START: "mra:engineStart",
  ENGINE_READY: "mra:engineReady",
  ENGINE_STOP: "mra:engineStop",
  ENGINE_DONE: "mra:engineDone",
  PING: "mra:ping",
};

export const STATE = {
  IDLE: "idle",
  SEARCH: "search",   // 手动启动：蓝色放大镜动画
  AUTO: "auto",       // 定时自动启动：红色放大镜动画
  DONE: "done",
  ERROR: "error",
};

export const BLUE = "#2f6fed";
export const RED = "#e03131";

export const STATE_META = {
  idle:   { label: "空闲",     badge: "",  color: BLUE, icon: "idle" },
  search: { label: "搜索中",   badge: "▶", color: RED,  icon: "search_f" },
  auto:   { label: "自动搜索", badge: "●", color: RED,  icon: "auto_f" },
  done:   { label: "已完成",   badge: "✓", color: BLUE, icon: "done" },
  error:  { label: "出错",     badge: "!", color: BLUE, icon: "error" },
};

export const ICON_SIZES = [16, 32, 48, 128];
export const ANIMATED_STATES = [STATE.SEARCH, STATE.AUTO];
export const BUSY_STATES = [STATE.SEARCH, STATE.AUTO];

export function iconPaths(state, frame = 0) {
  const meta = STATE_META[state] || STATE_META.idle;
  const animated = meta.icon.endsWith("_f");
  const name = animated ? `${meta.icon}${frame % 4}` : meta.icon;
  return Object.fromEntries(ICON_SIZES.map((s) => [String(s), `icons/${name}_${s}.png`]));
}
