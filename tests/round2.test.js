/* 本轮七项需求深度回归：node --test tests/round2.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = require('../shared/hsa-core.js');
const ZIP = require('../shared/hsa-zip.js');
const HOVER = require('../shared/hsa-hover-tip.js');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const NOW = Date.UTC(2026, 10, 11, 4, 0, 0);

/* 不依赖第三方库解析 store 模式 zip，验证文件清单与内容。 */
function parseStoreZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eo = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eo = i; break; }
  }
  assert.ok(eo >= 0, '缺少 EOCD');
  const count = dv.getUint16(eo + 10, true);
  const cdOff = dv.getUint32(eo + 16, true);
  const dec = new TextDecoder();
  const out = {};
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014B50, 'central directory 签名');
    assert.equal(dv.getUint16(p + 10, true), 0, 'store 模式');
    const csize = dv.getUint32(p + 20, true);
    const fnlen = dv.getUint16(p + 28, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.slice(p + 46, p + 46 + fnlen));
    assert.equal(dv.getUint32(localOff, true), 0x04034B50, 'local header 签名');
    const lfn = dv.getUint16(localOff + 26, true);
    const lex = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lfn + lex;
    out[name] = dec.decode(u8.slice(start, start + csize));
    p += 46 + fnlen;
  }
  return { count, files: out };
}

test('R4 · buildZip 产出合法 HTML zip 包（manifest + 三页 HTML）', () => {
  const pages = [
    { name: 'dashboard', url: 'https://rewards.bing.com/dashboard', ok: true,
      status: 200, bytes: 15, html: '<html>dashboard</html>', collectedAt: NOW },
    { name: 'earn', url: 'https://rewards.bing.com/earn', ok: true,
      status: 200, bytes: 10, html: '<html>earn</html>', collectedAt: NOW },
    { name: 'bing-sidebar', url: 'https://cn.bing.com/rewards/panelflyout', ok: true,
      status: 200, bytes: 13, html: '<html>sidebar</html>', collectedAt: NOW }
  ];
  const built = CORE.keyPageZipFiles(pages, NOW, { platform: 'edge-extension' });
  const zip = ZIP.buildZip(built.files, NOW);
  const parsed = parseStoreZip(zip);
  assert.equal(parsed.count, 4);
  assert.deepEqual(Object.keys(parsed.files),
    ['manifest.json', 'dashboard.html', 'earn.html', 'bing-sidebar.html']);
  assert.equal(parsed.files['dashboard.html'], '<html>dashboard</html>');
  assert.equal(parsed.files['bing-sidebar.html'], '<html>sidebar</html>');
  const manifest = JSON.parse(parsed.files['manifest.json']);
  assert.equal(manifest.schema, 'hsa-keypages/2');
  assert.equal(manifest.pages.length, 3);
  assert.ok(manifest.capturedAtSystemTime);
  assert.equal(manifest.source, 'live-network');
  /* base64 往返必须保真，桌面端靠它跨 IPC 写二进制文件。 */
  assert.equal(ZIP.toBase64(ZIP.fromBase64(ZIP.toBase64(zip))), ZIP.toBase64(zip));
  assert.match(CORE.keyPageFileName(NOW), /^hsa-keypages-\d{8}-\d{6}\.zip$/);
});

test('R4 · 抓取失败页也保留占位 HTML，zip 文件数不减少', () => {
  const built = CORE.keyPageZipFiles([], NOW, { platform: 'desktop-app' });
  const zip = ZIP.buildZip(built.files, NOW);
  const parsed = parseStoreZip(zip);
  assert.equal(parsed.count, 4);
  assert.match(parsed.files['earn.html'], /capture failed/i);
  assert.match(parsed.files['bing-sidebar.html'], /panelflyout/);
});

