/* ============================================================================
 * 拟人搜索助手 · 桌面版主进程
 *
 * 设计原则：插件源码（src/）保持 1:1 原样，所有平台差异收敛在本文件与
 * preload.js 的兼容层里。Chrome 扩展 API 在此由等价的 Electron API 实现：
 *
 *   chrome.storage.local   → userData/storage.json + IPC 广播
 *   chrome.tabs.*          → BrowserWindow 池（tabId = webContents.id）
 *   chrome.scripting       → webContents / WebFrameMain.executeJavaScript
 *   chrome.debugger        → webContents.debugger（CDP 1.3）
 *   chrome.alarms          → 主进程定时器（可跨窗口存活）
 *   chrome.runtime         → popup ↔ host 的 IPC 消息总线
 *   chrome.windows         → BrowserWindow.focus()
 *   chrome.permissions     → 桌面版天然拥有权限，contains() 恒真
 *   fetch(http/https)      → Electron net.fetch + 会话 Cookie（见 chrome:fetch）
 * ========================================================================== */
/* ============================================================================
 * 运行时：Windows 与 Linux 使用同一套 Electron —— 同版本、同 API、同 session、
 * 同窗口模型。生产路径唯一：require('electron')，不再按平台自动降级。
 *
 * lib/electron-lite.js 仅在 HSA_HEADLESS=1 时作为「无头 CI 验证替身」加载，
 * 只被 scripts/ 下的验证脚本使用，不参与任何平台的产品运行。
 * ========================================================================== */
const E = (() => {
  if (process.env.HSA_HEADLESS === '1') return require('./lib/electron-lite');
  const m = require('electron');
  if (!m || !m.app) {
    throw new Error('[runtime] 未检测到 Electron。请用 npm start 启动；无头验证请设 HSA_HEADLESS=1。');
  }
  return m;
})();
const { app, BrowserWindow, BrowserView, WebContentsView, Tray, Menu, ipcMain, net, session,
        nativeImage, shell } = E;

/* v1.1.2 · Electron 45：BrowserView 自 Electron 30 起已弃用，官方推荐
 * WebContentsView。构造参数一致（都接受 { webPreferences }），差异只在挂载：
 *   BrowserView   → win.addBrowserView(view)
 *   WebContentsView → win.contentView.addChildView(view)
 * 这里优先用新 API，并保留旧 API 回退（Electron 28 也能跑同一份代码），
 * Windows / Ubuntu 仍共用这一个运行时与这一套窗口模型。 */
const ViewClass = WebContentsView || BrowserView;
const VIEW_API = WebContentsView ? 'WebContentsView' : 'BrowserView';
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { DebugCapture } = require('./lib/debug-capture');
/* v1.1.6：调试默认禁用，仅命令行 `npm run start:debug`（HSA_DEBUG=1）开启。
   默认关闭可避免生产运行时持续的 HTML 落盘与 I/O。 */
const DBG = new DebugCapture();
const C = require('./lib/core');
const HSA_CORE = require('./shared/hsa-core.js');
const RUNTIME_BUDGET = require('./lib/runtime-budget.js');
const SidebarCards = require('./lib/sidebar-task-cards');

/* ==========================================================================
 * v2.9 · 已移除全部浏览器伪装
 *   · 不再设置全局 UA，也不再逐视图改写 UA；
 *   · 不再注入客户端提示头，也不再注册请求头改写钩子；
 *   · 不再在每个页面注入身份覆盖脚本（省掉常驻闭包与 dom-ready 监听）；
 *   内置浏览器使用 Electron 自身真实身份。仅保留上一轮要求的默认主页 /
 *   默认搜索引擎为 Bing（属于起始页设置，与身份伪装无关）。
 * ======================================================================== */
const DEFAULT_BROWSER_HOME = 'https://www.bing.com/?mkt=zh-CN';
const DEFAULT_SEARCH_ENGINE = 'https://www.bing.com/search?q=';
const { MemoryGovernor, trimSnapshotHtml, SNAPSHOT_HTML_LIMIT } = require('./lib/memory-governor');

/* 所有窗口（popup / host / Rewards 标签页 / 登录窗口）显式共用同一个
   持久化会话。此前登录 Cookie 落在标签页会话、后台 fetch 读的是另一处视图，
   在真 Electron（Windows）上表现为「登录了但积分与登录态不同步」。

   ⚠️ v1.0.7 启动崩溃修复：Electron 的 session.defaultSession 是「就绪后」
   才能取的 getter，在模块顶层（app.whenReady 之前）求值会直接抛
   `TypeError: Session can only be received when app is ready`。
   之前的无头验证替身把 session 做成普通对象，掩盖了这个真机差异。
   这里改为惰性获取：顶层只声明，ready 后由 initAppSession() 赋值。 */
let APP_SESSION = null;

/** 唯一取用入口：未就绪时返回 null（调用方有兜底），绝不提前触碰 defaultSession。 */
function getAppSession() {
  if (APP_SESSION) return APP_SESSION;
  try {
    if (typeof app.isReady === 'function' && !app.isReady()) return null;
    APP_SESSION = session.defaultSession;
  } catch { return null; }
  return APP_SESSION;
}

/* v2.9 · 不再注册任何请求头改写钩子：每次网络请求少一次 webRequest 回调，
   Electron 自带 UA / 客户端提示直接透传。 */
/** app.whenReady() 的第一件事：拿到会话并挂上 Cookie 同步监听。 */
function initAppSession() {
  if (APP_SESSION) return APP_SESSION;
  APP_SESSION = session.defaultSession;
  attachSessionSync();
  return APP_SESSION;
}

const ROOT = __dirname;
const PRELOAD = path.join(ROOT, 'preload.js');
const SRC = path.join(ROOT, 'src');
const USER = () => app.getPath('userData');

/* ------------------------------------------------------------ 单实例 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (popupWin) { popupWin.show(); popupWin.focus(); } });
}

let popupWin = null;
let hostWin = null;
let tray = null;
let quitting = false;

/* ==========================================================================
 * 1. storage.local —— 单一 JSON 文件 + onChanged 广播
 * ======================================================================== */
let state = {};
const statePath = () => path.join(USER(), 'storage.json');
function loadState() {
  try { state = JSON.parse(fs.readFileSync(statePath(), 'utf8')); }
  catch { state = {}; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
}
/* ==========================================================================
 * v2.9 · 桌面版写盘效率：以前每条运行日志都触发一次「整份 state 美化 JSON」
 * 同步写盘，而 state 里含 2 份 600KB 页面快照 + 600 条日志，运行期密集写盘
 * 会反复序列化几 MB。现在：
 *   · 紧凑 JSON（去掉 2 空格缩进）；
 *   · 前导立即写 + 150ms 尾随合并，高频写入最多约 6~7 次/秒；
 *   · 落盘副本只裁大快照（内存态保持完整，功能不受影响）；
 *   · will-quit 前强制 flush，绝不丢状态。
 * ======================================================================== */
const stateWrites = RUNTIME_BUDGET.makeWriteThrottle({
  now: () => Date.now(),
  write: () => {
    try {
      fs.mkdirSync(USER(), { recursive: true });
      fs.writeFileSync(statePath(),
        JSON.stringify(RUNTIME_BUDGET.diskState(state)), 'utf8');
    } catch (err) { console.error('[storage] 写入失败:', err.message); }
  },
  schedule: (fn, ms) => {
    const id = setTimeout(fn, ms);
    if (id.unref) id.unref();
    return id;
  },
  cancel: id => clearTimeout(id)
});
function saveState() { stateWrites.save(); }
function flushStateSync() { stateWrites.flush(); }

const shimWindows = new Set();      // 加载了 preload 的窗口（可接收事件广播）
function broadcast(key, args) {
  for (const wc of shimWindows) {
    if (wc && !wc.isDestroyed()) wc.send('chrome:event', { key, args });
  }
}

/* ==========================================================================
 * v1.1.8 · 零监控、零自动刷新界面
 * 主界面重绘的唯一入口是 chrome.storage.onChanged（业务数据写回时）与用户
 * 交互回调；这里不再有任何专用的「刷新界面」广播（ui:tick / ui:sync 已删除）。
 * 后台每次重写 pointsSummary / todayTasks 都会带新的 updatedAt；若只按对象
 * 引用比较，相同积分也会每轮广播 —— 那等于一直在刷。这里对积分/任务/快照
 * 对象做语义比对，忽略纯元数据字段，值不变就一个事件都不发。
 * ======================================================================== */
const SNAPSHOT_KEYS = new Set([
  'pointsSummary', 'todayTasks', 'taskClickIndex', 'visibleRewardsSnapshot', 'visibleRewardsEarnSnapshot'
]);
const UI_META_KEYS = new Set([
  'updatedAt', 'checkedAt', 'fetchedAt', 'ts', 'timestamp', 'capturedAt', 'at', 'reason'
]);
/* 只过滤纯时间戳心跳；signOutSignalAt 是业务信号（后台据此关闭积分护栏），
   必须照常广播，不能当成心跳丢掉。 */
const UI_HEARTBEAT_KEYS = new Set([
  'lastActivity', 'loginCheckedAt', 'todayCheckedAt'
]);

function uiFingerprint(v, isSnapshot) {
  if (Array.isArray(v)) return v.map(x => uiFingerprint(x, isSnapshot));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (isSnapshot && UI_META_KEYS.has(k)) continue;
      o[k] = uiFingerprint(v[k], isSnapshot);
    }
    return o;
  }
  return v;
}
function uiSame(key, a, b) {
  const snap = SNAPSHOT_KEYS.has(key);
  try { return JSON.stringify(uiFingerprint(a, snap)) === JSON.stringify(uiFingerprint(b, snap)); }
  catch { return Object.is(a, b); }
}
/** 返回真正需要通知 UI 的 changes；无变化时一个事件都不发。 */
function emitStorageChanges(before, patch, opts) {
  const raw = C.diffStorage(before, patch || {});
  const changes = {};
  for (const [k, ch] of Object.entries(raw)) {
    if (UI_HEARTBEAT_KEYS.has(k)) continue;             // 纯心跳字段不触发重绘
    if (k === 'taskClickIndex') continue;               // 点击定位索引不属于界面数据
    /* v1.3.1：官网页面快照只作为后台取数的数据源，不是界面数据；
       同步元数据同理。只有积分 / 任务 / 登录态等业务键变化才重绘一次。 */
    if (k === 'visibleRewardsSnapshot' || k === 'visibleRewardsEarnSnapshot') continue;
    if (k === 'syncAt' || k === 'syncReason') continue;
    if (Object.prototype.hasOwnProperty.call(ch, 'oldValue') &&
        Object.prototype.hasOwnProperty.call(ch, 'newValue') &&
        uiSame(k, ch.oldValue, ch.newValue)) continue;   // 积分/任务语义没变
    changes[k] = ch;
  }
  const keys = Object.keys(changes);
  if (keys.length) {
    // 唯一通知：数据真的变了 → popup 的 storage.onChanged 监听器重绘一次
    broadcast('storage.onChanged', [changes, 'local']);
  }
  return changes;
}

/* v1.3.8 · 主进程写精简运行详情（与后台同一份 activityDetail 结构）。
   静默开关不参与这里：无论是否静默，卡片 / 页面 / 下一步详情都照常写入，
   popup 在进度圆圈下方原状态行显示，与正常流程完全一致。 */
function desktopActivityPush(info) {
  const prev = state.activityDetail;
  const now = Date.now();
  const delayMs = Math.max(0, Math.round(Number(info && info.delayMs) || 0));
  const payload = Object.assign({
    at: now, until: delayMs ? now + delayMs : 0,
    state: 'running', zh: '', en: '', page: '', card: '',
    next: '', delayMs: delayMs, query: ''
  }, info || {});
  state.activityDetail = payload;
  saveState();
  try {
    broadcast('storage.onChanged', [{ activityDetail: { oldValue: prev, newValue: payload } }, 'local']);
  } catch {}
}

ipcMain.handle('chrome:storage:get', (_e, keys) => C.normalizeGetKeys(keys, state));
ipcMain.handle('chrome:storage:set', (_e, patch) => {
  const changes = emitStorageChanges(state, patch, { reason: 'storage:set' });
  Object.assign(state, patch);
  saveState();
  DBG.ipc('chrome:storage:set', { keys: Object.keys(patch || {}) });
  if (patch && ('pointsSummary' in patch || 'todayTasks' in patch || 'loginStatus' in patch)) {
    DBG.event({ t: Date.now(), type: 'storage-key',
      loginStatus: patch.loginStatus,
      points: patch.pointsSummary || null,
      taskCount: patch.todayTasks && Array.isArray(patch.todayTasks.items)
        ? patch.todayTasks.items.length : null,
      signedOut: patch.todayTasks ? !!patch.todayTasks.signedOut : null });
    DBG.snapshotStorage(state);
  }
  // 运行时展开右侧官网面板，结束自动收起；手动展开的面板不自动收。
  if (Object.prototype.hasOwnProperty.call(patch, 'running')) {
    try {
      if (patch.running === true) {
        if (!sideVisible) showSidePanel(null, 'run', false);
      } else if (patch.running === false && panelReason === 'run') {
        hideSidePanel();
      }
    } catch (err) { console.warn('[panel] 自动显隐失败:', err.message); }
    /* 任务启动要立刻退出静默并恢复保活；结束则允许重新进入低占用态 */
    governMemory('running:' + patch.running);
  }
  return null;
});
ipcMain.handle('chrome:storage:remove', (_e, keys) => {
  const list = Array.isArray(keys) ? keys : [keys];
  const changes = {};
  for (const k of list) {
    if (Object.prototype.hasOwnProperty.call(state, k)) {
      changes[k] = { oldValue: state[k] };
      delete state[k];
    }
  }
  saveState();
  if (Object.keys(changes).length) broadcast('storage.onChanged', [changes, 'local']);
  return null;
});
ipcMain.handle('chrome:storage:clear', () => {
  state = {}; saveState();
  broadcast('storage.onChanged', [{}, 'local']);
  return null;
});

