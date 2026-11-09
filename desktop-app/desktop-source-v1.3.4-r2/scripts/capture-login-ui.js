#!/usr/bin/env node
/* 生成修复后的首页截图：未登录 / 已登录两态，用于交付说明。 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-ui-'));
process.env.HSA_HEADLESS = '1';
process.env.HSA_USER_DATA = tmp;
require('../main.js');
const lite = require('../lib/electron-lite');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await sleep(6000);
  const popup = lite._pages().find(p => p.url.includes('popup.html'));
  const out = '/data/workspace';

  async function shot(file, loginStatus, points) {
    await popup.page.evaluate(async ({ s, p }) => {
      await chrome.storage.local.set({
        uiLang: 'zh',
        loginStatus: s, loginCheckedAt: Date.now(),
        running: false, phase: 'idle', error: null, autoResult: null,
        pointsSummary: p,
        todayTasks: { items: [], earned: 0, total: 0, percent: 0,
          signedOut: s === 'out', approx: false, updatedAt: Date.now() }
      });
    }, { s: loginStatus, p: points });
    await sleep(1200);
    await popup.page.screenshot({ path: path.join(out, file), fullPage: false });
    console.log('已生成', file);
  }

  await shot('修复后-未登录.png', 'out',
    { available: null, today: null, claimable: null, signedOut: true, updatedAt: Date.now() });
  await shot('修复后-已登录.png', 'in',
    { available: 20182, today: 36, claimable: 0, signedOut: false, updatedAt: Date.now() });

  // 真实鼠标悬停进度圆圈：展示信息卡 + 加强后的光环动画
  await popup.page.evaluate(async () => {
    await chrome.storage.local.set({
      uiLang: 'zh', loginStatus: 'in', loginCheckedAt: Date.now(),
      running: false, phase: 'idle', error: null,
      pointsSummary: { available: 20192, today: 257, claimable: 0, signedOut: false, updatedAt: Date.now() },
      todayTasks: { items: [
        { name: '今日 Bing 搜索', section: 'search', points: 60, earned: 60, total: 60, description: '' },
        { name: '每日活动', section: 'daily', points: 30, earned: 30, total: 30, description: '' }
      ], earned: 90, total: 90, percent: 100, signedOut: false, approx: false, updatedAt: Date.now() }
    });
  });
  await sleep(1200);
  if (popup.page.hover) await popup.page.hover('.ring-wrap');
  await sleep(700);
  await popup.page.screenshot({ path: '/data/workspace/修复后-进度圈悬停.png', fullPage: false });
  console.log('已生成 修复后-进度圈悬停.png');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
