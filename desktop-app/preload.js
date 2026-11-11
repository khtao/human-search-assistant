/* ============================================================================
 * Chrome 扩展 API 兼容层（运行在 Electron preload / isolated world）
 *
 * 目标：让 src/popup.js 与 src/background.js 一行都不用改，就能在桌面版里运行。
 * 所有 chrome.* 调用通过 IPC 交给主进程 main.js，由 Electron API 实现；
 * 事件类 API 在本地维护 listener 集合，由主进程广播触发。
 * ========================================================================== */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/* ------------------------------------------------------------------ 事件系统 */
const registry = new Map();
function makeEvent(key) {
  const set = new Set();
  registry.set(key, set);
  return {
    addListener: fn => { if (typeof fn === 'function') set.add(fn); },
    removeListener: fn => set.delete(fn),
    hasListener: fn => set.has(fn),
    hasListeners: () => set.size > 0
  };
}

ipcRenderer.on('chrome:event', (_e, payload) => {
  const set = registry.get(payload && payload.key);
  if (!set || !set.size) return;
  const args = Array.isArray(payload.args) ? payload.args : [];
  for (const fn of [...set]) {
    try { fn(...args); } catch (err) { console.error('[shim] listener error:', err); }
  }
});

/* chrome.runtime.onMessage 特殊处理：listener 可能异步调用 sendResponse，
   需要把结果回传给发起方（popup 窗口的 sendMessage Promise）。 */
const messageListeners = new Set();
function dispatchMessage(msg) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const sendResponse = value => finish(value);

    /* v1.3.1：真实 chrome.runtime.onMessage 会把消息投递给「每一个」监听器，
       只有第一个 sendResponse 生效。旧版遇到同步应答 / return true 就 return，
       后面的监听器永远收不到 —— 这正是主进程 syncRewards 被吞掉的根因之一。 */
    let asyncPending = false;
    for (const fn of [...messageListeners]) {
      let ret;
      try { ret = fn(msg, { id: 'desktop', tab: null, url: '' }, sendResponse); }
      catch (err) { console.error('[shim] onMessage error:', err); continue; }
      if (ret === true) {
        // 异步响应：最多等 14 秒（略短于主进程 15 秒兜底），避免永远挂起
        asyncPending = true;
        setTimeout(() => finish(undefined), 14000);
        continue;
      }
      if (ret && typeof ret.then === 'function') {
        asyncPending = true;
        ret.then(finish, () => finish(undefined));
        continue;
      }
    }
    // fire-and-forget 消息（start / refreshTasks 等）；异步响应未决时不能提前收口
    if (!settled && !asyncPending) finish(undefined);
  });
}

ipcRenderer.on('chrome:runtime:dispatch', async (_e, payload) => {
  const value = await dispatchMessage(payload.msg);
  ipcRenderer.send(payload.replyChannel, value === undefined ? null : value);
});

/* ------------------------------------------------------------------ storage */
const storageLocal = {
  get: keys => invoke('chrome:storage:get', keys == null ? null : keys),
  set: obj => invoke('chrome:storage:set', obj || {}),
  remove: keys => invoke('chrome:storage:remove', keys),
  clear: () => invoke('chrome:storage:clear')
};

/* ------------------------------------------------------------------ tabs */
/* v1.0.9：主界面右侧的内嵌官网面板（仅桌面版有，扩展版隐藏对应按钮） */
/* v1.3.8 · 桌面版专有设置：开机自动启动（Electron 登录项） */
const desktopApp = {
  isDesktop: true,
  setAutoLaunch: enabled => invoke('chrome:app:autoLaunch', !!enabled),
  getAutoLaunch: () => invoke('chrome:app:autoLaunch:get')
};

const desktopPanel = {
  show: url => invoke('chrome:panel:show', url || null),
  hide: () => invoke('chrome:panel:hide'),
  toggle: () => invoke('chrome:panel:toggle'),
  state: () => invoke('chrome:panel:state')
};