/* v1.3.8 · 开机自动启动：默认关闭，由设置页开关手动开启 */
ipcMain.handle('chrome:app:autoLaunch', (_e, enabled) => {
  const on = !!enabled;
  try {
    if (typeof app.setLoginItemSettings === 'function') {
      app.setLoginItemSettings({ openAtLogin: on, openAsHidden: false });
    }
  } catch (err) {
    DBG.log('startup', '设置开机自启失败', { error: String(err && err.message || err) });
  }
  state.launchAtLogin = on;
  saveState();
  return on;
});
/* 诊断数据导出：运行日志 / 实时关键网页，用户选路径后写盘（不落进日常日志）。 */
ipcMain.handle('chrome:diag:export', async (_e, fileName, content, encoding) => {
  try {
    const dlg = E.dialog;
    if (!dlg || typeof dlg.showSaveDialog !== 'function') {
      return { ok: false, reason: 'unavailable', message: 'save dialog unavailable' };
    }
    const name = String(fileName || 'hsa-export.json').replace(/[\\/:*?"<>|]/g, '_');
    const isZip = /\.zip$/i.test(name);
    const res = await dlg.showSaveDialog({
      title: '导出诊断数据',
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: [isZip ? { name: 'ZIP', extensions: ['zip'] }
                      : { name: 'JSON', extensions: ['json'] }]
    });
    if (!res || res.canceled || !res.filePath) return { ok: false, reason: 'canceled' };
    /* 文本日志写 utf8；HTML zip 包由 base64 还原为二进制后写盘。 */
    if (String(encoding || '') === 'base64') {
      fs.writeFileSync(res.filePath, Buffer.from(String(content || ''), 'base64'));
    } else {
      fs.writeFileSync(res.filePath, String(content || ''), 'utf8');
    }
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, reason: 'error', message: String(err && err.message || err) };
  }
});

ipcMain.handle('chrome:app:autoLaunch:get', () => {
  try {
    if (typeof app.getLoginItemSettings === 'function') {
      return !!app.getLoginItemSettings().openAtLogin;
    }
  } catch {}
  return !!state.launchAtLogin;
});

/* ==========================================================================
 * 2. fetch 代理 —— 让未改动的 background.js 能带 Cookie 访问 Rewards / 热搜源
 *    主进程用 Electron 网络栈，无 CORS 限制，自动跟随重定向与解压。
 * ======================================================================== */
const fetchControllers = new Map();

async function cookieHeaderFor(url) {
  try {
    const s = getAppSession();
    if (!s) return '';                       // app 未就绪：不带 Cookie，也不抛错
    const list = await s.cookies.get({ url });
    return (list || []).filter(c => c && c.name).map(c => `${c.name}=${c.value}`).join('; ');
  } catch { return ''; }
}

/** net.fetch 不可用时的最小回退。 */
function legacyRequest(url, opts, cookie) {
  return new Promise((resolve, reject) => {
    const s = getAppSession();
    if (!s) { reject(new Error('app 尚未就绪，无法发起网络请求')); return; }
    const req = net.request({
      method: opts.method || 'GET', url,
      session: s, redirect: 'follow'
    });
    for (const [k, v] of Object.entries(opts.headers || {})) req.setHeader(k, v);
    if (cookie) req.setHeader('Cookie', cookie);
    const chunks = [];
    req.on('response', res => {
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String((res.headers['content-encoding'] || res.headers['Content-Encoding'] || '')).toLowerCase();
        try {
          if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
          else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
        } catch {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode, url,
          headers: res.headers || {},
          text: async () => buf.toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

ipcMain.handle('chrome:fetch', async (_e, url, init, id) => {
  const timeoutMs = Math.max(1000, Number(init.desktopTimeoutMs) || 12000);
  // 用 Promise.race 实现超时/取消，同时用 AbortSignal 真正中止底层请求。
  // 超时后若底层请求仍在下载响应体，主进程会一直持有那个 Buffer，必须真正中止。
  const ctl = { reject: null, aborted: false, abort: null };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const e = new Error('timed out'); e.name = 'AbortError'; reject(e);
    }, timeoutMs);
    ctl.reject = () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    };
  });
  ctl.abort = () => {
    if (ctl.aborted) return;
    ctl.aborted = true;
    try { controller && controller.abort(); } catch {}
    try { ctl.reject && ctl.reject(); } catch {}
  };
  fetchControllers.set(id, ctl);
  // cookie 读取也在同一个 guard 覆盖范围内，避免登录探测挂起时 handler 永不返回。
  const work = (async () => {
    /* v2.9：无伪装，保留业务自带的必要请求头（Referer / Cookie 等）。 */
    const headers = Object.assign({}, init.headers || {});
    const cookie = await cookieHeaderFor(url);
    if (cookie && !headers.Cookie && !headers.cookie) headers.Cookie = cookie;
    const opts = { method: init.method || 'GET', headers, body: init.body || undefined };
    if (controller) opts.signal = controller.signal;
    const res = typeof net.fetch === 'function'
      ? await net.fetch(url, opts)
      : await legacyRequest(url, opts, cookie);
    const body = await res.text();
    const h = res.headers && typeof res.headers.entries === 'function'
      ? Object.fromEntries(res.headers.entries()) : (res.headers || {});
    const finalUrl = res.url || url;
    // 未登录时 Rewards 会 302 到 login.live.com；Electron 的 net.fetch 默认跟随，
    // 这里按 redirect:'error' 的语义还原，避免把登录页 HTML 当成已登录的数据。
    if (init.redirect === 'error' && finalUrl && finalUrl !== url) {
      return C.wrapFetchResult({
        ok: false, status: res.status, url: finalUrl,
        headers: h, body: '', error: 'redirected'
      });
    }
    return C.wrapFetchResult({
      ok: res.ok, status: res.status, url: finalUrl,
      headers: h, body, error: null
    });
  })();
  try {
    return await Promise.race([work, guard]);
  } catch (err) {
    return C.wrapFetchResult({
      ok: false, status: 0, url, body: '', headers: {},
      error: err && err.name === 'AbortError' ? 'timed out' : String(err && err.message || err)
    });
  } finally {
    clearTimeout(timer);
    /* 竞态失败（超时/主动取消）时中止底层请求，释放响应体 */
    if (ctl.aborted) { try { controller && controller.abort(); } catch {} }
    fetchControllers.delete(id);
  }
});
ipcMain.on('chrome:fetch:abort', (_e, id) => {
  const c = fetchControllers.get(id);
  if (c && typeof c.abort === 'function') c.abort();
});

/* ==========================================================================
 * 3. tabs —— 一个 BrowserWindow 就是一个标签页，tabId = webContents.id
 * ======================================================================== */
const tabs = new Map();   // tabId -> { win, kind }
let activeTabId = null;
/* 从菜单/托盘打开的登录窗口：导航回 rewards 域时主动复检登录徽标 */
const loginTabIds = new Set();
const isSignedInRewardsUrl = url =>
  /^https:\/\/rewards\.bing\.com\/(dashboard|earn)/i.test(String(url || '')) &&
  !/login\.(live|microsoftonline)\.com/i.test(String(url || ''));

function tabInfo(id, entry) {
  const wc = entry.win.webContents;
  const size = entry.win.getSize();
  // kind 供 background.js 区分「用户可见的官网面板」与后台数据视图，
  // 浏览器扩展版的原生 tab 对象没有该字段，判断一律按可见页处理。
  return Object.assign(C.tabObject({
    id,
    windowId: entry.win.id,
    url: wc.getURL(),
    loading: wc.isLoading(),
    active: entry.win.isFocused(),
    index: [...tabs.keys()].indexOf(id),
    title: entry.win.getTitle(),
    width: size[0], height: size[1]
  }), { kind: entry.kind || 'page' });
}
function safeTab(id) {
  const e = tabs.get(Number(id));
  if (!e || e.win.isDestroyed()) return null;
  return tabInfo(Number(id), e);
}

function attachTabEvents(id, entry) {
  const wc = entry.win.webContents;
  wc.on('did-start-loading', () => {
    const t = safeTab(id); if (t) broadcast('tabs.onUpdated', [id, { status: 'loading' }, t]);
  });
  wc.on('did-finish-load', () => {
    const t = safeTab(id);
    if (t) broadcast('tabs.onUpdated', [id, { status: 'complete', url: t.url }, t]);
  });
  wc.on('did-navigate', (_e, url) => {
    const t = safeTab(id);
    if (t) broadcast('tabs.onUpdated', [id, { url, status: 'complete' }, Object.assign(t, { url })]);
    if (loginTabIds.has(id) && isSignedInRewardsUrl(url)) {
      /* v1.1.8：不再主动派发抓取。登录完成跳回 Rewards 后由 did-finish-load
         的可见 DOM 快照写回积分/任务（事件驱动，不是刷新）。 */
    }
  });
  wc.on('page-title-updated', () => {
    const t = safeTab(id); if (t) broadcast('tabs.onUpdated', [id, { title: t.title }, t]);
  });
  entry.win.on('focus', () => { activeTabId = id; });
  let removed = false;
  const cleanupTab = () => {
    if (removed) return;
    removed = true;
    tabs.delete(id);
    loginTabIds.delete(id);
    if (activeTabId === id) activeTabId = null;
    broadcast('tabs.onRemoved', [id, { windowId: entry.win.id, isWindowClosing: false }]);
  };
  entry.win.on('closed', cleanupTab);
  // BrowserWindow wrappers emit `closed`; WebContentsView wrappers do not.
  // Listen to webContents.destroyed as the common lifecycle boundary.
  wc.on('destroyed', cleanupTab);
  // 任务卡片 target="_blank" → 变成应用内新标签页，与 Chrome 行为一致
  wc.setWindowOpenHandler(({ url }) => {
    openInSidePanel(url, 'user');
    return { action: 'deny' };
  });
}

/* 应用图标统一使用用户提供的原版图标（build/icon.ico / icon.png），
   不再用壳层自行生成的图形。Windows 任务栏、窗口标题栏、托盘、
   electron-builder 安装包四处都会取到同一份资源。 */
const APP_ICON = path.join(ROOT, 'build',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png');

/* ==========================================================================
 * v1.0.9 · 主界面右侧「内嵌官网面板」
 *
 * 之前 chrome.tabs.create() 每次都 new BrowserWindow：登录徽标、可领取卡片、
 * 搜索页、任务卡片各自弹一个独立窗口，用户既看不到「点击有反应」，也没法在
 * 一个界面里完成登录 + 搜索。这一版把页面收进主窗口右侧：
 *
 *   ┌──────────────┬───────────────────────────────┐
 *   │ 助手 UI 400px │ 官方页面 WebContentsView（同一窗口）│
 *   └──────────────┴───────────────────────────────┘
 *
 * sideView 是用户可见的交互页（官方登录 / 搜索 / 任务卡片），直接 loadURL
 * rewards.bing.com —— 登录样式就是官网本身，不做任何自定义。
 * 两个 dataView 挂在同一窗口、bounds 为 0，专供积分/任务列表读 DOM，
 * 因此后台刷新不会把用户正在看的页面导航走。
 *
 * 「运行时展开 / 不运行时收起」由 storage.running 驱动：
 *   · running=true  → 自动展开（reason='run'，结束自动收起）
 *   · 用户点徽标/面板按钮 → 展开（reason='user'，不会被后台覆盖）
 * ======================================================================== */
const PANEL_LEFT = 400;            // 左侧助手 UI 宽度，与 popup.html 的 .app 一致
const PANEL_DEFAULT_RIGHT = 760;   // 展开后右侧官网面板宽度
const COLLAPSED_WIDTH = 400;

let sideView = null;
/* v3.0 · 静默期释放侧栏时记下现场，退出静默按需重建（不重建已收起的面板）。 */
let sideViewRestore = null;
let sideTabId = null;
let sideVisible = false;
let panelReason = null;            // 'user' | 'run' | null
/* v2.6：侧栏固定内嵌在主窗口右侧的 WebContentsView，自带独立滚动条；
   主界面与设置在 #scroll-root 共用另一根滚动条。独立窗口模式已移除。 */
/* v1.3.3 · 用户主动点登录徽标 / 面板按钮时，给主进程一个短暂保护窗口：
   这期间侧栏的导航、登录页 DOM、Cookie 变更都不得写任何业务键，
   否则「单击开关侧栏 / 双击打开主页」会把 20,192 分清成 null、图标变灰。 */
let userPanelActionUntil = 0;
function notePanelAction() { userPanelActionUntil = Date.now() + 6000; }
function panelActionActive() { return Date.now() < userPanelActionUntil; }
let collapsedSize = null;
const attachedViews = new Set();
const dataViews = new Map();       // 'dash' | 'earn' -> { view, entry, id, lastNav }
/* 每个 webContents 只保留一个延时 DOM 快照定时器：避免连续导航堆积闭包，
   或在视图销毁后仍持有 outerHTML 字符串。 */
const snapshotTimers = new WeakMap();
function scheduleViewSnapshot(wc, fn, ms) {
  if (!wc || wc.isDestroyed()) return;
  const prev = snapshotTimers.get(wc);
  if (prev) clearTimeout(prev);
  const id = setTimeout(() => {
    snapshotTimers.delete(wc);
    if (wc.isDestroyed()) return;
    try { Promise.resolve(fn()).catch(() => {}); } catch {}
  }, ms);
  if (id.unref) id.unref();
  snapshotTimers.set(wc, id);
}
function cancelViewSnapshot(wc) {
  if (!wc) return;
  const prev = snapshotTimers.get(wc);
  if (prev) { clearTimeout(prev); snapshotTimers.delete(wc); }
}

const isEmbeddedUrl = url => /^https?:\/\//i.test(String(url || ''));

/** WebContentsView / BrowserView 不是 BrowserWindow；包一层同名方法，让 tabs / tabInfo /
 *  attachTabEvents / scripting / debugger 全部照旧按 tabId 工作。 */
function viewAsWindow(view, opts) {
  const wc = view.webContents;
  const o = opts || {};
  return {
    webContents: wc,
    id: o.id != null ? o.id : wc.id,
    isDestroyed: () => wc.isDestroyed(),
    getSize: () => (o.getSize ? o.getSize()
      : (popupWin && !popupWin.isDestroyed()
        ? popupWin.getContentSize() : [PANEL_LEFT, 780])),
    getTitle: () => { try { return wc.getTitle(); } catch { return ''; } },
    isFocused: () => !!(o.isFocused && o.isFocused()),
    show: () => { if (o.onShow) o.onShow(); },
    focus: () => { if (o.onShow) o.onShow(); },
    loadURL: u => wc.loadURL(u),
    destroy: () => { if (o.onDestroy) o.onDestroy(); },
    on: () => {}    // 窗口级事件不适用；导航事件挂在 webContents 上
  };
}

/* v2.9 · 所有内嵌视图的单一创建入口。不再为每个 webContents 挂
   dom-ready 监听、不再持有 navigator 脚本字符串，减少常驻闭包与 GC 压力。 */
function newEmbeddedView(prefs) {
  return new ViewClass(prefs || embeddedViewPrefs());
}

/* ==========================================================================
 * v2.9 · 桌面版专用：离屏取数视图空闲回收
 * 两个 dataViews 创建后以前一直常驻（只有主窗口隐藏到托盘才由 governor 释放），
 * 每个都占一个 renderer 进程。这里用 unref 的低频巡检，空闲 90s 后销毁，
 * 下次同步按需重建；运行中 / 任务点击期间绝不释放，不影响数据链路。
 * ======================================================================== */
let dataViewSweepTimer = null;
function startDataViewSweep() {
  if (dataViewSweepTimer) return;
  dataViewSweepTimer = setInterval(() => {
    if (taskClickRunning || desktopQuietRun()) return;
    const now = Date.now();
    for (const [key, d] of [...dataViews]) {
      if (!RUNTIME_BUDGET.shouldReleaseIdleView(d.lastUsed, now, false)) continue;
      destroyEmbeddedView(d && d.view, d && d.id);
      dataViews.delete(key);
      DBG.log('memory', '释放空闲取数视图', { key });
    }
  }, 30000);
  if (dataViewSweepTimer.unref) dataViewSweepTimer.unref();
}
function stopDataViewSweep() {
  if (dataViewSweepTimer) { clearInterval(dataViewSweepTimer); dataViewSweepTimer = null; }
}

function attachView(view) {
  if (!popupWin || popupWin.isDestroyed() || attachedViews.has(view)) return;
  const cv = popupWin.contentView;
  const canNew = VIEW_API === 'WebContentsView' && cv && typeof cv.addChildView === 'function';
  const canOld = typeof popupWin.addBrowserView === 'function';
  DBG.log('view', 'attachView', { api: VIEW_API, canNew, canOld,
    hasContentView: !!cv, viewId: view && view.webContents && view.webContents.id });
  let done = false, lastErr = null;
  if (canNew) {
    try { cv.addChildView(view); done = true; } catch (e) { lastErr = e; }
  }
  if (!done && canOld) {
    try { popupWin.addBrowserView(view); done = true; } catch (e) { lastErr = e; }
  }
  if (done) { attachedViews.add(view); DBG.log('view', '视图挂载成功', { via: canNew ? 'contentView.addChildView' : 'addBrowserView' }); }
  else {
    /* 挂载失败会让侧栏永远不显示，必须留日志与控制台错误，不能静默吞掉 */
    DBG.log('view', '视图挂载失败（侧栏不会显示）', { error: String(lastErr && lastErr.message || lastErr) });
    console.error('[view] 挂载失败：' + String(lastErr && lastErr.message || lastErr));
  }
}

function embeddedViewPrefs() {
  return {
    webPreferences: {
      session: getAppSession() || undefined,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  };
}

/* v3.0 · 默认页延迟加载：以前视图一创建就 loadURL(Bing 首页)，即使面板从未
   展开也常驻一个重量级 SPA renderer，这是静默内存 1GB+ 的主要来源之一。
   现在只在面板真正展开 / 静默恢复且当前为 about:blank 时才加载。 */
function loadSideViewDefault(url) {
  if (!sideView || !sideView.webContents) return;
  try {
    const cur = sideView.webContents.getURL ? sideView.webContents.getURL() : '';
    if (!cur || /^about:blank/i.test(cur)) {
      if (url) sideView.webContents.loadURL(url);
      else sideView.webContents.loadURL(DEFAULT_BROWSER_HOME);
    }
  } catch (err) {}
}
function ensureSideView(initialUrl) {
  if (sideView) return sideView;
  sideView = newEmbeddedView(embeddedViewPrefs());
  attachView(sideView);
  sideView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  /* 创建时不预加载；只有显式给了恢复 URL 才立即回到原页面。 */
  if (initialUrl) { try { sideView.webContents.loadURL(initialUrl); } catch (err) {} }
  sideTabId = sideView.webContents.id;
  const entry = {
    kind: 'embedded',
    win: viewAsWindow(sideView, {
      id: sideTabId,
      isFocused: () => sideVisible && !!(popupWin && popupWin.isFocused()),
      getSize: () => {
        if (!popupWin || popupWin.isDestroyed()) return [PANEL_DEFAULT_RIGHT, 780];
        const [w, h] = popupWin.getContentSize();
        return [Math.max(1, w - PANEL_LEFT), h];
      },
      // 后台 ensureTabActive 把搜索页拉回焦点时，不能把手动/运行面板的
      // 显隐原因改成 'user'，否则 running=false 就不会自动收起
      onShow: () => showSidePanel(null, panelReason || 'user'),
      onDestroy: () => hideSidePanel()
    })
  };
  tabs.set(sideTabId, entry);
  attachTabEvents(sideTabId, entry);
  loginTabIds.add(sideTabId);       // 登录跳回 Rewards 时自动全量复检
  // v1.1.1：did-navigate 发生在导航「开始」，那时 DOM 还没渲染，
  // 注入只能拿到 about:blank。页面真正 load 完再强制同步一次，
  // 用户看到 20,192 分的那一刻，左侧积分与今日任务就能对齐。
  sideView.webContents.on('did-finish-load', async () => {
    const u = sideView.webContents.getURL();
    DBG.log('panel', 'did-finish-load', { url: u });
    /* v2.9：调试关闭时不再读整页 outerHTML —— 每次导航都生成一份 600KB
       字符串并跨 IPC 回传，是渲染进程与主进程最大的临时内存尖峰。 */
    if (DBG.enabled) {
      try {
        const html = await sideView.webContents.executeJavaScript(
          'document.documentElement.outerHTML', true);
        DBG.captureHtml('side-panel', u, html, { source: 'visible-panel' });
      } catch (err) { DBG.log('panel', '侧栏 HTML 读取失败', { error: String(err.message || err) }); }
    }
    /* 等 SPA 把积分/任务卡渲染出来再推快照（did-finish-load 常早于 React 挂载）。
       同一视图只保留一个待执行定时器，避免连续导航堆积闭包。 */
    scheduleViewSnapshot(sideView.webContents,
      () => pushVisibleSnapshot('panel-loaded'), 900);
    /* 只有 URL 明确带 logout/signout 才算登出。OAuth 跳转、/earn 返回登录页
       DOM 都会命中 isLoginPageUrl，不能据此清空积分（认证票据轮换也同理）。 */
    if (/(?:\/logout|signout)/i.test(u)) markSignedOut('logout-url');
    /* 登录页信号在导航完成这一刻就记下：延时 DOM 快照可能已被后续跳转覆盖。 */
    if (isLoginPageUrl(u)) loginPageSeen = true;
  });
  return sideView;
}

function applyPanelBounds() {
  if (!sideView || !popupWin || popupWin.isDestroyed()) return;
  const [cw, ch] = popupWin.getContentSize();
  if (!sideVisible) {
    if (desktopSilentRun()) {
      sideView.setBounds({ x: -3000, y: -3000, width: 1180, height: 820 });
    } else {
      sideView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    return;
  }
  sideView.setBounds({ x: PANEL_LEFT, y: 0, width: Math.max(0, cw - PANEL_LEFT), height: ch });
  if (taskClickRunning) applyTaskViewBounds();
}

/* ==========================================================================
 * v1.3.2 · 任务侧栏：桌面版专用第二个内嵌视图
 *
 * 桌面壳只有一个可见 sideView，上传版「每张卡片 target=_blank 开新标签、
 * 载体页保持不动」的假设不成立：点开第一张卡就把扫描页导航走了，
 * 后面的卡片全部丢失（用户反馈「能打开一两个却打开不全」）。
 *
 * 这里新增：
 *   taskView       —— 右侧可见的任务侧栏，加载 /dashboard 与 /earn，
 *                     从页面顶部逐屏滚动到底，收集全部带 +N 积分的卡片
 *   taskResultView —— 隐藏视图，承接卡片 target=_blank 弹出的任务页，
 *                     扫描页永远不被覆盖，因此可以依次点完全部卡片
 * 全程不 active / 不 bringToFront / 不抢系统焦点。
 * ======================================================================== */
const TASK_CLICK_SETTLE_MS = 350;
const TASK_PAGE_READY_WAIT_MS = 5000; // R4: wait after each page is loaded before scrolling
const TASK_SCAN_STEP_DELAY_MS = 520;  // R4: at least 12 slow scan steps = 6240ms   // 索引定位后给 Rewards 页面留出短暂响应时间
let taskView = null, taskTabId = null, taskResultView = null, taskClickRunning = false;
let taskResultLoadPromise = null, taskResultLoadWatcher = null;

function ensureTaskResultView() {
  if (taskResultView) return taskResultView;
  taskResultView = newEmbeddedView(embeddedViewPrefs());
  attachView(taskResultView);
  /* 移到窗口外但保留正常视口：任务页需要真正加载才会被 Rewards 记一次点击 */
  taskResultView.setBounds({ x: -3200, y: -3200, width: 1180, height: 820 });
  taskResultView.webContents.setWindowOpenHandler(({ url }) => {
    try { taskResultView.webContents.loadURL(url); } catch {}
    return { action: 'deny' };
  });
  return taskResultView;
}

function ensureTaskView() {
  if (taskView) return taskView;
  taskView = newEmbeddedView(embeddedViewPrefs());
  attachView(taskView);
  taskView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  taskTabId = taskView.webContents.id;
  const entry = {
    kind: 'task-panel',
    win: viewAsWindow(taskView, { id: taskTabId, isFocused: () => false,
      getSize: () => [1180, 820] })
  };
  tabs.set(taskTabId, entry);
  attachTabEvents(taskTabId, entry);
  /* attachTabEvents 会装通用 handler，这里覆盖为「结果页落到隐藏视图」 */
  taskView.webContents.setWindowOpenHandler(({ url }) => {
    try { loadTaskResultFromClick(url); } catch (err) {
      DBG.log('task', '任务页无法交给结果视图', { url, error: String(err && err.message || err) });
    }
    DBG.log('task', '鼠标点击打开的任务页落到隐藏结果视图', { url });
    return { action: 'deny' };
  });
  return taskView;
}

function applyTaskViewBounds() {
  if (!taskView || !popupWin || popupWin.isDestroyed()) return;
  /* 静默开关已移除，这里保留兼容判断；正常模式始终给任务侧栏可见区域。 */
  if (desktopSilentRun()) {
    taskView.setBounds({ x: -3400, y: -3400, width: 1180, height: 820 });
    return;
  }
  const [cw, ch] = popupWin.getContentSize();
  taskView.setBounds({ x: PANEL_LEFT, y: 0, width: Math.max(0, cw - PANEL_LEFT), height: ch });
}
function hideTaskView() {
  if (taskView) taskView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

/* --------------------------------------------------------------------------
 * v1.3.3 · 任务侧栏扫描脚本（自包含，不引用外部变量）
 *
 * 用户反馈「滚动过程中遗漏了未完成的任务」的真因：
 *  ① 旧版只扫 a[href]，官网大量任务卡是 div[role=button] / data-bi-id，
 *     或积分徽标在 span 里而外层没有 href —— 整张卡被跳过；
 *  ② exclude 把 /dashboard、/earn/quest/、/apps/wallpaper 全排掉，
 *     这些恰恰是带 +N 的真实任务；metric 正则含「兑换」，
 *     官网「设置目标…兑换目标的收益 +50」这种描述卡也被误杀；
 *  ③ total 只取一次 scrollHeight，SPA 懒加载 / 无限滚动新增的卡片漏掉；
 *  ④ 扫描完 window.scrollTo(0,0)，点击阶段 hydration 冲掉 data 属性后
 *     按 index 重新查询 DOM，虚拟列表只剩可见的几张 → 后面的卡全点不到。
 *
 * 修法：可点击容器 + 徽标祖先双路识别、动态高度多轮滚动、
 * 把元素引用存进 window.__hsaTaskEls，点击按「引用 → href → 名称+滚动查找」
 * 三级定位，一张都不漏。
 * ------------------------------------------------------------------------ */
/* v1.3.6：主进程消费同步阶段生成的 taskClickIndex。
   只查询可交互节点，并优先使用稳定属性定位；不再先全页滚动扫描所有卡片。 */
function taskAimIndexedSrc(entry) {
  const data = JSON.stringify(entry || {});
  return `(() => {
    const entry = ${data};
    const loc = entry.locator || {};
    const expectedHref = String(loc.href || entry.url || '');
    const expectedTitle = String(loc.title || entry.name || '');
    const expectedPoints = Number(loc.points || entry.points) || 0;
    const clean = el => String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
    const norm = value => String(value || '').replace(/\\s+/g, '').toLowerCase();
    const abs = value => { try { return new URL(String(value || ''), location.href).href; } catch { return String(value || ''); } };
    const pointsOf = (el, text) => {
      const m = String(text || '').match(/(?:\\+|＋)\\s*([\\d,]{1,5})(?![\\d,])/);
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);
      const b = el.querySelector && el.querySelector('[class*="bg-statusSuccessRewardsBg"] p, [data-testid*="point"]');
      const n = clean(b).match(/^\\s*([\\d,]{1,5})\\s*$/);
      return n ? parseInt(n[1].replace(/,/g, ''), 10) : 0;
    };
    /* HSA_TASK_LOCATOR_REPAIR_20261109: include offer-id/test-id cards but require strong identity evidence. */
    const all = () => [...document.querySelectorAll('a,button,[role="button"],[data-bi-id],[data-offer-id],[data-testid]')];
    const find = () => {
      const nodes = all(); let best = null, bestScore = 0;
      const wantHref = expectedHref ? abs(expectedHref) : '';
      const wantTitle = norm(expectedTitle);
       for (const el of nodes) {
         const tx = clean(el).slice(0, 500);
         const href = el.tagName === 'A' ? abs(el.getAttribute('href') || '') : '';
         const strongMatch = !!(
           (wantHref && href === wantHref)
           || (loc.dataBiId && el.getAttribute('data-bi-id') === String(loc.dataBiId))
           || (loc.dataOfferId && el.getAttribute('data-offer-id') === String(loc.dataOfferId))
           || (loc.dataTestId && el.getAttribute('data-testid') === String(loc.dataTestId))
           || (loc.id && el.id === String(loc.id))
           || (loc.ariaLabel && el.getAttribute('aria-label') === String(loc.ariaLabel)));
         const semanticMatch = !!(wantTitle && norm(tx).includes(wantTitle));
         const gotPoints0 = expectedPoints ? pointsOf(el, tx) : 0;
         if (expectedPoints && gotPoints0 > 0 && gotPoints0 !== expectedPoints) continue;
         if (!strongMatch && (!semanticMatch || (expectedPoints && gotPoints0 !== expectedPoints))) continue;
         /* Avoid treating a multi-card wrapper as an individual click target. */
         if (!strongMatch && tx.length > 280) continue;
         let score = 0;
        if (wantHref && href === wantHref) score += 120;
        if (loc.dataBiId && el.getAttribute('data-bi-id') === String(loc.dataBiId)) score += 100;
        if (loc.dataOfferId && el.getAttribute('data-offer-id') === String(loc.dataOfferId)) score += 95;
        if (loc.dataTestId && el.getAttribute('data-testid') === String(loc.dataTestId)) score += 85;
        if (loc.id && el.id === String(loc.id)) score += 80;
        if (loc.ariaLabel && el.getAttribute('aria-label') === String(loc.ariaLabel)) score += 75;
        const gotTitle = norm(tx);
        if (wantTitle && gotTitle.includes(wantTitle)) score += 42;
        else if (wantTitle && gotTitle.length > 8 && wantTitle.includes(gotTitle.slice(0, 12))) score += 28;
        const gotPoints = expectedPoints ? pointsOf(el, tx) : 0;
        if (expectedPoints && gotPoints === expectedPoints) score += 24;
        else if (expectedPoints && gotPoints > 0) score -= 22;
         if (score > bestScore || (score === bestScore && best && el.contains(best))) {
           best = el; bestScore = score;
         }
      }
      return bestScore >= 42 ? best : null;
    };
    let el = find();
    if (!el) return { ok: false, reason: 'indexed-card-not-found', title: expectedTitle, href: expectedHref };
    const text = clean(el).slice(0, 500);
    const href = el.tagName === 'A' ? abs(el.getAttribute('href') || '') : '';
    if (expectedHref && href && href !== abs(expectedHref)) return { ok: false, reason: 'indexed-href-mismatch', href };
    if (expectedTitle && !norm(text).includes(norm(expectedTitle)) && !(expectedHref && href === abs(expectedHref))) {
      return { ok: false, reason: 'indexed-title-mismatch', title: text.slice(0, 80) };
    }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const left = Math.max(0, r.left), top = Math.max(0, r.top);
    const right = Math.min(window.innerWidth, r.right), bottom = Math.min(window.innerHeight, r.bottom);
    if (right - left < 8 || bottom - top < 8) return { ok: false, reason: 'indexed-card-outside-viewport' };
    const points = [
      [(left + right) / 2, (top + bottom) / 2],
      [left + (right-left)*0.35, top + (bottom-top)*0.35],
      [left + (right-left)*0.65, top + (bottom-top)*0.35],
      [left + (right-left)*0.35, top + (bottom-top)*0.65],
      [left + (right-left)*0.65, top + (bottom-top)*0.65]
    ];
    let point = null;
    for (const [x,y] of points) {
      const hit = document.elementFromPoint(x,y);
      if (hit && (hit === el || el.contains(hit))) { point = [x,y]; break; }
    }
    if (!point) return { ok: false, reason: 'indexed-card-covered' };
    return { ok: true, x: point[0], y: point[1], href: href || expectedHref,
      target: el.getAttribute('target') || entry.target || '', title: expectedTitle || text.slice(0,80),
      points: expectedPoints || pointsOf(el,text), tag: el.tagName,
      rect: { left:r.left, top:r.top, width:r.width, height:r.height },
      viewport: { width:window.innerWidth, height:window.innerHeight }, strategy: href ? 'href-index' : 'semantic-index' };
  })()`;
}

/* CDP 原生输入事件：mouseMoved → mousePressed → mouseReleased。
   不调用 HTMLElement.click()，也不合成 DOM MouseEvent。 */
async function dispatchTaskMouseClick(debuggerSession, x, y) {
  if (!debuggerSession || !debuggerSession.isAttached()) {
    throw new Error('CDP debugger is not attached');
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new Error('invalid mouse coordinates');
  }
  await debuggerSession.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse'
  });
  await new Promise(resolve => setTimeout(resolve, 45));
  await debuggerSession.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1,
    clickCount: 1, pointerType: 'mouse'
  });
  let released = false;
  try {
    await new Promise(resolve => setTimeout(resolve, 65));
    await debuggerSession.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0,
      clickCount: 1, pointerType: 'mouse'
    });
    released = true;
  } finally {
    if (!released) {
      try {
        await debuggerSession.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', buttons: 0,
          clickCount: 1, pointerType: 'mouse'
        });
      } catch {}
    }
  }
}