test('R7 · 严格按截图任务列表 DOM 顺序，不受分组 / 积分 / 完成态影响', () => {
  const names = ['今日 Bing 搜索', '即将到来的喜剧活动', '阿德莱德春季葡萄酒之旅',
    '云形成类型', '你是否知道答案?', '足球传奇', '全是希腊的事',
    '晚餐创意', '您听说过这句箴言吗?', '每日箴言', '计划一次旅行', '锁与钥匙'];
  /* 故意打乱输入顺序，并给不同 section / 积分 / 完成态。 */
  const shuffled = names.map((name, i) => ({
    idx: i, name: name, section: i < 1 ? 'search' : i < 4 ? 'daily' : 'promo',
    points: i % 2 ? 5 : 10, completed: i % 3 === 0, scored: true
  })).reverse();
  const ordered = CORE.taskListNames(CORE.taskListOrder(shuffled));
  assert.deepEqual(ordered, names, '必须按截图从上到下依次执行');
  /* 分段滚动后补进来的卡片按 idx 归位，而不是追加到末尾。 */
  const late = CORE.taskListOrder([
    { idx: 4, name: '第5张' }, { idx: 0, name: '第1张' },
    { idx: 2, name: '第3张' }, { idx: 1, name: '第2张' }, { idx: 3, name: '第4张' }
  ]);
  assert.deepEqual(late.map(c => c.name),
    ['第1张', '第2张', '第3张', '第4张', '第5张']);
  /* 缺 idx 时按原顺序稳定兜底，不崩溃。 */
  assert.deepEqual(CORE.taskListOrder([{ name: 'A' }, { name: 'B' }]).map(c => c.name),
    ['A', 'B']);
});

test('R2/R3 · 日历复位与无积分周期禁跳', () => {
  const r = CORE.calendarReset(NOW);
  assert.equal(r.mode, 'day');
  assert.equal(r.cursor.getTime(), NOW);
  const hist = { '2026-10-05': { today: 12 }, '2026-11-11': { today: 8 } };
  assert.equal(CORE.calendarNavAllowed(hist, 'day', 2026, 10, -1, '2026-11-11'), true);
  assert.equal(CORE.calendarNavAllowed(hist, 'day', 2026, 10, 1, '2026-11-11'), false,
    '未来周期无记录，禁止跳转');
  assert.equal(CORE.calendarNavAllowed({}, 'day', 2026, 10, -1, '2026-11-11'), false);
  /* month 模式的 step 是「年」偏移：2026 → 2025 / 2027 都无记录。 */
  assert.equal(CORE.calendarNavAllowed(hist, 'month', 2026, 10, -1, '2026-11-11'), false);
  assert.equal(CORE.calendarNavAllowed(hist, 'month', 2026, 10, 0, '2026-11-11'), true);
  assert.equal(CORE.calendarNavAllowed(hist, 'month', 2026, 10, 1, '2026-11-11'), false);
  /* 未来日期的记录不算数 */
  assert.equal(CORE.calendarNavAllowed({ '2027-01-01': { today: 99 } },
    'month', 2026, 10, 1, '2026-11-11'), false);
});

test('R5 · 日志分类覆盖用户操作 / 运行过程 / 结果 / 错误 + 系统时间', () => {
  const cases = [
    { actor: 'user', category: 'user-action', event: 'user-action',
      detail: '用户点击「导出运行日志」', result: 'ok' },
    { actor: 'system', category: 'run-step', event: 'run-state',
      detail: 'phase=searching', state: 'searching' },
    { actor: 'system', category: 'result', event: 'run-state',
      detail: 'phase=completed', result: 'finished' },
    { actor: 'system', category: 'error', event: 'error',
      detail: '网络超时', error: 'Bing 没有响应', ok: false }
  ];
  let log = [];
  for (const c of cases) log = CORE.runLogAppend(log, c, NOW);
  assert.deepEqual(log.map(e => e.category),
    ['user-action', 'run-step', 'result', 'error']);
  assert.deepEqual(log.map(e => e.actor), ['user', 'system', 'system', 'system']);
  assert.ok(log.every(e => e.ts && e.iso && e.platform !== undefined));
  assert.equal(log[3].error, 'Bing 没有响应');
  assert.equal(log[3].ok, false);
  const ex = JSON.parse(CORE.runLogExport(log, { now: NOW, platform: 'desktop-app' }));
  assert.equal(ex.schema, 'hsa-runlog/2');
  assert.equal(ex.count, 4);
  assert.ok(ex.exportedAtSystemTime);
  /* 严格运行期允许写日志，但禁止抓取网页 */
  assert.equal(CORE.strictBlockedMessage('logUserAction', true), false);
  assert.equal(CORE.strictBlockedMessage('captureKeyPages', true), true);
});

