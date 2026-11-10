/* S02=D：启动卡住自动纠正统一由 shared/hsa-recovery.js 提供。
   一次性超时检查 + 状态变化复检 + 只有确定卡住才限时重试；不再每秒轮询。 */
(function () {
  try {
    var rec = globalThis.HSA_RECOVERY;
    if (rec && typeof rec.install === 'function') rec.install();
  } catch (err) {}
})();
