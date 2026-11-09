/* ============================================================================
 * Chromium 兼容运行时（Linux 产出专用）
 *
 * 当构建环境无法下载 Electron 二进制时，用它把 main.js 需要的 Electron API
 * 映射到 Playwright / Chromium CDP 上。main.js 只改了一行「运行时选择」，
 * src/ 下插件源码仍然零改动；在真正的 Electron 环境里依旧优先用 Electron。
 *
 * 实现要点：
 *   BrowserWindow      → BrowserContext + Page
 *   webContents        → Page（事件 / 注入 / CDP / 消息广播）
 *   ipcMain            → Node 侧 handler 表，页面经 exposeFunction 调用
 *   preload.js         → 原样作为 addInitScript 注入，只把 require('electron')
 *                        替换成等价的 contextBridge / ipcRenderer 垫片
 *   net.fetch          → Node 20 全局 fetch（无 CORS，带手工 Cookie）
 *   session.cookies    → 各 BrowserContext 的 cookie jar
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');

function loadChromium() {
  const env = process.env.HSA_CHROMIUM;
  const candidates = [
    env,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/opt/chromium/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/usr/bin/chrome'
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.statSync(c).isFile() || fs.statSync(c).isSymbolicLink()) return c; } catch {} }
  try { return cp.execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(); } catch {}
  try { return cp.execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim(); } catch {}
  throw new Error('未找到 Chromium。请设置 HSA_CHROMIUM=/path/to/chrome 或安装 Chromium。');
}

function loadPlaywright() {
  const candidates = [
    path.join(ROOT, 'vendor/node_modules/playwright'),
    path.join(ROOT, 'node_modules/playwright'),
    'playwright',
    '/usr/local/lib/node_modules/playwright'
  ];
  let last;
  for (const c of candidates) { try { return require(c); } catch (e) { last = e; } }
  throw new Error('未找到 playwright：' + (last && last.message));
}

const { chromium } = loadPlaywright();
const headless = process.env.HSA_HEADLESS === '1' || !process.env.DISPLAY;
const args = ['--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check'];
if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
if (process.env.HSA_CHROME_ARGS) args.push(...process.env.HSA_CHROME_ARGS.split(/\s+/).filter(Boolean));

let browser = null;
let sharedCtx = null;
const contexts = new Set();
const wins = new Map();
const views = new Map();        // BrowserView / WebContentsView 的 page（E2E 用）
let seq = 100;

const ready = chromium.launch({
  executablePath: loadChromium(),
  headless,
  args
}).then(async b => {
  browser = b;
  // 一个共享上下文 = 一个 Chromium 窗口，多个页面 = 多个标签页。
  // 桌面模式下 host 作为后台标签页，popup 置前，语义最接近扩展。
  sharedCtx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  contexts.add(sharedCtx);
  await sharedCtx.exposeFunction('__hsaInvoke', (ch, args) => ipcMain.invoke(ch, ...(args || [])));
  await sharedCtx.addInitScript(INIT_SCRIPT);
  return b;
}).catch(err => {
  console.error('[chromium-lite] 启动失败：' + err.message);
  throw err;
});

/* ------------------------------------------------------------- IPC handler 表 */
const handlers = new Map();
const ipcMain = {
  handle: (ch, fn) => handlers.set(ch, fn),
  on: (ch, fn) => handlers.set(ch, fn),
  once: (ch, fn) => handlers.set(ch, (...args) => { handlers.delete(ch); return fn(...args); }),
  removeListener: ch => handlers.delete(ch),
  invoke: (ch, ...args) => {
    const h = handlers.get(ch);
    if (!h) return Promise.reject(new Error('未注册的 IPC: ' + ch));
    try { return Promise.resolve(h({}, ...args)); }
    catch (e) { return Promise.reject(e); }
  }
};

/* ------------------------------------------------------- 注入脚本（复用 preload.js） */
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
  .replace(/^const \{ contextBridge, ipcRenderer \} = require\('electron'\);\s*$/m, '');

const INIT_SCRIPT = `
window.__hsaOnMap = {};
window.__hsaOn = (ch, cb) => { window.__hsaOnMap[ch] = cb; };
window.__hsaDispatch = (ch, payload) => {
  const cb = window.__hsaOnMap[ch];
  if (typeof cb === 'function') { try { cb(null, payload); } catch (e) { console.error(e); } }
};
const contextBridge = { exposeInMainWorld: (k, v) => { window[k] = v; } };
const ipcRenderer = {
  invoke: (ch, ...args) => window.__hsaInvoke(ch, args),
  send:   (ch, ...args) => window.__hsaInvoke(ch, args),
  on:     (ch, cb) => window.__hsaOn(ch, cb)
};
` + PRELOAD_SRC;

