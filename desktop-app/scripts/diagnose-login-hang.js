#!/usr/bin/env node
/* 诊断：网络挂起 / fetch 不响应取消时，登录态检测是否会卡死。 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-hang-'));
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
  const state = () => {
    try { return JSON.parse(fs.readFileSync(path.join(tmp, 'storage.json'), 'utf8')); }
    catch { return {}; }
  };

  console.log('=== 场景 A：内置浏览器页面读取永不返回（模拟窗口卡死 / 注入无响应）===');
  await host.page.evaluate(() => {
    window.__fetchCalls = 0;
    // v1.0.8：模拟内置窗口页面读取永不返回（窗口卡死 / IPC 挂起）
    window.readEmbeddedRewardsPage = () => { window.__fetchCalls++; return new Promise(() => {}); };
  });

  const t0 = Date.now();
  const probe = host.page.evaluate(async () => {
    try { return { done: true, status: await window.detectLogin(), ms: Date.now() - window.__t0 }; }
    catch (e) { return { done: false, error: String(e) }; }
  });
  await host.page.evaluate(() => { window.__t0 = Date.now(); });

  let resolved = false;
  const timeout = setTimeout(() => { resolved = true; console.log(`[${Date.now()-t0}ms] ⚠ detectLogin 仍未返回 → 卡死`); }, 16000);
  const result = await Promise.race([probe.then(v => ({ v })), sleep(17000).then(() => ({ hung: true }))]);
  clearTimeout(timeout);
  console.log(`[${Date.now()-t0}ms] detectLogin 结果:`, JSON.stringify(result).slice(0, 300));

  const st = state();
  console.log(`[${Date.now()-t0}ms] storage.loginStatus =`, st.loginStatus, ' checkedAt =', st.loginCheckedAt);
  const calls = await host.page.evaluate(() => window.__fetchCalls);
  console.log(`[${Date.now()-t0}ms] 内置页读取调用次数 =`, calls);

  console.log('\n=== 场景 B：徽标状态与消息通道 ===');
  const badge = await popup.page.evaluate(() => ({
    cls: document.getElementById('login-badge').className,
    text: document.getElementById('login-badge-text').textContent,
    btn: document.getElementById('btn-action').dataset.mode
  }));
  console.log('  徽标:', JSON.stringify(badge));

  const t1 = Date.now();
  const pong = await Promise.race([
    popup.page.evaluate(async () => await chrome.runtime.sendMessage({ type: '__ping' })),
    sleep(16000).then(() => ({ HUNG: true }))
  ]);
  console.log(`[${Date.now()-t1}ms] 普通消息 __ping:`, JSON.stringify(pong));

  const t2 = Date.now();
  const start = await Promise.race([
    popup.page.evaluate(async () => await chrome.runtime.sendMessage({ type: 'autoComplete', level: 3 })),
    sleep(16000).then(() => ({ HUNG: true }))
  ]);
  console.log(`[${Date.now()-t2}ms] autoComplete 应答:`, JSON.stringify(start));

  console.log('\n=== 场景 C：连续 3 次 checkLogin（模拟徽标轮询堆积）===');
  const t3 = Date.now();
  const polls = await Promise.race([
    Promise.all([1,2,3].map(() => popup.page.evaluate(async () =>
      await chrome.runtime.sendMessage({ type: 'checkLogin' })))),
    sleep(16000).then(() => [{ HUNG: true }])
  ]);
  console.log(`[${Date.now()-t3}ms] 3 次 checkLogin:`, JSON.stringify(polls).slice(0, 300));
  console.log('  最终内置页读取调用次数 =', await host.page.evaluate(() => window.__fetchCalls));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