/* 监听下一次主 frame 导航；没有导航时可取消，不遗留定时器/监听器。 */
function watchMainFrameLoad(webContents, timeoutMs = 15000) {
  let started = false, settled = false, timer = null;
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    webContents.removeListener('did-start-navigation', onStart);
    webContents.removeListener('did-finish-load', onFinish);
    webContents.removeListener('did-fail-load', onFail);
  };
  const finish = result => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(result);
  };
  const onStart = (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) started = true;
  };
  const onFinish = () => {
    if (started) finish({ ok: true, url: webContents.getURL() });
  };
  const onFail = (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && started) finish({ ok: false, reason: 'load-failed:' + code, url });
  };
  webContents.on('did-start-navigation', onStart);
  webContents.on('did-finish-load', onFinish);
  webContents.on('did-fail-load', onFail);
  timer = setTimeout(() => finish({
    ok: false, reason: started ? 'load-timeout' : 'no-navigation'
  }), timeoutMs);
  return {
    promise,
    cancel: () => finish({ ok: false, reason: 'cancelled' })
  };
}

function loadTaskResultFromClick(url) {
  const resultView = ensureTaskResultView();
  // A rapid series of task clicks can supersede a still-pending navigation.
  // Cancel its watcher first so listeners and timeout handles do not stack up.
  if (taskResultLoadWatcher) taskResultLoadWatcher.cancel();
  const watcher = watchMainFrameLoad(resultView.webContents, 15000);
  taskResultLoadWatcher = watcher;
  taskResultLoadPromise = watcher.promise.finally(() => {
    if (taskResultLoadWatcher === watcher) taskResultLoadWatcher = null;
  });
  resultView.webContents.loadURL(url).catch(err => {
    watcher.cancel();
    DBG.log('task', '任务结果页加载失败', { url, error: String(err && err.message || err) });
  });
}

async function loadTaskPage(view, url) {
  const wc = view.webContents;
  await new Promise(resolve => {
    let done = false, timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      wc.removeListener('did-finish-load', finish);
      resolve();
    };
    wc.once('did-finish-load', finish);
    timer = setTimeout(finish, 20000);
    try { Promise.resolve(wc.loadURL(url)).catch(finish); } catch { finish(); }
  });
  /* 等 SPA 把任务卡渲染出来：最多 12 × 400ms */
  for (let i = 0; i < 12; i++) {
    try {
      const n = await wc.executeJavaScript("document.querySelectorAll('a[href]').length", true);
      if (n > 3) break;
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  // R4: wait a full five seconds after the page has become ready.
  await new Promise(r => setTimeout(r, TASK_PAGE_READY_WAIT_MS));
}

function panelState() {
  return {
    open: sideVisible, reason: panelReason, tabId: sideTabId,
    url: sideView ? sideView.webContents.getURL() : null
  };
}

function showSidePanel(url, reason, active) {
  /* v1.3.8：静默开关只改变「页面是否可见」。官网侧栏放到离屏视口继续渲染，
     同步 / 点击 / 搜索 / 详情写入全部走原链路；用户显式动作仍正常显示。 */
  if (desktopSilentRun() && !panelActionActive()) {
    ensureSideView();
    sideVisible = false;
    try { sideView.setBounds({ x: -3000, y: -3000, width: 1180, height: 820 }); } catch {}
    activeTabId = sideTabId;
    return tabInfo(sideTabId, tabs.get(sideTabId));
  }
  ensureSideView();
  if (!popupWin || popupWin.isDestroyed()) return tabInfo(sideTabId, tabs.get(sideTabId));
  const wasVisible = sideVisible;
  // 每轮搜索 ensureTabActive() 都会调 tabs.update(active)，这里短路掉：
  // 面板已经展开且没有新 URL 时只对齐 activeTabId，不重复 resize / 广播。
  if (wasVisible && !url) {
    if (activeTabId !== sideTabId) activeTabId = sideTabId;
    return tabInfo(sideTabId, tabs.get(sideTabId));
  }
  // 手动展开锁定为 'user'，后台搜索/定时运行不会把它改成 'run' 后自动收走
  if (panelReason !== 'user') panelReason = reason || 'user';
  if (!sideVisible) {
    collapsedSize = popupWin.getSize();
    sideVisible = true;
    popupWin.setSize(COLLAPSED_WIDTH + PANEL_DEFAULT_RIGHT, collapsedSize[1] || 780);
  }
  attachView(sideView);
  if (!url) loadSideViewDefault();   // v3.0：展开时才加载，空闲不常驻 Bing SPA
  applyPanelBounds();
  if (url) {
    // 用户显式传入 URL 时一定要有可见反馈，即使面板已展开且停在同一地址。
    panelReason = 'user';           // 锁为手动，运行结束不自动收走
    sideView.webContents.loadURL(url);
    popupWin.show();
    popupWin.focus();   // 仅显式用户动作激活窗口
    /* 不能调用侧栏视图自身的 focus()：会把焦点从登录页 iframe 拉回顶层 frame */
  }
  activeTabId = sideTabId;
  if (!wasVisible && !url && active !== false && panelReason === 'user') {
    popupWin.show(); popupWin.focus();
  }
  broadcast('ui:panel', [{ open: true, url: url || sideView.webContents.getURL(), reason: panelReason }]);
  return tabInfo(sideTabId, tabs.get(sideTabId));
}

function hideSidePanel() {
  if (sideView) sideView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  /* v3.0：静默期间若面板被收起，退出静默时不要把它重建回来 */
  if (sideViewRestore) sideViewRestore.visible = false;
  sideVisible = false;
  panelReason = null;
  if (collapsedSize && popupWin && !popupWin.isDestroyed()) {
    popupWin.setSize(collapsedSize[0], collapsedSize[1]);
  }
  broadcast('ui:panel', [{ open: false }]);
  return { open: false };
}

function openInSidePanel(url, reason, active) {
  return showSidePanel(url, reason || 'user', active);
}

function dataKeyFor(url) {
  let p = '/';
  try { p = new URL(String(url)).pathname || '/'; } catch {}
  return /^\/earn/i.test(p) ? 'earn' : 'dash';
}

/** 后台读积分/任务用：同一主窗口内的不可见视图，不打断用户正在看的页面。 */
function ensureDataTab(url) {
  const key = dataKeyFor(url);
  let d = dataViews.get(key);
  if (!d) {
    const view = newEmbeddedView(embeddedViewPrefs());
    attachView(view);
    // 移到窗口外：用户看不见，但视口仍是正常的 1180×820，DOM 能完整渲染
    view.setBounds({ x: -3000, y: -3000, width: 1180, height: 820 });
    const id = view.webContents.id;
    const entry = {
      kind: 'embedded-data',
      win: viewAsWindow(view, { id, isFocused: () => false,
        getSize: () => [1180, 820] })
    };
    tabs.set(id, entry);
    attachTabEvents(id, entry);
    view.webContents.on('did-finish-load', async () => {
      if (!DBG.enabled) return;   // v2.9：调试关闭时零整页 HTML 分配
      const u = view.webContents.getURL();
      try {
        const html = await view.webContents.executeJavaScript('document.documentElement.outerHTML', true);
        DBG.captureHtml('data-view-' + key, u, html, { source: 'background-data-view' });
      } catch (err) { DBG.log('data-view', key + ' HTML 读取失败', { error: String(err.message || err) }); }
    });
    d = { view, entry, id, lastNav: 0, lastUsed: Date.now() };
    dataViews.set(key, d);
  }
  const wc = d.view.webContents;
  const now = Date.now();
  d.lastUsed = now;                // v2.9：刷新空闲计时
  startDataViewSweep();
  if (url && wc.getURL() !== url) { wc.loadURL(url); d.lastNav = now; }
  else if (now - d.lastNav > 60000) { try { wc.reload(); } catch {} d.lastNav = now; }
  return tabInfo(d.id, d.entry);
}

function makeWindow(opts) {
  const win = new BrowserWindow(Object.assign({
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // 两个平台的每一个窗口都显式绑到同一个持久化 session：
      // 登录窗口写入的 Cookie，后台 fetch 与 popup 立刻可见。
      session: getAppSession() || undefined,
      // 插件会把标签页藏在后台运行（active:false），桌面版必须关掉
      // Chromium 的后台节流，否则页面不加载、注入拿不到 DOM。
      backgroundThrottling: false
    }
  }, opts));
  shimWindows.add(win.webContents);
  win.webContents.on('destroyed', () => shimWindows.delete(win.webContents));
  return win;
}