/* ------------------------------------------------------------- frame / debugger */
let frameSeq = 1000;
const frameIds = new WeakMap();
const idOf = f => { if (!frameIds.has(f)) frameIds.set(f, ++frameSeq); return frameIds.get(f); };

class LiteFrame {
  constructor(frame) { this.frame = frame; }
  isDestroyed() { return this.frame.isDetached ? this.frame.isDetached() : false; }
  executeJavaScript(code) { return this.frame.evaluate(code); }
  get frameId() { return idOf(this); }
}

class LiteDebugger {
  constructor(wc) { this.wc = wc; this.attached = false; this.cdp = null; }
  isAttached() { return this.attached; }
  async attach() {
    this.cdp = this.cdp || await this.wc.win.ctx.newCDPSession(this.wc.page);
    this.attached = true;
  }
  async detach() { this.attached = false; }
  async sendCommand(method, params) {
    this.cdp = this.cdp || await this.wc.win.ctx.newCDPSession(this.wc.page);
    return await this.cdp.send(method, params || {});
  }
}

class LiteWebContents {
  constructor(win) {
    this.win = win;
    this.id = win.id;
    this._ev = new Map();
    this._url = '';
    this._title = '';
    this._destroyed = false;
    this._pagePromise = null;
    this.debugger = new LiteDebugger(this);
    this.mainFrame = {
      isDestroyed: () => false,
      get framesInSubtree() {
        return win.page ? win.page.frames().map(f => new LiteFrame(f)) : [];
      },
      executeJavaScript: code => win.page ? win.page.evaluate(code) : Promise.resolve(null)
    };
  }
  on(ev, cb) { if (!this._ev.has(ev)) this._ev.set(ev, []); this._ev.get(ev).push(cb); }
  emit(ev, ...args) { for (const cb of this._ev.get(ev) || []) { try { cb(null, ...args); } catch (e) { console.error('[lite] event error', e); } } }
  isDestroyed() { return this._destroyed; }
  isLoading() { return false; }
  getURL() { return this._url; }
  getTitle() { return this._title || ''; }
  canGoBack() { return true; }
  goBack() { return this.win.page ? this.win.page.goBack().catch(() => {}) : Promise.resolve(); }
  executeJavaScript(code) { return this.win.page ? this.win.page.evaluate(code) : Promise.resolve(null); }
  openDevTools() {}
  setWindowOpenHandler(fn) { this.win._popupHandler = fn; }
  send(channel, payload) {
    const p = this.win.page;
    if (!p || p.isClosed()) return;
    p.evaluate(
      ({ c, d }) => { if (window.__hsaDispatch) window.__hsaDispatch(c, d); },
      { c: channel, d: payload }
    ).catch(() => {});
  }
}

