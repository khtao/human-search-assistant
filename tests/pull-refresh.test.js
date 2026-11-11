/* v2.5 下拉刷新 / 悬浮框专项：node --test tests/pull-refresh.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PTR = require('../shared/hsa-pull-refresh.js');
const CORE = require('../shared/hsa-core.js');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

function mockDom(scrollTop) {
  const doc = new EventTarget();
  doc.scrollingElement = { scrollTop: Number(scrollTop) || 0 };
  doc.documentElement = {};
  const wrapEl = { style: {} };
  doc.getElementById = id => (id === 'main' ? wrapEl : null);
  const win = new EventTarget();
  const textEl = { textContent: '' };
  const indicator = {
    dataset: {},
    classList: {
      items: new Set(),
      toggle(cls, on) { if (on) this.items.add(cls); else this.items.delete(cls); }
    },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    querySelector() { return textEl; }
  };
  return { doc, win, indicator, textEl, wrapEl };
}

test('v2.5 · decide 纯逻辑：仅顶部下拉生效，带阻尼 / 阈值 /  armed 状态', () => {
  assert.equal(PTR.VERSION, '1.0.0');
  const base = { startY: 100, currentY: 240, scrollTop: 0 };
  const d = PTR.decide(base);
  assert.equal(d.active, true);
  assert.equal(d.pull, 70);             // 140px 拖动 × 0.5 阻尼
  assert.equal(d.armed, true);          // ≥ 64px 阈值
  assert.equal(d.progress, 1);
  const small = PTR.decide({ startY: 100, currentY: 150, scrollTop: 0 });
  assert.equal(small.pull, 25);
  assert.equal(small.armed, false);
  assert.ok(small.progress > 0 && small.progress < 1);
  /* 未到顶部 / 向上推 / 刷新中 / 被拦截：一律不进入下拉 */
  for (const extra of [{ scrollTop: 12 }, { currentY: 80 },
    { refreshing: true }, { blocked: true }]) {
    assert.equal(PTR.decide(Object.assign({}, base, extra)).active, false,
      JSON.stringify(extra));
  }
  /* 最大下拉距离封顶 */
  const huge = PTR.decide({ startY: 0, currentY: 5000, scrollTop: 0 });
  assert.equal(huge.pull, PTR.DEFAULTS.maxPull);
});

test('v2.5 · wheelAccum：顶部向上滚累积，离开顶部 / 向下滚清零', () => {
  let acc = 0;
  acc = PTR.wheelAccum({ deltaY: -120, accumulated: acc, scrollTop: 0 });
  assert.equal(acc, 36);               // 120 × 0.3
  acc = PTR.wheelAccum({ deltaY: -120, accumulated: acc, scrollTop: 0 });
  assert.equal(acc, 72);
  assert.equal(PTR.wheelAccum({ deltaY: -120, accumulated: acc, scrollTop: 5 }), 0);
  assert.equal(PTR.wheelAccum({ deltaY: 120, accumulated: acc, scrollTop: 0 }), 0);
  assert.equal(PTR.wheelAccum({ deltaY: -120, accumulated: acc, scrollTop: 0, blocked: true }), 0);
  assert.equal(PTR.wheelAccum({ deltaY: -120, accumulated: acc, scrollTop: 0, refreshing: true }), 0);
  assert.ok(PTR.DEFAULTS.wheelThreshold <= PTR.DEFAULTS.wheelMax);
});