function createBrowserTab(url, active) {
  const quiet = desktopQuietRun();
  const win = makeWindow({
    width: 1180, height: 820,
    title: 'Human Search Assistant',
    show: active !== false && !quiet,
    autoHideMenuBar: true
  });
  const id = win.webContents.id;
  const entry = { win, kind: 'page' };
  tabs.set(id, entry);
  attachTabEvents(id, entry);
  if (active !== false && !quiet) { win.show(); safeAutoFocus(win); }
  if (active !== false) activeTabId = id;
  /* v2.7：默认浏览器主页 / 搜索引擎 = Bing。自动任务链路始终显式传 URL
     （/dashboard、/earn、panelflyout、www.bing.com/search?q=…），不受影响。 */
  win.loadURL(url && url !== 'about:blank' ? url : DEFAULT_BROWSER_HOME);
  broadcast('windows.onCreated', [{ id: win.id, focused: active !== false, type: 'normal' }]);
  return tabInfo(id, entry);
}

function wildcard(str) {
  return new RegExp('^' + String(str).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
}
function queryTabs(info) {
  const q = info || {};
  let list = [...tabs.entries()].map(([id, e]) => safeTab(id)).filter(Boolean);
  if (q.url != null) {
    const pats = (Array.isArray(q.url) ? q.url : [q.url]).map(wildcard);
    list = list.filter(t => pats.some(re => re.test(t.url)));
  }
  if (typeof q.active === 'boolean') list = list.filter(t => t.active === q.active);
  if (q.status) list = list.filter(t => t.status === q.status);
  if (typeof q.windowId === 'number') list = list.filter(t => t.windowId === q.windowId);
  if (q.lastFocusedWindow && activeTabId != null) {
    const hit = list.find(t => t.id === activeTabId);
    if (hit) list = [hit];
  }
  return list;
}

ipcMain.handle('chrome:tabs:get', (_e, id) => {
  const t = safeTab(id);
  if (!t) throw new Error('No tab with id: ' + id);
  return t;
});
ipcMain.handle('chrome:tabs:query', (_e, info) => queryTabs(info));
ipcMain.handle('chrome:tabs:create', (_e, opts) => {
  const o = opts || {};
  DBG.ipc('chrome:tabs:create', { url: o.url, active: o.active, dataOnly: !!o.dataOnly });
  // 后台读 /dashboard、/earn 的 DOM：走同窗口内的不可见视图，不抢用户页面
  if (o.dataOnly) return ensureDataTab(o.url);
  // 登录、搜索、任务卡片、可领取页：全部在主界面右侧的官方页面里进行
  if (isEmbeddedUrl(o.url)) {
    return openInSidePanel(o.url, o.active === false ? 'run' : 'user', o.active);
  }
  return createBrowserTab(o.url, o.active);
});
ipcMain.handle('chrome:tabs:update', (_e, id, opts) => {
  const e = tabs.get(Number(id));
  if (!e || e.win.isDestroyed()) throw new Error('No tab with id: ' + id);
  if (opts.url) {
    e.win.loadURL(opts.url);
  } else if (opts.active) {
    /* v1.3.1：运行期只更新逻辑 activeTabId，不 show / focus 窗口 */
    if (!desktopQuietRun()) { e.win.show(); safeAutoFocus(e.win); }
    activeTabId = Number(id);
  }
  return safeTab(Number(id));
});
ipcMain.handle('chrome:tabs:remove', (_e, id) => {
  const e = tabs.get(Number(id));
  if (e && !e.win.isDestroyed()) e.win.destroy();
  return null;
});
ipcMain.handle('chrome:panel:show', (_e, url) => {
  notePanelAction();
  DBG.ipc('chrome:panel:show', { url }); return showSidePanel(url || null, 'user');
});

/* v1.3.2：一次调用完成「两页 → 从头滚动到底 → 逐张点击全部 +N 卡片」。
   后台 completePendingTaskCards 只换成这一个绑定，上传版其余函数不动。 */
function orderHint(list, current) {
  const i = (list || []).indexOf(current);
  const next = i >= 0 && list[i + 1] ? String(list[i + 1].name || '').slice(0, 28) : '';
  return next ? '下一张：' + next : '';
}

/* HSA_TASK_LOCATOR_REPAIR_20261109: discover scored real click targets omitted from server-side HTML index. */
async function discoverLiveScoredCards(webContents, pageDef) {
  const collectSource = (() => {
    return String.raw`(() => {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
      const candidates = document.querySelectorAll('a[href],button,[role="button"],[data-bi-id],[data-offer-id]');
      const rows = [];
      for (const el of candidates) {
        if (!el || !el.getBoundingClientRect) continue;
        const hrefRaw = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
        let href = '';
        if (hrefRaw) {
          try { href = new URL(hrefRaw, location.href).href; } catch { continue; }
          if (!/^https:\/\/(?:[^/]+\.)?(?:bing\.com|microsoft\.com)\//i.test(href) && !/^https:\/\/aka\.ms\//i.test(href)) continue;
          if (/\/(?:redeem|referandearn)(?:\/|[?#]|$)/i.test(href)) continue;
        }
        const idBi = el.getAttribute('data-bi-id') || '';
        const offerId = el.getAttribute('data-offer-id') || '';
        const testId = el.getAttribute('data-testid') || '';
        if (!href && !idBi && !offerId) continue; // no stable clickable identity
        const text = norm(el.innerText || el.textContent);
        if (text.length < 3 || text.length > 280) continue;
        const matched = text.match(/(?:\+|＋)\s*(\d{1,4})(?!\d)/);
        if (!matched) continue;
        const points = Number(matched[1]);
        if (!Number.isFinite(points) || points <= 0) continue;
        if (/^(?:可用积分|今日积分|可领取|兑换|积分概览|points balance)/i.test(text)) continue;
        if (el.querySelector && el.querySelector('a[href],button,[role="button"]')) {
          // outer wrapper is not the actual card; avoid clicks over several children
          if (el.tagName !== 'A' && el.tagName !== 'BUTTON') continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 20) continue;
        const title = text.replace(/(?:\+|＋)\s*\d{1,4}(?!\d)/g, '').trim().slice(0, 100);
        if (!title) continue;
        rows.push({name:title,points,completed:/已完成|已领取|completed|claimed/i.test(text),
          url:href,target:el.getAttribute('target')||'',
          locator:{href,dataBiId:idBi,dataOfferId:offerId,dataTestId:testId,
            id:el.id||'',ariaLabel:el.getAttribute('aria-label')||'',
            title,points}});
      }
      return rows.slice(0, 120);
    })()`;
  })();
  const found = new Map();
  const invoke = async source => {
    try { return await webContents.executeJavaScript(source, true); } catch { return null; }
  };
  const add = rows => {
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const l = row.locator || {};
      const k = l.href || l.dataOfferId || l.dataBiId || '';
      if (!k) continue;
      const id = k + '|' + Number(row.points);
      if (!found.has(id)) found.set(id, row);
    }
  };
  const metrics = await invoke('(() => {window.scrollTo(0,0);const e=document.scrollingElement||document.documentElement;return {h:e.scrollHeight,v:innerHeight}})()');
  let height = Math.max(500, Number(metrics && metrics.h) || 800);
  const view = Math.max(250, Number(metrics && metrics.v) || 700);
  /* R4.1: limit each move to at most 220 CSS pixels, rather than allocating
     the whole height across a fixed number of passes. Scan ticks are spaced
     by 520ms; a completed page gets at least twelve (>= 6.24s). */
  const minimumTicks = Math.ceil(5000 / TASK_SCAN_STEP_DELAY_MS) + 2;
  let lastY = 0;
  for (let n = 0; n < 160 && state.running; n++) {
    const maxY = Math.max(0, height - view);
    // Spread small scroll ranges over the whole 5+ second window.
    const slowStep = Math.min(220, Math.max(1, Math.floor(maxY / Math.max(1, minimumTicks - 1))));
    const y = n === 0 ? 0 : Math.min(maxY, lastY + slowStep);
    // Real CDP wheel input triggers lazy-loader listeners; scrollTo pins
    // the exact target in case the browser consumed the wheel in a child.
    if (y > lastY && webContents.debugger && webContents.debugger.isAttached()) {
      try { await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 330, y: Math.max(50, Math.round(view / 2)),
        deltaX: 0, deltaY: y - lastY, modifiers: 0, button: 'none'
      }); } catch (err) { DBG.log('task', 'CDP slow scroll fallback to DOM', {error: String(err)}); }
    }
    const pos = await invoke('(() => {window.scrollTo(0,' + y + ');const e=document.scrollingElement||document.documentElement;return e.scrollHeight})()');
    await new Promise(r => setTimeout(r, TASK_SCAN_STEP_DELAY_MS));
    add(await invoke(collectSource));
    height = Math.max(height, Number(pos) || 0);
    lastY = y;
    if (n + 1 >= minimumTicks && y >= Math.max(0, height - view)) {
      // One additional lazy-load/hydration opportunity at the bottom.
      await new Promise(r => setTimeout(r, TASK_SCAN_STEP_DELAY_MS));
      add(await invoke(collectSource));
      const updated = await invoke('(() => (document.scrollingElement||document.documentElement).scrollHeight)()');
      if (Number(updated) > height) height = Number(updated);
      else break;
    }
  }
  /* Do not guess shadow/iframe locations: only the rendered DOM with stable locators. */
  const count = await invoke('(() => {window.__hsaDiscoverScrollers=[...document.querySelectorAll("*")].filter(e=>e.scrollHeight>e.clientHeight+40 && /auto|scroll/i.test(getComputedStyle(e).overflowY)).slice(0,12);return window.__hsaDiscoverScrollers.length})()');
  for (let i = 0; i < Math.min(Number(count)||0,12) && state.running; i++) {
    let max = Number(await invoke('(() => {const e=window.__hsaDiscoverScrollers[' + i + '];return e?e.scrollHeight-e.clientHeight:0})()')) || 0;
    for (let y = 0, n = 0; n < 48 && state.running; y += Math.max(95, Math.round(0.32 * 400)), n++) {
      const pos = await invoke('(() => {const e=window.__hsaDiscoverScrollers[' + i + '];if(!e)return 0;e.scrollTop=' + y + ';return e.scrollHeight-e.clientHeight})()');
      await new Promise(r => setTimeout(r, TASK_SCAN_STEP_DELAY_MS));
      add(await invoke(collectSource));
      max = Math.max(max, Number(pos) || 0);
      if (y >= max) break;
    }
  }
  return [...found.values()].map((e,i) => ({
    ...e,key:'live-dom|' + pageDef.page + '|' + i,
    page:pageDef.page,pageUrl:pageDef.url,
    section:pageDef.page === '/dashboard' ? 'daily' : 'promo',source:'live-dom'
  }));
}

/* HSA_TASK_LOCATOR_REPAIR_20261109: sweep SPA/virtual-list viewports for an indexed card. */
async function locateIndexedCardAcrossScroll(webContents, entry) {
  const aim = async () => webContents.executeJavaScript(taskAimIndexedSrc(entry), true).catch(() => null);
  let result = await aim();
  if (result && result.ok) return result;
  const scroll = async (script) => {
    try { return await webContents.executeJavaScript(script, true); } catch { return null; }
  };
  let m = await scroll('(() => { window.scrollTo(0,0); const e=document.scrollingElement||document.documentElement; return {height:e.scrollHeight, view:window.innerHeight}; })()');
  let height = Math.max(800, Number(m && m.height) || 800);
  const view = Math.max(250, Number(m && m.view) || 700);
  const step = Math.max(160, Math.round(view * 0.65));
  for (let y = 0, i = 0; i < 48 && state.running; i++, y += step) {
    const pos = await scroll('(() => {window.scrollTo(0,' + y + ');const e=document.scrollingElement||document.documentElement;return e.scrollHeight})()');
    await new Promise(r => setTimeout(r, 190));
    result = await aim();
    if (result && result.ok) return result;
    height = Math.max(height, Number(pos) || 0);
    if (y >= height - view) break;
  }
  /* Also search the scrollable panel; many Rewards lists do not scroll window. */
  const count = await scroll('(() => { const a=[...document.querySelectorAll("*")].filter(e=>e.scrollHeight>e.clientHeight+40 && /auto|scroll/i.test(getComputedStyle(e).overflowY)); window.__hsaLocateScrollers=a.slice(0,12); return window.__hsaLocateScrollers.length; })()');
  for (let i = 0; i < Math.min(Number(count) || 0, 12) && state.running; i++) {
    let max = Number(await scroll('(() => {const e=window.__hsaLocateScrollers&&window.__hsaLocateScrollers[' + i + '];return e?e.scrollHeight-e.clientHeight:0})()')) || 0;
    for (let y = 0, n = 0; n < 48 && state.running; n++, y += 230) {
      const more = await scroll('(() => {const e=window.__hsaLocateScrollers&&window.__hsaLocateScrollers[' + i + '];if(!e)return 0;e.scrollTop=' + y + ';return e.scrollHeight-e.clientHeight})()');
      await new Promise(r => setTimeout(r, 190));
      result = await aim();
      if (result && result.ok) return result;
      max = Math.max(max, Number(more) || 0);
      if (y >= max) break;
    }
  }
  return {ok:false, reason:'not-found-after-full-outer-inner-scroll'};
}

/* ==========================================================================
 * v1.3.8-s2 · 通过 Bing Rewards 侧栏点击积分卡片
 *
 * 自动完成任务的顺序固定为：开始时同步积分状态 → （若积分与任务都完成则零动作）
 * → 侧栏主动重新加载页面 → 按主界面任务状态逐张点击积分卡片 → 关闭页面
 * → 拟人搜索 → 收尾同步。
 * 侧栏取 cn.bing.com/rewards/panelflyout 顶层页，卡片是普通顶层 DOM。
 * 识别与过滤规则集中在 lib/sidebar-task-cards.js；完成与否只看同步得到的
 * todayTasks / taskClickIndex（主界面任务状态），不看侧栏 DOM 的完成标记。
 * 侧栏读不到积分卡时才回退到 dashboard/earn 索引点击。
 * ========================================================================== */
/** 等待一次导航真正完成，带超时兜底，绝不遗留监听器。 */
function waitForNavigation(wc, action, timeoutMs) {
  return new Promise(resolve => {
    let done = false, timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      wc.removeListener('did-finish-load', finish);
      resolve();
    };
    wc.once('did-finish-load', finish);
    timer = setTimeout(finish, timeoutMs || 20000);
    try { Promise.resolve(action()).catch(finish); } catch { finish(); }
  });
}

/**
 * forceReload=true 表示「点击任务卡片流程开启」：先 loadURL，再主动 reload
 * 丢弃首屏缓存 / 旧 DOM，保证任务状态与积分同步结果一致。
 */
async function loadSidebarFlyout(view, urls, forceReload) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  for (const u of list) {
    try {
      const wc = view.webContents;
      await waitForNavigation(wc, () => wc.loadURL(u), 20000);
      if (forceReload) {
        try {
          await waitForNavigation(wc, () => wc.reloadIgnoringCache
            ? wc.reloadIgnoringCache() : wc.reload(), 20000);
        } catch (err) {
          DBG.log('task', '侧栏主动重新加载失败，沿用首次加载结果', {
            error: String(err && err.message || err)
          });
        }
      }
      /* 等 React 把卡片渲染出来；保存页 / 真机都适用 */
      for (let i = 0; i < 12; i++) {
        const n = await wc.executeJavaScript("document.querySelectorAll('a[href]').length", true).catch(() => 0);
        if (Number(n) > 5) break;
        await new Promise(r => setTimeout(r, 400));
      }
      await new Promise(r => setTimeout(r, 700));
      return true;
    } catch (err) {
      DBG.log('task', '侧栏页面加载失败，尝试下一个入口', {
        url: u, error: String(err && err.message || err)
      });
    }
  }
  return false;
}

/** 点击流程结束：把侧栏任务页面真正关掉（导航到空白页并收起视图）。 */
async function closeSidebarTaskPage(view) {
  if (view && view.webContents && !view.webContents.isDestroyed()) {
    try { await view.webContents.loadURL('about:blank'); } catch {}
  }
  hideTaskView();
}

