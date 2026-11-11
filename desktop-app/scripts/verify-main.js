#!/usr/bin/env node
/* ============================================================================
 * 主进程集成测试 —— 不需要 Electron 二进制，也不需要图形桌面。
 *
 * 用一个最小 Electron API 替身加载真实的 main.js，然后像 preload 那样调用
 * 各个 IPC handler，验证：窗口创建、storage 读写与广播、tabs 生命周期事件、
 * scripting / debugger / alarms / runtime 消息 / fetch 代理、启动生命周期事件。
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗ ' + msg + '\x1b[0m'); }
};
const group = (t, fn) => { console.log('\n\x1b[1m' + t + '\x1b[0m'); fn(); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-desktop-'));
let idSeq = 100;
const broadcasts = [];
const dispatches = [];

/* ------------------------------------------------------ Electron API 替身 */
function fakeWebContents(win) {
  let url = '';
  const handlers = new Map();
  const wc = {
    id: ++idSeq,
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => url,
    getTitle: () => 'test page',
    loadURL: u => { url = u; wc.emit('did-start-loading'); wc.emit('did-navigate', u); wc.emit('did-finish-load'); },
    reload: () => {},
    on: (ev, cb) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(cb); },
    emit: (ev, ...args) => { for (const cb of handlers.get(ev) || []) cb(...args); },
    send: (...args) => {
      if (args[0] === 'chrome:event') broadcasts.push(args[1]);
      if (args[0] === 'chrome:runtime:dispatch') dispatches.push(args[1]);
    },
    executeJavaScript: async () => 42,
    setWindowOpenHandler: () => {},
    openDevTools: () => {},
    goBack: () => {}, canGoBack: () => false,
    mainFrame: {
      isDestroyed: () => false,
      framesInSubtree: [],
      executeJavaScript: async () => 42
    },
    debugger: {
      isAttached: () => false,
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (method, params) => ({ method, params })
    },
    _setUrl: u => { url = u; wc.emit('did-start-loading'); wc.emit('did-finish-load'); wc.emit('did-navigate', u); },
    _win: win
  };
  return wc;
}

class FakeWindow {
  constructor(opts) {
    this.opts = opts || {};
    this.id = ++idSeq;
    this.wc = fakeWebContents(this);
    this.webContents = this.wc;
    this._handlers = new Map();
    this._views = [];
    this._w = this.opts.width || 400;
    this._h = this.opts.height || 780;
    this._focused = false;
    this._shown = this.opts.show !== false;
  }
  on(ev, cb) { if (!this._handlers.has(ev)) this._handlers.set(ev, []); this._handlers.get(ev).push(cb); }
  _emit(ev) { for (const cb of this._handlers.get(ev) || []) cb(); }
  // 真实 Electron 的 did-finish-load 是异步的，createHost 会先注册监听器再收到事件。
  // 同步 emit 会让监听器错过，hostReady 永不 resolve，消息门控测试就会误判。
  loadFile() { setTimeout(() => this.wc.emit('did-finish-load'), 0); }
  loadURL(u) { this.wc._setUrl(u); }
  getSize() { return [this._w, this._h]; }
  getContentSize() { return this.getSize(); }
  setSize(w, h) { this._w = w; this._h = h; this._emit('resize'); }
  addBrowserView(v) { if (!this._views.includes(v)) this._views.push(v); }
  removeBrowserView(v) { this._views = this._views.filter(x => x !== v); }
  getBrowserViews() { return this._views.slice(); }
  get contentView() {
    const self = this;
    return { addChildView: v => self.addBrowserView(v),
      removeChildView: v => self.removeBrowserView(v),
      get children() { return self.getBrowserViews(); } };
  }
  getTitle() { return 'test page'; }
  isFocused() { return this._focused; }
  isDestroyed() { return false; }
  show() { this._shown = true; }
  hide() { this._shown = false; }
  focus() { this._focused = true; this._emit('focus'); }
  destroy() { this._emit('closed'); }
}
FakeWindow.fromId = id => createdWindows.find(w => w.id === id) || null;
const createdWindows = [];

/* v1.0.9：BrowserView 替身。不是 BrowserWindow，不进 createdWindows，
   因此「启动只创建 host + popup 两个窗口」的断言依然成立。 */
class FakeBrowserView {
  constructor(opts) {
    this.opts = opts || {};
    const fakeWin = { id: ++idSeq };
    this.webContents = fakeWebContents(fakeWin);
    this._bounds = { x: 0, y: 0, width: 0, height: 0 };
  }
  setBounds(b) { this._bounds = Object.assign({}, b); }
  getBounds() { return Object.assign({}, this._bounds); }
}
const createdViews = [];

