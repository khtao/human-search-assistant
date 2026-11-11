/* v2.4 桌面版四项需求专项：node --test tests/round3.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CSS = read('desktop-app/src/popup.css');
const HTML = read('desktop-app/src/popup.html');
const POP = read('desktop-app/src/popup.js');
const MAIN = read('desktop-app/main.js');
const PRE = read('desktop-app/preload.js');
const EXT_CSS = read('edge-extension/popup.css');

test('R1 · 黑色积分卡悬浮框与插件版一致且始终最上层', () => {
  const tipAt = CSS.indexOf('.tip {');
  const tip = CSS.slice(tipAt, tipAt + 400);
  assert.match(tip, /z-index: 2147483647/);
  assert.doesNotMatch(tip, /z-index: 30\b/);
  const extTip = EXT_CSS.slice(EXT_CSS.indexOf('.tip {'), EXT_CSS.indexOf('.tip {') + 400);
  assert.match(extTip, /z-index: 2147483647/);
  const hoverAt = CSS.indexOf('.point-card:hover,');
  const hover = CSS.slice(hoverAt, hoverAt + 320);
  assert.match(hover, /position: relative/);
  assert.match(hover, /z-index: 2147483647/);
  assert.match(read('shared/hsa-hover-tip.js'), /documentElement\.appendChild\(tip\)/);
  assert.match(read('shared/hsa-shared.css'), /z-index: 2147483647 !important/);
  assert.match(POP, /HSA_HOVER_TIP\.install\(document\)/);
});

test('R2 · 静默完成与独立窗口两个开关均已移除，桌面设置只剩开机自启', () => {
  for (const [name, src] of [['popup.html', HTML], ['popup.js', POP]]) {
    assert.doesNotMatch(src, /set-silent-run/, name + ' 仍残留静默控件');
    assert.doesNotMatch(src, /desktop\.silent/, name + ' 仍残留静默文案');
    for (const pat of [/set-sidebar-window/, /desktop\.sidebarWindow/,
      /sidebarWindow/, /setSidebarWindow/]) {
      assert.doesNotMatch(src, pat, name + ' 仍残留独立窗口 ' + pat);
    }
  }
  assert.doesNotMatch(POP, /silentRun/);
  assert.match(MAIN, /function desktopSilentRun\(\)[\s\S]{0,220}return false/);
  assert.match(HTML, /id="set-auto-launch"/);
  assert.match(POP, /const auto = \$\('set-auto-launch'\);/);
  assert.doesNotMatch(POP, /setSidebarWindow|sidebarWindow/);
});

test('R3 · 主界面与设置共用唯一滚动条，侧栏独立滚动', () => {
  assert.match(HTML, /<body>\s*<!--[\s\S]{0,120}-->\s*<div id="scroll-root">\s*<div class="app" id="main">/);
  assert.match(HTML, /<\/section>\s*<\/div><!-- \/#scroll-root -->/);
  assert.ok(HTML.indexOf('id="settings"') < HTML.indexOf('/#scroll-root'),
    '设置必须落在共享滚动容器里');
  assert.match(CSS, /body \{[\s\S]{0,400}overflow: hidden/);
  assert.match(CSS, /#scroll-root \{[\s\S]{0,260}overflow-y: auto/);
  assert.match(CSS, /overscroll-behavior: contain/);
  assert.match(CSS, /body\.panel-open #scroll-root/);
  assert.match(CSS, /\.settings \{[\s\S]{0,260}position: relative/);
  assert.match(CSS, /\.settings\.open \{\s*display: flex/);
  assert.match(CSS, /body\.settings-open \.app \{ display: none; \}/);
  const bodyAt = CSS.indexOf('.settings-body {');
  const bodyBlock = CSS.slice(bodyAt, bodyAt + 300);
  assert.match(bodyBlock, /overflow: visible/);
  assert.doesNotMatch(bodyBlock, /overflow-y: auto/);
  for (const tag of ['function openSettings()', 'function closeSettings()']) {
    const at = POP.indexOf(tag);
    assert.match(POP.slice(at, at + 420), /scroll-root[\s\S]{0,120}scrollTop = 0/);
  }
});

test('R4 · 独立窗口设置与功能已移除，侧栏固定内嵌', () => {
  const srcs = { preload: PRE, main: MAIN, popup: POP, html: HTML };
  for (const [name, src] of Object.entries(srcs)) {
    for (const pat of [/'chrome:app:sidebarWindow'/, /setSidebarWindow/,
      /getSidebarWindow/, /sidebarWindowEnabled/, /sidebarWin\b/,
      /openDetachedSidebar/, /closeDetachedSidebar/, /sidebarDetachedOpen/,
      /set-sidebar-window/, /desktop\.sidebarWindow/, /sidebarWindow: v/]) {
      assert.doesNotMatch(src, pat, name + ' 仍残留 ' + pat);
    }
  }
  /* 侧栏恢复为内嵌：展开时放大主窗口、显式动作抢回焦点、正常 bounds */
  assert.match(MAIN, /function showSidePanel\(url, reason, active\)[\s\S]{0,1400}popupWin\.setSize\(COLLAPSED_WIDTH \+ PANEL_DEFAULT_RIGHT/);
  assert.match(MAIN, /popupWin\.focus\(\);   \/\/ 仅显式用户动作激活窗口/);
  assert.match(MAIN, /sideView\.setBounds\(\{ x: PANEL_LEFT, y: 0, width: Math\.max\(0, cw - PANEL_LEFT\), height: ch \}\)/);
  assert.match(MAIN, /function panelState\(\)[\s\S]{0,240}url: sideView \? sideView\.webContents\.getURL\(\) : null\s*\}/);
  assert.doesNotMatch(MAIN, /function hideSidePanel\(\)[\s\S]{0,120}closeDetachedSidebar/);
  assert.match(CSS, /#scroll-root \{[\s\S]{0,220}overflow-y: auto/);
  assert.match(CSS, /overscroll-behavior: contain/);
});