/* T07：页面稳定后才允许下一次动作（与插件端 waitForTaskPageStable 同一策略）。 */
async function hsaWaitPageStable(wc) {
  const deadline = Date.now() + HSA_CORE.DEFAULTS.pageStableWaitMs;
  while (wc && Date.now() < deadline) {
    try {
      if (!wc.isDestroyed() && !wc.isLoading()) {
        const r = await wc.executeJavaScript('document.readyState', true);
        if (r === 'complete') return true;
      }
    } catch (err) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

/* T02=A：先快速扫 DOM，再对懒加载容器做「有次数上限」的分段滚动，最后按共享
   taskCardKey 去重。上限来自 shared/hsa-core.js，避免无限滚动常驻占用内存。 */
async function scanSidebarCards(webContents) {
  const plan = HSA_CORE.scanPlan();
  const merged = new Map();
  let last = null;
  const collect = async () => {
    const res = await webContents.executeJavaScript(
      SidebarCards.SIDEBAR_SCAN_SOURCE, true).catch(() => null);
    if (!res || !Array.isArray(res.cards)) return 0;
    last = res;
    for (const c of res.cards) {
      const k = HSA_CORE.taskCardKey(c);
      if (k && !merged.has(k)) merged.set(k, c);
    }
    return res.cards.length;
  };
  for (let i = 0; i < 6; i++) {
    if (await collect()) break;
    await new Promise(r => setTimeout(r, plan.retryMs));
  }
  if (!merged.size) {
    for (let step = 1; step <= plan.maxSteps; step++) {
      const y = step * plan.segmentPx;
      await webContents.executeJavaScript(
        '(function(){try{window.scrollTo(0,' + y + ');' +
        'var s=document.scrollingElement||document.documentElement;' +
        'if(s)s.scrollTop=' + y + ';' +
        'for(var i=0;i<document.querySelectorAll("*").length&&i<400;i++){}' +
        '}catch(e){}return true;})()', true).catch(() => null);
      await new Promise(r => setTimeout(r, Math.min(plan.retryMs, 350)));
      await collect();
    }
    await webContents.executeJavaScript('window.scrollTo(0,0)', true).catch(() => null);
  }
  /* 分段滚动补齐后按 DOM 序号归位：严格保持截图任务列表顺序。 */
  const cards = HSA_CORE.taskListOrder([...merged.values()]);
  merged.clear();                 // 及时释放收集结果，不常驻引用 DOM 数据
  return cards.length ? Object.assign({}, last || {}, { cards: cards }) : null;
}

ipcMain.handle('chrome:task:clickAll', async (_event, clickIndex, options) => {
  if (taskClickRunning) return { ok: false, reason: 'busy' };
  taskClickRunning = true;
  const pages = [];
  let totalClicked = 0, totalOpened = 0, totalFailed = 0, totalScanned = 0, totalUnconfirmed = 0;
  /* T06=D / T05=D：三态计数、可手动打开的链接、实际触发方式；数组均有上限。 */
  const manualLinks = [];
  const triggerMethods = [];
  let pageInteractionClicks = 0;
  const noteTrigger = (method, reason) => {
    if (triggerMethods.length < 64) triggerMethods.push({ method: method, reason: reason });
  };
  const noteUnconfirmed = (name, href) => {
    totalUnconfirmed++;
    if (/^https?:\/\//i.test(String(href || '')) && manualLinks.length < 20) {
      manualLinks.push({ title: String(name || '未确认任务').slice(0, 60), url: String(href) });
    }
  };
  /* T01=D：CDP 不可用时降级到官网卡片自身的页面交互，不把技术手段当成功条件。 */
  const domClickFallback = async (wc, href) => {
    const src = '(function(href){try{' +
      'var as=document.querySelectorAll("a[href]");' +
      'for(var i=0;i<as.length;i++){' +
      'if(as[i].getAttribute("href")===href||as[i].href===href){as[i].click();return {ok:true};}}' +
      'return {ok:false,reason:"no-anchor"};' +
      '}catch(e){return {ok:false,reason:String(e&&e.message||e)}}})(' +
      JSON.stringify(String(href || '')) + ')';
    return await wc.executeJavaScript(src, true).catch(() => null);
  };
  const clickStates = () => ({
    clickSent: totalClicked, pageOpened: totalOpened,
    officialConfirmed: 0,   /* 官网确认只能由官网数据判定，桌面端绝不冒充 */
    unconfirmed: totalUnconfirmed, failed: totalFailed,
    pageInteractionClicks: pageInteractionClicks,
    manualLinks: manualLinks.slice(0, 20), triggerMethods: triggerMethods.slice(0, 64)
  });
  let debuggerAttachedHere = false;
  let lastPhysicalClickAt = 0;
  let tv = null, dbg = null;
  try {
    const index = clickIndex && clickIndex.schemaVersion === 1 ? clickIndex : null;
    const indexFresh = !!(index && Array.isArray(index.items) && Number.isFinite(index.updatedAt)
      && Date.now() - index.updatedAt <= 30 * 60 * 1000);
    /* T04=A：两版统一用共享 taskCardKey（索引 → 标题 → 链接）判断卡片身份。 */
    const seenIndex = new Set();
    const indexedEntries = indexFresh ? index.items.filter(x => {
      if (!x || !(x.page === '/dashboard' || x.page === '/earn')) return false;
      const k = HSA_CORE.taskCardKey(x);
      if (!k || seenIndex.has(k)) return false;
      seenIndex.add(k);
      return true;
    }) : [];
    const skipCompletedCards = !!(options && options.skipCompletedCards);
    /* T07=D：默认 10 秒、1~60 秒范围，与插件端同源。 */
    const cardClickIntervalMs = HSA_CORE.clampIntervalSec(
      options && options.cardClickIntervalSec) * 1000;
    // Count actual CDP mouse actions rather than time spent locating cards.
    const waitClickSpacing = async () => {
      while (lastPhysicalClickAt && state.running) {
        const remain = cardClickIntervalMs - (Date.now() - lastPhysicalClickAt);
        if (remain <= 0) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(remain, 300)));
      }
      return !!state.running;
    };
    // Match the browser extension: default=false clicks all scored cards;
    // enabling the setting filters completed cards at the last responsible moment.
    const entries = indexedEntries.filter(x => !skipCompletedCards || !x.completed);
    const skippedCompleted = indexedEntries.length - entries.length;
    /* HSA_TASK_LOCATOR_REPAIR_20261109: an empty RSC index does not imply the real page has no clickable task cards. */

    /* 自动运行时保证任务侧栏有可见视口；索引只包含受信任的两个 Rewards 页面。 */
    if (!sideVisible) showSidePanel(null, 'run', false);
    tv = ensureTaskView();
    attachView(tv);
    applyTaskViewBounds();
    dbg = tv.webContents.debugger;
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      debuggerAttachedHere = true;
    }

    /* ------------------------------------------------------------------
     * 侧栏优先：开始时同步积分状态（todayTasks / taskClickIndex 已写入），
     * 点击流程开启时**主动重新加载侧栏页面**，再按 DOM 顺序点击积分卡片。
     *   · 点哪张只取决于主界面任务状态（同步结果），不看侧栏显示的完成标记
     *   · skipCompletedCards=true  → 只真实点击未完成的积分卡（默认）
     *   · skipCompletedCards=false → 点击所有积分卡（含已完成）
     *   · 搜索配额、推荐、兑换、推广、0 分卡由识别模块直接排除
     * ------------------------------------------------------------------ */
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const sidebarUrls = process.env.HSA_SIDEBAR_TEST_FILE
      ? [pathToFileURL(path.resolve(process.env.HSA_SIDEBAR_TEST_FILE)).href]
      : SidebarCards.SIDEBAR_FLYOUT_URLS;
    /* 流程开启：主动重新加载侧栏页面，不复用上一次运行残留的 DOM */
    const sidebarReady = await loadSidebarFlyout(tv, sidebarUrls, true);
    const scan = sidebarReady ? await scanSidebarCards(tv.webContents) : null;
    /* 主界面任务状态：todayTasks 为主，taskClickIndex 为补充；二者都不是侧栏 DOM */
    const syncSummary = (clickIndex && clickIndex.taskSummary) || state.todayTasks || null;
    const merged = SidebarCards.mergeSidebarWithSync(
      scan && Array.isArray(scan.cards) ? scan.cards : [], syncSummary, clickIndex);
    const scored = merged.filter(c => c && c.scored);
    const excluded = merged.filter(c => c && !c.scored);
    /* 没有可用的主界面任务状态时绝不按侧栏显示自行判断，交给原来的双页索引回退 */
    const matchedScored = scored.filter(c => c.syncMatched).length;
    if (scored.length && matchedScored > 0) {
      /* 严格按截图任务列表 DOM 顺序，修复实际运行中的顺序错乱。 */
      const plan = HSA_CORE.taskListOrder(
        SidebarCards.planSidebarClicks(merged, skipCompletedCards));
      const orderText = HSA_CORE.taskListNames(plan)
        .map((n, i) => (i + 1) + '.' + n).join(' → ');
      desktopActivityPush({
        state: 'syncing', page: tv.webContents.getURL(),
        zh: '任务卡执行顺序（严格按截图列表）：' + orderText,
        en: 'Task card order (strict DOM order): ' + orderText
      });
      DBG.log('task', '任务卡执行顺序（严格按截图列表 DOM 顺序）', {
        count: plan.length, order: orderText, source: 'sidebar-flyout'
      });
      const skippedBySetting = scored.length - plan.length;
      const page = {
        url: tv.webContents.getURL(), found: scored.length, clicked: 0,
        opened: 0, skipped: 0, failed: 0, source: 'sidebar-flyout'
      };
      totalScanned += scored.length;
      desktopActivityPush({
        state: 'syncing', page: page.url,
        zh: '同步积分状态 · 侧栏识别 ' + scored.length + ' 张积分卡 · 待点击 '
          + plan.length + ' 张' + (skipCompletedCards ? '（跳过已完成）' : '（含已完成）'),
        en: 'Points synced · ' + scored.length + ' scored cards · '
          + plan.length + ' to click' + (skipCompletedCards ? ' (skip completed)' : ' (include completed)')
      });
      DBG.log('task', '侧栏积分卡片识别（完成状态来自主界面任务状态）', {
        total: merged.length, scored: scored.length, excluded: excluded.length,
        matchedMainUi: matchedScored,
        excludedKinds: excluded.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m; }, {}),
        pending: plan.length, skippedBySetting: skippedBySetting,
        skipCompletedCards: skipCompletedCards, source: 'main-ui-task-state + sidebar-flyout'
      });

      for (const card of plan) {
        if (!state.running) break;
        const aim = await tv.webContents.executeJavaScript(
          SidebarCards.sidebarAimSource(card), true).catch(() => null);
        if (!aim || !aim.ok) {
          page.failed++; totalFailed++;
          DBG.log('task', '侧栏卡片无法安全定位', {
            name: card.name, reason: aim && aim.reason || 'no-aim', idx: card.idx
          });
          continue;
        }
        if (!(await waitClickSpacing())) break;
        await hsaWaitPageStable(tv.webContents);
        const targetBlank = String(aim.target || card.target || '').toLowerCase() === '_blank';
        const samePageWatcher = !targetBlank ? watchMainFrameLoad(tv.webContents, 12000) : null;
        taskResultLoadPromise = null;
        try {
          const cardName = String(card.name || '未命名任务').slice(0, 40);
          desktopActivityPush({
            state: 'clicking', page: page.url, card: cardName,
            delayMs: TASK_CLICK_SETTLE_MS,
            zh: '侧栏点击 ' + (page.clicked + 1) + '/' + plan.length + ' · ' + cardName
              + ' +' + (Number(card.points) || 0)
              + ' · 下一步：' + (orderHint(plan, card) || '搜索任务')
              + ' · 等 ' + TASK_CLICK_SETTLE_MS + 'ms',
            en: 'Sidebar click ' + (page.clicked + 1) + '/' + plan.length + ' · ' + cardName
              + ' +' + (Number(card.points) || 0)
              + ' · Next: ' + (orderHint(plan, card) || 'search')
              + ' · wait ' + TASK_CLICK_SETTLE_MS + 'ms'
          });
          lastPhysicalClickAt = Date.now();
          await dispatchTaskMouseClick(dbg, aim.x, aim.y);
          noteTrigger('cdp', '官网卡片真实鼠标路径');
          page.clicked++;
          totalClicked++;
          await wait(100);
        } catch (err) {
          if (samePageWatcher) samePageWatcher.cancel();
          /* T01=D：CDP 不可用时改用页面真实交互，并明确记录实际触发方式。 */
          const dom = await domClickFallback(tv.webContents, aim.href || card.href);
          if (dom && dom.ok) {
            noteTrigger('page-interaction', 'CDP 不可用，降级页面交互');
            pageInteractionClicks++;
            page.clicked++;
            totalClicked++;
            await wait(100);
          } else {
            page.failed++; totalFailed++;
            DBG.log('task', '侧栏 CDP 鼠标点击失败且页面交互亦不可用', {
              name: card.name, x: aim.x, y: aim.y,
              error: String(err && err.message || err), dom: dom
            });
            continue;
          }
        }

        if (taskResultLoadPromise) {
          if (samePageWatcher) samePageWatcher.cancel();
          const opened = await taskResultLoadPromise;
          if (opened && opened.ok) { page.opened++; totalOpened++; }
          else {
            noteUnconfirmed(card.name, aim.href || card.href);
            DBG.log('task', '侧栏点击已发送，但任务结果页未完成加载', { name: card.name, result: opened });
          }
        } else if (samePageWatcher) {
          const nav = await Promise.race([
            samePageWatcher.promise,
            new Promise(resolve => wait(900).then(() => resolve(null)))
          ]);
          if (nav && nav.ok) {
            page.opened++; totalOpened++;
            /* 同页导航会冲掉侧栏 DOM：重新加载并重建序号，后续卡片继续点 */
            await loadSidebarFlyout(tv, sidebarUrls);
            await scanSidebarCards(tv.webContents);
          } else {
            samePageWatcher.cancel();
            noteUnconfirmed(card.name, aim.href || card.href);
            await wait(TASK_CLICK_SETTLE_MS);
          }
        } else {
          noteUnconfirmed(card.name, aim.href || card.href);
          await wait(TASK_CLICK_SETTLE_MS);
        }
        DBG.log('task', '侧栏积分卡 CDP 鼠标点击完成', {
          name: card.name, points: card.points, completed: !!card.completed,
          x: aim.x, y: aim.y, href: aim.href, target: aim.target,
          strategy: aim.strategy, opened: page.opened
        });
      }
      pages.push(page);
      desktopActivityPush({
        state: 'clicking', page: page.url,
        zh: '侧栏已点击 ' + page.clicked + ' 张积分卡 · 下一步：完成搜索任务',
        en: 'Sidebar clicked ' + page.clicked + ' cards · Next: search tasks'
      });
      DBG.log('task', '侧栏点击汇总', {
        clicked: totalClicked, opened: totalOpened, failed: totalFailed,
        skippedCompleted: skippedBySetting, excludedNoPoints: excluded.length,
        unconfirmed: totalUnconfirmed, skipCompletedCards: skipCompletedCards
      });
      return {
        ok: true, pages, clicked: totalClicked, scanned: totalScanned,
        opened: totalOpened, failed: totalFailed, skipped: skippedBySetting,
        clickUnconfirmed: totalUnconfirmed, excludedNoPoints: excluded.length,
        stateSource: 'main-ui-task-state',
        method: 'sidebar-flyout + CDP Input.dispatchMouseEvent',
        states: clickStates(), manualLinks: manualLinks.slice(0, 20),
        triggerMethods: triggerMethods.slice(0, 64)
      };
    }
    DBG.log('task', '侧栏无可依据的主界面任务状态，回退到 dashboard/earn 索引点击', {
      sidebarReady: sidebarReady, scanned: merged.length,
      scored: scored.length, matchedMainUi: matchedScored
    });

    DBG.log('task', '任务卡片点击开始：消费同步阶段 taskClickIndex，不再全页扫描', {
      indexCount: entries.length, source: index.source || 'sync-index',
      method: 'indexed locator + CDP Input.dispatchMouseEvent'
    });

    for (const pageDef of [
      { page: '/dashboard', url: 'https://rewards.bing.com/dashboard' },
      { page: '/earn', url: 'https://rewards.bing.com/earn' }
    ]) {
      if (!state.running) break;
      let pageEntries = entries.filter(x => x.page === pageDef.page);
      desktopActivityPush({
        state: 'opening', page: pageDef.url,
        zh: '打开页面 · Rewards ' + pageDef.page + ' · 待点击 ' + pageEntries.length + ' 张卡片',
        en: 'Opening · Rewards ' + pageDef.page + ' · ' + pageEntries.length + ' cards to click'
      });
      await loadTaskPage(tv, pageDef.url);
      desktopActivityPush({state:'opening', page:pageDef.url,
        zh:'页面加载后已等待 5 秒 · 正在慢速滚动扫描（不少于 5 秒）',
        en:'Loaded; waited 5s · slow-scanning page for at least 5s'});
      const live = await discoverLiveScoredCards(tv.webContents, pageDef);
      const known = new Set(pageEntries.map(e => {
        const l = e.locator || {};
        return String(l.href || e.url || l.dataOfferId || l.dataBiId || '') + '|' + Number(e.points || 0);
      }));
      for (const item of live) {
        if (skipCompletedCards && item.completed) continue;
        const l = item.locator || {};
        const id = String(l.href || item.url || l.dataOfferId || l.dataBiId || '') + '|' + Number(item.points || 0);
        if (known.has(id)) continue;
        known.add(id);
        pageEntries.push(item);
      }
      if (!pageEntries.length) {
        DBG.log('task', '同步索引和实时 DOM 均无任务卡', {page:pageDef.page});
        continue;
      }
      /* 回退路径同样严格按 DOM 顺序，实时发现的卡片按 idx 归位到正确位置。 */
      pageEntries = HSA_CORE.taskListOrder(pageEntries);
      const fallbackOrder = HSA_CORE.taskListNames(pageEntries)
        .map((n, i) => (i + 1) + '.' + n).join(' → ');
      desktopActivityPush({
        state: 'opening', page: pageDef.url,
        zh: '任务卡执行顺序（索引回退 · DOM 顺序）：' + fallbackOrder,
        en: 'Task card order (index fallback · DOM order): ' + fallbackOrder
      });
      DBG.log('task', '同步索引和实时 DOM 合并（按 DOM 顺序）', {
        page:pageDef.page, live:live.length, total:pageEntries.length, order:fallbackOrder
      });
      const page = {
        url: pageDef.url, found: pageEntries.length, clicked: 0,
        opened: 0, skipped: 0, failed: 0, source: 'sync-index'
      };
      totalScanned += pageEntries.length;

      for (const entry of pageEntries) {
        if (!state.running) break;
        let aim = null;
        try {
          aim = await locateIndexedCardAcrossScroll(tv.webContents, entry);
        } catch (err) {
          DBG.log('task', '索引定位异常', {
            name: entry.name, error: String(err && err.message || err)
          });
        }
        if (!aim || !aim.ok) {
          page.failed++;
          totalFailed++;
          DBG.log('task', '跳过无法安全定位的索引任务卡', {
            name: entry.name, reason: aim && aim.reason || 'no-aim', key: entry.key
          });
          continue;
        }

        if (!(await waitClickSpacing())) break;
        await hsaWaitPageStable(tv.webContents);
        taskResultLoadPromise = null;
        const targetBlank = String(aim.target || entry.target || '').toLowerCase() === '_blank';
        const samePageWatcher = !targetBlank ? watchMainFrameLoad(tv.webContents, 12000) : null;
        try {
          const cardName = String(entry.name || '未命名任务').slice(0, 40);
          desktopActivityPush({
            state: 'clicking', page: pageDef.url, card: cardName,
            delayMs: TASK_CLICK_SETTLE_MS,
            zh: '点击 ' + (page.clicked + 1) + '/' + pageEntries.length + ' · ' + cardName
              + ' +' + (Number(entry.points) || 0)
              + ' · 下一步：' + (orderHint(pageEntries, entry) || '搜索')
              + ' · 等 ' + TASK_CLICK_SETTLE_MS + 'ms',
            en: 'Click ' + (page.clicked + 1) + '/' + pageEntries.length + ' · ' + cardName
              + ' +' + (Number(entry.points) || 0)
              + ' · Next: ' + (orderHint(pageEntries, entry) || 'search')
              + ' · wait ' + TASK_CLICK_SETTLE_MS + 'ms'
          });
          // Timestamp corresponds to the beginning of the CDP mouse action.
          lastPhysicalClickAt = Date.now();
          await dispatchTaskMouseClick(dbg, aim.x, aim.y);
          noteTrigger('cdp', '索引卡片真实鼠标路径');
          page.clicked++;
          totalClicked++;
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (err) {
          if (samePageWatcher) samePageWatcher.cancel();
          const dom = await domClickFallback(tv.webContents, aim.href || entry.url);
          if (dom && dom.ok) {
            noteTrigger('page-interaction', 'CDP 不可用，降级页面交互');
            pageInteractionClicks++;
            page.clicked++;
            totalClicked++;
            await new Promise(resolve => setTimeout(resolve, 100));
          } else {
            page.failed++;
            totalFailed++;
            DBG.log('task', 'CDP 索引鼠标点击失败且页面交互亦不可用', {
              name: entry.name, x: aim.x, y: aim.y,
              error: String(err && err.message || err)
            });
            continue;
          }
        }

        if (taskResultLoadPromise) {
          if (samePageWatcher) samePageWatcher.cancel();
          const opened = await taskResultLoadPromise;
          if (opened && opened.ok) {
            page.opened++;
            totalOpened++;
          } else {
            noteUnconfirmed(entry.name, aim.href || entry.url);
            DBG.log('task', '鼠标点击已发送，但结果页未完成加载', {
              name: entry.name, result: opened
            });
          }
        } else if (samePageWatcher) {
          const nav = await Promise.race([
            samePageWatcher.promise,
            new Promise(resolve => setTimeout(() => resolve(null), 900))
          ]);
          if (nav && nav.ok) {
            page.opened++;
            totalOpened++;
            await loadTaskPage(tv, pageDef.url);
          } else {
            samePageWatcher.cancel();
            noteUnconfirmed(entry.name, aim.href || entry.url);
            await new Promise(resolve => setTimeout(resolve, TASK_CLICK_SETTLE_MS));
          }
        } else {
          noteUnconfirmed(entry.name, aim.href || entry.url);
          await new Promise(resolve => setTimeout(resolve, TASK_CLICK_SETTLE_MS));
        }
        DBG.log('task', '同步索引任务卡 CDP 鼠标点击完成', {
          name: entry.name, points: entry.points, x: aim.x, y: aim.y,
          href: aim.href, target: aim.target, strategy: aim.strategy,
          opened: page.opened
        });
      }
      pages.push(page);
      desktopActivityPush({
        state: 'clicking', page: pageDef.url,
        zh: '本页已点击 ' + page.clicked + ' 张卡片 · 下一步：切换页面或搜索',
        en: 'Clicked ' + page.clicked + ' cards · Next: next page or search'
      });
      DBG.log('task', '同步索引页面点击完成', page);
    }

    return {
      ok: true, pages, clicked: totalClicked, scanned: totalScanned,
      opened: totalOpened, failed: totalFailed, skipped: skippedCompleted,
      clickUnconfirmed: totalUnconfirmed, method: 'sync-index + CDP Input.dispatchMouseEvent',
      states: clickStates(), manualLinks: manualLinks.slice(0, 20),
      triggerMethods: triggerMethods.slice(0, 64)
    };
  } catch (err) {
    DBG.log('task', '任务卡片索引点击整体失败', { error: String(err && err.stack || err) });
    return {
      ok: false, reason: String(err && err.message || err), pages,
      clicked: totalClicked, opened: totalOpened, failed: totalFailed + 1, clickUnconfirmed: totalUnconfirmed
    };
  } finally {
    if (debuggerAttachedHere && dbg && dbg.isAttached()) {
      try { dbg.detach(); } catch {}
    }
    taskResultLoadPromise = null;
    taskClickRunning = false;
    hideTaskView();
    /* 点击任务卡片流程结束：把侧栏页面真正关掉，不残留上次的 flyout DOM */
    if (tv) await closeSidebarTaskPage(tv).catch(() => {});
    DBG.log('task', '点击任务卡片流程结束：侧栏页面已关闭');
  }
});