const ipcHandlers = new Map();
const ipcOn = new Map();
const ipcOnce = new Map();
const ipcMain = {
  handle: (ch, fn) => ipcHandlers.set(ch, fn),
  on: (ch, fn) => { if (!ipcOn.has(ch)) ipcOn.set(ch, []); ipcOn.get(ch).push(fn); },
  once: (ch, fn) => ipcOnce.set(ch, fn),
  removeListener: ch => ipcOnce.delete(ch),
  emitReply: (ch, value) => { const fn = ipcOnce.get(ch); if (fn) fn({}, value); }
};
const call = (ch, ...args) => {
  if (!ipcHandlers.has(ch)) throw new Error('未注册的 IPC: ' + ch);
  return ipcHandlers.get(ch)({}, ...args);
};

/* v1.0.7 真机行为回归：Electron 的 session.defaultSession 是「app ready 后」
   才能取的 getter，在模块顶层求值会抛
   `TypeError: Session can only be received when app is ready`。
   之前的替身把它做成普通对象，掩盖了这个 Windows 启动崩溃。这里严格模拟。 */
let electronReady = false;
let sessionReadsBeforeReady = 0;
let cookieChangedHandler = null;
const SHARED_SESSION = {
  cookies: {
    get: async () => [],
    on: (_ev, cb) => { cookieChangedHandler = cb; }
  }
};

const mockElectron = {
  app: {
    requestSingleInstanceLock: () => true,
    on: () => {},
    getPath: () => tmp,
    isReady: () => electronReady,
    whenReady: () => { electronReady = true; return Promise.resolve(); },
    quit: () => {}
  },
  BrowserWindow: FakeWindow,
  BrowserView: function (opts) {
    const v = new FakeBrowserView(opts); createdViews.push(v); return v;
  },
  WebContentsView: function (opts) {
    const v = new FakeBrowserView(opts); createdViews.push(v); return v;
  },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  ipcMain,
  net: {
    fetch: async (url) => ({
      ok: true, status: 200, url,
      headers: { entries: () => [['content-type', 'text/html']] },
      text: async () => '<html>"availablePoints":12345</html>'
    }),
    request: () => { throw new Error('不应走到 legacyRequest'); }
  },
  session: {
    get defaultSession() {
      if (!electronReady) {
        sessionReadsBeforeReady++;
        throw new TypeError('Session can only be received when app is ready');
      }
      return SHARED_SESSION;
    }
  },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return mockElectron;
  return origLoad.apply(this, arguments);
};
// 让 FakeWindow 记录实例
const OrigBW = FakeWindow;
mockElectron.BrowserWindow = new Proxy(OrigBW, {
  construct(target, args) { const w = Reflect.construct(target, args); createdWindows.push(w); return w; }
});

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'main.js'));