test('v2.5 · install：刷新触发一次、状态流转、运行期拦截、destroy 清理', async () => {
  const m = mockDom(0);
  let calls = 0, blocked = false, enabled = true;
  const ctl = PTR.install({
    document: m.doc, window: m.win, indicator: m.indicator,
    scroller: () => m.doc.scrollingElement,
    blocked: () => blocked, enabled: () => enabled,
    onRefresh: async () => { calls++; return true; },
    labels: () => ({ idle: '下拉刷新页面', pull: '下拉刷新页面', armed: '释放立即刷新',
      refreshing: '正在刷新页面…', done: '页面已刷新', blocked: '自动运行中：刷新已禁用' }),
    config: { doneMs: 20, cooldownMs: 10, maxDurationMs: 200 }
  });
  assert.ok(ctl && typeof ctl.destroy === 'function');
  assert.equal(m.indicator.dataset.state, 'idle');
  assert.equal(m.textEl.textContent, '下拉刷新页面');
  /* 触发一次刷新 */
  assert.equal(await ctl.refresh(), true);
  assert.equal(calls, 1);
  assert.equal(m.indicator.dataset.state, 'done');
  assert.equal(m.textEl.textContent, '页面已刷新');
  /* 冷却期重复触发被抑制 */
  await ctl.refresh();
  assert.equal(calls, 1);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(await ctl.refresh(), true);
  assert.equal(calls, 2);
  /* 运行期拦截：不调用 onRefresh，指示器给出禁用提示 */
  blocked = true;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(await ctl.refresh(), false);
  assert.equal(calls, 2);
  assert.equal(m.indicator.dataset.state, 'blocked');
  assert.match(m.textEl.textContent, /禁用|disabled/);
  /* 设置打开时不接管 */
  enabled = false;
  assert.equal(await ctl.refresh(), false);
  ctl.destroy();
  assert.equal(m.indicator.dataset.state, 'idle');
});

test('v2.5 · 手势事件：触摸下拉超过阈值松手触发刷新', async () => {
  const m = mockDom(0);
  let calls = 0;
  const ctl = PTR.install({
    document: m.doc, window: m.win, indicator: m.indicator,
    scroller: () => m.doc.scrollingElement,
    onRefresh: async () => { calls++; },
    config: { doneMs: 10, cooldownMs: 5, maxDurationMs: 200 }
  });
  const touch = (type, y) => {
    const e = new Event(type);
    e.touches = y == null ? [] : [{ clientY: y }];
    return e;
  };
  m.doc.dispatchEvent(touch('touchstart', 100));
  m.doc.dispatchEvent(touch('touchmove', 260));
  assert.equal(m.indicator.dataset.state, 'pulling');
  assert.equal(m.indicator.dataset.armed, '1');
  assert.equal(m.indicator.style.props['--pull'], '80px');
  m.doc.dispatchEvent(touch('touchend'));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls, 1, '松手应触发一次刷新');
  assert.equal(m.indicator.dataset.state, 'done');
  ctl.destroy();
});