const tabs = {
  get: tabId => invoke('chrome:tabs:get', Number(tabId)),
  query: info => invoke('chrome:tabs:query', info || {}),
  create: opts => invoke('chrome:tabs:create', opts || {}),
  update: (tabId, opts) => invoke('chrome:tabs:update', Number(tabId), opts || {}),
  remove: tabId => invoke('chrome:tabs:remove', Number(tabId)),
  goBack: tabId => invoke('chrome:tabs:goBack', Number(tabId)),
  onUpdated: makeEvent('tabs.onUpdated'),
  onRemoved: makeEvent('tabs.onRemoved'),
  onActivated: makeEvent('tabs.onActivated')
};

/* ------------------------------------------------------------------ scripting */
const scripting = {
  executeScript: spec => {
    const s = spec || {};
    const target = s.target || {};
    return invoke('chrome:scripting:executeScript', {
      tabId: Number(target.tabId),
      allFrames: !!s.allFrames,
      frameIds: Array.isArray(target.frameIds) ? target.frameIds.map(Number) : null,
      /* v1.1.4：优先用调用方在 main world 序列化好的字符串。
         contextBridge 会把跨世界传入的函数转成代理，其 toString() 是
         `function () { [native code] }`，拼进注入代码必然语法错。 */
      funcSource: (typeof s.funcSource === 'string' && s.funcSource)
        ? s.funcSource
        : (typeof s.func === 'function' ? String(s.func) : null),
      args: Array.isArray(s.args) ? s.args : []
    });
  }
};

/* ------------------------------------------------------------------ debugger */
const debuggerApi = {
  attach: (target, version) => invoke('chrome:debugger:attach', Number(target.tabId), version || '1.3'),
  detach: target => invoke('chrome:debugger:detach', Number(target.tabId)),
  sendCommand: (target, method, params) =>
    invoke('chrome:debugger:sendCommand', Number(target.tabId), method, params || {}),
  onEvent: makeEvent('debugger.onEvent'),
  onDetach: makeEvent('debugger.onDetach')
};

/* ------------------------------------------------------------------ alarms */
const alarms = {
  create: (name, info) => invoke('chrome:alarms:create', name, info || {}),
  clear: name => invoke('chrome:alarms:clear', name),
  get: name => invoke('chrome:alarms:get', name),
  getAll: () => invoke('chrome:alarms:getAll'),
  onAlarm: makeEvent('alarms.onAlarm')
};

/* ------------------------------------------------------------------ windows */
const windows = {
  update: (windowId, info) => invoke('chrome:windows:update', Number(windowId), info || {}),
  get: windowId => invoke('chrome:windows:get', Number(windowId)),
  getCurrent: () => invoke('chrome:windows:getCurrent'),
  onCreated: makeEvent('windows.onCreated'),
  onRemoved: makeEvent('windows.onRemoved')
};

/* ------------------------------------------------------------------ permissions
 * 桌面版天然拥有完整页面访问能力，contains() 恒定为真；事件保留为空实现。 */
const permissions = {
  contains: () => Promise.resolve(true),
  request: () => Promise.resolve(true),
  remove: () => Promise.resolve(true),
  getAll: () => Promise.resolve({ origins: ['<all_urls>'], permissions: [] }),
  onAdded: makeEvent('permissions.onAdded'),
  onRemoved: makeEvent('permissions.onRemoved')
};

