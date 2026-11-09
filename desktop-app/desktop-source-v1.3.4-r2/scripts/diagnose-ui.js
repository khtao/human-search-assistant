#!/usr/bin/env node
/* 诊断：真实页面里设置项是否可点、有无脚本异常、hover 动画是否生效。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-ui-diag-'));
process.env.HSA_HEADLESS = '1';
process.env.HSA_USER_DATA = tmp;
require('../main.js');
const lite = require('../lib/electron-lite');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await sleep(6000);
  const popup = lite._pages().find(p => p.url.includes('popup.html'));
  const errors = [];
  if (popup.page.on) {
    popup.page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    popup.page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  }
  await popup.page.evaluate(() => location.reload()).catch(() => {});
  await sleep(2500);

  console.log('=== 1. 脚本异常 ===');
  console.log(errors.length ? errors.join('\n') : '  无');

  console.log('\n=== 2. 打开设置面板 ===');
  const openState = await popup.page.evaluate(() => {
    const btn = document.getElementById('settings-open');
    btn.click();
    return { btn: !!btn, panel: document.getElementById('settings').className,
      display: getComputedStyle(document.getElementById('settings')).transform };
  });
  console.log(' ', JSON.stringify(openState));

  console.log('\n=== 3. 点击「50」次数上限 ===');
  const before = await popup.page.evaluate(async () =>
    (await chrome.storage.local.get(['autoTasks'])).autoTasks);
  console.log('  改前:', JSON.stringify(before));
  await popup.page.evaluate(() => {
    const b = document.querySelector('#set-auto-count-chips button[data-value="50"]');
    b.click();
  });
  await sleep(600);
  const after = await popup.page.evaluate(async () => ({
    stored: (await chrome.storage.local.get(['autoTasks'])).autoTasks,
    checked: [...document.querySelectorAll('#set-auto-count-chips button')]
      .map(b => b.getAttribute('aria-checked')),
    msg: document.getElementById('set-auto-msg').textContent
  }));
  console.log('  改后:', JSON.stringify(after));

  console.log('\n=== 4. 点「添加」时间点（留空）===');
  await popup.page.evaluate(() => document.getElementById('set-auto-time-add').click());
  await sleep(600);
  const times = await popup.page.evaluate(async () => ({
    stored: (await chrome.storage.local.get(['autoTasks'])).autoTasks,
    chips: [...document.querySelectorAll('#set-auto-times .time-chip')].map(c => c.textContent),
    msg: document.getElementById('set-auto-msg').textContent,
    err: document.getElementById('set-auto-msg').hidden
  }));
  console.log(' ', JSON.stringify(times));

  console.log('\n=== 5. 总开关与 pointer-events ===');
  const pe = await popup.page.evaluate(() => {
    const o = document.getElementById('auto-opts');
    return { off: o.classList.contains('off'), pointerEvents: getComputedStyle(o).pointerEvents,
      title: o.getAttribute('title'),
      childPE: getComputedStyle(document.getElementById('set-auto-time-add')).pointerEvents };
  });
  console.log(' ', JSON.stringify(pe));

  console.log('\n=== 6. 进度圆圈 hover 前/后计算样式 ===');
  const hov = await popup.page.evaluate(async () => {
    const wrap = document.querySelector('.ring-wrap');
    const halo = document.querySelector('.progress-halo');
    const before = { transform: getComputedStyle(wrap).transform,
      haloOpacity: getComputedStyle(halo).opacity,
      title: wrap.getAttribute('title') };
    wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return { before, ringTitle: wrap.parentElement.getAttribute('title'),
      tipCount: document.querySelectorAll('.tip').length };
  });
  console.log(' ', JSON.stringify(hov));

  console.log('\n=== 累计脚本异常 ===');
  console.log(errors.length ? errors.join('\n') : '  无');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
