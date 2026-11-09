/* v3.0 · 扩展平台独立兜底（外部脚本，符合 MV3 CSP: script-src 'self'）
 *
 * 桌面壳靠主进程 1 秒 IPC 心跳（chrome.onTick）反复驱动这段复位；MV3 没有
 * 该事件，也没有常驻主进程，这里改成 popup 打开后的一次性 3.5s 看门狗。
 * 与 popup.js 的 DOMContentLoaded 链路完全解耦：即使 popup.js 初始化失败，
 * 「正在启动…」「正在读取今日任务…」也不会永久卡住。
 */
(function () {
  var boot = Date.now();
  var zh = (document.documentElement.lang || '').indexOf('zh') === 0;
  setTimeout(function () {
    if (Date.now() - boot < 3400) return;
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(['running', 'todayTasks']).then(function (s) {
        if (s && s.running) return;
        var b = document.getElementById('btn-action');
        if (b && b.dataset.mode === 'stop') {
          b.dataset.mode = 'start';
          b.disabled = false;
          b.classList.remove('is-stop');
          var l = document.getElementById('btn-action-label');
          if (l) l.textContent = zh ? '自动完成任务' : 'Auto-complete Tasks';
          var st = document.getElementById('status');
          if (st) st.className = 'status stopped';
        }
        var e = document.getElementById('today-tasks-empty');
        if (e && /正在读取|Loading/.test(e.textContent) &&
            !(s && s.todayTasks && s.todayTasks.updatedAt)) {
          e.textContent = zh
            ? '暂时读不到任务数据，点「刷新」重试'
            : 'Could not load tasks. Tap Refresh to retry.';
        }
      }).catch(function () {});
    } catch (err) {}
  }, 3500);
})();