/* ------------------------------------------------------------------ runtime */
const runtime = {
  id: 'human-search-assistant-desktop',
  sendMessage: (msg, cb) => {
    const p = invoke('chrome:runtime:sendMessage', msg).then(v => v === null ? undefined : v);
    if (typeof cb === 'function') p.then(cb, () => cb(undefined));
    return p;
  },
  getURL: path => 'file://' + String(path || '').replace(/^\//, ''),
  getManifest: () => invoke('chrome:runtime:getManifest'),
  onMessage: {
    addListener: fn => { if (typeof fn === 'function') messageListeners.add(fn); },
    removeListener: fn => messageListeners.delete(fn),
    hasListener: fn => messageListeners.has(fn),
    hasListeners: () => messageListeners.size > 0
  },
  onInstalled: makeEvent('runtime.onInstalled'),
  onStartup: makeEvent('runtime.onStartup')
};

/* ------------------------------------------------------------------ 导出 chrome */
/* v1.1.3：Chromium 156 / Electron 45 下 `window.chrome` 可能被浏览器内置的
   同名对象占用，导致 contextBridge 注入 'chrome' 失败或只得到半份 API
   （真机表现：右上角没有「官网」面板按钮、点登录毫无反应）。
   这里把同一份 shim 再用一个绝不可能冲突的 key 备份一次，主进程在
   did-finish-load 时探针发现缺失即可用备份恢复并 reload 一次。 */
const chromeApi = {
  storage: { local: storageLocal, onChanged: makeEvent('storage.onChanged') },
  runtime,
  /* v1.1.8：删除 onTick / onSync 两个专用「刷新界面」事件。
     UI 重绘唯一入口是 storage.onChanged —— 业务数据写回时自然触发，
     不存在任何由主进程主动发起的界面刷新通道。 */
  /* 面板展开/收起状态（桌面版专用） */
  onPanel: makeEvent('ui:panel'),
  /* v1.3.2：桌面版任务侧栏——一次调用完成两页滚动扫描与逐张点击 */
  taskPanel: { clickAll: (index, options) => invoke('chrome:task:clickAll', index, options || {}) },
  desktopPanel,
  desktopApp,
  tabs,
  scripting,
  debugger: debuggerApi,
  alarms,
  windows,
  permissions,
  action: { setBadgeText: () => Promise.resolve(), setTitle: () => Promise.resolve() },
  i18n: { getUILanguage: () => 'zh-CN' }
};
try {
  contextBridge.exposeInMainWorld('__hsaChrome', chromeApi);   // 一定成功：无内置同名对象
} catch (err) {
  console.error('[shim] __hsaChrome 注入失败:', err);
}
try {
  contextBridge.exposeInMainWorld('chrome', chromeApi);
} catch (err) {
  console.error('[shim] chrome 注入失败（将由主进程自愈）:', err);
}

/* ------------------------------------------------------- 网络请求代理辅助
 * background.js 用 fetch() 直连 Rewards / 热搜源，并依赖会话 Cookie。
 * 桌面版把 http(s) 请求交给主进程的 Electron net.fetch（共享同一 session，
 * 自动带 Cookie、自动跟随重定向、自动解压），再在 host.html 里包装成
 * Response-like 对象还给未改动的业务代码。 */
let fetchSeq = 0;
contextBridge.exposeInMainWorld('__desktop', {
  fetchRaw: (url, init, id) => invoke('chrome:fetch', url, init || {}, id),
  abort: id => ipcRenderer.send('chrome:fetch:abort', id),
  nextId: () => ++fetchSeq,
  /* host.html 在 background.js 执行完、onMessage 已注册后调用，
     主进程据此放行消息队列。其它窗口不会调用。 */
  hostReady: () => ipcRenderer.send('chrome:host:ready'),
  /* v1.1.3：即使 window.chrome 整体注入失败，__desktop 仍可用，
     登录徽标 / 面板按钮走这些通道也能展开右侧官网页面。 */
  openOfficial: url => invoke('chrome:open:official', url || null),
  hidePanel: () => invoke('chrome:panel:hide'),
  togglePanel: () => invoke('chrome:panel:toggle'),
  panelState: () => invoke('chrome:panel:state'),
  debugLog: (scope, msg, data) => ipcRenderer.send('chrome:debug:log', scope, msg, data),
  /* 保存 background.js 里解析函数实际输入的 HTML（原始 + 合成字段） */
  saveHtml: (kind, url, html, meta) =>
    ipcRenderer.send('chrome:debug:page', kind, url, html, meta || {}),
  /* v1.1.4：直接读用户眼前那个官网侧栏（不经 tabs.query / waitForSettled /
     12 秒 guard 竞速），返回渲染 DOM 的完整 HTML、可见文本与积分。 */
  readVisibleRewards: () => invoke('chrome:rewards:readVisible'),
  /* v1.3.2：即使 window.chrome 只剩半份，任务点击仍能走通 */
  taskClickAll: (index, options) => invoke('chrome:task:clickAll', index, options || {}),
  shimVersion: '1.3.8',
  setAutoLaunch: enabled => invoke('chrome:app:autoLaunch', !!enabled),
  getAutoLaunch: () => invoke('chrome:app:autoLaunch:get'),
  /* 诊断数据导出：系统保存对话框写 JSON 文件 */
  saveExport: (fileName, content, encoding) => invoke('chrome:diag:export',
    String(fileName || ''), String(content || ''), String(encoding || ''))
});
