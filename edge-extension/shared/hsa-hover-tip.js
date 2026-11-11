/* AUTO-GENERATED from shared/ — do not edit; run node scripts/sync-shared.js */
/* ============================================================================
 * HSA_HOVER_TIP · 统一自定义鼠标悬浮提示（两版唯一实现）
 *
 *  · 与插件版表现完全一致：短提示单行、长提示自动换行且全文可读（U08=D）。
 *  · 浮层挂到 <html> 末尾、position:fixed、z-index 2147483647 !important，
 *    不落在任何设置面板 / 卡片的 stacking context 内，始终在最上层。
 *  · 把元素原生 title 同步到 data-tip 并移除 title，避免浏览器黑色系统提示。
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HSA_HOVER_TIP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var INSTALLED_KEY = '__hsaHoverTipInstalled';

  function install(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.documentElement || d.documentElement[INSTALLED_KEY]) return null;
    if (d.getElementById('hover-tip')) {
      d.documentElement[INSTALLED_KEY] = true;
      return d.getElementById('hover-tip');
    }

    var tip = d.createElement('div');
    tip.id = 'hover-tip';
    tip.className = 'hover-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    /* 内联最高层级兜底：即使宿主页面另有 z-index 覆盖也不会被盖住。 */
    tip.style.setProperty('position', 'fixed', 'important');
    tip.style.setProperty('z-index', '2147483647', 'important');
    /* 挂在 <html> 末尾，脱离 body 内任何 transform / overflow 容器。 */
    d.documentElement.appendChild(tip);
    d.documentElement[INSTALLED_KEY] = true;

    var sync = function (el) {
      var v = el.getAttribute('title') || '';
      if (!v) return;
      el.dataset.tip = v;
      el.removeAttribute('title');
      if (!el.hasAttribute('data-i18n-aria')) {
        var label = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (label) el.setAttribute('aria-label', label + ' — ' + v);
      }
    };
    var hintSelector = '[data-tip-role="hint"]';
    d.querySelectorAll(hintSelector).forEach(sync);

    var mo = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var el = list[i].target;
        if (el && el.nodeType === 1 && el.matches && el.matches(hintSelector)) sync(el);
      }
    });
    mo.observe(d.body, { subtree: true, attributes: true, attributeFilter: ['title'] });

    var place = function (host) {
      var r = host.getBoundingClientRect();
      var w = tip.offsetWidth, h = tip.offsetHeight;
      var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2),
                          Math.max(8, window.innerWidth - w - 8));
      var top = r.top - h - 8;
      if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);
      tip.style.left = left + 'px';
      tip.style.top = Math.max(8, top) + 'px';
    };
    var closestTip = function (node) {
      return node && node.closest ? node.closest('[data-tip]') : null;
    };
    d.addEventListener('mouseover', function (e) {
      var host = closestTip(e.target);
      if (!host || !host.dataset.tip) return;
      tip.textContent = host.dataset.tip;
      /* U08=D：短提示单行，长提示自动换行且全文可读。 */
      tip.dataset.short = String(host.dataset.tip || '').length <= 40 ? '1' : '';
      tip.hidden = false;
      place(host);
    });
    d.addEventListener('mouseout', function (e) {
      var host = closestTip(e.target);
      if (!host) return;
      if (e.relatedTarget && host.contains(e.relatedTarget)) return;
      tip.hidden = true;
    });
    window.addEventListener('scroll', function () { tip.hidden = true; }, true);
    window.addEventListener('resize', function () { tip.hidden = true; });
    return tip;
  }

  return { VERSION: VERSION, install: install };
});