class LiteWindow {
  constructor(opts) {
    this.opts = opts || {};
    this.id = ++seq;
    this._ev = new Map();
    this._focused = false;
    this._shown = this.opts.show !== false;
    this._popupHandler = null;
    this._views = [];
    this._w = this.opts.width || 400;
    this._h = this.opts.height || 780;
    this.page = null;
    this.ctx = null;
    this.webContents = new LiteWebContents(this);
    wins.set(this.id, this);

    this._init = ready.then(async () => {
      this.ctx = sharedCtx;
      const size = [this.opts.width || 400, this.opts.height || 780];
      const page = await sharedCtx.newPage();
      await page.setViewportSize({ width: size[0], height: size[1] }).catch(() => {});
      this.page = page;
      this.webContents.page = page;

      page.on('load', () => {
        this.webContents._url = page.url();
        this._title = this.opts.title || '';
        this.webContents.emit('did-finish-load');
      });
      page.on('framenavigated', f => {
        if (f === page.mainFrame()) {
          this.webContents._url = f.url();
          this.webContents.emit('did-navigate', f.url());
        }
      });
      page.on('close', () => {
        this.webContents._destroyed = true;
        wins.delete(this.id);
        this._emit('closed');
        this.webContents.emit('destroyed');
      });
      page.on('popup', async popup => {
        const url = popup.url() || '';
        if (this._popupHandler) {
          const r = this._popupHandler({ url });
          if (r && r.action === 'deny') { try { await popup.close(); } catch {} }
        } else { try { await popup.close(); } catch {} }
      });
      if (this._pendingUrl) await this._goto(this._pendingUrl);
      if (this._shown) await page.bringToFront().catch(() => {});
      return page;
    }).catch(err => { console.error('[chromium-lite] 窗口初始化失败：' + err.message); });
  }
  on(ev, cb) { if (!this._ev.has(ev)) this._ev.set(ev, []); this._ev.get(ev).push(cb); }
  _emit(ev, arg) { for (const cb of this._ev.get(ev) || []) { try { cb(arg); } catch {} } }
  async _goto(url) {
    if (!this.page) { this._pendingUrl = url; return; }
    this._pendingUrl = null;
    this.webContents.emit('did-start-loading');
    this.webContents._url = url;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    this.webContents.emit('did-navigate', url);
    this.webContents.emit('did-finish-load');
  }
  loadURL(url) {
    // main.js 不会 await，tabInfo 会立刻读 getURL()：先同步写入 URL
    this.webContents._url = url;
    this.webContents.emit('did-start-loading');
    return this._init.then(() => this._goto(url));
  }
  loadFile(file) { return this.loadURL('file://' + path.resolve(file)); }
  getSize() { return [this._w || this.opts.width || 400, this._h || this.opts.height || 780]; }
  /* v1.0.9：主窗口右侧内嵌 BrowserView 需要的窗口级 API */
  getContentSize() { return this.getSize(); }
  setSize(w, h) { this._w = w; this._h = h; this._emit('resize'); }
  setContentSize(w, h) { this.setSize(w, h); }
  addBrowserView(v) { if (!this._views) this._views = []; if (!this._views.includes(v)) this._views.push(v); }
  removeBrowserView(v) { if (this._views) this._views = this._views.filter(x => x !== v); }
  getBrowserViews() { return (this._views || []).slice(); }
  /* v1.1.2：Electron 45 的 WebContentsView 挂载入口 */
  get contentView() {
    const self = this;
    return {
      addChildView(v) { self.addBrowserView(v); },
      removeChildView(v) { self.removeBrowserView(v); },
      get children() { return self.getBrowserViews(); }
    };
  }
  getTitle() { return this._title || this.opts.title || ''; }
  isFocused() { return this._focused; }
  isDestroyed() { return this.webContents._destroyed; }
  show() { this._shown = true; if (this.page) this.page.bringToFront().catch(() => {}); }
  hide() { this._shown = false; }
  focus() { this._focused = true; this.show(); this._emit('focus'); }
  destroy() { if (this.page && !this.page.isClosed()) this.page.close().catch(() => {}); }
}

LiteWindow.fromId = id => wins.get(Number(id)) || null;

/* v1.0.9 · BrowserView 轻量替身：与主窗口共享同一进程/会话，
   不创建独立 Playwright page（无头验证里官方页面不会被真实加载）。
   webContents 仍具备 loadURL / getURL / executeJavaScript / did-navigate，
   足以让 main.js 的 tabs、tabs.onUpdated、scripting 注入链路完整跑通。 */
