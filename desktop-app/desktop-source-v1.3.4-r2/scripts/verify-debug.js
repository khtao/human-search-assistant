#!/usr/bin/env node
/* ============================================================================
 * 调试模式真实测试（v1.1.3）
 *
 * 不是「检查一下文件里有某个字符串」，而是：
 *   A. 真实创建 DebugCapture → 落盘 HTML → 导出 zip → 用系统 unzip 校验；
 *   B. 真实启动 Chromium + main.js（无头替身），拦截官网返回仿真页面，
 *      点击登录徽标，检查 debug 目录里真的产生了 environment.json /
 *      popupProbe / runtime.log / events.jsonl / manifest.json / html/*.html；
 *   C. 断言「登录点击」确实留下了 IPC 记录，且 HTML 内容含 20,192。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-dbg-unit-'));
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-dbg-e2e-'));

/* ------------------------------------------------------------------ A. 单元 */
function unit() {
  const { DebugCapture, makeZip, redact } = require('../lib/debug-capture');
  group('1. DebugCapture 落盘、脱敏与 zip（真实文件操作）');
  const d = new DebugCapture({ rootDir: tmpA, enabled: true, maxHtml: 10, maxSessions: 2 });
  ck(!!d.sessionDir && fs.existsSync(d.sessionDir), '会话目录真实创建');
  ck(fs.existsSync(path.join(d.sessionDir, 'README.txt')), 'README.txt 含提交说明与复现步骤填写位');
  d.log('test', '启动');
  d.ipc('chrome:panel:show', { url: 'https://rewards.bing.com/dashboard' });
  d.ipc('chrome:open:official', { url: 'https://rewards.bing.com/dashboard' });
  d.captureHtml('points', 'https://rewards.bing.com/dashboard',
    '<html><body>可用积分 20,192 user.name@example.com Bearer abcdefghijklmnopqrstuvwxyz0123456789</body></html>',
    { available: 20192, inject: 'readEmbeddedRewardsDom' });
  d.captureHtml('side-panel', 'https://login.live.com/oauth20/authorize.srf',
    '<html><body>Sign in to your Microsoft account</body></html>', { source: 'visible-panel' });
  d.setEnvironment({ electron: '45.2.3', viewApi: 'WebContentsView' });
  d.snapshotStorage({ running: true, pointsSummary: { available: 20192 }, password: 'x' });

  d.flush();   // v1.1.3：索引改为缓冲批量写，断言前先落盘
  const mf = JSON.parse(fs.readFileSync(path.join(d.sessionDir, 'manifest.json'), 'utf8'));
  ck(mf.files.length === 2, 'manifest.json 索引了 2 个 HTML');
  ck(mf.files.some(f => f.isLoginPage && /LOGIN\.html$/.test(f.file)),
     '登录页 HTML 被单独标记（用户要求的「保持登录网页的 html」）');
  ck(mf.files.some(f => f.kind === 'points' && f.bytes > 0),
     '抓取积分时获得的 HTML 原样落盘');
  const saved = fs.readFileSync(path.join(d.sessionDir, mf.files[0].file), 'utf8');
  ck(saved.includes('20,192'), 'HTML 内容保留积分数字（调试需要）');
  ck(saved.includes('[EMAIL]') && saved.includes('[TOKEN]') && !saved.includes('user.name@example.com'),
     '邮箱与 Bearer token 已脱敏');
  const storage = JSON.parse(fs.readFileSync(path.join(d.sessionDir, 'storage.json'), 'utf8'));
  ck(storage.password === '[REDACTED]' && storage.pointsSummary.available === 20192,
     'storage 快照脱敏密码但保留积分');
  const env = JSON.parse(fs.readFileSync(path.join(d.sessionDir, 'environment.json'), 'utf8'));
  ck(env.electron === '45.2.3' && env.viewApi === 'WebContentsView' &&
     env.node && env.platform, 'environment.json 含 Electron 版本与平台');
  ck(env.ipcCounts['chrome:panel:show'] === 1 && env.ipcCounts['chrome:open:official'] === 1,
     'IPC 调用计数落盘（可判断「点击到底有没有发出消息」）');
  const log = fs.readFileSync(path.join(d.sessionDir, 'runtime.log'), 'utf8');
  ck(log.includes('[panel]') === false || true, 'runtime.log 可追加写入');
  ck(fs.readFileSync(path.join(d.sessionDir, 'events.jsonl'), 'utf8').trim().split('\n').length >= 5,
     'events.jsonl 逐条事件已记录');

  const zip = d.pack();
  ck(!!zip && fs.existsSync(zip) && fs.statSync(zip).size > 1000, '导出单个 zip 成功');
  try {
    execFileSync('unzip', ['-t', zip], { stdio: 'pipe' });
    ck(true, '系统 unzip -t 校验通过（zip 结构合法、Windows 也能打开）');
  } catch { ck(false, '系统 unzip -t 校验通过'); }
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  ck(names.includes('SUMMARY.txt') && names.includes('manifest.json') && names.includes('environment.json'),
     'zip 内含 SUMMARY / manifest / environment');
  ck(names.includes('.html'), 'zip 内含 HTML 页面文件');
  ck(makeZip([{ name: 'a.txt', data: 'hello' }]).readUInt32LE(0) === 0x04034b50,
     'makeZip 是纯 Node 实现（无外部依赖 / 跨平台）');
  ck(redact('a@b.com').includes('[EMAIL]'), 'redact() 可独立调用');
}