ipcMain.handle('chrome:panel:hide', () => {
  notePanelAction(); DBG.ipc('chrome:panel:hide'); return hideSidePanel();
});
ipcMain.handle('chrome:panel:toggle', () => {
  notePanelAction(); DBG.ipc('chrome:panel:toggle');
  return sideVisible ? hideSidePanel() : showSidePanel(null, 'user');
});
ipcMain.handle('chrome:panel:state', () => panelState());
/* v1.1.3：即使 window.chrome 被 Chromium 内置对象占用、desktopPanel 缺失，
   preload 的 __desktop 仍可直达这里 —— 登录徽标点击一定能展开右侧官网。 */
ipcMain.handle('chrome:open:official', (_e, url) => {
  notePanelAction();
  DBG.ipc('chrome:open:official', { url });
  return openInSidePanel(url || DEFAULT_BROWSER_HOME, 'user');
});
ipcMain.on('chrome:debug:log', (_e, scope, msg, data) => DBG.log('renderer:' + scope, msg, data));
ipcMain.on('chrome:debug:page', (_e, kind, url, html, meta) => {
  if (!DBG.enabled) return;
  DBG.captureHtml('parser-input-' + String(kind || 'page'), url, html,
    Object.assign({ source: 'background.js' }, meta || {}));
});

/* ==========================================================================
 * v1.1.4 · 直读可见官网面板（修「官网 20,192 分、主界面全 — / 未登录」）
 *
 * 旧链路：tabs.query → 排序 → waitForSettled(25s) → DIRECT_TIMEOUT(12s) 竞速。
 * 只要可见面板没被选中（status/kind/url 任一不对），12 秒一到就返回空 html，
 * 后面 classifyLogin / parsePointsTrio 全部落空。而且 classifyLogin 对整页
 * outerHTML 跑 isSignInPage，官网 Next.js bundle 里的登录页文案会把已登录页
 * 误判成 'out' —— 正是截图里红色横幅「未登录」的来源。
 *
 * 这条 IPC 直接对用户正在看的 sideView 执行注入：同一页面、同一会话、同一
 * 份已渲染 DOM，没有任何筛选与超时竞速；同时把 HTML 原样落盘供排障。
 * ======================================================================== */
const VISIBLE_READER = `(function () {
  var clean = function (el) {
    return String(el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
  };
  var text = clean(document.body);
  var html = document.documentElement.outerHTML;
  var toNum = function (s) {
    var m = String(s || '').match(/\\d{1,3}(?:[,\\s]\\d{3})+|\\d{1,6}/);
    if (!m) return null;
    var n = parseInt(m[0].replace(/\\D/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  /* 全局可见文本：标签后 40 字内第一个数字（不依赖任何 class / DOM 层级）。
     截图里「可用积分 20,192」「可领取 0」都是这种紧邻写法。 */
  var near = function (names) {
    for (var k = 0; k < names.length; k++) {
      var i = text.indexOf(names[k]);
      if (i < 0) continue;
      var v = toNum(text.slice(i + names[k].length, i + names[k].length + 40));
      if (v !== null) return v;
    }
    return null;
  };
  var points = {};
  var av = near(['可用积分', '可用点数', 'Available points', 'Points balance', '我的积分']);
  if (av !== null) points.available = av;
  var td = near(['今日积分', "Today's points", 'Today points', '今日赚取', 'Points earned today']);
  if (td !== null) points.today = td;
  var cl = near(['可领取', '可领取积分', '待领取积分', 'Claimable', 'Points to claim']);
  if (cl !== null) points.claimable = cl;
  /* 右上角大数字兜底：20,192 这种带千分位的数字，且页面有积分面板标识 */
  if (points.available == null && /可用积分|金牌会员|积分赚取|邀请好友赚积分/.test(text)) {
    var big = text.match(/\\b\\d{1,3}(?:,\\d{3}){1,}\\b/);
    if (big) points.available = toNum(big[0]);
  }
  /* 任务卡片：以 a[href] 为入口，按「+N 分」取积分，不依赖具体 class */
  var cards = [];
  var anchors = document.querySelectorAll('a[href]');
  for (var ai = 0; ai < anchors.length; ai++) {
    var a = anchors[ai], href = a.getAttribute('href') || '';
    if (!/bing\\.com/i.test(href)) continue;
    if (/\\/redeem|\\/referandearn|\\/dashboard|\\/earn\\/?(?:[?#]|$)/i.test(href)) continue;
    var tx = clean(a);
    if (!tx || tx.length > 400) continue;
    if (/可用积分|今日积分|可领取|兑换|管理奖励/i.test(tx)) continue;
    var pm = tx.match(/\\+\\s*(\\d{1,4})(?!\\d)/);
    if (!pm) continue;
    var pts = parseInt(pm[1], 10);
    if (!(pts > 0)) continue;
    var name = clean(a.querySelector('h3,h4,[class*="Body2Strong"]')) ||
      clean(a.querySelector('img') && a.querySelector('img').alt);
    if (!name) continue;
    var sec = 'promo', prevH = '';
    var hs = document.querySelectorAll('h2');
    for (var hi = 0; hi < hs.length; hi++) {
      if (hs[hi].compareDocumentPosition(a) & 4) prevH = clean(hs[hi]); else break;
    }
    if (/每日活动|每日任务|每日福利|Daily set/i.test(prevH)) sec = 'daily';
    cards.push({ name: name, description: '', section: sec, points: pts,
      earned: 0, completed: /已完成|已领取|Completed/i.test(tx),
      url: href, source: 'visible-panel' });
  }
  var signedIn = /\\d/.test(text) && /可用积分|今日积分|可领取|Available points|金牌会员|银牌会员|积分赚取|邀请好友赚积分|兑换|Redeem/i.test(text);
  var signedOut = /^(?:[\\s\\S]{0,300}?)(?:Sign in to your Microsoft account|登录你的 Microsoft 帐户|登录到 Microsoft 帐户|登录以使用|Sign in to Microsoft)/i.test(text) &&
    /创建帐户|忘记用户名|无法访问你的帐户|Create (?:an? )?account|No account\\?|Get a new account/i.test(text);
  return {
    ok: true, url: location.href, html: html, text: text.slice(0, 30000),
    title: String(document.title || ''), points: points, cards: cards,
    signedIn: !!signedIn, signedOut: !!signedOut,
    textHead: text.slice(0, 400)
  };
})()`;

