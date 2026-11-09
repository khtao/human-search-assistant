#!/usr/bin/env node
/* 诊断：模拟首页点击「自动完成任务」，观察未登录/网络异常时的状态推进。 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-diag-'));
process.env.HSA_HEADLESS = '1';
process.env.HSA_USER_DATA = tmp;

require('../main.js');
const lite = require('../lib/electron-lite');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await sleep(6000);
  const pages = lite._pages();
  const host = pages.find(p => p.url.includes('host.html'));
  const popup = pages.find(p => p.url.includes('popup.html'));
  const logs = [];
  host.page.on('console', m => {
    if (m.type() === 'log' || m.type() === 'info' || m.type() === 'warning' || m.type() === 'error') {
      logs.push(`[${m.type()}] ${m.text()}`);
    }
  });

  console.log('=== 初始 storage ===');
  console.log(fs.readFileSync(path.join(tmp, 'storage.json'), 'utf8').slice(0, 600));

  // 模拟点击：popup 发 autoComplete 消息（与 popup.js 完全一致）
  const t0 = Date.now();
  console.log('\n=== 发送 autoComplete（t=0s）===');
  popup.page.evaluate(() => chrome.runtime.sendMessage({ type: 'autoComplete', level: 3, count: 30 }))
    .then(r => console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] popup 收到响应:`, JSON.stringify(r)))
    .catch(e => console.log('popup 消息异常:', e.message));

  for (const sec of [2, 5, 10, 20, 35, 55, 75]) {
    await sleep((sec - (Date.now() - t0) / 1000) * 1000 > 0 ? (sec - (Date.now() - t0) / 1000) * 1000 : 0);
    let st = {};
    try { st = JSON.parse(fs.readFileSync(path.join(tmp, 'storage.json'), 'utf8')); } catch {}
    const keys = ['running', 'phase', 'authState', 'pointsSummary', 'todayTasks', 'taskSync', 'error', 'warning', 'lastActivity'];
    const snap = {};
    for (const k of keys) if (st[k] !== undefined) snap[k] = st[k];
    const winCount = lite._pages().length;
    console.log(`\n[${((Date.now()-t0)/1000).toFixed(1)}s] 窗口=${winCount} 状态=${JSON.stringify(snap).slice(0, 420)}`);
    const recent = logs.slice(-4);
    if (recent.length) console.log('  最近日志: ' + recent.join(' | ').slice(0, 600));
  }

  console.log('\n=== 全部后台日志（前 40 条）===');
  logs.slice(0, 40).forEach(l => console.log('  ' + l.slice(0, 220)));
  console.log(`\n总耗时 ${((Date.now()-t0)/1000).toFixed(1)}s，日志 ${logs.length} 条`);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
