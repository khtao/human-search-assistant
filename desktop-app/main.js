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
const { DebugCapture } = require('./lib/debug-capture');
/* v1.1.6：调试默认禁用，仅命令行 `npm run start:debug`（HSA_DEBUG=1）开启。
   默认关闭可避免生产运行时持续的 HTML 落盘与 I/O。 */
const DBG = new DebugCapture();
const C = require('./lib/core');

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
function saveState() {
  try {
    fs.mkdirSync(USER(), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) { console.error('[storage] 写入失败:', err.message); }
}

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
  // v1.0.9：运行时展开右侧官网面板，结束自动收起；手动展开的面板不自动收。
  if (Object.prototype.hasOwnProperty.call(patch, 'running')) {
    try {
      if (patch.running === true) {
        if (!sideVisible) showSidePanel(null, 'run', false);
      } else if (patch.running === false && panelReason === 'run') {
        hideSidePanel();
      }
    } catch (err) { console.warn('[panel] 自动显隐失败:', err.message); }
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

/** net.fetch 不可用时的最小回退（旧版 Electron）。 */
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
  // 用 Promise.race 实现超时/取消，不依赖 net.fetch 是否支持 signal 选项
  const ctl = { reject: null, aborted: false };
  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const e = new Error('timed out'); e.name = 'AbortError'; reject(e);
    }, timeoutMs);
    ctl.reject = () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    };
  });
  fetchControllers.set(id, ctl);
  // 整个请求（含 cookie 读取）都放进 work，由同一个 guard 统一兜底。
  // 旧版只 race 了 net.fetch，若 cookieHeaderFor 挂起或 IPC 无响应，
  // handler 永不返回，AbortController 也无从取消 —— 登录探测就会卡死。
  const work = (async () => {
    const headers = Object.assign({}, init.headers || {});
    const cookie = await cookieHeaderFor(url);
    if (cookie && !headers.Cookie && !headers.cookie) headers.Cookie = cookie;
    const opts = { method: init.method || 'GET', headers, body: init.body || undefined };
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
    fetchControllers.delete(id);
  }
});
ipcMain.on('chrome:fetch:abort', (_e, id) => {
  const c = fetchControllers.get(id);
  if (c && !c.aborted) {
    c.aborted = true;
    try { c.reject && c.reject(); } catch {}
  }
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
let sideTabId = null;
let sideVisible = false;
let panelReason = null;            // 'user' | 'run' | null
/* v1.3.3 · 用户主动点登录徽标 / 面板按钮时，给主进程一个短暂保护窗口：
   这期间侧栏的导航、登录页 DOM、Cookie 变更都不得写任何业务键，
   否则「单击开关侧栏 / 双击打开主页」会把 20,192 分清成 null、图标变灰。 */
let userPanelActionUntil = 0;
function notePanelAction() { userPanelActionUntil = Date.now() + 6000; }
function panelActionActive() { return Date.now() < userPanelActionUntil; }
let collapsedSize = null;
const attachedViews = new Set();
const dataViews = new Map();       // 'dash' | 'earn' -> { view, entry, id, lastNav }

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
    // 旧版在这里是空的 catch{}，真机挂载失败时侧栏永远不出现、点登录「没反应」
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

function ensureSideView() {
  if (sideView) return sideView;
  sideView = new ViewClass(embeddedViewPrefs());
  attachView(sideView);
  sideView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
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
    /* 用户要求：保留登录网页的 html 文件。侧栏每次导航完成都存一份，
       无论停在 Rewards 首页还是 Microsoft 登录页。 */
    try {
      const html = await sideView.webContents.executeJavaScript(
        'document.documentElement.outerHTML', true);
      DBG.captureHtml('side-panel', u, html, { source: 'visible-panel' });
      /* 等 SPA 把积分/任务卡渲染出来再推快照（did-finish-load 常早于 React 挂载） */
      setTimeout(() => pushVisibleSnapshot('panel-loaded').catch(() => {}), 900);
    } catch (err) { DBG.log('panel', '侧栏 HTML 读取失败', { error: String(err.message || err) }); }
    /* v1.3.3：导航到 Microsoft 授权 / 登录页**不是**登出信号。
       官网 302、OAuth 授权跳转、/earn 返回登录页 DOM 都会命中 isLoginPageUrl，
       旧版因此把已登录的 20,192 分写成 null、图标翻灰 —— 正是「点击登录按键
       却把积分设成 null」的根因。只保留 URL 里明确带 logout/signout 的动作，
       不把 Cookie 删除本身当作登出依据，避免认证票据轮换误清积分。 */
    if (/(?:\/logout|signout)/i.test(u)) markSignedOut('logout-url');
    /* v1.3.3：登录页信号在「导航完成的那一刻」就记下。
       旧版只靠 900ms 后的 DOM 快照置位，若 900ms 内已跳回 Rewards，
       快照读到的是新 URL，loginPageSeen 永远不置位 → 登录后不派发统一同步，
       积分与任务列表迟迟不更新。这里只记信号，不判登出（见上段注释）。 */
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
<<<<<<< HEAD
const TASK_CLICK_SETTLE_MS = 350;   // 索引定位后给 Rewards 页面留出短暂响应时间
=======
const TASK_CLICK_SETTLE_MS = 350;
const TASK_PAGE_READY_WAIT_MS = 5000; // R4: wait after each page is loaded before scrolling
const TASK_SCAN_STEP_DELAY_MS = 520;  // R4: at least 12 slow scan steps = 6240ms   // 索引定位后给 Rewards 页面留出短暂响应时间
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
let taskView = null, taskTabId = null, taskResultView = null, taskClickRunning = false;
let taskResultLoadPromise = null, taskResultLoadWatcher = null;

function ensureTaskResultView() {
  if (taskResultView) return taskResultView;
  taskResultView = new ViewClass(embeddedViewPrefs());
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
  taskView = new ViewClass(embeddedViewPrefs());
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
<<<<<<< HEAD
    const all = () => [...document.querySelectorAll('a,button,[role="button"],[data-bi-id]')];
=======
    /* HSA_TASK_LOCATOR_REPAIR_20261109: include offer-id/test-id cards but require strong identity evidence. */
    const all = () => [...document.querySelectorAll('a,button,[role="button"],[data-bi-id],[data-offer-id],[data-testid]')];
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
    const find = () => {
      const nodes = all(); let best = null, bestScore = 0;
      const wantHref = expectedHref ? abs(expectedHref) : '';
      const wantTitle = norm(expectedTitle);
<<<<<<< HEAD
      for (const el of nodes) {
        const tx = clean(el).slice(0, 500);
        const href = el.tagName === 'A' ? abs(el.getAttribute('href') || '') : '';
        let score = 0;
=======
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
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
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
<<<<<<< HEAD
        if (score > bestScore) { best = el; bestScore = score; }
=======
         if (score > bestScore || (score === bestScore && best && el.contains(best))) {
           best = el; bestScore = score;
         }
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
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
  applyPanelBounds();
  if (url) {
    // 徽标 / 可领取卡片 / 菜单显式传入 URL：一定要有可见反馈。
    // 旧版仅在「URL 不同」时才导航，面板已展开且停在同一地址时点击
    // 毫无变化 —— 这正是「未确认按键点击没反应」的第二个原因。
    panelReason = 'user';           // 锁为手动，运行结束不自动收走
    sideView.webContents.loadURL(url);
    popupWin.show();
    popupWin.focus();   // 仅显式用户动作激活窗口
    /* 不再调用侧栏视图自身的 focus()：它会把焦点从官网登录页的
       账号/密码 iframe 拉回顶层 frame，正是「输入困难」的直接原因。 */
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
    const view = new ViewClass(embeddedViewPrefs());
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
      const u = view.webContents.getURL();
      try {
        const html = await view.webContents.executeJavaScript('document.documentElement.outerHTML', true);
        DBG.captureHtml('data-view-' + key, u, html, { source: 'background-data-view' });
      } catch (err) { DBG.log('data-view', key + ' HTML 读取失败', { error: String(err.message || err) }); }
    });
    d = { view, entry, id, lastNav: 0 };
    dataViews.set(key, d);
  }
  const wc = d.view.webContents;
  const now = Date.now();
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
  if (url) win.loadURL(url);
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

<<<<<<< HEAD
=======
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

>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
ipcMain.handle('chrome:task:clickAll', async (_event, clickIndex, options) => {
  if (taskClickRunning) return { ok: false, reason: 'busy' };
  taskClickRunning = true;
  const pages = [];
  let totalClicked = 0, totalOpened = 0, totalFailed = 0, totalScanned = 0, totalUnconfirmed = 0;
  let debuggerAttachedHere = false;
<<<<<<< HEAD
  let tv = null, dbg = null;
  try {
    const index = clickIndex && clickIndex.schemaVersion === 1 ? clickIndex : null;
    if (!index || !Array.isArray(index.items)) {
      return { ok: false, reason: 'task-click-index-missing', pages, clicked: 0, failed: 1 };
    }
    if (!Number.isFinite(index.updatedAt) || Date.now() - index.updatedAt > 30 * 60 * 1000) {
      return { ok: false, reason: 'task-click-index-stale', pages, clicked: 0, failed: 1 };
    }
    const indexedEntries = index.items.filter(x => x && (x.page === '/dashboard' || x.page === '/earn'));
    const skipCompletedCards = !!(options && options.skipCompletedCards);
=======
  let lastPhysicalClickAt = 0;
  let tv = null, dbg = null;
  try {
    const index = clickIndex && clickIndex.schemaVersion === 1 ? clickIndex : null;
    const indexFresh = !!(index && Array.isArray(index.items) && Number.isFinite(index.updatedAt)
      && Date.now() - index.updatedAt <= 30 * 60 * 1000);
    const indexedEntries = indexFresh ? index.items.filter(x => x &&
      (x.page === '/dashboard' || x.page === '/earn')) : [];
    const skipCompletedCards = !!(options && options.skipCompletedCards);
    const intervalRaw = Number(options && options.cardClickIntervalSec != null ? options.cardClickIntervalSec : NaN);
    const cardClickIntervalMs = (Number.isFinite(intervalRaw)
      ? Math.min(60, Math.max(1, Math.round(intervalRaw))) : 10) * 1000;
    // Count actual CDP mouse actions rather than time spent locating cards.
    const waitClickSpacing = async () => {
      while (lastPhysicalClickAt && state.running) {
        const remain = cardClickIntervalMs - (Date.now() - lastPhysicalClickAt);
        if (remain <= 0) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(remain, 300)));
      }
      return !!state.running;
    };
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
    // Match the browser extension: default=false clicks all scored cards;
    // enabling the setting filters completed cards at the last responsible moment.
    const entries = indexedEntries.filter(x => !skipCompletedCards || !x.completed);
    const skippedCompleted = indexedEntries.length - entries.length;
<<<<<<< HEAD
    if (!entries.length) {
      return { ok: true, reason: 'no-pending-indexed-tasks', pages, clicked: 0, scanned: 0, opened: 0, failed: 0, skipped: skippedCompleted };
    }
=======
    /* HSA_TASK_LOCATOR_REPAIR_20261109: an empty RSC index does not imply the real page has no clickable task cards. */
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf

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
    DBG.log('task', '任务卡片点击开始：消费同步阶段 taskClickIndex，不再全页扫描', {
      indexCount: entries.length, source: index.source || 'sync-index',
      method: 'indexed locator + CDP Input.dispatchMouseEvent'
    });

    for (const pageDef of [
      { page: '/dashboard', url: 'https://rewards.bing.com/dashboard' },
      { page: '/earn', url: 'https://rewards.bing.com/earn' }
    ]) {
      if (!state.running) break;
<<<<<<< HEAD
      const pageEntries = entries.filter(x => x.page === pageDef.page);
      if (!pageEntries.length) continue;
=======
      let pageEntries = entries.filter(x => x.page === pageDef.page);
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
      desktopActivityPush({
        state: 'opening', page: pageDef.url,
        zh: '打开页面 · Rewards ' + pageDef.page + ' · 待点击 ' + pageEntries.length + ' 张卡片',
        en: 'Opening · Rewards ' + pageDef.page + ' · ' + pageEntries.length + ' cards to click'
      });
      await loadTaskPage(tv, pageDef.url);
<<<<<<< HEAD
=======
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
      DBG.log('task', '同步索引和实时 DOM 合并', {page:pageDef.page, live:live.length, total:pageEntries.length});
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
      const page = {
        url: pageDef.url, found: pageEntries.length, clicked: 0,
        opened: 0, skipped: 0, failed: 0, source: 'sync-index'
      };
      totalScanned += pageEntries.length;

      for (const entry of pageEntries) {
        if (!state.running) break;
        let aim = null;
        try {
<<<<<<< HEAD
          for (let locateRound = 0; locateRound < 6 && (!aim || !aim.ok); locateRound++) {
            if (locateRound > 0) {
              const y = await tv.webContents.executeJavaScript('Math.min((window.scrollY || 0) + Math.max(240, Math.round((window.innerHeight || 800) * 0.72)), (document.scrollingElement || document.documentElement).scrollHeight)', true);
              await tv.webContents.executeJavaScript('window.scrollTo(0, ' + Math.max(0, Number(y) || 0) + ')', true);
              await new Promise(resolve => setTimeout(resolve, 220));
            }
            aim = await tv.webContents.executeJavaScript(taskAimIndexedSrc(entry), true);
          }
=======
          aim = await locateIndexedCardAcrossScroll(tv.webContents, entry);
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
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

<<<<<<< HEAD
=======
        if (!(await waitClickSpacing())) break;
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
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
<<<<<<< HEAD
=======
          // Timestamp corresponds to the beginning of the CDP mouse action.
          lastPhysicalClickAt = Date.now();
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
          await dispatchTaskMouseClick(dbg, aim.x, aim.y);
          page.clicked++;
          totalClicked++;
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (err) {
          if (samePageWatcher) samePageWatcher.cancel();
          page.failed++;
          totalFailed++;
          DBG.log('task', 'CDP 索引鼠标点击失败', {
            name: entry.name, x: aim.x, y: aim.y,
            error: String(err && err.message || err)
          });
          continue;
        }

        if (taskResultLoadPromise) {
          if (samePageWatcher) samePageWatcher.cancel();
          const opened = await taskResultLoadPromise;
          if (opened && opened.ok) {
            page.opened++;
            totalOpened++;
          } else {
            totalUnconfirmed++;
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
            totalUnconfirmed++;
            await new Promise(resolve => setTimeout(resolve, TASK_CLICK_SETTLE_MS));
          }
        } else {
          totalUnconfirmed++;
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
      opened: totalOpened, failed: totalFailed, skipped: skippedCompleted, clickUnconfirmed: totalUnconfirmed, method: 'sync-index + CDP Input.dispatchMouseEvent'
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
  return openInSidePanel(url || 'https://rewards.bing.com/dashboard', 'user');
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

/* v1.3.1 · 官网侧栏快照只做「后台取数的数据源」，不再直接写业务键。
   旧版在这里把 pointsSummary / todayTasks / loginStatus 写回，而可见面板
   只认 +N 文本卡（/dashboard 每日活动），会把后台两页解析出的完整任务列表
   覆盖成「只有每日活动」，还会因 /earn 单页登录文案把已登录判成未登录。
   现在登录完成跳回 Rewards 时只发一条 syncRewards 消息，由后台
   desktopSyncRewards 走与「点击自动完成任务 / 手动刷新」完全相同的逻辑，
   一次抓取、一次原子写回。 */
async function pushVisibleSnapshot(reason) {
  const r = await readVisibleNow();
  if (!r || !r.html) return null;
  const snap = {
    at: Date.now(), url: r.url, text: r.text || '',
    html: String(r.html || ''),
    points: r.points || {}, cards: Array.isArray(r.cards) ? r.cards : [],
    signedIn: !!r.signedIn, signedOut: !!r.signedOut,
    reason: reason || 'panel-loaded'
  };
  const isEarn = r.pageKind === 'earn' ||
    /\/earn(?:\/|[?#]|$)/i.test(String(r.url || ''));
  snap.pageKind = isEarn ? 'earn' : 'dashboard';
  const patch = { [isEarn ? 'visibleRewardsEarnSnapshot' : 'visibleRewardsSnapshot']: snap };

  /* v1.3.2 · 用户要求「点击登录按键不要刷新积分和登录状态」：
     · 点徽标 / 面板按钮展开官网 → 只保存 DOM 快照作为数据源，不发任何同步
     · 只有「用户真的完成登录、从 Microsoft 登录页跳回 Rewards」才同步一次
     · 运行态（running / 搜索中）一律不派发：搜索中间不做任何积分同步
     同步仍由后台 desktopSyncRewards 一次抓取、一次原子写回（同一套逻辑）。 */
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

/* --------------------------------------------------------------------------
 * 会话同步：登录 Cookie 一写入就通知后台复检，不用等 30 秒轮询。
 * Windows 真 Electron 里 Cookie 异步落盘，旧版只有「导航回 Rewards」才复检，
 * 用户停在登录页或登录完没跳转时，徽标与积分会一直停在「未确认 / —」。
 * ------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------
 * v1.1.6 · 官网登录时输入框反复失焦的根因
 * 后台 refreshLogin / refreshPoints 会走 chrome.tabs.update(active) 与
 * chrome.windows.update(focused)，主进程对应 handler 里无条件 BrowserWindow.focus()；
 * 登录页（login.live.com）在输入过程中不断重定向、Cookie 不断变化，于是每来一次
 * 同步就把焦点从账号/密码输入框抢走，表现为「输入困难」。
 * 修法：自动路径统一走 safeAutoFocus()，侧栏停在登录域名时一律不抢焦点；
 * 用户显式动作（托盘 / 菜单 / 点徽标）仍正常激活窗口。
 * ------------------------------------------------------------------------ */
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
/* v1.3.8：静默完成任务。只在「用户手动开启 + 自动运行期间」生效；
   默认关闭时完全不改变原有可见行为。 */
function desktopSilentRun() {
  return !!(state && state.silentRun === true && desktopQuietRun());
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
  const nextPoints = Object.assign({}, prevPoints, {
    available: null, signedOut: true, updatedAt: now
  });
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

/* --------------------------------------------------------------------------
 * host 消息队列：host 页面要加载 250KB 的 background.js，真 Electron 冷启动
 * （尤其 Windows）常超过 5 秒。旧版等 5 秒就硬发，消息落到还没
 * 注册 chrome:runtime:dispatch 的窗口就永久丢失 —— 弹窗与后台从此不同步。
 * 现在未就绪时排队，host 明确回报 ready 后按序 flush。
 * ------------------------------------------------------------------------ */
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
 * 8. 窗口、托盘、菜单与生命周期
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
    if (tray) { e.preventDefault(); popupWin.hide(); return; }
    // If the tray could not be initialized, do not hide an unrecoverable window.
    quitting = true;
    app.quit();
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
  /* v1.3.8：静默完成任务默认关闭；开机自启与系统登录项对齐（默认关闭）。 */
  if (typeof state.silentRun !== 'boolean') state.silentRun = false;
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

  /* v1.1.8 · 启动零抓取
     旧版启动 1.8 秒后无条件派发 refreshLogin / refreshPoints / refreshTasks，
     未登录时也会反复请求 /dashboard 与 /earn（用户提交的登录页现场即由此产生）。
     现在初始化只渲染 storage 里已有的数据，不主动请求任何官网页面；
     积分与任务列表只在「点击开始自动完成任务」和「每轮搜索完成后」刷新。 */
  DBG.log('startup', 'v1.1.8 启动零抓取：不派发 refreshLogin / refreshPoints / refreshTasks');

  /* ------------------------------------------------------------------------
   * v1.0.4 卡死根因（保留结论）：popup 失焦时渲染进程定时器被节流到分钟级，
   * 自愈逻辑失效。v1.1.8 起自愈改由后台流程超时 + storage 结果写回事件承担，
   * UI 不再依赖任何渲染进程周期定时器；三类后台节流开关继续兜底。
   * ---------------------------------------------------------------------- */
  // 图标在 makeWindow 构造时已通过 APP_ICON 指定；这里再用 nativeImage 兜一次，
  // 兼容部分平台上 BrowserWindow 构造参数不生效的情况。
  for (const w of [hostWin, popupWin]) {
    if (!w || w.isDestroyed() || !fs.existsSync(APP_ICON)) continue;
    try { w.setIcon(nativeImage.createFromPath(APP_ICON)); } catch {}
  }

  /* v1.1.8 · 禁止任何监控：主进程不再有任何 setInterval。
     旧版曾有 1 秒 UI 心跳 → 30 秒静默积分监控 → 5 秒状态看门狗，本轮全部删除。
     空闲（尤其未登录）时：零定时器、零官网请求、零界面刷新。
     防卡死改由「后台流程自身的超时 + storage 结果写回事件」承担：
     点击开始后无论成功/失败/全完成都会写 autoResult / running，popup 通过
     storage.onChanged 立即重绘，不再需要主进程轮询复位。 */

  app.on('activate', () => {
    if (popupWin) { popupWin.show(); popupWin.focus(); }
    else createPopup();
  });
});

/* 必须在 app ready 之前注册：彻底关闭三类窗口失焦节流。
   backgroundThrottling:false 只覆盖 webPreferences，遮挡窗口仍会被 Chromium
   降频，这里从进程开关层面兜住。 */
try {
  const switches = [
    'disable-background-timer-throttling',
    'disable-renderer-backgrounding',
    'disable-backgrounding-occluded-windows'
  ];
  for (const s of switches) if (E.app && typeof E.app.commandLine?.appendSwitch === 'function') E.app.commandLine.appendSwitch(s);
} catch {}

// 桌面常驻：监听但从不调用 app.quit()，关闭所有窗口后由托盘 / 菜单退出
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  try { if (tray && typeof tray.destroy === 'function') tray.destroy(); tray = null; } catch {}
  for (const k of [...alarmTimers.keys()]) clearAlarm(k);
  try { if (taskResultLoadWatcher) taskResultLoadWatcher.cancel(); } catch {}
  try { if (DBG && typeof DBG.close === 'function') DBG.close(); } catch {}
  saveState();
});