async function readVisibleNow() {
  if (!sideView || !sideView.webContents || sideView.webContents.isDestroyed()) {
    DBG.log('rewards', 'readVisible: 侧栏视图不存在'); return null;
  }
  const wc = sideView.webContents;
  const url = wc.getURL();
  try {
    const r = await wc.executeJavaScript(VISIBLE_READER, true);
    if (!r || !r.ok) { DBG.log('rewards', 'readVisible: 注入返回空', { url }); return null; }
    /* v1.1.5 · 今日积分在 /earn 页。官网把「今日积分」卡片放在 React
       streaming 的 hidden 占位里，innerText 常常读不到；用页面 HTML 再补两条
       （RSC totalPoints / SSR 卡片 text-pageHeader）。 */
    r.points = r.points || {};
    if (!Number.isFinite(r.points.today)) {
      const mt = /totalPoints[^\d]{0,8}(\d{1,7})/.exec(r.html || '');
      if (mt) r.points.today = parseInt(mt[1], 10);
      else {
        const mc = /(?:今日积分|Today'?s?\s*points)[\s\S]{0,420}?text-pageHeader[^>]*>\s*([\d,.\s]+)\s*</i.exec(r.html || '');
        if (mc) r.points.today = parseInt(mc[1].replace(/\D/g, ''), 10);
      }
    }
    const effUrl = r.url || url;
    r.pageKind = /\/earn(?:\/|[?#]|$)/i.test(effUrl) ? 'earn' : 'dashboard';
    /* 调试要求：抓取积分/任务时拿到的 HTML 原样落盘；登录页也保留。 */
    DBG.captureHtml('read-visible-panel', r.url || url, r.html, {
      source: 'visible-side-panel', points: r.points || null,
      signedIn: !!r.signedIn, signedOut: !!r.signedOut,
      textBytes: (r.text || '').length
    });
    DBG.log('rewards', 'readVisible 成功', {
      url: wc.getURL(), bytes: (r.html || '').length,
      points: r.points, signedIn: r.signedIn, signedOut: r.signedOut,
      textHead: r.textHead
    });
    return r;
  } catch (err) {
    DBG.log('rewards', 'readVisible 注入失败', { url, error: String(err && err.message || err) });
    return null;
  }
}

ipcMain.handle('chrome:rewards:readVisible', () => readVisibleNow());

/* v1.1.4 核心：侧栏页面真正渲染完，主进程就把「可见 DOM 快照」写进
   storage.local 并广播同步。background.js 的 fetchRewardsPage 直接读这份
   本地快照，不再每次跨进程等 executeJavaScript —— 页面导航期的 2.5 秒
   竞速、execution context destroyed、tabs.query 筛选全部被绕开。
   官网页面与主界面用的就是同一份已渲染 DOM，积分/任务自然一致。 */
let loginPageSeen = false;
let lastLoginSyncAt = 0;

/* 官网侧栏快照只作为后台取数的数据源，不直接写业务键；登录跳回 Rewards
   时只发一条 syncRewards，由 desktopSyncRewards 一次抓取、一次原子写回。 */
async function pushVisibleSnapshot(reason) {
  const r = await readVisibleNow();
  if (!r || !r.html) return null;
  const snap = {
    at: Date.now(), url: r.url, text: String(r.text || '').slice(0, 64 * 1024),
    /* 整页 outerHTML 可达数 MB；后台只用前 600KB 解析积分/任务。 */
    html: String(r.html || '').slice(0, SNAPSHOT_HTML_LIMIT),
    points: r.points || {}, cards: Array.isArray(r.cards) ? r.cards : [],
    signedIn: !!r.signedIn, signedOut: !!r.signedOut,
    reason: reason || 'panel-loaded'
  };
  const isEarn = r.pageKind === 'earn' ||
    /\/earn(?:\/|[?#]|$)/i.test(String(r.url || ''));
  snap.pageKind = isEarn ? 'earn' : 'dashboard';
  const patch = { [isEarn ? 'visibleRewardsEarnSnapshot' : 'visibleRewardsSnapshot']: snap };

  /* 仅「完成登录后跳回 Rewards」才同步；展开面板只存快照，运行态一律不派发。 */
  const url = String(snap.url || '');
  if (isLoginPageUrl(url)) loginPageSeen = true;
  const isRewards = /^https:\/\/rewards\.bing\.com\//i.test(url);
  const loginReturn = loginPageSeen && isRewards;
  if (loginReturn) loginPageSeen = false;
  if (loginReturn && !desktopQuietRun()) {
    if (Date.now() - lastLoginSyncAt > 800) {
      lastLoginSyncAt = Date.now();
      try {
        sendToHost({ type: 'syncRewards', reason: 'login-return' }).catch(() => {});
        DBG.log('rewards', '派发统一同步', { reason: 'login-return', url: url });
      } catch (err) {
        DBG.log('rewards', '统一同步派发失败', { error: String(err && err.message || err) });
      }
    }
  }

  emitStorageChanges(state, patch, { reason: 'panel-snapshot' });
  Object.assign(state, patch);
  saveState();
  DBG.log('rewards', '官网快照已保存（业务状态由统一同步写回）', {
    reason: snap.reason, url: snap.url, pageKind: snap.pageKind,
    points: snap.points, cards: snap.cards.length,
    signedIn: snap.signedIn, signedOut: snap.signedOut
  });
  return snap;
}

ipcMain.handle('chrome:tabs:goBack', (_e, id) => {
  const e = tabs.get(Number(id));
  if (e && !e.win.isDestroyed() && e.win.webContents.canGoBack()) e.win.webContents.goBack();
  return null;
});

/* ==========================================================================
 * 4. scripting.executeScript —— 序列化 func 后在目标 frame 执行
 * ======================================================================== */
const frameIds = new WeakMap();
let frameSeq = 1000;
function idForFrame(f) {
  if (!frameIds.has(f)) frameIds.set(f, ++frameSeq);
  return frameIds.get(f);
}
async function runInFrame(frame, code, wc) {
  try {
    if (frame && typeof frame.executeJavaScript === 'function') {
      return { result: await frame.executeJavaScript(code, true), error: null };
    }
    return { result: await wc.executeJavaScript(code, true), error: null };
  } catch (err) {
    return { result: null, error: String(err && err.message || err) };
  }
}

ipcMain.handle('chrome:scripting:executeScript', async (_e, spec) => {
  const e = tabs.get(Number(spec.tabId));
  if (!e || e.win.isDestroyed()) throw new Error('No tab with id: ' + spec.tabId);
  const wc = e.win.webContents;
  if (!spec.funcSource) throw new Error('func is required');
  const code = C.buildInjectCode(spec.funcSource, spec.args);

  let frames;
  if (spec.frameIds && spec.frameIds.length) {
    const all = wc.mainFrame ? wc.mainFrame.framesInSubtree : [];
    frames = spec.frameIds.map(fid => all.find(f => idForFrame(f) === Number(fid))).filter(Boolean);
    if (!frames.length) frames = [wc.mainFrame];
  } else if (spec.allFrames) {
    frames = wc.mainFrame ? wc.mainFrame.framesInSubtree.filter(f => !f.isDestroyed?.()) : [];
    if (!frames.length) frames = [wc.mainFrame];
  } else {
    frames = [wc.mainFrame || null];
  }
  const out = [];
  const fnName = /function\s+([A-Za-z0-9_$]+)\s*\(/.exec(String(spec.funcSource || ''));
  const injectName = fnName ? fnName[1] : 'func';
  for (const f of frames) {
    const r = await runInFrame(f, code, wc);
    const result = r.result === undefined ? null : r.result;
    /* v1.1.3 · debug：抓取积分 / 任务列表时真正拿到的页面 HTML 原样落盘。
       主进程在 IPC 边界就能拿到注入返回值，不需要改动 src/ 插件源码。 */
    if (result && typeof result === 'object' && typeof result.html === 'string') {
      DBG.captureHtml('read-' + injectName, result.url || (wc && wc.getURL()), result.html, {
        tabId: spec.tabId, inject: injectName, ok: !!result.ok,
        signedIn: !!result.signedIn, signedOut: !!result.signedOut,
        points: result.points || null,
        textBytes: (result.text || '').length
      });
    } else if (result && Array.isArray(result.rows)) {
      DBG.event({ t: Date.now(), type: 'task-rows', inject: injectName, rows: result.rows.length });
    }
    if (r.error) DBG.log('inject', injectName + ' 注入失败', {
      error: r.error, tabId: spec.tabId,
      funcSourceHead: String(spec.funcSource || '').slice(0, 90),
      codeHead: String(code || '').slice(0, 240)
    });
    out.push({ frameId: f ? idForFrame(f) : 0, result, error: r.error });
  }
  return out;
});

/* ==========================================================================
 * 5. debugger —— 直接映射到 webContents.debugger（CDP 1.3）
 * ======================================================================== */
function dbgOf(id) {
  const e = tabs.get(Number(id));
  if (!e || e.win.isDestroyed()) throw new Error('No tab with id: ' + id);
  return e.win.webContents.debugger;
}
ipcMain.handle('chrome:debugger:attach', async (_e, id, version) => {
  const d = dbgOf(id);
  if (!d.isAttached()) await d.attach(version || '1.3');
  return null;
});
ipcMain.handle('chrome:debugger:detach', async (_e, id) => {
  const d = dbgOf(id);
  if (d.isAttached()) await d.detach();
  return null;
});
ipcMain.handle('chrome:debugger:sendCommand', async (_e, id, method, params) => {
  const d = dbgOf(id);
  if (!d.isAttached()) await d.attach('1.3');
  return await d.sendCommand(method, params || {});
});

/* ==========================================================================
 * 6. alarms —— 主进程定时器，跨窗口存活
 * ======================================================================== */
const alarmTimers = new Map();
function clearAlarm(name) {
  const rec = alarmTimers.get(name);
  if (rec) { clearTimeout(rec.timer); alarmTimers.delete(name); }
}
function setAlarm(name, info) {
  clearAlarm(name);
  const delay = C.computeAlarmDelay(info, Date.now());
  if (delay == null) return null;
  const rec = { name, spec: info, scheduledTime: Date.now() + delay, timer: null };
  const tick = () => {
    broadcast('alarms.onAlarm', [{
      name,
      scheduledTime: rec.scheduledTime,
      periodInMinutes: info.periodInMinutes || null
    }]);
    if (info.periodInMinutes) {
      const next = C.computeAlarmDelay(info, Date.now());
      rec.scheduledTime = Date.now() + next;
      rec.timer = setTimeout(tick, next);
    } else {
      alarmTimers.delete(name);
    }
  };
  rec.timer = setTimeout(tick, delay);
  alarmTimers.set(name, rec);
  return rec;
}
ipcMain.handle('chrome:alarms:create', (_e, name, info) => {
  const r = setAlarm(name, info || {});
  return r ? { name, scheduledTime: r.scheduledTime } : null;
});
ipcMain.handle('chrome:alarms:clear', (_e, name) => {
  if (name == null) { for (const k of [...alarmTimers.keys()]) clearAlarm(k); }
  else clearAlarm(name);
  return true;
});
ipcMain.handle('chrome:alarms:get', (_e, name) => {
  const r = alarmTimers.get(name);
  return r ? { name, scheduledTime: r.scheduledTime, periodInMinutes: r.spec.periodInMinutes || null } : null;
});
ipcMain.handle('chrome:alarms:getAll', () =>
  [...alarmTimers.values()].map(r => ({ name: r.name, scheduledTime: r.scheduledTime })));

/* ==========================================================================
 * 7. windows / permissions / runtime 消息
 * ======================================================================== */
ipcMain.handle('chrome:windows:update', (_e, windowId, info) => {
  const w = BrowserWindow.fromId(Number(windowId));
  if (w && info && info.focused && !desktopQuietRun()) { w.show(); safeAutoFocus(w); }
  return { id: Number(windowId), focused: true };
});
ipcMain.handle('chrome:windows:get', (_e, id) => ({ id: Number(id), focused: true, type: 'normal' }));
ipcMain.handle('chrome:windows:getCurrent', () => ({ id: popupWin ? popupWin.id : 1, focused: true, type: 'popup' }));
ipcMain.handle('chrome:permissions:contains', () => true);
ipcMain.handle('chrome:runtime:getManifest', () => {
  try { return JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')); }
  catch { return {}; }
});

/* 会话同步：登录 Cookie 一写入就通知后台复检，不依赖页面跳转（Windows 上
   Cookie 异步落盘，用户可能停在登录页或登录完没跳转）。 */
/* 自动路径统一走 safeAutoFocus()：登录页输入过程中不断重定向、Cookie 不断变化，
   无条件 BrowserWindow.focus() 会反复抢走账号/密码输入框的焦点。
   用户显式动作（托盘 / 菜单 / 点徽标）仍正常激活窗口。 */
function isLoginPageUrl(u) {
  /* v1.3.1：/oauth2/v2.0/authorize 是正常登录跳转，不能当成「已登出」信号，
     否则官网已登录、主界面却显示未登录。 */
  return /^https?:\/\/(login\.live\.com|login\.microsoftonline\.com|account\.live\.com|account\.microsoft\.com)/i
      .test(String(u || '')) || /(?:\/logout|signout)/i.test(String(u || ''));
}
/** v1.3.1：自动完成任务运行期间不把任何窗口弹到系统前台。
 *  页面保活靠 backgroundThrottling:false + CDP 焦点模拟，不需要抢焦点。 */
function desktopQuietRun() {
  return !!(state && (state.running === true ||
    /completingTasks|searching|fetchingStartPoints|checkingLimit|fetchingEndPoints|syncing/
      .test(String((state && state.phase) || ''))));
}
/* v2.4：设置里的「静默完成任务」开关已移除。保留函数名兼容既有调用点，
   恒定返回 false —— 侧栏 / 页面一律按用户可见行为运行，不再有隐藏页面模式。 */
function desktopSilentRun() {
  return false;
}
function autoFocusAllowed() {
  try {
    if (desktopQuietRun()) return false;
    if (sideView && sideView.webContents && isLoginPageUrl(sideView.webContents.getURL())) return false;
  } catch {}
  return true;
}
function safeAutoFocus(win) {
  if (!win || win.isDestroyed()) return;
  if (!autoFocusAllowed()) return;          // 登录页输入中：不抢焦点
  try { win.focus(); } catch {}
}

/* v1.1.6 · 官网退出登录后主界面状态改变迟缓
 * 旧链路只靠 2.5s 节流 + 4~5s 轮询 + 「积分新鲜度护栏」累积两次才清空，
 * 用户登出后要等很久才变未登录。这里对确凿的登出信号即时写状态并广播。 */
function markSignedOut(reason) {
  const now = Date.now();
  /* v1.3.2：自动完成任务期间 UI 必须保持不动。任何登出信号（瞬时登录页、
     导航抖动、Cookie 变更）都只记日志，绝不写业务键 —— 修「运行中被清空」。 */
  if (desktopQuietRun()) {
    DBG.log('login', '运行中忽略登出信号，UI 保持不动', { reason });
    return;
  }
  /* v1.3.3：用户单击 / 双击登录徽标开关侧栏、打开主页期间，任何登出信号
     都不得改图标与积分。单击双击是纯界面动作，不改变登录状态。 */
  if (panelActionActive()) {
    DBG.log('login', '用户面板动作期间忽略登出信号，图标与积分保持不动', { reason });
    return;
  }
  /* 非运行期的确凿登出：只改变「变化的值」，不清空任务列表、不把 today/
     claimable 写成 null。登录状态绑定可用积分，available=null 即显示未登录。 */
  const prevLogin = state.loginStatus;
  const prevPoints = state.pointsSummary || {};
  if (prevLogin === 'out' && !Number.isFinite(prevPoints.available)) return;
  /* D05=D：隐藏当前可用余额，保留历史 / 今日值并标记为「上次记录」。 */
  const nextPoints = HSA_CORE.logoutPresentation(prevPoints, now).pointsSummary;
  state.loginStatus = 'out';
  state.loginCheckedAt = now;
  state.signOutSignalAt = now;
  state.pointsSummary = nextPoints;
  /* todayTasks 原样保留：刷新不清空、只改变化的值 */
  const changes = emitStorageChanges(state, {
    loginStatus: 'out', pointsSummary: nextPoints, taskClickIndex: null,
    loginCheckedAt: now, signOutSignalAt: now
  }, { reason: 'sign-out' });
  Object.assign(state, { loginStatus: 'out', loginCheckedAt: now,
    signOutSignalAt: now, pointsSummary: nextPoints, taskClickIndex: null });
  saveState();
  if (!Object.keys(changes).length) {
    broadcast('storage.onChanged', [{
      loginStatus: { oldValue: prevLogin, newValue: 'out' },
      pointsSummary: { oldValue: prevPoints, newValue: nextPoints }
    }, 'local']);
  }
  DBG.log('login', '退出登录即时同步（仅改变化值）', { reason });
}

function attachSessionSync() {
  const s = getAppSession();
  if (!s || !s.cookies || typeof s.cookies.on !== 'function') return;
  try {
    s.cookies.on('changed', (_e, cookie, cause, removed) => {
      if (!cookie) return;
      const d = String(cookie.domain || '');
      if (!/(bing\.com|live\.com|microsoftonline\.com|rewards)/i.test(d)) return;
      /* Cookie 删除不等于 Rewards 已登出：Microsoft 登录会轮换认证票据，
         即使是已知认证 Cookie，也必须等明确 logout URL 或 Rewards 页面同步确认。
         这里仅记诊断，不清空积分、不改登录徽标。 */
      if (removed && C.isRewardsAuthCookie(cookie)) {
        DBG.log('login', '认证 Cookie 被移除，保留积分并等待页面确认登录状态', {
          name: String(cookie.name || ''), domain: d, cause: String(cause || '')
        });
        return;
      }
      /* v1.1.8：Cookie 新增/变更不再触发任何抓取。登录成功后的状态由侧栏
         DOM 快照事件写回；空闲时零请求。 */
    });
  } catch { /* 无头验证替身没有 cookies.on，忽略 */ }
}

/* host 消息队列：host 加载 250KB 的 background.js，冷启动可能超过 5 秒。
   未就绪时排队，等 host 明确回报 ready 后按序 flush，避免消息永久丢失。 */
let msgSeq = 0;
let hostReadyDone = false;
let hostReadyResolve = null;
const hostReady = new Promise(r => { hostReadyResolve = r; });
const hostQueue = [];

function markHostReady() {
  if (hostReadyDone) return;
  hostReadyDone = true;
  if (hostReadyResolve) { hostReadyResolve(); hostReadyResolve = null; }
  const pending = hostQueue.splice(0);
  for (const job of pending) {
    if (job.cancelled) continue;            // 已超时的消息不再补发
    job.cancelled = true;
    dispatchToHost(job.msg, job.timeoutMs).then(job.resolve);
  }
}
// host.html 在 background.js 注册完 onMessage 后主动回报；did-finish-load 作二次保险
ipcMain.on('chrome:host:ready', markHostReady);

async function dispatchToHost(msg, timeoutMs = 15000) {
  const alive = () => hostWin && !hostWin.isDestroyed() && !hostWin.webContents.isDestroyed();
  if (!alive()) return undefined;
  const id = ++msgSeq;
  const replyChannel = `chrome:runtime:reply:${id}`;
  return new Promise(resolve => {
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ipcMain.removeListener(replyChannel, onReply);
      resolve(v === null ? undefined : v);   // 超时/无响应 → undefined，让弹窗恢复按钮
    };
    const onReply = (__e, v) => finish(v);
    const timer = setTimeout(() => finish(null), timeoutMs);
    ipcMain.once(replyChannel, onReply);
    try {
      hostWin.webContents.send('chrome:runtime:dispatch', { id, msg, replyChannel });
    } catch {
      finish(null);
    }
  });
}

async function sendToHost(msg, timeoutMs = 15000) {
  if (hostReadyDone) return dispatchToHost(msg, timeoutMs);
  // 排队；20 秒兜底，host 窗口意外销毁时调用方也不会永久挂起。
  // 超时后把任务移出队列，避免 ready 之后又补发一次造成重复执行。
  let job = null;
  const queued = new Promise(resolve => {
    job = { msg, timeoutMs, resolve, cancelled: false };
    hostQueue.push(job);
  });
  let guardTimer = null;
  const guard = new Promise(resolve => {
    guardTimer = setTimeout(() => {
      if (job && !job.cancelled) {
        job.cancelled = true;
        const i = hostQueue.indexOf(job);
        if (i >= 0) hostQueue.splice(i, 1);
      }
      resolve(undefined);
    }, Math.max(timeoutMs, 20000));
  });
  try { return await Promise.race([queued, guard]); }
  finally { if (guardTimer) clearTimeout(guardTimer); }
}
ipcMain.handle('chrome:runtime:sendMessage', (_e, msg) => sendToHost(msg));

/* ==========================================================================
 * 8. 托盘静默 / 内存治理
 *
 * 应用常驻托盘时，侧栏、任务视图、任务结果视图与两个后台取数视图原先会
 * 一直保持完整官网页面 renderer（共 5 个），加上主界面与后台宿主共 7 个
 * 渲染进程全速保活 —— 这是长期运行内存居高不下的主因。
 *
 * 规则：主窗口隐藏到托盘且没有任务在跑 → 延迟数秒进入静默态，销毁所有
 * 空闲视图、允许 Chromium 节流、裁剪 storage 里的大 HTML 快照、触发一次 GC。
 * 用户回到界面或任务启动 → 立即退出静默并恢复保活；所有 ensureXxx() 都是
 * 惰性重建，不需要额外恢复代码。任务运行期间绝不释放视图。
 * ========================================================================== */

/** 销毁一个嵌入式视图并清掉全部登记，避免 Set / Map 持有已销毁对象。 */
function destroyEmbeddedView(view, tabId) {
  if (!view) return 0;
  const wc = view.webContents;
  cancelViewSnapshot(wc);
  attachedViews.delete(view);          // 反复重建若不清理会持续累积
  try {
    if (popupWin && !popupWin.isDestroyed()) {
      const cv = popupWin.contentView;
      if (VIEW_API === 'WebContentsView' && cv && typeof cv.removeChildView === 'function')
        cv.removeChildView(view);
      else if (typeof popupWin.removeBrowserView === 'function') popupWin.removeBrowserView(view);
    }
  } catch {}
  if (tabId != null) {
    tabs.delete(tabId);
    loginTabIds.delete(tabId);
    if (activeTabId === tabId) activeTabId = null;
  }
  try {
    if (wc && !wc.isDestroyed()) {
      if (typeof wc.removeAllListeners === 'function') wc.removeAllListeners();
      if (typeof wc.stop === 'function') wc.stop();
      if (typeof wc.close === 'function') wc.close();
      else if (typeof wc.destroy === 'function') wc.destroy();
    }
  } catch {}
  return 1;
}

/** 释放所有空闲 renderer；返回销毁数量。任务运行中直接跳过。 */
function releaseIdleViews() {
  if (desktopQuietRun() || taskClickRunning) return 0;
  let n = 0;
  for (const [key, d] of [...dataViews]) {
    n += destroyEmbeddedView(d && d.view, d && d.id);
    dataViews.delete(key);
  }
  if (taskView && !taskClickRunning) {
    n += destroyEmbeddedView(taskView, taskTabId);
    taskView = null; taskTabId = null;
  }
  if (taskResultView) {
    if (taskResultLoadWatcher) { try { taskResultLoadWatcher.cancel(); } catch {} }
    taskResultLoadWatcher = null;
    taskResultLoadPromise = null;
    n += destroyEmbeddedView(taskResultView, null);
    taskResultView = null;
  }
  /* v3.0 · 窗口隐藏时用户看不到侧栏，静默期无条件销毁（以前只在面板
     收起时才释放，展开着的最小化会留一个完整 Rewards / Bing renderer）。
     记下 URL 与显隐状态，退出静默由 restoreSideViewIfNeeded() 复原。 */
  if (sideView) {
    try {
      sideViewRestore = {
        url: sideView.webContents.getURL ? sideView.webContents.getURL() : '',
        visible: !!sideVisible,
        reason: panelReason || null
      };
    } catch (err) { sideViewRestore = { url: '', visible: false, reason: null }; }
    n += destroyEmbeddedView(sideView, sideTabId);
    sideView = null; sideTabId = null;
  }
  return n;
}

/** v3.0 · 退出静默后只重建「原本展开着」的侧栏，回到原 URL。 */
function restoreSideViewIfNeeded() {
  const r = sideViewRestore;
  sideViewRestore = null;
  if (!r || !r.visible) return 0;
  try {
    ensureSideView(r.url || DEFAULT_BROWSER_HOME);
    sideVisible = true;
    panelReason = r.reason || 'user';
    attachView(sideView);
    applyPanelBounds();
    broadcast('ui:panel', [{ open: true, url: r.url, reason: panelReason }]);
    return 1;
  } catch (err) {
    DBG.log('memory', '侧栏恢复失败', { error: String(err && err.message || err) });
    return 0;
  }
}

/** 允许 / 关闭后台节流。Electron 版本若无该运行时 API 则静默忽略。 */
function setAllThrottling(allow) {
  const on = !!allow;
  const applyWc = wc => {
    if (!wc || wc.isDestroyed()) return;
    try { if (typeof wc.setBackgroundThrottling === 'function') wc.setBackgroundThrottling(on); } catch {}
    /* v3.0：进入静默时中止隐藏 renderer 仍在进行的页面加载，避免后台
       持续解码图片 / 执行 SPA 定时器。已完成加载的页面不受影响。 */
    if (on) { try { if (typeof wc.stop === 'function') wc.stop(); } catch {} }
  };
  const applyWin = w => {
    if (!w || w.isDestroyed()) return;
    try { if (typeof w.setBackgroundThrottling === 'function') w.setBackgroundThrottling(on); } catch {}
    applyWc(w.webContents);
  };
  applyWin(popupWin); applyWin(hostWin);
  for (const d of dataViews.values()) applyWc(d && d.view && d.view.webContents);
  for (const v of [sideView, taskView, taskResultView]) if (v) applyWc(v.webContents);
}

/** 把 storage 里的整页快照裁到上限；有裁剪才落盘，避免无谓 IO。 */
function trimStateSnapshots() {
  let cut = 0;
  for (const k of ['visibleRewardsSnapshot', 'visibleRewardsEarnSnapshot']) {
    const s = state[k];
    if (!s || typeof s !== 'object') continue;
    /* v3.0 · 静默期不再把两份整页 HTML 留在常驻内存里（各 600KB，且
       每次 saveState 都要序列化）。落盘副本已有裁剪版；退出静默后的
       syncOnOpen 会重新抓官网并写回快照，解析链路不受影响。 */
    if (typeof s.html === 'string' && s.html.length) {
      cut += s.html.length;
      delete s.html;
      s.htmlQuietTrimmed = true;
    }
    cut += trimSnapshotHtml(s, SNAPSHOT_HTML_LIMIT);
    if (Array.isArray(s.rows) && s.rows.length > 60) {
      cut += s.rows.length;
      s.rows = s.rows.slice(0, 60);
    }
  }
  /* 运行日志 / 历史词同步收紧到桌面预算（与插件版 180 / 120 分别取值） */
  if (Array.isArray(state.runLog) && state.runLog.length > RUNTIME_BUDGET.POLICY.runLogEntries) {
    cut += state.runLog.length - RUNTIME_BUDGET.POLICY.runLogEntries;
    state.runLog = state.runLog.slice(-RUNTIME_BUDGET.POLICY.runLogEntries);
  }
  if (cut) saveState();
  return cut;
}

function gcIfPossible() {
  try { if (typeof global.gc === 'function') global.gc(); } catch {}
}

const memoryGovernor = new MemoryGovernor({
  hooks: {
    isBusy: () => !!(state && (state.running === true || desktopQuietRun() || taskClickRunning)),
    isWindowHidden: () => !!(popupWin && !popupWin.isDestroyed() && !popupWin.isVisible()),
    releaseIdleViews: () => releaseIdleViews(),
    setThrottling: allow => setAllThrottling(allow),
    trimState: () => trimStateSnapshots(),
    gc: () => gcIfPossible(),
    onEnter: () => {
      /* v3.0 · 清 HTTP 缓存释放磁盘缓存的内存映射；不影响登录 Cookie */
      try {
        const s = getAppSession();
        if (s && typeof s.clearCache === 'function') Promise.resolve(s.clearCache()).catch(() => {});
      } catch {}
    },
    onExit: reason => {
      if (reason === 'dispose' || quitting) return;
      restoreSideViewIfNeeded();
    },
    onLog: (scope, msg, data) => DBG.log(scope, msg, data)
  }
});
function governMemory(reason) {
  try { memoryGovernor.schedule(reason); } catch {}
}
ipcMain.handle('chrome:memory:stats', () => memoryGovernor.snapshot());

/* ==========================================================================
 * 9. 窗口、托盘、菜单与生命周期
 * ======================================================================== */
/* v1.1.3 · 真机诊断：把 popup 页面里 window.chrome / __desktop / __hsaChrome
   的真实形状写进 environment.json。用户把调试包交回来，一眼就能看出
   「登录点击无效」是 preload 注入失败、IPC 未注册，还是面板挂载失败。 */
async function probePopupChrome() {
  if (!popupWin || popupWin.isDestroyed()) return;
  const code = `(function(){
    var c = window.chrome, d = window.__desktop, b = window.__hsaChrome;
    var p = document.getElementById('login-badge-icon');
    var badge = document.getElementById('login-badge-text');
    return {
      chromeType: typeof c,
      chromeKeys: c ? Object.keys(c).slice(0, 40) : [],
      hasStorage: !!(c && c.storage && c.storage.local),
      hasTabs: !!(c && c.tabs),
      hasRuntime: !!(c && c.runtime),
      hasDesktopPanel: !!(c && c.desktopPanel),
      hasOnTick: !!(c && c.onTick),
      hasOnPanel: !!(c && c.onPanel),
      hasHsaChrome: !!b,
      hsaChromeKeys: b ? Object.keys(b).slice(0, 40) : [],
      desktopKeys: d ? Object.keys(d) : [],
      hasOpenOfficial: !!(d && d.openOfficial),
      hasHostReady: !!(d && d.hostReady),
      badgeIconHidden: p ? !!p.hidden : null,
      badgeText: badge ? badge.textContent : null,
      readyState: document.readyState
    };
  })()`;
  let r;
  try { r = await popupWin.webContents.executeJavaScript(code, true); }
  catch (e) { DBG.log('probe', 'popup 探针执行失败', { error: String(e.message || e) }); return; }
  DBG.setEnvironment({ popupProbe: r });
  DBG.log('probe', 'popup chrome 形状', r);
  if (!r.hasStorage || !r.hasOnTick || !r.hasDesktopPanel) {
    DBG.log('probe', '⚠ popup 的 chrome 不完整（前置补丁应已修复，若仍异常请查 environment.json）');
  }
}

function createPopup() {
  popupWin = makeWindow({
    icon: APP_ICON,
    width: 400, height: 780,
    minWidth: 360, minHeight: 520,
    title: '拟人搜索助手',
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#F4F5F9'
  });
  popupWin.loadFile(path.join(SRC, 'popup.html'));
  popupWin.webContents.on('did-finish-load', () => {
    DBG.log('popup', 'did-finish-load', { url: popupWin.webContents.getURL() });
    setTimeout(() => probePopupChrome().catch(() => {}), 300);
  });
  popupWin.webContents.on('preload-error', (_e, p, err) => {
    DBG.log('popup', '⚠ preload 加载失败', { path: p, error: String(err && err.message || err) });
  });
  popupWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) DBG.log('popup-console', message, { line, source: sourceId });
  });
  popupWin.on('close', e => {
    if (quitting) return;
    if (tray) { e.preventDefault(); popupWin.hide(); governMemory('window:hide'); return; }
    // If the tray could not be initialized, do not hide an unrecoverable window.
    quitting = true;
    app.quit();
  });
  /* 托盘静默：窗口隐藏才进入低占用态，重新显示立即恢复。 */
  for (const ev of ['hide', 'minimize']) popupWin.on(ev, () => governMemory('window:' + ev));
  for (const ev of ['show', 'restore']) popupWin.on(ev, () => {
    governMemory('window:' + ev);
    /* v3.0 · 打开主界面时触发一次同步（popup 端共享判定会跳过运行中 / 60s 内重复） */
    broadcast('ui:opened', [{ at: Date.now() }]);
  });
  popupWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) openInSidePanel(url, 'user');
    return { action: 'deny' };
  });
  popupWin.on('resize', () => applyPanelBounds());
  popupWin.on('closed', () => { attachedViews.clear(); });
}