test('v2.5 · 两端接线一致：指示器 / 共享脚本 / 字典 / 严格模式守卫', () => {
  for (const h of ['edge-extension/popup.html', 'desktop-app/src/popup.html']) {
    const s = read(h);
    assert.match(s, /id="pull-refresh"/);
    assert.match(s, /data-pull-text/);
    assert.match(s, /hsa-pull-refresh\.js/);
    assert.ok(s.indexOf('hsa-pull-refresh.js') < s.indexOf('popup.js'),
      h + ' 共享手势脚本须先于 popup.js 加载');
  }
  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    const s = read(p);
    assert.match(s, /HSA_PULL_REFRESH\.install\(/);
    assert.match(s, /scroller: \(\) => \$\('scroll-root'\) \|\| document\.scrollingElement/);
    assert.match(s, /enabled: \(\) => !body\.classList\.contains\('settings-open'\)/);
    assert.match(s, /blocked: \(\) => strictRunGuard\('refreshTasks'\)/);
    assert.match(s, /await send\('refreshTasks'\)/);
    assert.match(s, /logUserAction\('pull-refresh'/);
    for (const k of ['pull.idle', 'pull.pull', 'pull.armed',
      'pull.refreshing', 'pull.done', 'pull.error', 'pull.blocked']) {
      assert.ok(s.includes("'" + k + "'"), p + ' 缺少字典键 ' + k);
    }
  }
  const css = read('shared/hsa-shared.css');
  assert.match(css, /\.pull-refresh \{/);
  assert.match(css, /z-index: 2147483646/);
  assert.match(css, /pull-refresh\[data-state="refreshing"\]/);
  assert.match(read('scripts/sync-shared.js'), /hsa-pull-refresh\.js/);
  /* 严格运行模式：下拉复用 refreshTasks，运行期仍被白名单拦截 */
  assert.equal(CORE.strictBlockedMessage('refreshTasks', true), true);
  assert.equal(CORE.strictBlockedMessage('logUserAction', true), false);
});

test('v2.5 · 所有悬浮框统一最上层（截图中的黑色提示 / 圆环卡 / 登录提示）', () => {
  const TOP = /z-index:\s*2147483647/;
  for (const p of ['edge-extension/popup.css', 'desktop-app/src/popup.css']) {
    const s = read(p);
    for (const sel of ['.tip {', '.ring-hover-card {']) {
      const at = s.indexOf(sel);
      assert.ok(at >= 0, p + ' 缺少 ' + sel);
      assert.match(s.slice(at, at + 1200), TOP, p + ' ' + sel + ' 不在最上层');
    }
  }
  const dc = read('desktop-app/src/popup.css');
  const loginAt = dc.indexOf('.login-badge-tip {');
  assert.ok(loginAt >= 0);
  assert.match(dc.slice(loginAt, loginAt + 320), TOP);
  assert.match(read('shared/hsa-shared.css'), /z-index: 2147483647 !important/);
  assert.match(read('shared/hsa-hover-tip.js'), /'z-index', '2147483647', 'important'/);
});

test('v2.6 · 桌面版前三项仍成立：静默与独立窗口移除 / 单滚动条 / 侧栏内嵌', () => {
  const html = read('desktop-app/src/popup.html');
  const js = read('desktop-app/src/popup.js');
  const css = read('desktop-app/src/popup.css');
  const main = read('desktop-app/main.js');
  const pre = read('desktop-app/preload.js');
  assert.doesNotMatch(html, /set-silent-run|set-sidebar-window|desktop\.sidebarWindow/);
  assert.doesNotMatch(js, /silentRun|sidebarWindow|setSidebarWindow/);
  assert.doesNotMatch(main, /openDetachedSidebar|sidebarWindowEnabled|chrome:app:sidebarWindow/);
  assert.doesNotMatch(pre, /setSidebarWindow|getSidebarWindow/);
  assert.match(html, /id="set-auto-launch"/);
  assert.match(html, /<div id="scroll-root">/);
  assert.match(css, /#scroll-root \{[\s\S]{0,220}overflow-y: auto/);
  assert.match(css, /overscroll-behavior: contain/);
  assert.match(main, /function showSidePanel\(url, reason, active\)/);
});


test('v2.6 · applet 主题视觉：50px 透明区 / 三点 ball-beat / 交错动画', () => {
  const css = read('shared/hsa-shared.css');
  assert.match(css, /v2\.6 · 下拉刷新 · minirefresh applet 主题风格/);
  assert.match(css, /\.pull-refresh \{[\s\S]{0,360}height: 50px/);
  assert.match(css, /background: transparent; border: 0/);
  assert.match(css, /min\(var\(--pull, 0px\), 50px\)/);
  assert.match(css, /\.ball-beat \.dot \{[\s\S]{0,260}width: 8px; height: 8px/);
  assert.match(css, /opacity: calc\(\.3 \+ var\(--pull-progress, 0\) \* \.55\)/);
  assert.match(css, /@keyframes hsa-ball-beat/);
  assert.match(css, /animation: hsa-ball-beat \.9s infinite ease-in-out both/);
  assert.match(css, /dot:nth-child\(2\) \{ animation-delay: \.16s/);
  assert.match(css, /dot:nth-child\(3\) \{ animation-delay: \.32s/);
  assert.match(css, /\.loading-applet \.ball-beat \.dot/);
  assert.match(css, /\.pull-text \{[\s\S]{0,300}opacity: 0/);
  assert.match(css, /\[data-state="error"\] \.pull-text/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /data-state="done"[^\n]*\{ opacity: 1/);
  for (const h of ['edge-extension/popup.html', 'desktop-app/src/popup.html']) {
    const s = read(h);
    assert.match(s, /class="ball-beat" aria-hidden="true"><i class="dot"><\/i><i class="dot"><\/i><i class="dot"><\/i>/);
    assert.match(s, /class="pull-text" data-pull-text/);
    assert.doesNotMatch(s, /pull-arrow/);
  }
  /* 零第三方依赖：只复刻主题视觉，共享清单仍是 7 个文件 */
  const sync = read('scripts/sync-shared.js');
  assert.match(sync, /hsa-pull-refresh\.js/);
  assert.doesNotMatch(sync, /minirefresh/);
  const files = sync.match(/const FILES = \[([\s\S]*?)\];/)[1];
  assert.equal((files.match(/\.js'|\.css'|\.json'/g) || []).length, 7);
});

test('v2.6 · default 主题文案语义与两端字典一致', () => {
  const lib = read('shared/hsa-pull-refresh.js');
  assert.match(lib, /idle: '下拉刷新', pull: '下拉刷新', armed: '释放刷新'/);
  assert.match(lib, /refreshing: '加载中\.\.\.', done: '刷新成功', error: '刷新失败'/);
  assert.match(lib, /isWrapCssTranslate=true/);
  assert.match(lib, /error: l\.error/);
  assert.match(lib, /render\(r && r\.ok === false \? 'error' : 'done'/);
  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    const s = read(p);
    for (const lit of ["'pull.armed': '释放刷新'", "'pull.refreshing': '加载中...'",
      "'pull.done': '刷新成功'", "'pull.error': '刷新失败'",
      "'pull.armed': 'Release to refresh'", "'pull.done': 'Refreshed'",
      "'pull.error': 'Refresh failed'"]) {
      assert.ok(s.includes(lit), p + ' 缺少 ' + lit);
    }
    assert.match(s, /error: t\('pull\.error'\)/);
    assert.match(s, /wrap: \(\) => \$\('main'\) \|\| \$\('scroll-root'\) \|\| document\.scrollingElement/);
  }
});

test('v2.6 · applet 动态：内容跟随下拉、三点 loading、成功直接回弹', async () => {
  const m = mockDom(0);
  let finishRefresh;
  const ctl = PTR.install({
    document: m.doc, window: m.win, indicator: m.indicator,
    scroller: () => m.doc.scrollingElement,
    onRefresh: () => new Promise(r => { finishRefresh = r; }),
    config: { doneMs: 30, cooldownMs: 5, maxDurationMs: 500 }
  });
  const touch = (type, y) => {
    const e = new Event(type);
    e.touches = y == null ? [] : [{ clientY: y }];
    return e;
  };
  m.doc.dispatchEvent(touch('touchstart', 100));
  m.doc.dispatchEvent(touch('touchmove', 240));   // dy 140 × 0.5 = 70px
  assert.equal(m.indicator.dataset.state, 'pulling');
  assert.equal(m.indicator.style.props['--pull'], '70px');
  assert.equal(m.indicator.style.props['--pull-progress'], '1');
  assert.equal(m.wrapEl.style.transform, 'translateY(70px)', '内容区域应随下拉位移');
  m.doc.dispatchEvent(touch('touchend'));
  await Promise.resolve();   // 让 Promise.resolve().then(onRefresh) 的微任务先执行
  assert.equal(m.indicator.dataset.state, 'refreshing');
  assert.ok(m.indicator.classList.items.has('loading-applet'), 'loading 时加 applet 动画类');
  assert.equal(m.indicator.attrs['aria-label'], '加载中...');
  assert.equal(m.wrapEl.style.transform, 'translateY(64px)');
  finishRefresh(true);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(m.indicator.dataset.state, 'done');
  assert.equal(m.wrapEl.style.transform, '', '成功无动画，直接回弹收起');
  assert.ok(!m.indicator.classList.items.has('loading-applet'));
  ctl.destroy();
});

test('v2.6 · 刷新失败显示 error 小字、拦截态不调用刷新', async () => {
  const m = mockDom(0);
  let calls = 0, blocked = false;
  const ctl = PTR.install({
    document: m.doc, window: m.win, indicator: m.indicator,
    scroller: () => m.doc.scrollingElement,
    blocked: () => blocked,
    onRefresh: () => { calls++; return Promise.reject(new Error('network')); },
    config: { doneMs: 30, cooldownMs: 5, maxDurationMs: 200 }
  });
  assert.equal(await ctl.refresh(), false);
  assert.equal(m.indicator.dataset.state, 'error');
  assert.equal(m.textEl.textContent, '刷新失败');
  assert.equal(calls, 1);
  blocked = true;
  await new Promise(r => setTimeout(r, 10));
  assert.equal(await ctl.refresh(), false);
  assert.equal(calls, 1, '运行期拦截不得触发刷新');
  assert.equal(m.indicator.dataset.state, 'blocked');
  assert.equal(m.textEl.textContent, '自动运行中：刷新已禁用');
  ctl.destroy();
});
