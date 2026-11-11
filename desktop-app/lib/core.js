/* ============================================================================
 * 桌面适配层的「纯逻辑」部分。
 * 刻意不 require('electron')，因此可以在纯 Node 里被单元测试直接调用。
 * 主进程 main.js 与验证脚本 scripts/verify-shim.js 共用同一份实现。
 * ========================================================================== */


/**
 * Only these known Microsoft / Rewards authentication cookies can indicate a
 * real sign-out when removed. Telemetry, preference, and experiment cookies
 * are intentionally excluded: their removal must never clear cached points.
 */
const REWARDS_AUTH_COOKIE_NAME = /^(?:MSPAuth|MSPProf|MSPRequ|MSPOK|MSPShared|MSPBack|MSPState|MSPConsent|MSAAuth|__Host-MSAAUTH|ESTSAUTH(?:PERSISTENT|LIGHT)?|ESTSSC|ESTSAUTHCOOKIE|RPS(?:Sec)?Auth|RPSTAuth|KievRPSAuth|WLID|WLSSC|_RwBf(?:2)?)$/i;
function isRewardsAuthCookie(cookie) {
  return !!(cookie && typeof cookie.name === 'string' && REWARDS_AUTH_COOKIE_NAME.test(cookie.name));
}

/** chrome.storage.local.get 的 keys 参数归一化：支持数组 / 字符串 / 对象 / 空。 */
function normalizeGetKeys(keys, data) {
  if (keys == null) return Object.assign({}, data);
  if (typeof keys === 'string') {
    const out = {};
    if (Object.prototype.hasOwnProperty.call(data, keys)) out[keys] = data[keys];
    return out;
  }
  if (Array.isArray(keys)) {
    const out = {};
    for (const k of keys) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
    return out;
  }
  if (typeof keys === 'object') {
    // 对象形式：默认值字典，未存过的键返回默认值
    const out = {};
    for (const [k, fallback] of Object.entries(keys)) {
      out[k] = Object.prototype.hasOwnProperty.call(data, k) ? data[k] : fallback;
    }
    return out;
  }
  return {};
}

/** 计算 storage.onChanged 的 changes 结构（Chrome 语义：{ key: {oldValue, newValue} }）。 */
function diffStorage(before, patch) {
  const changes = {};
  for (const [k, newValue] of Object.entries(patch || {})) {
    const hadOld = Object.prototype.hasOwnProperty.call(before, k);
    const oldValue = hadOld ? before[k] : undefined;
    if (hadOld && Object.is(oldValue, newValue)) continue;  // 值没变不广播
    changes[k] = hadOld ? { oldValue, newValue } : { newValue };
  }
  return changes;
}

/** chrome.alarms.create 的调度时间计算：when 为绝对时间戳，periodInMinutes 为周期。 */
function computeAlarmDelay(spec, now) {
  const n = Number(now) || Date.now();
  const period = Number(spec && spec.periodInMinutes);
  if (Number.isFinite(period) && period > 0) return Math.max(100, Math.round(period * 60000));
  const when = Number(spec && spec.when);
  if (Number.isFinite(when)) return Math.max(0, Math.round(when - n));
  return null;
}

/** 把 Electron BrowserWindow 状态转成 chrome.tabs.Tab 形状。 */
function tabObject(info) {
  return {
    id: info.id,
    windowId: info.windowId,
    url: info.url || '',
    status: info.loading ? 'loading' : 'complete',
    active: !!info.active,
    index: Number(info.index) || 0,
    title: info.title || '',
    height: info.height || 0,
    width: info.width || 0
  };
}

/** chrome.scripting.executeScript({func, args}) → 可在页面上下文执行的代码字符串。
 *  与 Chrome 扩展一致：函数被序列化，因此注入函数必须是自包含的（原插件已满足）。 */
function buildInjectCode(funcSource, args) {
  /* v1.1.4：宁可抛明确错误，也不要把 `[native code]` 拼进脚本后
     在 V8 里变成难懂的 `Unexpected identifier 'code'`。 */
  if (!funcSource || /\[native code\]/.test(String(funcSource))) {
    throw new Error('inject func was not serialized in main world (contextBridge proxy)');
  }
  const list = Array.isArray(args) ? args : [];
  const argv = list.map(a => JSON.stringify(a === undefined ? null : a)).join(',');
  return `(async () => {\n  const __fn = ${funcSource};\n  return await Promise.resolve(__fn(${argv}));\n})()`;
}

/** 把主进程 net.fetch 的结果收敛成 background.js 需要的 Response-like 形状。 */
function wrapFetchResult(r) {
  return {
    ok: !!r.ok,
    status: Number(r.status) || 0,
    url: r.url || '',
    headers: r.headers || {},
    body: typeof r.body === 'string' ? r.body : '',
    error: r.error || null
  };
}

/** 从 fetch init 里挑出可以通过 IPC 传输的字段，剥离不可克隆的 signal / 函数。 */
function serializableInit(init) {
  const src = init || {};
  const out = {};
  if (typeof src.method === 'string') out.method = src.method;
  if (src.headers && typeof src.headers === 'object' && !Array.isArray(src.headers)) {
    out.headers = {};
    for (const [k, v] of Object.entries(src.headers)) {
      if (typeof v === 'string' || typeof v === 'number') out.headers[k] = String(v);
    }
  }
  if (typeof src.body === 'string') out.body = src.body;
  if (typeof src.cache === 'string') out.cache = src.cache;
  if (src.credentials === 'include' || src.credentials === 'omit') out.credentials = src.credentials;
  if (Number.isFinite(Number(src.desktopTimeoutMs))) out.desktopTimeoutMs = Number(src.desktopTimeoutMs);
  return out;
}

/** 判断是否为需要走主进程会话代理的网络请求（本地文件保持原生 fetch）。 */
function shouldProxyFetch(input) {
  const u = String(input || '');
  return /^https?:\/\//i.test(u);
}

module.exports = {
  normalizeGetKeys,
  isRewardsAuthCookie,
  diffStorage,
  computeAlarmDelay,
  tabObject,
  buildInjectCode,
  wrapFetchResult,
  serializableInit,
  shouldProxyFetch
};
