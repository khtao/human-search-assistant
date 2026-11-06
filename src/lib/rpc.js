/* 所有特权浏览器操作都集中在 service worker；
 * popup / options / offscreen 通过这一层调用，避免在多个上下文里散落 chrome API。 */
import { MSG } from "./messages.js";

export async function call(op, ...args) {
  const response = await chrome.runtime.sendMessage({ type: MSG.RPC, op, args });
  if (!response) throw new Error("后台服务未响应（可能正在重启），请重试");
  if (!response.ok) throw new Error(response.error || "后台操作失败");
  return response.data;
}

export function rpcOk(data) { return { ok: true, data }; }
export function rpcFail(error) {
  return { ok: false, error: String(error?.message || error) };
}
