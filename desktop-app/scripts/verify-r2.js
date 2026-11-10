/** v1.3.8-R2: Windows system tray and Edge card-identity regressions; no Electron installation needed. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const ext = fs.readFileSync(path.join(root, '../edge-extension/background.js'), 'utf8');
const config = fs.readFileSync(path.join(root, 'electron-builder.win.yml'), 'utf8');
assert(/\n  - build\/icon\.ico\n/.test(config), 'Windows ICO must be packaged');
assert(/\n  - build\/icon\.png\n/.test(config), 'Windows PNG tray fallback must be packaged');
assert(config.includes('to: tray-icons/icon.ico') && config.includes('to: tray-icons/icon.png'),
  'Both tray icons must also be copied outside asar for native Windows Tray');
assert(main.includes('if (tray) { e.preventDefault(); popupWin.hide(); return; }'), 'Close-to-tray only when tray exists');
assert(main.includes("if (file === 'icon.png') img = img.resize"), 'PNG tray icon is explicitly resized');
const trayBlock = main.slice(main.indexOf('function showMainFromTray()'), main.indexOf('\napp.whenReady().then', main.indexOf('function showMainFromTray()')));
assert(trayBlock.includes('new Tray(img)'), 'Tray creation code must be in package');
function trayMock(files, shouldThrow = false, pathLib = path) {
  const opened = [];
  const handlers = {};
  const fakeWin = { isDestroyed: () => false, isMinimized: () => true,
    restore: () => opened.push('restore'), show: () => opened.push('show'), focus: () => opened.push('focus') };
  const context = { tray: null, popupWin: fakeWin, ROOT: root, process: { platform:'win32', resourcesPath: pathLib.join(root, 'resources-for-test') },
    path: pathLib, fs: { existsSync: file => files.some(x => file.endsWith(x)) },
    nativeImage: { createFromPath: file => ({ file, isEmpty: () => false, resize() { return this; } }) },
    Tray: function(img) { if (shouldThrow) throw Error('no notification area');
      this.img = img; this.setToolTip = () => {}; this.setContextMenu = x => { this.menu = x; };
      this.on = (event, handler) => { handlers[event] = handler; };
    }, Menu: { buildFromTemplate: x => x },
    DBG: { log: () => {} }, console: { warn: () => {} }, quitting: false,
    app: { quit: () => {} }, createPopup: () => opened.push('create') };
  vm.createContext(context);
  vm.runInContext(trayBlock+'\nthis.createTray=createTray;this.showMainFromTray=showMainFromTray;', context);
  return { context, opened, handlers };
}
{
  const { context, opened, handlers } = trayMock(['icon.png','icon.ico']);
  assert.strictEqual(context.createTray(), true);
  assert(context.tray.img.file.endsWith(path.join('tray-icons', 'icon.ico')),
    'Windows must prefer unpacked ICO');
  assert.deepStrictEqual([...context.tray.menu.map(x => x.label)], ['打开主界面', '退出']);
  handlers['click']();
  assert.deepStrictEqual(opened, ['restore','show','focus']);
  assert.strictEqual(context.createTray(), true, 'Tray must not be created twice');
}
// A Linux test runner must also exercise Windows-style backslash paths.
// A literal 'tray-icons/icon.ico' suffix incorrectly rejects valid Windows paths.
{
  const { context } = trayMock(['icon.png', 'icon.ico'], false, path.win32);
  assert.strictEqual(context.createTray(), true);
  assert(context.tray.img.file.endsWith(path.win32.join('tray-icons', 'icon.ico')),
    'Windows backslash path must select the unpacked ICO');
}
{
  const { context } = trayMock(['icon.png']);
  assert.strictEqual(context.createTray(), true);
  assert(context.tray.img.file.endsWith('icon.png'), 'PNG must be used when ICO is unavailable');
}
assert.strictEqual(trayMock([]).context.createTray(), false, 'Cannot hide window without tray assets');
assert.strictEqual(trayMock(['icon.ico'], true).context.createTray(), false, 'Cannot hide window if Tray creation throws');
const a = ext.indexOf('function hsaMergeLiveTaskCards(');
const b = ext.indexOf('\nconst humanClickTasksV136Original', a);
assert(a > 0 && b > a);
const merger = { Set, Map, Number, Array, String };
vm.createContext(merger);
vm.runInContext(ext.slice(a,b)+'\nthis.merge=hsaMergeLiveTaskCards;', merger);
const cards = [
  { idx:'yb-id:offer-alpha|p:10', title:'同名奖励', points:10, href:'' },
  { idx:'yb-id:offer-beta|p:10', title:'同名奖励', points:10, href:'' },
  { idx:'yb-id:offer-gamma|p:10', title:'同名奖励', points:10, href:'' },
];
let merged = merger.merge([], cards, '/earn');
assert.strictEqual(merged.length,3, 'Three different offers with the same title must not collapse');
merged = merger.merge([{ name:'同名奖励',points:10,locator:{dataOfferId:'offer-beta'} }], cards, '/earn');
assert.strictEqual(merged.length,3, 'Known offer ID must deduplicate only that one card');
merged = merger.merge([{ name:'同名奖励',points:10,locator:{} }], cards, '/earn');
assert.strictEqual(merged.length,3, 'Unidentified index may consume only one same-title card');
const hrefCards = [
  { idx:'one', title:'奖励',points:5,href:'https://www.bing.com/search?q=first' },
  { idx:'two', title:'奖励',points:5,href:'https://www.bing.com/search?q=second' }
];
assert.strictEqual(merger.merge([],hrefCards,'/dashboard').length,2, 'Same title but different hrefs remain distinct');
assert.strictEqual(merger.merge([{name:'奖励',points:5,url:hrefCards[0].href}],hrefCards,'/dashboard').length,2,
  'Existing URL is deduplicated and another URL remains');
assert(ext.includes('let supplementalScans = 0;') && ext.includes('点击后新发现'),
  'Task loop must re-scan once after last click');
assert(ext.includes('var taskLinkPoints = function (el, href)') && ext.includes('var badgePoints = function (el)'),
  'Card collector must recognize points badges and plain numeric task points');
console.log('PASS v1.3.8-R2: packaged tray icons, ICO/PNG fallback, safe close, distinct offer IDs, URL dedupe, post-click scan');
