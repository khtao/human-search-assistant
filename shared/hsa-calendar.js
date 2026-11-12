/* ============================================================================
 * Human Search Assistant · 积分日历（共享唯一实现，v3.3）
 *
 * 两端 popup.js 只保留一层薄封装，日历的模型、渲染、导航、复位全部在这里，
 * 保证桌面版与浏览器插件版的设计与行为逐字一致。
 *
 * 设计约束（本次需求）：
 *   · 可折叠：容器为 <details class="cal-fold" open>，样式见 hsa-shared.css；
 *   · 紧凑且零空白：三种视图都只渲染「有积分」的周期单元，不铺 42 格 / 12 格；
 *   · 周视图只显示当月的周：周起止裁剪到当月 1 日与月末，绝不跨月；
 *   · 日视图只显示有积分的月份：只列当月有积分的日期，当前月无记录时
 *     自动定位到最近有积分的月份；导航同样只放行有积分的周期；
 *   · 每次打开设置复位：reset() 回到日视图 + 最近有积分月 + 展开状态。
 *
 * 纯逻辑部分可在 Node 下直接 require 做单测；DOM 部分通过 createController
 * 注入 document / $ / t / storage，不依赖任何全局宿主能力。
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HSA_CALENDAR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var MODES = Object.freeze(['day', 'week', 'month']);
  var MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dkey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function addDays(d, n) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }
  function mondayOf(d) { return addDays(d, -((d.getDay() + 6) % 7)); }
  function dateLabel(d, lang) {
    return lang === 'en'
      ? MONTHS_EN[d.getMonth()] + ' ' + d.getDate()
      : (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function histValue(h, k) {
    var e = h && h[k];
    if (e == null) return null;
    var v = Number(e && typeof e === 'object'
      ? (e.today != null ? e.today : (e.points != null ? e.points : e.total))
      : e);
    return Number.isFinite(v) ? v : null;
  }
  /** 归一化历史：只保留 ≤ 今天的正积分记录，并补上今天的实时积分。 */
  function normalize(hist, ps, now) {
    var out = {}, src = hist || {}, todayK = dkey(now);
    for (var k of Object.keys(src)) {
      if (k > todayK) continue;
      var v = histValue(src, k);
      if (v > 0) out[k] = v;
    }
    if (!out[todayK] && Number.isFinite(ps && ps.today) && Number(ps.today) > 0) {
      out[todayK] = Number(ps.today);
    }
    return out;
  }
  function coreNavAllowed() {
    var c = (typeof globalThis !== 'undefined' && globalThis.HSA_CORE) ||
      (typeof require === 'function' ? require('./hsa-core.js') : null);
    return c && typeof c.calendarNavAllowed === 'function'
      ? c.calendarNavAllowed : null;
  }

  /**
   * 构建紧凑日历模型。所有视图只输出有积分的单元；没有空白占位格。
   * opts = { hist, pointsSummary, mode, cursor, now, lang }
   */
  function buildModel(opts) {
    var o = opts || {};
    var now = o.now instanceof Date ? o.now : new Date();
    var todayK = dkey(now);
    var hist = normalize(o.hist, o.pointsSummary, now);
    var lang = o.lang === 'en' ? 'en' : 'zh';
    var mode = MODES.indexOf(o.mode) >= 0 ? o.mode : 'day';
    var cursor = o.cursor instanceof Date ? o.cursor : now;
    var y = cursor.getFullYear(), m = cursor.getMonth();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var first = new Date(y, m, 1), last = new Date(y, m, daysInMonth);
    var cells = [], vals = [], earningDays = [];

    if (mode === 'day') {
      /* 日视图：只列出当月有积分的日期，不铺满 6 行 × 7 列。 */
      for (var dd = 1; dd <= daysInMonth; dd++) {
        var k = y + '-' + pad2(m + 1) + '-' + pad2(dd);
        if (k > todayK) continue;
        var v = hist[k];
        if (!(v > 0)) continue;
        vals.push(v); earningDays.push(v);
        var d = new Date(y, m, dd);
        cells.push({
          kind: 'day', label: (m + 1) + '/' + dd, value: v,
          cls: 'cal-has' + (k === todayK ? ' cal-today' : ''),
          tipKey: 'calendar.cellTip',
          tipArgs: { date: dateLabel(d, lang), points: String(v) },
          daily: null, detail: ''
        });
      }
    } else if (mode === 'week') {
      /* 周视图：周起止裁剪到当月边界（绝不跨月），且只保留有积分的周。 */
      var wStart = mondayOf(first);
      var wNo = 0;
      while (wStart <= last) {
        var wEnd = addDays(wStart, 6);
        var clipStart = wStart < first ? first : wStart;
        var clipEnd = wEnd > last ? last : wEnd;
        wNo++;
        var total = 0, hit = 0, daily = [];
        for (var cur = new Date(clipStart); cur <= clipEnd; cur = addDays(cur, 1)) {
          var kk = dkey(cur);
          var vv = kk <= todayK ? hist[kk] : null;
          if (vv > 0) { total += vv; hit++; earningDays.push(vv); }
          daily.push({ value: vv || 0, label: dateLabel(cur, lang),
                       future: kk > todayK });
        }
        if (hit) {
          vals.push(total);
          var tag = pad2(clipStart.getMonth() + 1) + '/' + pad2(clipStart.getDate())
            + '–' + pad2(clipEnd.getMonth() + 1) + '/' + pad2(clipEnd.getDate());
          cells.push({
            kind: 'week', label: 'W' + wNo + ' · ' + tag, value: total,
            cls: 'cal-has', daily: daily,
            tipKey: 'calendar.cellTip',
            tipArgs: { date: tag, points: String(total) },
            detail: String(hit)
          });
        }
        wStart = addDays(wStart, 7);
      }
    } else {
      /* 月视图：当年内只保留有积分的月。 */
      for (var mm = 0; mm < 12; mm++) {
        var prefix = y + '-' + pad2(mm + 1);
        if (prefix > todayK.slice(0, 7)) continue;
        var mt = 0, mh = 0;
        for (var k2 of Object.keys(hist)) {
          if (k2.slice(0, 7) !== prefix) continue;
          mt += hist[k2]; mh++; earningDays.push(hist[k2]);
        }
        if (!mh) continue;
        vals.push(mt);
        var mtag = y + '/' + pad2(mm + 1);
        cells.push({
          kind: 'month', label: mtag, value: mt, cls: 'cal-has', daily: null,
          tipKey: 'calendar.cellTip',
          tipArgs: { date: mtag, points: String(mt) },
          detail: String(mh)
        });
      }
    }

    var total = vals.reduce(function (a, b) { return a + b; }, 0);
    var avg = earningDays.length ? Math.round(total / earningDays.length) : 0;
    var max = earningDays.length ? Math.max.apply(null, earningDays) : 0;
    var nav = coreNavAllowed();
    function navOk(step) {
      return nav ? !!nav(hist, mode, y, m, step, todayK) : false;
    }
    return {
      mode: mode, year: y, month: m, cursor: new Date(y, m, 1),
      range: mode === 'month' ? String(y) : y + ' / ' + pad2(m + 1),
      cells: cells, total: total, avg: avg, max: max,
      earningDays: earningDays.length, empty: cells.length === 0,
      hasAny: Object.keys(hist).length > 0,
      heroLabelKey: mode === 'month' ? 'calendar.yearLabel' : 'calendar.totalLabel',
      navPrev: navOk(-1), navNext: navOk(1),
      hist: hist, todayKey: todayK
    };
  }

  /** 复位光标：日视图 + 最近有积分的月份（避免复位到空白月）。 */
  function resetCursor(hist, ps, now) {
    var n = now instanceof Date ? now : new Date();
    var h = normalize(hist, ps, n);
    var todayK = dkey(n);
    var y = n.getFullYear(), m = n.getMonth();
    for (var i = 0; i < 24; i++) {
      var prefix = y + '-' + pad2(m + 1);
      var hit = false;
      for (var k of Object.keys(h)) {
        if (k <= todayK && k.slice(0, 7) === prefix) { hit = true; break; }
      }
      if (hit) return { cursor: new Date(y, m, 1), mode: 'day' };
      m--;
      if (m < 0) { m = 11; y--; }
    }
    return { cursor: new Date(n.getFullYear(), n.getMonth(), 1), mode: 'day' };
  }

  /** 把模型渲染进 DOM：紧凑小卡片，无空白格；详细全文走共享悬浮提示。 */
  function renderGrid(opts) {
    var o = opts || {}, doc = o.doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !o.grid) return;
    var t = o.t || function (k) { return k; };
    var model = o.model || buildModel(o);
    var grid = o.grid;
    grid.className = 'cal-grid cal-' + model.mode + ' cal-compact';
    grid.textContent = '';
    if (o.weekdays) o.weekdays.textContent = '';
    if (model.empty) {
      var empty = doc.createElement('div');
      empty.className = 'cal-empty';
      empty.textContent = t('calendar.empty');
      grid.appendChild(empty);
      return;
    }
    for (var c of model.cells) {
      var cell = doc.createElement('div');
      cell.className = 'cal-cell ' + c.cls;
      cell.setAttribute('role', 'gridcell');
      var tag = doc.createElement('span');
      tag.className = 'cal-tag';
      tag.textContent = c.label;
      var value = doc.createElement('strong');
      value.className = 'cal-value';
      value.textContent = String(c.value);
      cell.append(tag, value);
      if (Array.isArray(c.daily) && c.daily.length) {
        var strip = doc.createElement('div');
        strip.className = 'cal-week-strip';
        for (var d of c.daily) {
          var dot = doc.createElement('span');
          dot.className = 'cal-week-dot' + (d.future ? ' is-future'
            : d.value > 0 ? ' is-earned' : '');
          dot.title = d.label + ' · ' + String(d.value);
          strip.appendChild(dot);
        }
        cell.appendChild(strip);
      }
      try { cell.dataset.tip = t(c.tipKey, c.tipArgs); cell.dataset.tipRole = 'cell'; }
      catch (err) {}
      grid.appendChild(cell);
    }
  }

  /**
   * 创建日历控制器并接线。ctx:
   *   { doc, $, t, getLang, setSegment, onSegment, storage, logUserAction,
   *     navAllowed, resetBase }
   * 返回 { render, reset, move, setMode, state }。
   */
  function createController(ctx) {
    var c = ctx || {};
    var doc = c.doc || (typeof document !== 'undefined' ? document : null);
    var state = { mode: 'day', cursor: new Date(), hist: {}, renderId: 0, navTimer: null };
    function $(id) { return c.$ ? c.$(id) : (doc && doc.getElementById(id)); }
    function t(k, a) { return c.t ? c.t(k, a) : k; }
    function lang() { return c.getLang ? c.getLang() : 'zh'; }
    function loadData() {
      return Promise.resolve(c.storage
        ? c.storage.get(['pointsHistory', 'pointsSummary']) : {})
        .then(function (s) { return s || {}; })
        .catch(function () { return {}; });
    }
    function navAllowed(hist, mode, y, m, step, todayK) {
      return c.navAllowed ? !!c.navAllowed(hist, mode, y, m, step, todayK) : false;
    }
    function notice() {
      var el = $('cal-nav-msg');
      if (el) {
        el.textContent = t('calendar.navBlocked');
        el.hidden = false;
        clearTimeout(state.navTimer);
        var noticeTimer = setTimeout(function () { el.hidden = true; }, 2600);
        /* Node 测试环境不让短提示 timer 拖住事件循环；浏览器返回 number，无 unref。 */
        if (noticeTimer && typeof noticeTimer.unref === 'function') noticeTimer.unref();
        state.navTimer = noticeTimer;
      }
      try { if (c.logUserAction) c.logUserAction('calendar-nav-blocked', 'calendar nav blocked'); }
      catch (err) {}
    }
    async function render() {
      var rid = ++state.renderId;
      var s = await loadData();
      if (rid !== state.renderId) return;
      var hist = Object.assign({}, (s && s.pointsHistory) || {});
      state.hist = hist;
      var model = buildModel({ hist: hist, pointsSummary: (s && s.pointsSummary) || {},
        mode: state.mode, cursor: state.cursor, now: new Date(), lang: lang() });
      /* 当前周期没有积分但历史里有 → 自动定位到最近有积分的周期，杜绝空白页。 */
      if (model.empty && model.hasAny && !state.autoSnapped) {
        var snap = resetCursor(hist, (s && s.pointsSummary) || {}, new Date());
        state.autoSnapped = true;
        state.cursor = snap.cursor;
        model = buildModel({ hist: hist, pointsSummary: (s && s.pointsSummary) || {},
          mode: state.mode, cursor: state.cursor, now: new Date(), lang: lang() });
      }
      if (!model.empty) state.autoSnapped = false;
      renderCells(model);
      var range = $('cal-range');
      if (range) range.textContent = model.range;
      var total = $('cal-total');
      if (total) total.textContent = String(model.total);
      var hero = $('cal-hero-label');
      if (hero) hero.textContent = t(model.heroLabelKey);
      var sum = $('cal-summary');
      if (sum) {
        sum.textContent = t('calendar.summary', {
          total: String(model.total), avg: String(model.avg), max: String(model.max),
          n: String(model.earningDays)
        }) + (model.earningDays ? '' : ' · ' + t('calendar.empty'));
      }
      var y = model.year, m = model.month;
      for (var pair of [['cal-prev', -1], ['cal-next', 1]]) {
        var btn = $(pair[0]);
        if (!btn) continue;
        var ok = navAllowed(hist, state.mode, y, m, pair[1], model.todayKey);
        btn.disabled = !ok;
        btn.classList.toggle('cal-nav-empty', !ok);
        btn.setAttribute('data-empty', String(!ok));
        btn.setAttribute('aria-description', ok ? '' : t('calendar.navEmpty'));
      }
      if (c.setSegment) c.setSegment('cal-mode', state.mode);
    }
    function renderCells(model) {
      /* 必须调用模块级 renderGrid：控制器内部同名 render 会遮蔽它，
         写成 render({...}) 会递归调用本控制器导致无限挂起。 */
      renderGrid({ doc: doc, grid: $('cal-grid'), weekdays: $('cal-weekdays'),
        model: model, t: t, lang: lang() });
    }
    async function reset() {
      var s = await loadData();
      var hist = Object.assign({}, (s && s.pointsHistory) || {});
      var base = c.resetBase ? c.resetBase() : { cursor: new Date(), mode: 'day' };
      var r = resetCursor(hist, (s && s.pointsSummary) || {}, base.cursor);
      state.cursor = r.cursor;
      state.mode = r.mode;
      state.autoSnapped = false;
      /* 可折叠设计：每次打开设置复位为展开（与插件版基线一致）。 */
      var fold = $('calendar-group');
      if (fold && 'open' in fold) fold.open = true;
      return render();
    }
    async function move(step) {
      var y = state.cursor.getFullYear(), m = state.cursor.getMonth();
      if (!navAllowed(state.hist, state.mode, y, m, step, dkey(new Date()))) {
        notice();
        return;
      }
      state.cursor = state.mode === 'month'
        ? new Date(y + step, m, 1) : new Date(y, m + step, 1);
      state.autoSnapped = false;
      return render();
    }
    function setMode(v) {
      if (MODES.indexOf(v) < 0) return;
      state.mode = v;
      state.autoSnapped = false;
      return render();
    }
    function mount() {
      if (c.onSegment) c.onSegment('cal-mode', function (v) { return setMode(v); });
      var prev = $('cal-prev'), next = $('cal-next');
      if (prev) prev.addEventListener('click', function () { return move(-1); });
      if (next) next.addEventListener('click', function () { return move(1); });
    }
    if (doc && c.mount !== false) mount();
    return { render: render, reset: reset, move: move, setMode: setMode,
      state: state, notice: notice };
  }

  return {
    VERSION: VERSION,
    MODES: MODES,
    pad2: pad2, dkey: dkey, addDays: addDays, mondayOf: mondayOf,
    histValue: histValue, normalize: normalize,
    buildModel: buildModel, resetCursor: resetCursor,
    render: renderGrid, createController: createController
  };
});