function createHost() {
  hostWin = makeWindow({
    icon: APP_ICON,
    width: 900, height: 620, show: false,
    title: 'background host',
    skipTaskbar: true
  });
  hostWin.loadFile(path.join(ROOT, 'host.html'));
  hostWin.webContents.on('did-finish-load', () => {
    // 二次保险：即使 preload 的 host:ready 信号因故没到，加载完也放行队列
    markHostReady();
    // 等 background.js 顶层注册完监听器再派发生命周期事件
    setTimeout(() => {
      const flag = path.join(USER(), 'installed.flag');
      const first = !fs.existsSync(flag);
      if (first) { try { fs.writeFileSync(flag, '1'); } catch {} }
      if (first) broadcast('runtime.onInstalled', [{ reason: 'install' }]);
      broadcast('runtime.onStartup', []);
    }, 400);
  });
}

function openRewardsLogin() {
  const tab = openInSidePanel('https://rewards.bing.com/dashboard', 'user');
  if (tab && Number.isInteger(tab.id)) loginTabIds.add(tab.id);
  // 打开时先复检一次，让徽标立刻进入「检测中」→ 实际的未登录/已登录
  sendToHost({ type: 'checkLogin' }).catch(() => {});
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '拟人搜索助手',
      submenu: [
        { label: '显示主界面', click: () => { popupWin && (popupWin.show(), popupWin.focus()); } },
        { label: '登录 Microsoft Rewards', click: openRewardsLogin },
        { type: 'separator' },
        { label: '退出', click: () => { quitting = true; app.quit(); } }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggledevtools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'resetZoom', label: '重置缩放' }
      ]
    }
  ]);
}

/* v1.3.8 Windows tray repair: packed Windows builds formerly excluded build/icon.png,
 * while the tray unconditionally read that file. Always package both icons; prefer
 * Windows ICO (multi-resolution) and fall back to PNG. Never silently hide a window
 * if Tray creation failed, otherwise closing X leaves an invisible orphan process. */
function showMainFromTray() {
  if (!popupWin || popupWin.isDestroyed()) { createPopup(); return; }
  if (typeof popupWin.isMinimized === 'function' && popupWin.isMinimized()) popupWin.restore();
  popupWin.show();
  popupWin.focus();
}
function createTray() {
  if (tray) return true;
  const files = process.platform === 'win32'
    ? ['icon.ico', 'icon.png'] : ['icon.png', 'icon.ico'];
  // Prefer real on-disk resources over virtual paths inside app.asar.
  const dirs = process.resourcesPath
    ? [path.join(process.resourcesPath, 'tray-icons'), path.join(ROOT, 'build')]
    : [path.join(ROOT, 'build')];
  for (const dir of dirs) for (const file of files) {
    const iconPath = path.join(dir, file);
    if (!fs.existsSync(iconPath)) continue;
    try {
      let img = nativeImage.createFromPath(iconPath);
      if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) continue;
      if (file === 'icon.png') img = img.resize({ width: 24, height: 24 });
      const candidate = new Tray(img);
      candidate.setToolTip('拟人搜索助手');
      candidate.setContextMenu(Menu.buildFromTemplate([
        { label: '打开主界面', click: showMainFromTray },
        { label: '退出', click: () => { quitting = true; app.quit(); } }
      ]));
      candidate.on('click', showMainFromTray);
      candidate.on('double-click', showMainFromTray);
      tray = candidate; // strong reference keeps the icon alive until app shutdown
      DBG.log('tray', '托盘已创建', { icon: iconPath });
      return true;
    } catch (err) {
      console.warn('[tray] 加载图标或创建托盘失败：' + iconPath, err.message);
    }
  }
  console.warn('[tray] 无法创建系统托盘；关闭窗口时将正常退出，不会隐藏成后台残留进程。');
  return false;
}

app.whenReady().then(() => {
  // 必须最先执行：makeWindow 的 session 参数、Cookie 监听、后台 fetch 都依赖它
  initAppSession();
  loadState();
  /* v2.6：静默完成任务与侧栏独立窗口均已移除；开机自启与系统登录项对齐（默认关闭）。 */
  if (typeof state.launchAtLogin !== 'boolean') state.launchAtLogin = false;
  try {
    if (typeof app.getLoginItemSettings === 'function' &&
        typeof app.setLoginItemSettings === 'function') {
      const sys = !!app.getLoginItemSettings().openAtLogin;
      const saved = state.launchAtLogin === true;
      if (sys !== saved) app.setLoginItemSettings({ openAtLogin: saved, openAsHidden: false });
    }
  } catch {}

  /* v1.1.3 · 清掉上次崩溃 / 强制退出遗留的运行态。
     截图里「状态标是就绪、按钮却卡在正在启动…」就是 storage.json 里
     running:true 没被复位，而 popup 的 uiStartAt / pendingStartUntil 只在
     下次 render 才会在 3 秒后翻过去 —— 心跳没到就永远不动。 */
  const stale = { running: !!state.running, phase: state.phase || null,
    hadError: !!state.error, lastActivity: state.lastActivity || null };
  state.running = false;
  state.phase = 'idle';
  state.stopRequested = false;
  state.error = null;
  state.lastActivity = Date.now();
  saveState();
  DBG.log('startup', '强制复位运行态', stale);
  DBG.snapshotStorage(state);

  DBG.setEnvironment({
    electron: process.versions.electron || (() => {
      try { return require('./package.json').devDependencies.electron; } catch { return 'unknown'; }
    })(),
    chromium: process.versions.chrome || null,
    node: process.versions.node,
    viewApi: VIEW_API,
    hasWebContentsView: !!WebContentsView,
    hasBrowserView: !!BrowserView,
    hasContentViewApi: !!(app && WebContentsView),
    appReady: typeof app.isReady === 'function' ? app.isReady() : null,
    sessionReady: !!getAppSession(),
    shimWindowCount: shimWindows.size,
    debugEnabled: DBG.enabled,
    sessionDir: DBG.sessionDir,
    stateKeys: Object.keys(state),
    ipcExpected: ['chrome:storage:get', 'chrome:storage:set', 'chrome:panel:show',
      'chrome:open:official', 'chrome:tabs:create', 'chrome:tabs:query',
      'chrome:scripting:executeScript', 'chrome:fetch', 'chrome:host:ready',
      'chrome:debug:log']
  });
  DBG.log('startup', '环境快照已写入', { electron: process.versions.electron, viewApi: VIEW_API });

  Menu.setApplicationMenu(buildMenu());
  createHost();
  createPopup();
  createTray();
  DBG.setEnvironment({ shimWindowCount: shimWindows.size,
    windowsCreated: { host: !!hostWin, popup: !!popupWin },
    sessionReadyAfterWindows: !!getAppSession() });
  DBG.log('startup', '窗口创建完成', { shimWindows: shimWindows.size,
    host: !!hostWin, popup: !!popupWin });

  /* 启动零抓取：初始化只渲染 storage 里已有的数据，不主动请求官网页面。
     积分与任务列表只在开始时同步、收尾同步时刷新。 */
  DBG.log('startup', '启动零抓取：不派发 refreshLogin / refreshPoints / refreshTasks');

  // 图标在 makeWindow 构造时已指定；这里再用 nativeImage 兜一次，兼容部分平台。
  for (const w of [hostWin, popupWin]) {
    if (!w || w.isDestroyed() || !fs.existsSync(APP_ICON)) continue;
    try { w.setIcon(nativeImage.createFromPath(APP_ICON)); } catch {}
  }

  /* 主进程不做轮询：界面重绘只由 storage.onChanged 驱动，防卡死靠后台流程
     自身超时 + 结果写回。唯一的周期定时器是托盘静默期的低频内存巡检
     （10 分钟、unref），活跃态与任务运行期都不存在。 */

  app.on('activate', () => {
    if (popupWin) { popupWin.show(); popupWin.focus(); }
    else createPopup();
    governMemory('app:activate');
  });
});

/* 必须在 app ready 之前注册。
   · 三个保活开关保证定时任务与离屏视图不被降频（业务流程依赖，不能删）。
   · 内存治理：给 V8 堆设上限，让渲染进程更积极回收；同时暴露 gc 供
     托盘静默态主动触发。降低常驻内存靠 memory-governor 销毁空闲视图，
     而不是削弱保活开关（那会让任务页面在后台加载不全）。 */
try {
  const switches = [
    'disable-background-timer-throttling',
    'disable-renderer-backgrounding',
    'disable-backgrounding-occluded-windows'
  ];
  for (const s of switches) if (E.app && typeof E.app.commandLine?.appendSwitch === 'function') E.app.commandLine.appendSwitch(s);
  if (E.app && typeof E.app.commandLine?.appendSwitch === 'function') {
    E.app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --expose-gc');
  }
} catch {}

// 桌面常驻：监听但从不调用 app.quit()，关闭所有窗口后由托盘 / 菜单退出
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  try { memoryGovernor.dispose(); } catch {}
  try { if (tray && typeof tray.destroy === 'function') tray.destroy(); tray = null; } catch {}
  for (const k of [...alarmTimers.keys()]) clearAlarm(k);
  for (const c of fetchControllers.values()) { try { c.abort && c.abort(); } catch {} }
  fetchControllers.clear();
  try { if (taskResultLoadWatcher) taskResultLoadWatcher.cancel(); } catch {}
  try { if (DBG && typeof DBG.close === 'function') DBG.close(); } catch {}
  try { stopDataViewSweep(); } catch {}
  flushStateSync();   // v2.9：把节流的尾随写强制落盘
});
