#!/usr/bin/env node
/* ============================================================================
 * v1.0.5 专项：运行时一致性 + Windows 状态同步链路
 *
 * 用最小 Electron 替身加载真实 main.js，但故意让 host 的 did-finish-load
 * 不自动触发，以复现「真 Electron 冷启动慢 → 消息排队 → ready 后按序 flush」。
 * 全程走生产运行时分支（HSA_HEADLESS 未设置），require('electron') 被替身注入。
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-sync-'));
process.env.HSA_USER_DATA = tmp;
delete process.env.HSA_HEADLESS;

let idSeq = 100;
let cookieChanged = null;
let menuTemplate = [];
const menuTemplates = [];
const broadcasts = [];
const dispatches = [];
const sessions = [];
const created = [];

function fakeWC(win) {
  let url = '';
  const handlers = new Map();
  const wc = {
    id: ++idSeq,
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => url,
    getTitle: () => 'test',
    loadURL: u => { url = u; wc.emit('did-start-loading'); wc.emit('did-navigate', u); wc.emit('did-finish-load'); },
    reload: () => {},
    on: (ev, cb) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(cb); },
    once: (ev, cb) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(cb); },
    emit: (ev, ...a) => { for (const cb of [...(handlers.get(ev) || [])]) cb(...a); },
    send: (...a) => {
      if (a[0] === 'chrome:event') broadcasts.push(a[1]);
      if (a[0] === 'chrome:runtime:dispatch') dispatches.push(a[1]);
    },
    executeJavaScript: async () => ({}),
    setWindowOpenHandler: () => {},
    mainFrame: { isDestroyed: () => false, framesInSubtree: [], executeJavaScript: async () => ({}) },
    debugger: { isAttached: () => false, attach: async () => {}, detach: async () => {}, sendCommand: async (m, p) => ({ method: m, params: p }) },
    _setUrl: u => { url = u; wc.emit('did-start-loading'); wc.emit('did-navigate', u); wc.emit('did-finish-load'); },
    _win: win
  };
  return wc;
}

class FakeWindow {
  constructor(opts) {
    this.opts = opts || {};
    this.id = ++idSeq;
    this.webContents = fakeWC(this);
    this._h = new Map();
    this._views = [];
    this._w = 400;
    this._height = 780;
    this._focused = false;
    sessions.push(this.opts.webPreferences && this.opts.webPreferences.session);
  }
  on(ev, cb) { if (!this._h.has(ev)) this._h.set(ev, []); this._h.get(ev).push(cb); }
  _emit(ev) { for (const cb of [...(this._h.get(ev) || [])]) cb(); }
  loadFile() {}                       // 关键：不自动 emit did-finish-load
  loadURL(u) { this.webContents._setUrl(u); }
  getSize() { return [this._w, this._height]; }
  getContentSize() { return this.getSize(); }
  setSize(w, h) { this._w = w; this._height = h; this._emit('resize'); }
  addBrowserView(v) { if (!this._views.includes(v)) this._views.push(v); }
  removeBrowserView(v) { this._views = this._views.filter(x => x !== v); }
  getBrowserViews() { return this._views.slice(); }
  get contentView() {
    const self = this;
    return { addChildView: v => self.addBrowserView(v),
      removeChildView: v => self.removeBrowserView(v),
      get children() { return self.getBrowserViews(); } };
  }
  getTitle() { return 'test'; }
  isFocused() { return this._focused; }
  isDestroyed() { return false; }
  show() {} hide() {}
  focus() { this._focused = true; this._emit('focus'); }
  setIcon() {}
  destroy() { this._emit('closed'); }
}
FakeWindow.fromId = id => created.find(w => w.id === id) || null;

/* v1.0.9：BrowserView 替身，不进 created（启动仍只有两个 BrowserWindow） */
class FakeBrowserView {
  constructor(opts) {
    this.opts = opts || {};
    this.webContents = fakeWC({ id: ++idSeq });
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
  removeListener: ch => ipcOnce.delete(ch)
};
const call = (ch, ...a) => {
  if (!ipcHandlers.has(ch)) throw new Error('未注册 IPC: ' + ch);
  return ipcHandlers.get(ch)({}, ...a);
};

const SHARED_SESSION = {
  cookies: {
    get: async () => [],
    on: (_ev, cb) => { cookieChanged = cb; }
  }
};
/* 与真 Electron 一致：ready 前访问 defaultSession 必须抛错。
   若 main.js 顶层求值，require 阶段就会失败，本测试立刻暴露。 */
let electronReady = false;
let sessionReadsBeforeReady = 0;
const mock = {
  app: {
    requestSingleInstanceLock: () => true,
    on: () => {},
    getPath: () => tmp,
    isReady: () => electronReady,
    whenReady: () => { electronReady = true; return Promise.resolve(); },
    quit: () => {},
    commandLine: { appendSwitch: () => {} }
  },
  BrowserWindow: new Proxy(FakeWindow, {
    construct(t, a) { const w = Reflect.construct(t, a); created.push(w); return w; }
  }),
  BrowserView: function (opts) { const v = new FakeBrowserView(opts); createdViews.push(v); return v; },
  WebContentsView: function (opts) { const v = new FakeBrowserView(opts); createdViews.push(v); return v; },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} },
  Menu: { buildFromTemplate: t => { menuTemplate = t; menuTemplates.push(t); return {}; }, setApplicationMenu: () => {} },
  ipcMain,
  net: {
    fetch: async url => ({ ok: true, status: 200, url, headers: { entries: () => [] }, text: async () => '' }),
    request: () => { throw new Error('unexpected legacyRequest'); }
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
Module._load = function (req) {
  if (req === 'electron') return mock;
  return origLoad.apply(this, arguments);
};
require(path.join(__dirname, '..', 'main.js'));

async function main() {
  await sleep(80);
  group('1. 运行时与会话一致性');
  ck(sessionReadsBeforeReady === 0,
     'v1.0.7 回归：模块加载阶段未在 app ready 前读取 session.defaultSession');
  ck(electronReady === true, 'app.whenReady() 已执行，会话已初始化');
  ck(created.length === 2, '启动创建 host + popup 两个窗口');
  ck(sessions.length >= 2 && sessions[0] === SHARED_SESSION && sessions[1] === SHARED_SESSION,
     'host 与 popup 显式绑定同一个 session.defaultSession（登录 Cookie 可共享）');
  ck(typeof cookieChanged === 'function', '主进程注册了 Cookie changed 监听');

  group('2. host 未就绪时消息排队（旧版 5 秒后硬发会丢）');
  const before = dispatches.length;
  const beforeProbe = before;
  call('chrome:runtime:sendMessage', { type: '__queued_1' });
  call('chrome:runtime:sendMessage', { type: '__queued_2' });

  // 关键回归：旧版 waitHost(5000) 到 5 秒就硬发，真 Electron（Windows）
  // 冷启动加载 250KB background.js 常超过 5 秒，消息因此永久丢失。
  // 这里故意等 5.6 秒，验证新队列在超时点之后仍稳稳留住消息。
  await sleep(5600);
  ck(dispatches.length === before, 'host 冷启动 5.6 秒仍未 ready，消息依旧排队（旧版此刻已丢失）');
  ck(dispatches.length === beforeProbe, '队列内仍有 2 条待发消息，未提前投递');

  group('3. host 回报 ready 后按序 flush');
  const readyFns = ipcOn.get('chrome:host:ready') || [];
  ck(readyFns.length > 0, '主进程注册了 chrome:host:ready 监听');
  readyFns[0]();
  await sleep(60);
  const flushed = dispatches.slice(before).map(d => d.msg && d.msg.type);
  ck(flushed.includes('__queued_1') && flushed.includes('__queued_2'),
     '排队的两条消息按序送达 host：' + JSON.stringify(flushed));

  group('4. ready 后新消息直接送达');
  const b2 = dispatches.length;
  call('chrome:runtime:sendMessage', { type: '__direct' });
  await sleep(40);
  ck(dispatches.slice(b2).some(d => d.msg && d.msg.type === '__direct'),
     'ready 后不再入队，直接 dispatch');

  group('5. v1.1.8 · Cookie 新增/变更零抓取');
  const b3 = dispatches.length, s3 = broadcasts.length;
  cookieChanged({}, { domain: '.bing.com', name: 'MUID', value: 'x' }, 'explicit', false);
  await sleep(50);
  const types = dispatches.slice(b3).map(d => d.msg && d.msg.type);
  ck(!types.includes('refreshLogin') && !types.includes('refreshPoints') && !types.includes('refreshTasks'),
     '普通 Cookie 变更不派发任何抓取消息：' + JSON.stringify(types));
  ck(!broadcasts.slice(s3).some(b => b.key === 'ui:sync' || b.key === 'ui:tick'),
     '不再广播 ui:sync / ui:tick 专用刷新界面事件');

  group('5b. 认证 Cookie 删除 → 即时登出（用户动作，不是监控）');
  const s3b = broadcasts.length;
  cookieChanged({}, { domain: '.live.com', name: 'WLID', value: '' }, 'explicit', true);
  await sleep(50);
  ck(broadcasts.slice(s3b).some(b => b.key === 'storage.onChanged'),
     '登出写回 loginStatus / pointsSummary / todayTasks 并经 storage.onChanged 重绘一次');
  ck(!broadcasts.slice(s3b).some(b => b.key === 'ui:tick'),
     '登出也不发专用刷新事件（storage.onChanged 已足够）');

  group('6. v1.1.8 · popup 切回焦点零抓取');
  const b4 = dispatches.length, s4 = broadcasts.length;
  created[1].focus();
  await sleep(50);
  ck(!dispatches.slice(b4).some(d => d.msg && d.msg.type === 'refreshLogin'),
     '窗口 focus 不再触发登录态复检');
  ck(!broadcasts.slice(s4).some(b => b.key === 'ui:sync'), '窗口 focus 不广播任何同步事件');

  group('7. 登录窗口导航回 Rewards 触发同步');
  const loginItem = (function find(items) {
    for (const it of items || []) {
      if (it && /登录 Microsoft Rewards/.test(it.label || '') && typeof it.click === 'function') return it;
      if (it && Array.isArray(it.submenu)) { const r = find(it.submenu); if (r) return r; }
    }
    return null;
  })(menuTemplates.find(t => JSON.stringify(t).includes('登录 Microsoft Rewards')) || menuTemplate);
  ck(!!loginItem, '应用菜单提供「登录 Microsoft Rewards」入口');
  const trayFlat = (function flat(items) {
    return (items || []).reduce((a, it) => a.concat([it.label || it.role || ''], it && Array.isArray(it.submenu) ? flat(it.submenu) : []), []);
  })(menuTemplate).filter(Boolean);
  ck(trayFlat.length === 2 && trayFlat.includes('打开主界面') && trayFlat.includes('退出'),
     '托盘菜单只保留「打开主界面」和「退出」：' + JSON.stringify(trayFlat));
  ck(!JSON.stringify(menuTemplate).includes('导出调试现场包'), '托盘菜单不含调试入口');
  if (loginItem) {
    const b5 = dispatches.length;
    loginItem.click();
    const win = created[created.length - 1];
    win.webContents.emit('did-navigate', null, 'https://rewards.bing.com/dashboard');
    await sleep(60);
    ck(!dispatches.slice(b5).some(d => d.msg && ['refreshLogin','refreshPoints','refreshTasks'].includes(d.msg.type)),
       'v1.1.8 导航回 Rewards 不派发抓取（由侧栏 DOM 快照事件写回）');
  }

  console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
