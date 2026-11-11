/* ============================================================================
 * HSA_PULL_REFRESH · 下拉刷新页面（插件版 / 桌面版共用唯一实现）
 * v2.6：视觉对齐 minirefresh applet 主题（仿微信小程序）——
 *   50px 透明下拉区 + 三点 ball-beat + 内容跟随 translate + 无成功动画。
 *   文案沿用 default 主题语义（下拉刷新 / 释放刷新 / 加载中... /
 *   刷新成功 / 刷新失败），视觉隐藏，仅拦截与失败时露出小字。
 *
 *  · 纯逻辑 decide() / wheelAccum() 可在 Node 单测里直接跑，不碰 DOM；
 *  · install() 统一接管触摸 / 鼠标拖拽 / 顶部滚轮三种下拉手势：
 *      滚动容器在顶部 → 继续下拉 → 超过阈值松手即刷新 → 指示器回弹；
 *  · 运行期由 opts.blocked() 拦截（严格运行模式不放行刷新），设置面板
 *    打开时由 opts.enabled() 关闭，刷新中 / 冷却期不重复触发；
 *  · 刷新动作由宿主注入 opts.onRefresh()，模块不读写业务状态、不发消息。
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HSA_PULL_REFRESH = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var DEFAULTS = Object.freeze({
    threshold: 64,        // 松手触发所需下拉距离（px，已按阻尼折算）
    damping: 0.5,         // 拖动阻尼：手指 120px → 指示器 60px
    maxPull: 96,          // 指示器最大下拉距离
    wheelFactor: 0.3,     // 滚轮向上滚动的累积系数
    wheelThreshold: 90,   // 滚轮累积到该值直接触发
    wheelMax: 140,
    cooldownMs: 900,      // 刷新完成后的防抖冷却
    doneMs: 900,          // 「已刷新」停留时间
    maxDurationMs: 15000  // 刷新动作最长等待，超时不阻塞手势
  });

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** 纯函数：把一次拖拽位移换算成下拉状态。 */
  function decide(o) {
    var x = o && typeof o === 'object' ? o : {};
    var cfg = Object.assign({}, DEFAULTS, x.config || {});
    var startY = Number(x.startY), currentY = Number(x.currentY);
    var dy = currentY - startY;
    var active = !x.refreshing && !x.blocked && num(x.scrollTop) <= 0
      && Number.isFinite(startY) && Number.isFinite(currentY) && dy > 0;
    var pull = active ? Math.min(cfg.maxPull, dy * cfg.damping) : 0;
    var armed = active && pull >= cfg.threshold;
    return {
      active: active,
      pull: pull,
      armed: armed,
      progress: cfg.threshold ? Math.min(1, pull / cfg.threshold) : 0,
      dy: active ? dy : 0
    };
  }

  /** 纯函数：顶部继续向上滚轮的累积量；离开顶部 / 向下滚即清零。 */
  function wheelAccum(o) {
    var x = o && typeof o === 'object' ? o : {};
    var cfg = Object.assign({}, DEFAULTS, x.config || {});
    var delta = num(x.deltaY);
    if (x.refreshing || x.blocked || num(x.scrollTop) > 0 || delta >= 0) return 0;
    return Math.min(cfg.wheelMax, Math.max(0, num(x.accumulated)) + (-delta) * cfg.wheelFactor);
  }

  /* default 主题文案语义（applet 继承 default）；视觉上不显示，供读屏与状态提示。 */
  var DEFAULT_LABELS = Object.freeze({
    idle: '下拉刷新', pull: '下拉刷新', armed: '释放刷新',
    refreshing: '加载中...', done: '刷新成功', error: '刷新失败',
    blocked: '自动运行中：刷新已禁用'
  });

  /**
   * 安装下拉刷新手势。
   * @param {Object} o
   *  scroller: 滚动容器元素或返回元素的函数（默认 document.scrollingElement）
   *  indicator: 指示器元素（必需）
   *  onRefresh: 异步刷新回调（必需）
   *  blocked: () => boolean 运行期禁用
   *  enabled: () => boolean 设置面板打开时返回 false
   *  labels: () => ({ idle, pull, armed, refreshing, done, error, blocked })
   *  wrap: 下拉时跟随 CSS translate 的内容区域（默认 #main）
   *  onLog: (phase, detail) => void 可选
   * @returns {{ destroy: Function, isBusy: Function, refresh: Function } | null}
   */
  function install(o) {
    var opts = o && typeof o === 'object' ? o : {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var win = opts.window || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win) return null;
    var indicator = opts.indicator;
    if (!indicator) return null;

    var cfg = Object.assign({}, DEFAULTS, opts.config || {});
    var getScroller = typeof opts.scroller === 'function' ? opts.scroller
      : function () { return opts.scroller || doc.scrollingElement || doc.documentElement; };
    /* applet 的 isWrapCssTranslate=true：内容区域整体跟随下拉位移。 */
    var getWrap = typeof opts.wrap === 'function' ? opts.wrap : function () {
      return opts.wrap || (doc.getElementById ? doc.getElementById('main') : null)
        || getScroller();
    };
    var labels = typeof opts.labels === 'function' ? opts.labels
      : function () { return opts.labels || DEFAULT_LABELS; };
    var blocked = typeof opts.blocked === 'function' ? opts.blocked : function () { return false; };
    var enabled = typeof opts.enabled === 'function' ? opts.enabled : function () { return true; };
    var onRefresh = typeof opts.onRefresh === 'function' ? opts.onRefresh : function () {};
    var onLog = typeof opts.onLog === 'function' ? opts.onLog : function () {};

    var textEl = indicator.querySelector('[data-pull-text]') || indicator;
    var state = 'idle', pull = 0, startY = null, dragging = false;
    var wheelAcc = 0, busy = false, lastDoneAt = 0, timer = null;

    function scrollTop() {
      var el = getScroller();
      return el ? num(el.scrollTop) : 0;
    }
    function render(next, px, armed) {
      state = next;
      pull = Math.max(0, num(px));
      indicator.dataset.state = next;
      indicator.dataset.armed = armed ? '1' : '0';
      indicator.style.setProperty('--pull', pull + 'px');
      indicator.style.setProperty('--pull-progress',
        String(Math.min(1, pull / (cfg.threshold || 1))));
      if (indicator.classList && indicator.classList.toggle) {
        indicator.classList.toggle('loading-applet', next === 'refreshing');
      }
      /* 内容区域跟随下拉（小程序观感）；回弹时立即清除，不留 transform。 */
      var wrap = getWrap();
      if (wrap && wrap.style) {
        wrap.style.transform = pull > 0 ? 'translateY(' + pull + 'px)' : '';
      }
      var l = labels() || DEFAULT_LABELS;
      var map = { idle: l.idle, pulling: armed ? l.armed : l.pull,
        refreshing: l.refreshing, done: l.done, error: l.error, blocked: l.blocked };
      var text = map[next];
      if (text != null && textEl) textEl.textContent = String(text);
      if (text != null && indicator.setAttribute) {
        indicator.setAttribute('aria-label', String(text));
      }
    }
    function reset() {
      dragging = false; startY = null; wheelAcc = 0;
      render('idle', 0, false);
    }
    function canStart() {
      return enabled() && !busy && !blocked()
        && Date.now() - lastDoneAt >= cfg.cooldownMs && scrollTop() <= 0;
    }
    function begin(y) {
      if (!canStart()) return false;
      dragging = true; startY = num(y); wheelAcc = 0;
      return true;
    }
    function move(y, ev) {
      if (!dragging) return false;
      var d = decide({ startY: startY, currentY: num(y), scrollTop: scrollTop(),
        refreshing: busy, blocked: blocked(), config: cfg });
      if (!d.active) {
        if (scrollTop() > 0) reset();
        return false;
      }
      render('pulling', d.pull, d.armed);
      /* 触摸时阻止原生滚动接管手势；桌面鼠标不拦截默认行为。 */
      if (ev && ev.cancelable && ev.type === 'touchmove') ev.preventDefault();
      return true;
    }
    function finish() {
      if (!dragging) return;
      var armed = pull >= cfg.threshold;
      dragging = false; startY = null;
      if (armed) trigger();
      else render('idle', 0, false);
    }
    function trigger() {
      if (blocked()) {
        render('blocked', 0, false);
        clearTimeout(timer);
        timer = setTimeout(function () { render('idle', 0, false); }, cfg.doneMs);
        return Promise.resolve(false);
      }
      /* 刷新中 / 设置打开 / 冷却期：直接忽略，不重置已有状态、不重复发请求。 */
      if (busy || !enabled() || Date.now() - lastDoneAt < cfg.cooldownMs) {
        return Promise.resolve(false);
      }
      busy = true; wheelAcc = 0;
      render('refreshing', cfg.threshold, true);
      onLog('trigger', 'pull=' + Math.round(pull) + 'px');
      var timeoutId = null;
      var timeout = new Promise(function (resolve) {
        timeoutId = setTimeout(function () { resolve({ ok: false, reason: 'timeout' }); }, cfg.maxDurationMs);
      });
      return Promise.race([
        Promise.resolve().then(onRefresh).then(function (r) {
          return { ok: r === undefined ? true : !!r };
        }, function (err) {
          return { ok: false, reason: String(err && err.message || err) };
        }),
        timeout
      ]).then(function (r) {
        /* 无论哪条分支先返回，都清掉超时定时器，避免每次刷新残留 15s 计时器。 */
        clearTimeout(timeoutId);
        busy = false;
        lastDoneAt = Date.now();
        /* 失败 → 显示「刷新失败」小字；成功 → 无成功动画，直接回弹收起。 */
        render(r && r.ok === false ? 'error' : 'done',
          r && r.ok === false ? cfg.threshold : 0, false);
        onLog('finish', JSON.stringify(r || {}));
        clearTimeout(timer);
        timer = setTimeout(function () { render('idle', 0, false); }, cfg.doneMs);
        return !!(r && r.ok !== false);
      });
    }

    /* ---- 触摸 ---- */
    var onTouchStart = function (e) {
      if (!e.touches || !e.touches.length) return;
      begin(e.touches[0].clientY);
    };
    var onTouchMove = function (e) {
      if (!e.touches || !e.touches.length) return;
      move(e.touches[0].clientY, e);
    };
    var onTouchEnd = function () { finish(); };
    /* ---- 鼠标拖拽（避开按钮 / 输入控件，防止误触） ---- */
    var onMouseDown = function (e) {
      if (e.button !== 0) return;
      var t = e.target;
      if (t && t.closest && t.closest('button, input, a, select, textarea, label, [role="button"]')) return;
      begin(e.clientY);
    };
    var onMouseMove = function (e) { move(e.clientY, e); };
    var onMouseUp = function () { finish(); };
    /* ---- 顶部继续向上滚轮（桌面无触控时的等价下拉） ---- */
    var onWheel = function (e) {
      if (busy || !enabled() || blocked()) return;
      wheelAcc = wheelAccum({ deltaY: num(e.deltaY), accumulated: wheelAcc,
        scrollTop: scrollTop(), refreshing: busy, blocked: blocked(), config: cfg });
      if (wheelAcc <= 0) {
        if (!dragging && state === 'pulling') reset();
        return;
      }
      if (e.cancelable && num(e.deltaY) < 0) e.preventDefault();
      if (wheelAcc >= cfg.wheelThreshold) {
        render('pulling', Math.min(cfg.maxPull, wheelAcc * 0.6), true);
        trigger();
      } else {
        render('pulling', Math.min(cfg.maxPull, wheelAcc * 0.6),
          wheelAcc * 0.6 >= cfg.threshold);
      }
    };
    var onScroll = function () {
      if (dragging && scrollTop() > 0) reset();
    };

    doc.addEventListener('touchstart', onTouchStart, { passive: true });
    doc.addEventListener('touchmove', onTouchMove, { passive: false });
    doc.addEventListener('touchend', onTouchEnd, { passive: true });
    doc.addEventListener('touchcancel', onTouchEnd, { passive: true });
    doc.addEventListener('mousedown', onMouseDown, true);
    doc.addEventListener('mousemove', onMouseMove, true);
    doc.addEventListener('mouseup', onMouseUp, true);
    win.addEventListener('wheel', onWheel, { passive: false });
    win.addEventListener('scroll', onScroll, true);
    render('idle', 0, false);

    return {
      VERSION: VERSION,
      isBusy: function () { return busy; },
      refresh: function () { return trigger(); },
      destroy: function () {
        clearTimeout(timer);
        doc.removeEventListener('touchstart', onTouchStart);
        doc.removeEventListener('touchmove', onTouchMove);
        doc.removeEventListener('touchend', onTouchEnd);
        doc.removeEventListener('touchcancel', onTouchEnd);
        doc.removeEventListener('mousedown', onMouseDown, true);
        doc.removeEventListener('mousemove', onMouseMove, true);
        doc.removeEventListener('mouseup', onMouseUp, true);
        win.removeEventListener('wheel', onWheel);
        win.removeEventListener('scroll', onScroll, true);
        reset();
      }
    };
  }

  return {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    decide: decide,
    wheelAccum: wheelAccum,
    install: install
  };
});
