/* v2.3 专项单测：node --test tests/v23.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CORE = require('../shared/hsa-core.js');
const ZIP = require('../shared/hsa-zip.js');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* 最小 ZIP 解析器（store 模式）：从 EOCD → 中央目录 → 本地头读出文件名与内容。 */
function parseZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, '缺少 EOCD');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, '中央目录签名');
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    assert.equal(dv.getUint32(localOff, true), 0x04034b50, '本地文件头签名');
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const size = dv.getUint32(localOff + 22, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    files.push({ name, data: dec.decode(bytes.subarray(start, start + size)) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

test('v2.3 · HSA_ZIP 真实打包：三页 HTML + manifest，可解包且内容完整', () => {
  const pages = [
    { name: 'dashboard', path: '/dashboard', file: 'dashboard.html',
      url: 'https://rewards.bing.com/dashboard', ok: true, status: 200,
      html: '<html><body>dashboard 实时</body></html>', collectedAt: 1 },
    { name: 'earn', path: '/earn', file: 'earn.html',
      url: 'https://rewards.bing.com/earn', ok: true, status: 200,
      html: '<html><body>earn 实时</body></html>', collectedAt: 1 },
    { name: 'bing-sidebar', path: '/rewards/panelflyout', file: 'bing-sidebar.html',
      url: 'https://cn.bing.com/rewards/panelflyout', ok: true, status: 200,
      html: '<html><body>侧栏 实时</body></html>', collectedAt: 1 }
  ];
  const built = CORE.keyPageZipFiles(pages, 1, { platform: 'desktop-app' });
  const bytes = ZIP.buildZip(built.files, 1);
  assert.ok(bytes instanceof Uint8Array && bytes.length > 100);
  const files = parseZip(bytes);
  assert.deepEqual(files.map(f => f.name),
    ['manifest.json', 'dashboard.html', 'earn.html', 'bing-sidebar.html']);
  assert.match(files[1].data, /dashboard 实时/);
  assert.match(files[2].data, /earn 实时/);
  assert.match(files[3].data, /侧栏 实时/);
  const manifest = JSON.parse(files[0].data);
  assert.equal(manifest.schema, 'hsa-keypages/2');
  assert.equal(manifest.pages.length, 3);
  assert.equal(manifest.source, 'live-network');
  /* base64 往返：跨 IPC / 下载链路不会损坏二进制 */
  const b64 = ZIP.toBase64(bytes);
  const back = ZIP.fromBase64(b64);
  assert.equal(back.length, bytes.length);
  assert.deepEqual(Array.from(back.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual(parseZip(back).map(f => f.name), files.map(f => f.name));
});

test('v2.3 · 悬浮提示：两端共享单一实现，挂 <html> 且最高层级', () => {
  const mod = read('shared/hsa-hover-tip.js');
  assert.match(mod, /HSA_HOVER_TIP/);
  assert.match(mod, /documentElement\.appendChild\(tip\)/);
  assert.match(mod, /'z-index', '2147483647', 'important'/);
  assert.match(mod, /'position', 'fixed', 'important'/);
  assert.match(mod, /dataset\.short/);
  assert.match(mod, /data-tip-role="hint"/);
  for (const h of ['edge-extension/popup.html', 'desktop-app/src/popup.html']) {
    const s = read(h);
    assert.match(s, /hsa-hover-tip\.js/);
    assert.ok(s.indexOf('hsa-hover-tip.js') < s.indexOf('popup.js'), h + ' 共享脚本须先加载');
  }
  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    const s = read(p);
    assert.match(s, /HSA_HOVER_TIP\.install\(document\)/);
    assert.doesNotMatch(s, /function initHoverTips\(/);
  }
  assert.match(read('shared/hsa-shared.css'), /z-index: 2147483647 !important/);
});

test('v2.3 · 日历：无积分记录的周期禁止跳转，打开设置自动复位', () => {
  const hist = { '2026-11-01': { today: 12 }, '2026-10-03': 15 };
  assert.equal(CORE.calendarNavAllowed(hist, 'day', 2026, 10, -1, '2026-11-11'), true);
  assert.equal(CORE.calendarNavAllowed(hist, 'day', 2026, 10, 1, '2026-11-11'), false);
  assert.equal(CORE.calendarNavAllowed(hist, 'day', 2026, 10, -2, '2026-11-11'), false);
  assert.equal(CORE.calendarNavAllowed({}, 'day', 2026, 10, -1, '2026-11-11'), false);
  const r = CORE.calendarReset();
  assert.equal(r.mode, 'day');
  assert.ok(r.cursor instanceof Date);
  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    const s = read(p);
    assert.match(s, /HSA_CORE\.calendarNavAllowed\(lastCalHist/);
    assert.match(s, /logUserAction\('calendar-nav-blocked'/);
    assert.match(s, /function openSettings\(\)[\s\S]{0,220}resetCalendar\(\)/);
    assert.match(s, /HSA_CORE\.calendarReset\(\)/);
    assert.match(s, /'calendar\.navBlocked'/);
  }
  for (const h of ['edge-extension/popup.html', 'desktop-app/src/popup.html']) {
    assert.match(read(h), /id="cal-nav-msg"/);
  }
});

test('v2.3 · 任务卡严格按任务列表顺序依次执行', () => {
  const cards = [{ name: 'C', idx: 9 }, { name: 'A', idx: 1 }, { name: 'B', idx: 5 }];
  assert.deepEqual(CORE.taskListOrder(cards).map(c => c.name), ['A', 'B', 'C']);
  const stable = CORE.taskListOrder([
    { name: 'X', domOrder: 2 }, { name: 'Y', domOrder: 1 }, { name: 'Z' }
  ]);
  assert.deepEqual(stable.map(c => c.name), ['Y', 'X', 'Z']);
  assert.equal(CORE.taskListNames(cards).join(' → '), 'A → B → C');
  const main = read('desktop-app/main.js');
  assert.match(main, /HSA_CORE\.taskListOrder\(/);
  assert.match(main, /HSA_CORE\.taskListNames\(/);
  assert.match(read('desktop-app/lib/sidebar-task-cards.js'), /domOrder/);
  const bg = read('desktop-app/src/background.js');
  assert.match(bg, /HSA_CORE\.taskListNames\(HSA_CORE\.taskListOrder\(idxItems\)\)/);
  assert.match(bg, /hsaRunLog\('task-list'/);
  assert.match(bg, /hsaRunLog\('task-list-result'/);
  assert.match(bg, /已按列表顺序点击/);
});

test('v2.3 · 运行日志：系统时间 / 用户操作 / 运行过程 / 结果 / 错误', () => {
  const at = Date.UTC(2026, 10, 10, 17, 52, 7, 321);
  const e = CORE.runLogAppend([], {
    event: 'user-action', actor: 'user', category: 'user-action',
    action: 'start', detail: 'count=30', result: 'ok', level: 'info',
    error: '', zh: '用户点击开始', state: 'running'
  }, at)[0];
  assert.ok(e.ts && e.iso);
  assert.match(e.ts, /\d{4}-\d{2}-\d{2}/);
  assert.equal(e.actor, 'user');
  assert.equal(e.category, 'user-action');
  assert.equal(e.detail, 'count=30');
  assert.equal(e.result, 'ok');
  const err = CORE.runLogAppend([], {
    event: 'error', level: 'error', category: 'error',
    result: 'failed', error: 'network timeout', zh: '网络超时'
  }, at)[0];
  assert.equal(err.level, 'error');
  assert.equal(err.result, 'failed');
  assert.equal(err.error, 'network timeout');
  for (const p of ['edge-extension/popup.js', 'desktop-app/src/popup.js']) {
    assert.match(read(p), /function logUserAction\(/);
    assert.match(read(p), /logUserAction\(type, summarize\(extra\)\)/);
    assert.match(read(p), /logUserAction\('openSettings'/);
  }
  for (const b of ['edge-extension/background.js', 'desktop-app/src/background.js']) {
    const s = read(b);
    assert.match(s, /msg\.type === 'logUserAction'/);
    assert.match(s, /hsaRunLog\('run-state'|hsaRunLog\('activity'/);
    assert.match(s, /category: 'error'|category: 'result'/);
  }
});

test('v2.3 · Windows 与 Ubuntu 编译产物同目录、固定文件名直接覆盖', () => {
  for (const p of ['desktop-app/electron-builder.yml', 'desktop-app/electron-builder.win.yml']) {
    const s = read(p);
    assert.match(s, /output: \.\.\/release/);
    assert.doesNotMatch(s, /\$\{version\}/);
    assert.match(s, /artifactName: HumanSearchAssistant-(Ubuntu|Windows)[^\n]*\.\$\{ext\}/);
    assert.match(s, /shared\/\*\*\/\*/);
  }
  const win = read('desktop-app/scripts/build-win-safe.js');
  assert.match(win, /const outputRel = '\.\.\/release'/);
  assert.doesNotMatch(win, /windows-builds|win-\$\{stamp\}/);
  assert.match(win, /overwriteOutput\s*:\s*true/);
  const linux = read('desktop-app/scripts/build-linux.sh');
  assert.match(linux, /release/);
  assert.match(linux, /rm -f/);
});

test('v2.3 · 严格模式衔接：日志导出 / 用户操作放行，抓取网页仍禁用', () => {
  assert.equal(CORE.strictBlockedMessage('exportRunLog', true), false);
  assert.equal(CORE.strictBlockedMessage('logUserAction', true), false);
  assert.equal(CORE.strictBlockedMessage('captureKeyPages', true), true);
  assert.equal(CORE.strictAlarmAllowed('watchdog', true), false);
  assert.equal(CORE.strictAlarmAllowed('cooldownEnd', true), true);
  assert.ok(CORE.STRICT_RUN.keptGuardrails.includes('stop'));
});
