/* ============================================================================
 * runtime-budget.js · 桌面版专用内存/效率预算（仅 desktop-app，插件版不使用）
 *
 * Electron 常驻多个渲染进程，瓶颈不在「缓存几个字符串」，而在：
 *   · 每条运行日志都触发一次全量 state JSON 同步写盘（含 2 份 600KB 快照）；
 *   · 后台取数的离屏 WebContentsView 创建后永不释放，长期占着 renderer；
 *   · 调试关闭时仍每次导航都读整页 outerHTML，制造大字符串 GC 压力。
 *
 * 本模块提供纯逻辑（零 Electron 依赖，可离线单测）：
 *   · makeWriteThrottle  —— 前导立即写 + 尾随合并写，退出时强制 flush；
 *   · diskState          —— 落盘副本裁剪大快照，内存态保持完整；
 *   · shouldReleaseIdleView —— 离屏数据视图空闲回收判定。
 * ========================================================================== */
'use strict';

const POLICY = Object.freeze({
  stateWriteMinGapMs: 150,          // 合并窗口：最多约 6~7 次全量写/秒
  diskSnapshotHtmlBytes: 256 * 1024, // 落盘快照上限（内存态不裁）
  diskSnapshotTextBytes: 32 * 1024,
  runLogEntries: 240,               // 桌面持久化日志上限（插件 180）
  usedWordsMax: 160,                // 桌面历史词上限（插件 120）
  officialHtmlBytes: 256 * 1024,    // 官网 HTML 读取上限（原 600KB）
  dataViewIdleMs: 90 * 1000,        // 离屏取数视图空闲 90s 后释放
  debugHtmlWhenIdle: false          // 调试关闭时不读整页 outerHTML
});

/**
 * 前导 + 尾随节流写盘。首次 save 立即同步写（保证启动校验可见），
 * 高频连续 save 合并成一次尾随写；flush() 用于进程退出前强制落盘。
 * io = { now(), write(), schedule(fn, ms), cancel(id) }
 */
function makeWriteThrottle(io) {
  let last = 0, timer = null, writes = 0;
  const gap = POLICY.stateWriteMinGapMs;
  function doWrite() {
    last = io.now();
    writes++;
    io.write();
  }
  return Object.freeze({
    save() {
      const n = io.now();
      if (timer != null) return;              // 已有尾随写排队，不重复排队
      if (n - last >= gap) { doWrite(); return; }
      timer = io.schedule(() => { timer = null; doWrite(); }, Math.max(1, gap - (n - last)));
    },
    flush() {
      if (timer != null) { io.cancel(timer); timer = null; }
      doWrite();
    },
    stats() { return { writes, pending: timer != null, last }; }
  });
}

/** 生成落盘副本：只裁大快照，不改动内存里的 state。 */
function diskState(state) {
  const out = Object.assign({}, state || {});
  const keys = ['visibleRewardsSnapshot', 'visibleRewardsEarnSnapshot'];
  for (const k of keys) {
    const s = out[k];
    if (!s || typeof s !== 'object') continue;
    let copy = null;
    if (typeof s.html === 'string' && s.html.length > POLICY.diskSnapshotHtmlBytes) {
      copy = Object.assign({}, s, {
        html: s.html.slice(0, POLICY.diskSnapshotHtmlBytes), htmlTruncated: true
      });
    }
    if (typeof s.text === 'string' && s.text.length > POLICY.diskSnapshotTextBytes) {
      copy = Object.assign({}, copy || s, {
        text: s.text.slice(0, POLICY.diskSnapshotTextBytes)
      });
    }
    if (copy) out[k] = copy;
  }
  if (Array.isArray(out.runLog) && out.runLog.length > POLICY.runLogEntries) {
    out.runLog = out.runLog.slice(-POLICY.runLogEntries);
  }
  return out;
}

/** 离屏数据视图是否该释放：运行中 / 面板可见时绝不释放。 */
function shouldReleaseIdleView(lastUsedAt, now, busy) {
  if (busy) return false;
  const t = Number(now) || Date.now();
  /* 没有访问时间戳的视图视为「刚创建」，不参与空闲回收。 */
  if (lastUsedAt == null || lastUsedAt === '') return false;
  const used = Number(lastUsedAt);
  if (!Number.isFinite(used)) return false;
  return t - used >= POLICY.dataViewIdleMs;
}

function trimUsedWords(list) {
  return Array.isArray(list) ? list.slice(-POLICY.usedWordsMax) : [];
}

function trimLog(list) {
  return Array.isArray(list) ? list.slice(-(POLICY.runLogEntries - 1)) : [];
}

module.exports = Object.freeze({
  VERSION: '1.0.0',
  POLICY,
  makeWriteThrottle,
  diskState,
  shouldReleaseIdleView,
  trimUsedWords,
  trimLog
});