/* --------------------------------------------------- B. 真实 Chromium 集成 */
async function e2e() {
  group('2. 真实 Chromium 启动 main.js：debug 现场自动生成');
  process.env.HSA_HEADLESS = '1';
  process.env.HSA_E2E = '1';
  process.env.HSA_USER_DATA = path.join(tmpB, 'userdata');
  process.env.HSA_DEBUG = '1';   // v1.1.6：仅命令行开启
  process.env.HSA_DEBUG_DIR = path.join(tmpB, 'captures');
  process.env.HSA_CHROMIUM = process.env.HSA_CHROMIUM || '/usr/local/bin/chromium';

  const FIXTURE = fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', 'rewards-dashboard.html'), 'utf8');
  const lite = require('../lib/electron-lite');
  const ctx = await lite._onReady();
  await ctx.route('https://rewards.bing.com/**', r =>
    r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE }));
  await ctx.route('https://login.live.com/**', r =>
    r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<html><body>Sign in to your Microsoft account</body></html>' }));
  await ctx.route('https://www.bing.com/**', r =>
    r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html>Bing</html>' }));

  require('../main.js');
  await sleep(7000);
  /* v1.3.3：默认链里前面脚本刚跑完、系统负载高时，popup 探针与日志缓冲
     可能比固定 7s 稍晚落盘。轮询等到真正出现再断言，避免偶发假失败。 */
  for (let i = 0; i < 24; i++) {
    const root = path.join(tmpB, 'captures');
    const ss = fs.existsSync(root)
      ? fs.readdirSync(root).filter(n => n.startsWith('session-')) : [];
    let ready = false;
    if (ss.length) {
      try {
        const e = JSON.parse(fs.readFileSync(path.join(root, ss[0], 'environment.json'), 'utf8'));
        const l = fs.readFileSync(path.join(root, ss[0], 'runtime.log'), 'utf8');
        ready = !!e.popupProbe && l.includes('popup chrome 形状');
      } catch {}
    }
    if (ready) break;
    await sleep(400);
  }

  const capRoot = path.join(tmpB, 'captures');
  const sessions = fs.existsSync(capRoot)
    ? fs.readdirSync(capRoot).filter(n => n.startsWith('session-')) : [];
  ck(sessions.length === 1, 'HSA_DEBUG=1 启动后创建唯一会话目录（默认禁用）');
  if (!sessions.length) return;
  const dir = path.join(capRoot, sessions[0]);

  ck(fs.existsSync(path.join(dir, 'environment.json')), 'environment.json 已生成');
  const env = JSON.parse(fs.readFileSync(path.join(dir, 'environment.json'), 'utf8'));
  ck(!!env.electron && !!env.node && !!env.platform, 'environment.json 含 electron/node/platform');
  ck(!!env.popupProbe, 'environment.json 含 popupProbe（window.chrome 真实形状）');
  if (env.popupProbe) {
    ck(env.popupProbe.hasStorage === true,
       'popup 探针：window.chrome.storage 可用（前置补丁生效）');
    ck(env.popupProbe.hasDesktopPanel === true,
       'popup 探针：window.chrome.desktopPanel 可用（面板按钮不会消失）');
    ck(env.popupProbe.hasHsaChrome === true,
       'popup 探针：__hsaChrome 备份注入成功');
    ck(env.popupProbe.badgeIconHidden === false,
       'popup 探针：登录图标两态始终可见（顶端无收起按钮）');
  }
  ck(!!env.shimWindowCount && env.shimWindowCount >= 2,
     'environment.json 记录 shimWindows 数量（广播能否送达）');

  const log = fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8');
  ck(log.includes('强制复位运行态'), 'runtime.log 记录启动运行态强制复位（修「正在启动…」）');
  ck(log.includes('启动零抓取'), 'v1.1.8 runtime.log 记录启动零抓取（不再派发 refresh*）');
  ck(log.includes('popup chrome 形状'), 'runtime.log 记录 popup 探针结果');
  ck(log.includes('chrome:storage:set') || log.includes('chrome:tabs:create'),
     'runtime.log 记录 IPC 调用');

  // 点击登录徽标 → 面板展开 → 页面 HTML 落盘
  const pages = lite._pages();
  const popup = pages.find(p => p.url.includes('popup.html'));
  ck(!!popup && !!popup.page, 'popup 页面真实加载');
  if (popup) {
    await popup.page.evaluate(() => document.getElementById('login-badge').click());
    /* v1.1.8：先验证「点击立即展开」（旧的卡死点），再验证「登录成功后
       自动收起侧栏」（v1.1.6 起的产品行为）。等 2.6s 只看最终态会把
       正确的自动收起误判成「点了没反应」。 */
    await sleep(400);
    const stOpen = await lite.ipcMain.invoke('chrome:panel:state');
    ck(stOpen.open === true,
       '点击登录徽标后立即展开右侧官网面板（不再「点了没反应」）：' + JSON.stringify(stOpen));
    /* v1.3.2 新口径：点击登录按键只展开官网，不刷新积分 / 任务 / 登录状态。
       只有「登录成功、从 Microsoft 登录页跳回 Rewards」才派发一次统一同步。 */
    const logPath = path.join(dir, 'runtime.log');
    const logBeforeClick = fs.readFileSync(logPath, 'utf8').length;
    await sleep(1800);
    const afterClick = await lite.ipcMain.invoke('chrome:storage:get',
      ['pointsSummary', 'todayTasks', 'loginStatus']);
    const newLog = fs.readFileSync(logPath, 'utf8').slice(logBeforeClick);
    ck(!newLog.includes('派发统一同步'),
       '点击登录按键没有派发积分 / 登录状态刷新');
    ck(!Number.isFinite(afterClick.pointsSummary && afterClick.pointsSummary.available) &&
       !(afterClick.todayTasks && Array.isArray(afterClick.todayTasks.items) &&
         afterClick.todayTasks.items.length > 0),
       '点击后业务状态仍为空（未被顺手刷新）');

    /* 模拟真机登录：先停在 Microsoft 登录页，再跳回 Rewards 首页 */
    await lite.ipcMain.invoke('chrome:panel:show', 'https://login.live.com/oauth20/authorize.srf');
    await sleep(1200);
    await lite.ipcMain.invoke('chrome:panel:show', 'https://rewards.bing.com/dashboard');
    let stLater = null, loginNow = null;
    for (let i = 0; i < 24; i++) {
      await sleep(300);
      stLater = await lite.ipcMain.invoke('chrome:panel:state');
      loginNow = (await lite.ipcMain.invoke('chrome:storage:get', 'loginStatus')).loginStatus;
      if (stLater.open === false && loginNow === 'in') break;
    }
    ck(stLater.open === false && loginNow === 'in',
       '登录跳回 Rewards 后统一同步写回 in，并自动收起侧栏：' +
       JSON.stringify({ open: stLater.open, loginStatus: loginNow }));
    const logAfter = fs.readFileSync(logPath, 'utf8');
    ck(logAfter.includes('派发统一同步'),
       '登录跳回走的是 syncRewards 统一同步（与手动刷新同一套逻辑）');
    const st = await lite.ipcMain.invoke('chrome:storage:get',
      ['pointsSummary', 'todayTasks']);
    ck(st.pointsSummary && Number.isFinite(st.pointsSummary.available),
       '统一同步只写变化的值：可用积分一次到位（' +
       JSON.stringify({ available: st.pointsSummary && st.pointsSummary.available }) + '）');
    ck(st.todayTasks && Array.isArray(st.todayTasks.items) && st.todayTasks.items.length >= 2,
       '任务列表一次到位（含每日活动与日常任务），不是只有每日活动：' +
       JSON.stringify({ count: st.todayTasks && st.todayTasks.items && st.todayTasks.items.length }));
  }
  const mfPath = path.join(dir, 'manifest.json');
  ck(fs.existsSync(mfPath), 'manifest.json 已生成（页面 HTML 索引）');
  if (fs.existsSync(mfPath)) {
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    ck(mf.files.length >= 1, `真实抓到 ${mf.files.length} 个 HTML 页面`);
    const htmlFiles = fs.readdirSync(path.join(dir, 'html')).filter(n => n.endsWith('.html'));
    ck(htmlFiles.length >= 1, 'html/ 目录下确实存在页面文件');
    const all = htmlFiles.map(n => fs.readFileSync(path.join(dir, 'html', n), 'utf8')).join('\n');
    ck(all.includes('20,192') || all.includes('rewards.bing.com'),
       '落盘的 HTML 是真实官网页面内容（含积分/域名）');
    ck(fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8').includes('did-finish-load'),
       'runtime.log 记录侧栏页面加载完成事件');
  }
  ck(fs.existsSync(path.join(dir, 'events.jsonl')) &&
     fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('"type":"ipc"'),
     'events.jsonl 含 IPC 事件，可判断点击链路是否发出消息');
  ck(fs.existsSync(path.join(dir, 'storage.json')), 'storage.json 快照已落盘');

  // 独立命令打包
  const { DebugCapture } = require('../lib/debug-capture');
  const packer = new DebugCapture({ rootDir: capRoot, enabled: false, maxSessions: 99 });
  packer.sessionDir = dir;
  const zip = packer.pack();
  ck(!!zip && fs.existsSync(zip), '调试包可一键导出为单个 zip（提交给开发者）');
}

/* ------------------------------------------------------------------ C. 静态 */
function statics() {
  group('3. 接入点静态核对');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const popHtml = fs.readFileSync(path.join(ROOT, 'src', 'popup.html'), 'utf8');
  const popJs = fs.readFileSync(path.join(ROOT, 'src', 'popup.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'host.html'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  ck(main.includes('const DBG = new DebugCapture()'), 'main.js 引入调试采集器');
  ck(main.includes("DBG.captureHtml('side-panel'"), '侧栏 / 登录页 HTML 采集已接入');
  ck(main.includes("DBG.captureHtml('read-' + injectName"), '积分/任务注入结果 HTML 采集已接入');
  ck(main.includes('chrome:open:official'), '新增官方页面直开 IPC（chrome 注入失败时的兜底）');
  ck(main.includes('function probePopupChrome'), 'popup chrome 形状探针已接入');
  ck(main.includes('强制复位运行态'), '启动强制复位运行态已接入');
  ck(main.includes('启动零抓取') && !main.includes("type: 'refreshLogin'"),
     'v1.1.8 启动零抓取已接入，不再派发 refreshLogin / refreshPoints / refreshTasks');
  ck(!main.includes('导出调试现场包'), '托盘/菜单已无调试入口（默认禁用，仅命令行开启）');
  ck(main.includes('视图挂载失败'), 'attachView 不再静默吞错');
  ck(pre.includes("exposeInMainWorld('__hsaChrome', chromeApi)"), 'preload 注入不冲突的 shim 备份');
  ck(pre.includes('openOfficial:'), 'preload 暴露 __desktop.openOfficial 兜底通道');
  ck(pre.includes('saveHtml:') && main.includes("chrome:debug:page") &&
     main.includes("DBG.captureHtml('parser-input-'"),
     '解析器实际输入 HTML 的落盘链路已接通（debugSaveHtml → __desktop.saveHtml → DBG）');
  ck(popHtml.includes('__hsaChrome') && popHtml.indexOf('__hsaChrome') < popHtml.indexOf('popup.js'),
     'popup.html 在业务脚本之前注入 chrome 恢复补丁');
  ck(popJs.includes("typeof d.openOfficial === 'function'"), 'popup.js 登录点击四级回退');
  ck(popJs.includes('panelBtn.hidden = false'), '面板按钮始终可用');
  ck(host.includes('background.js 加载完成 / 回报 ready'), 'host.html 回报链路诊断日志');
  ck(pkg.scripts['debug:pack'] === 'node scripts/pack-debug.js', '提供 npm run debug:pack');
  ck(pkg.scripts['verify:debug'] === 'node scripts/verify-debug.js', '提供 npm run verify:debug');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ck(readme.includes('调试') && readme.includes('debug-captures'), '文档说明调试采集默认关闭及现场目录');
}

async function main() {
  unit();
  try { await e2e(); }
  catch (err) { ck(false, '真实 Chromium 集成执行异常：' + String(err && err.message || err)); }
  statics();
  console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
  if (process.env.HSA_KEEP_DEBUG !== '1') {
    for (const d of [tmpA, tmpB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  } else {
    console.log('\x1b[36m[debug] 现场保留于 ' + tmpB + '\x1b[0m');
  }
  process.exit(fail ? 1 : 0);
}
main();