async function main() {
  await new Promise(r => setTimeout(r, 60));  // 等 whenReady().then() 执行

  group('1. 启动与窗口', () => {
    ck(createdWindows.length === 2, '启动时创建 host + popup 两个窗口');
    ck(fs.existsSync(tmp), 'userData 临时目录可用');
    ck(ipcHandlers.size >= 18, `注册 ${ipcHandlers.size} 个 IPC handler`);
    // v1.0.7：真 Electron 启动崩溃的回归断言。若 main.js 在模块顶层求值
    // session.defaultSession，require() 阶段就会抛错，本文件根本跑不到这里。
    ck(sessionReadsBeforeReady === 0,
       '模块加载阶段没有在 app ready 前读取 session.defaultSession（真机不崩溃）');
    ck(electronReady === true, 'app.whenReady() 已执行，会话已初始化');
    ck(typeof cookieChangedHandler === 'function',
       'Cookie changed 监听在会话就绪后才注册（initAppSession 内）');
    ck(createdWindows[0].opts.webPreferences.session === SHARED_SESSION &&
       createdWindows[1].opts.webPreferences.session === SHARED_SESSION,
       '窗口拿到的是 ready 后的同一个会话实例');
  });

  group('2. storage.local 读写与 onChanged 广播', async () => {});
  {
    const before = broadcasts.length;
    await call('chrome:storage:set', { phase: 'cooldown', running: true });
    const got = await call('chrome:storage:get', ['phase', 'running', 'missing']);
    ck(got.phase === 'cooldown' && got.running === true, 'set → get 读回写入的状态');
    ck(!('missing' in got), 'get 忽略不存在的键');
    const ev = broadcasts.slice(before).find(b => b.key === 'storage.onChanged');
    ck(!!ev, 'set 广播 storage.onChanged');
    ck(ev && ev.args[0].phase && ev.args[0].phase.newValue === 'cooldown', 'changes 含 newValue');
    const all = await call('chrome:storage:get', null);
    ck(all.phase === 'cooldown', 'get(null) 返回全部状态');
    ck(fs.existsSync(path.join(tmp, 'storage.json')), '状态落盘到 userData/storage.json');
    const b2 = broadcasts.length;
    await call('chrome:storage:set', { phase: 'cooldown' });
    ck(broadcasts.slice(b2).filter(x => x.key === 'storage.onChanged').length === 0,
       '写入相同值不产生多余广播');
  }

  group('3. tabs 生命周期与事件', () => {});
  {
    const tab = await call('chrome:tabs:create', { url: 'https://rewards.bing.com/earn', active: false });
    ck(tab && Number.isInteger(tab.id) && tab.url.includes('rewards.bing.com'), 'tabs.create 返回合法 Tab');
    const before = broadcasts.length;
    const tab2 = await call('chrome:tabs:update', tab.id, { url: 'https://www.bing.com/search?q=x' });
    const updated = broadcasts.slice(before).filter(b => b.key === 'tabs.onUpdated');
    ck(updated.length >= 1, '导航触发 tabs.onUpdated 广播');
    ck(updated.some(b => b.args[1].status === 'complete'), 'onUpdated 带 status=complete（waitForTab 依赖）');
    ck(tab2.url.includes('/search'), 'update(url) 后 tab.url 更新');
    const q = await call('chrome:tabs:query', { url: 'https://www.bing.com/*' });
    ck(q.length === 1 && q[0].id === tab.id, 'query 支持 Chrome match pattern 通配');
    const q2 = await call('chrome:tabs:query', { active: true });
    ck(Array.isArray(q2), 'query(active) 返回数组');
    const got = await call('chrome:tabs:get', tab.id);
    ck(got.id === tab.id && got.status === 'complete', 'tabs.get 返回完整 Tab');
  }

  group('4. scripting / debugger', () => {});
  {
    const tab = (await call('chrome:tabs:query', {}))[0];
    const list = await call('chrome:scripting:executeScript', {
      tabId: tab.id, funcSource: 'function f(a){ return a + 1; }', args: [41],
      allFrames: false, frameIds: null
    });
    ck(Array.isArray(list) && list.length === 1, 'executeScript 返回结果数组');
    ck(list[0].result === 42 && !list[0].error, '注入函数被执行并取回 result');
    const all = await call('chrome:scripting:executeScript', {
      tabId: tab.id, funcSource: '() => 1', args: [], allFrames: true, frameIds: null
    });
    ck(Array.isArray(all) && all[0].frameId > 0, 'allFrames 返回带 frameId 的结果');
    await call('chrome:debugger:attach', tab.id, '1.3');
    const cmd = await call('chrome:debugger:sendCommand', tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved' });
    ck(cmd.method === 'Input.dispatchMouseEvent', 'debugger.sendCommand 转发到 CDP');
    await call('chrome:debugger:detach', tab.id);
    ck(true, 'debugger.detach 正常返回');
  }

  group('5. alarms 与 runtime 消息', () => {});
  {
    const before = broadcasts.length;
    await call('chrome:alarms:create', 'immediate', { when: Date.now() - 1000 });
    await new Promise(r => setTimeout(r, 30));
    const fired = broadcasts.slice(before).filter(b => b.key === 'alarms.onAlarm');
    ck(fired.length >= 1 && fired[0].args[0].name === 'immediate', '过期 when 立即触发 onAlarm');
    await call('chrome:alarms:create', 'watchdog', { periodInMinutes: 0.5 });
    const rec = await call('chrome:alarms:get', 'watchdog');
    ck(rec && rec.scheduledTime > Date.now(), '周期 alarm 记录下次触发时间');
    await call('chrome:alarms:clear', 'watchdog');
    ck((await call('chrome:alarms:get', 'watchdog')) === null, 'clear 移除 alarm');

    const p = call('chrome:runtime:sendMessage', { type: 'start', count: 10 });
    // sendToHost 会先 await hostReady（异步门控），等一帧再取 dispatch 记录
    await new Promise(r => setTimeout(r, 10));
    const d = dispatches[dispatches.length - 1];
    ck(!!d && d.msg.type === 'start', 'popup 消息被转发给 host 窗口（门控已放行）');
    ipcMain.emitReply(d.replyChannel, { ok: true });
    const res = await p;
    ck(res && res.ok === true, 'host 的 sendResponse 回传给 popup 的 Promise');
  }

  group('6. fetch 会话代理', () => {});
  {
    const r = await call('chrome:fetch', 'https://rewards.bing.com/earn',
      { method: 'GET', credentials: 'include', headers: { 'Accept-Language': 'zh-CN' } }, 77);
    ck(r.ok === true && r.status === 200, '代理返回 ok/status');
    ck(r.body.includes('availablePoints'), '代理返回 HTML 正文供 parseBalance 解析');
    ck(r.url === 'https://rewards.bing.com/earn', '代理保留最终 URL');
    ck(r.error === null, '成功请求 error 为空');
  }

  group('7. 启动生命周期事件（onInstalled / onStartup）', () => {});
  {
    await new Promise(r => setTimeout(r, 480));
    const evs = broadcasts.map(b => b.key);
    ck(evs.includes('runtime.onInstalled'), '首次启动广播 runtime.onInstalled');
    ck(evs.includes('runtime.onStartup'), '每次启动广播 runtime.onStartup');
    ck(fs.existsSync(path.join(tmp, 'installed.flag')), '安装标记落盘（下次不再触发 onInstalled）');
    // 消息门控已解除：host 未就绪时排队的消息不会丢
    ck(typeof ipcHandlers.get('chrome:runtime:sendMessage') === 'function',
       'runtime.sendMessage handler 已注册');
  }

  // 清理临时目录
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  group('8. v1.0.9 右侧内嵌官网面板', () => {
    const winsBefore = createdWindows.length;
    const urlDash = 'https://rewards.bing.com/dashboard';
    const urlSearch = 'https://www.bing.com/search?q=hello';

    const t1 = call('chrome:tabs:create', { url: urlDash, active: true });
    const t2 = call('chrome:tabs:create', { url: urlSearch, active: false });
    const t3 = call('chrome:tabs:create', { url: 'https://rewards.bing.com/earn', active: true });
    ck(createdWindows.length === winsBefore,
       '登录 / 搜索 / 任务卡片都未新建独立 BrowserWindow');
    ck(t1.id === t2.id && t2.id === t3.id,
       '三次 tabs.create 复用同一个右侧面板 tabId（' + t1.id + '）');
    ck(createdViews.length >= 1, '主窗口挂上了视图（WebContentsView / BrowserView）');
    /* v1.1.2：Electron 45 走 contentView.addChildView，不是旧的 addBrowserView。
       这里断言真实挂载结果，而不是只做字符串检查。 */
    const popupFake = createdWindows.find(w => w.opts && w.opts.width === 400);
    ck(popupFake && popupFake.contentView && popupFake.contentView.children.length >= 1,
       '视图通过 win.contentView.addChildView 挂载（Electron 45 新 API）');
    ck(popupFake && popupFake.contentView.children.length === createdViews.length,
       '侧栏面板与两个后台数据视图都挂在同一主窗口的 contentView 上');

    const d1 = call('chrome:tabs:create', { url: urlDash, active: false, dataOnly: true });
    const d2 = call('chrome:tabs:create', { url: 'https://rewards.bing.com/earn', active: false, dataOnly: true });
    const d3 = call('chrome:tabs:create', { url: urlDash, active: false, dataOnly: true });
    ck(d1.id !== t1.id && d2.id !== t1.id, '后台读取用独立的不可见视图，不占用用户页面');
    ck(d1.id === d3.id && d1.id !== d2.id,
       '/dashboard 与 /earn 各一个常驻视图，同路径复用');
    const dataView = createdViews.find(v => v.webContents.id === d1.id);
    ck(dataView && dataView._bounds.width > 0 && dataView._bounds.x < 0,
       '数据视图有正常视口但位于窗口之外（DOM 可渲染、用户看不见）');

    const st = call('chrome:panel:state');
    ck(st.open === true && st.tabId === t1.id, '面板状态为展开');
    const sideView = createdViews.find(v => v.webContents.id === t1.id);
    ck(sideView && sideView._bounds.x === 400 && sideView._bounds.width > 0,
       '右侧面板 bounds 从 x=400 开始，宽度大于 0（' + JSON.stringify(sideView && sideView._bounds) + '）');
    ck(broadcasts.some(b => b.key === 'ui:panel' && b.args[0] && b.args[0].open),
       '广播 ui:panel 让弹窗同步按钮状态');

    const hidden = call('chrome:panel:hide');
    ck(hidden.open === false && sideView._bounds.width === 0,
       '收起时面板宽度归零');
    call('chrome:panel:toggle');
    const toggledState = call('chrome:panel:state');
    ck(toggledState.open === true && toggledState.reason === 'user',
       '面板按钮 toggle 可重新展开，原因标为手动');

    call('chrome:panel:hide');
    call('chrome:storage:set', { running: true });
    ck(call('chrome:panel:state').open === true &&
       call('chrome:panel:state').reason === 'run',
       'storage.running=true 自动展开（reason=run）');
    call('chrome:storage:set', { running: false });
    ck(call('chrome:panel:state').open === false,
       '运行结束自动收起右侧面板');

    call('chrome:panel:show', urlDash);
    call('chrome:storage:set', { running: false });
    ck(call('chrome:panel:state').open === true,
       '用户手动展开的面板不会被后台运行结束收走');
  });

  console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('验证异常:', err); process.exit(1); });