test('R1 · 悬浮框共享实现：挂到 <html> 且强制最高层级', () => {
  const src = read('shared/hsa-hover-tip.js');
  assert.match(src, /d\.documentElement\.appendChild\(tip\)/);
  assert.match(src, /2147483647/);
  assert.match(src, /dataset\.short/);
  assert.equal(typeof HOVER.install, 'function');
  const css = read('shared/hsa-shared.css');
  assert.match(css, /position: fixed !important/);
  assert.match(css, /z-index: 2147483647 !important/);
  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    const s = read(p);
    assert.match(s, /HSA_HOVER_TIP\.install\(document\)/);
    assert.ok(!s.includes('function initHoverTips()'),
      p + ' 不应再保留各自的实现');
  }
});

test('R6 · Windows 与 Ubuntu 输出到同一目录且固定文件名覆盖', () => {
  const linux = read('desktop-app/electron-builder.yml');
  const win = read('desktop-app/electron-builder.win.yml');
  for (const yml of [linux, win]) {
    assert.match(yml, /output: \.\.\/release/);
    assert.doesNotMatch(yml, /artifactName:.*\$\{version\}/,
      '文件名不能带版本号，否则不会覆盖原文件');
  }
  assert.match(linux, /HumanSearchAssistant-Ubuntu\.\$\{ext\}/);
  assert.match(win, /HumanSearchAssistant-Windows\.\$\{ext\}/);
  assert.match(win, /HumanSearchAssistant-Windows-Portable\.\$\{ext\}/);
  const winBuild = read('desktop-app/scripts/build-win-safe.js');
  const sh = read('desktop-app/scripts/build-linux.sh');
  assert.match(winBuild, /const outputRel = '\.\.\/release'/);
  assert.match(winBuild, /overwriteOutput\s*:\s*true/);
  assert.ok(!winBuild.includes('uniqueOutput'), '不再按时间戳生成独立目录');
  assert.match(sh, /release/);
  assert.match(sh, /HumanSearchAssistant-Ubuntu\.deb/);
  assert.ok(!sh.includes('rm -f "$ROOT/dist"/HumanSearchAssistant'),
    '不应先删旧产物，直接覆盖');
});

test('R1–R7 · 两端源码接线一致', () => {
  for (const b of ['edge-extension/background.js', 'desktop-app/src/background.js']) {
    const s = read(b);
    assert.match(s, /HSA_CORE\.keyPageZipFiles/);
    assert.match(s, /ZIP\.toBase64\(zip\)/);
    assert.match(s, /encoding: 'base64'/);
    assert.match(s, /msg\.type === 'logUserAction'/);
    assert.match(s, /actor: 'user'/);
    assert.match(s, /category: isError \? 'error' : isResult \? 'result' : 'run-step'/);
    assert.match(s, /file: page\.file/);
    assert.match(s, /page\.url \|\| \(p\.origin \+ page\.path\)/);
  }
  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    const s = read(p);
    assert.match(s, /function logUserAction\(/);
    assert.match(s, /logUserAction\(type, summarize\(extra\)\)/);
    assert.match(s, /HSA_CORE\.calendarReset\(\)/);
    assert.match(s, /HSA_CORE\.calendarNavAllowed\(/);
    assert.match(s, /btn\.disabled = empty/);
    assert.match(s, /r\.encoding === 'base64'/);
    assert.match(s, /application\/zip/);
  }
  const main = read('desktop-app/main.js');
  assert.match(main, /HSA_CORE\.taskListOrder/);
  assert.match(main, /Buffer\.from\(String\(content \|\| ''\), 'base64'\)/);
  assert.match(read('desktop-app/lib/sidebar-task-cards.js'),
    /严格按侧栏 DOM 顺序/);
});