class LiteBrowserView {
  constructor(opts) {
    this.opts = opts || {};
    const fakeWin = { id: ++seq, page: null, ctx: null,
      _ev: new Map(), _popupHandler: null };
    this.webContents = new LiteWebContents(fakeWin);
    this.webContents.id = fakeWin.id;
    this._bounds = { x: 0, y: 0, width: 0, height: 0 };
    this._page = null;
    this._pendingUrl = null;
    const wc = this.webContents;

    /* HSA_E2E=1：BrowserView 变成真正的 Chromium 页面。
       端到端测试用 context.route 拦截 rewards.bing.com，返回仿真官网 HTML，
       于是 loadURL / did-finish-load / executeJavaScript(注入读 DOM) 全部真跑，
       不再是「只改 url 字符串」的假实现 —— 这才能验证「官网已登录却读不到积分」。 */
    if (process.env.HSA_E2E === '1') {
      this._init = ready.then(async () => {
        const page = await sharedCtx.newPage();
        await page.setViewportSize({ width: 1180, height: 820 }).catch(() => {});
        fakeWin.page = page;              // LiteWebContents.mainFrame.executeJavaScript 靠它
        fakeWin.ctx = sharedCtx;
        this._page = page;
        views.set(fakeWin.id, this);   // 供 e2e 按 tabId 精确定位侧栏页面
        page.on('load', () => {
          wc._url = page.url();
          wc.emit('did-finish-load');
        });
        page.on('framenavigated', f => {
          if (f === page.mainFrame()) { wc._url = f.url(); wc.emit('did-navigate', f.url()); }
        });
        if (this._pendingUrl) await this._goto(this._pendingUrl);
        return page;
      });
      wc.loadURL = url => {
        wc._url = String(url);
        wc.emit('did-start-loading');
        if (!this._page) { this._pendingUrl = wc._url; return this._init; }
        return this._goto(wc._url);
      };
      wc.reload = () => this._page ? this._page.reload().catch(() => {}) : Promise.resolve();
    } else {
      wc.loadURL = url => {
        wc._url = String(url);
        wc.emit('did-start-loading');
        wc.emit('did-navigate', wc._url);
        wc.emit('did-finish-load');
        return Promise.resolve();
      };
      wc.reload = () => Promise.resolve();
    }
  }
  async _goto(url) {
    if (!this._page) { this._pendingUrl = url; return; }
    this._pendingUrl = null;
    const wc = this.webContents;
    wc._url = url;
    wc.emit('did-start-loading');
    try {
      await this._page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      wc._url = this._page.url();
      wc.emit('did-navigate', wc._url);
      wc.emit('did-finish-load');
    } catch (err) {
      wc.emit('did-finish-load');   // 即使失败也放行，避免后台等待卡死
    }
  }
  setBounds(b) { this._bounds = Object.assign({}, b); }
  getBounds() { return Object.assign({}, this._bounds); }
}

/* ------------------------------------------------------------- 其余 Electron API */
const userData = () => process.env.HSA_USER_DATA ||
  path.join(os.homedir(), '.config', 'human-search-assistant-desktop');

/* v1.3.8：无头验证替身也提供登录项 API，保证 IPC 在 CI 里可测 */
let liteLoginItemOpenAtLogin = false;
const app = {
  setLoginItemSettings: settings => {
    liteLoginItemOpenAtLogin = !!(settings && settings.openAtLogin);
  },
  getLoginItemSettings: () => ({ openAtLogin: liteLoginItemOpenAtLogin }),
  requestSingleInstanceLock: () => true,
  on: () => {},
  getPath: () => { const d = userData(); try { fs.mkdirSync(d, { recursive: true }); } catch {} return d; },
  whenReady: () => ready.then(() => {}),
  quit: () => { try { browser && browser.close(); } catch {} process.exit(0); }
};

const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} };
const Tray = class { setToolTip() {} setContextMenu() {} on() {} };
const nativeImage = { createFromPath: () => ({ resize: () => ({}) }) };

const net = {
  fetch: async (url, opts) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      return await globalThis.fetch(url, {
        method: (opts && opts.method) || 'GET',
        headers: (opts && opts.headers) || {},
        body: opts && opts.body,
        redirect: 'follow',
        signal: ctrl.signal
      });
    } finally { clearTimeout(timer); }
  },
  request: () => { throw new Error('legacyRequest 在 Chromium 运行时下不需要'); }
};

const session = {
  defaultSession: {
    cookies: {
      get: async ({ url } = {}) => {
        const out = [];
        for (const ctx of contexts) {
          try { for (const c of await ctx.cookies(url ? [url] : [])) out.push({ name: c.name, value: c.value }); }
          catch {}
        }
        return out;
      }
    }
  }
};

module.exports = { app, BrowserWindow: LiteWindow,
  BrowserView: LiteBrowserView, WebContentsView: LiteBrowserView,
  Tray, Menu, ipcMain, net, session, nativeImage };
module.exports._pages = () => [...wins.values()].map(w => ({
  id: w.id, url: w.webContents._url, page: w.page, ctx: w.ctx
}));
/* 端到端测试用：拿到共享 BrowserContext，以便 context.route() 拦截官网请求。 */
module.exports._onReady = () => ready.then(() => sharedCtx);
/** 按 sideTabId 拿到 BrowserView 的真实 Playwright 页面（e2e 断言用） */
module.exports._viewPage = id => {
  const v = views.get(Number(id));
  return v ? v._page : null;
};
module.exports._debug = () => ({
  windows: [...wins.values()].map(w => ({
    id: w.id, url: w.webContents._url, hasPage: !!w.page,
    title: w.getTitle()
  })),
  contextCount: contexts.size,
  handlerCount: handlers.size,
  headless,
  chromium: loadChromium()
});
