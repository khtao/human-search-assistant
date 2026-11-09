#!/usr/bin/env node
/* ============================================================================
 * v1.3.4 · Ubuntu 真机启动链路专项
 *
 * 复现用户日志里的两个问题：
 *  ① npm warn Unknown project config "electron_mirror" / ... / "disturl"
 *  ② FATAL:setuid_sandbox_host.cc:172 → SIGTRAP（chrome-sandbox 权限不合格）
 *
 * 实际测试（不是只匹配字符串）：
 *   · vm 实跑 scripts/npm-mirror.js，捕获它 spawn npm 时注入的环境变量
 *   · 直接 require scripts/launch.js 的纯函数 computeLaunch / sandboxStatus，
 *     构造 root / 普通用户 / 权限合格 / 权限不合格 / strict / Windows / 缺文件
 *     共 8 种场景，断言追加的 Electron 参数
 *   · 实跑 launch()，用 mock spawn 捕获真实命令行参数
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const launchMod = require('../scripts/launch.js');
const { sandboxStatus, computeLaunch, launch, NO_SANDBOX_ARGS } = launchMod;

let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');

const BIN = '/home/khtao/下载/desktop-app/node_modules/electron/dist/electron';

/* -------------------------------------------------------------------------- */
group('1. .npmrc 只剩 npm 内置键（消除 Unknown project config 警告）');
const npmrc = read('.npmrc');
const keys = npmrc.split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => l.split('=')[0].trim());
const KNOWN = new Set(['registry', 'audit', 'fund', 'prefix', 'cache', 'proxy',
  'https-proxy', 'strict-ssl', 'ignore-scripts', 'save-exact', 'legacy-peer-deps']);
const unknown = keys.filter(k => !KNOWN.has(k));
ck(unknown.length === 0, '项目 .npmrc 无未知 project config（' + keys.join(', ') + '）');
ck(!/electron_mirror|electron_builder_binaries_mirror|disturl/.test(npmrc.replace(/^#.*$/gm, '')),
   '★ 三条触发警告的键已从 .npmrc 移除');
ck(/^registry\s*=\s*https:\/\/registry\.npmmirror\.com\/$/m.test(npmrc),
   'npm registry 镜像仍保留（npm 内置键，不警告）');
ck(/audit=false/.test(npmrc) && /fund=false/.test(npmrc),
   'audit / fund 为 npm 内置键，保留无警告');

/* -------------------------------------------------------------------------- */
group('2. vm 实跑 npm-mirror.js：镜像以环境变量注入，功能没退化');
let captured = null;
const mirrorSrc = read('scripts/npm-mirror.js');
const mirrorCtx = vm.createContext({
  console, process: { platform: 'linux', argv: ['node', 'npm-mirror.js', 'ci'], exit() {} },
  require: () => ({ spawnSync: (cmd, args, o) => { captured = { cmd, args, env: o.env }; return { status: 0 }; } }),
  Object, String
});
vm.runInContext(mirrorSrc, mirrorCtx, { filename: 'npm-mirror.js' });
ck(!!captured && captured.cmd === 'npm' && captured.args.join(' ') === 'ci',
   'wrapper 真实 spawn npm ci（cmd=' + (captured && captured.cmd) + '）');
const env = captured && captured.env || {};
ck(env.ELECTRON_MIRROR === 'https://npmmirror.com/mirrors/electron/' &&
   env.npm_config_electron_mirror === 'https://npmmirror.com/mirrors/electron/',
   '★ Electron 二进制镜像两种键名都注入（@electron/get 可读）');
ck(env.ELECTRON_BUILDER_BINARIES_MIRROR ===
     'https://npmmirror.com/mirrors/electron-builder-binaries/' &&
   env.npm_config_electron_builder_binaries_mirror ===
     'https://npmmirror.com/mirrors/electron-builder-binaries/',
   '★ electron-builder 工具链镜像两种键名都注入');
ck(env.npm_config_disturl === 'https://npmmirror.com/mirrors/node',
   'node-gyp 头文件镜像注入');
/* Windows 分支也实跑一次 */
let capturedWin = null;
const winCtx = vm.createContext({
  console, process: { platform: 'win32', argv: ['node', 'npm-mirror.js', 'install'], exit() {} },
  require: () => ({ spawnSync: (cmd, args, o) => { capturedWin = { cmd, args, shell: o.shell }; return { status: 0 }; } }),
  Object, String
});
vm.runInContext(mirrorSrc, winCtx);
ck(!!capturedWin && capturedWin.cmd === 'npm.cmd' && capturedWin.shell === true,
   'Windows 走 npm.cmd + shell:true（双平台同一条命令）');

const pkg = JSON.parse(read('package.json'));
ck(pkg.scripts.ci === 'node scripts/npm-mirror.js ci', '提供 npm run ci');
ck(pkg.scripts.setup === 'node scripts/npm-mirror.js install && npm run doctor && npm start',
   'npm run setup 也走镜像包装');
ck(pkg.scripts.start === 'node scripts/launch.js', 'npm start 走启动包装');

/* -------------------------------------------------------------------------- */
group('3. sandboxStatus：精确定位真机 SIGTRAP');
const badStat = () => ({ uid: 1000, mode: 0o100755 });
const goodStat = () => ({ uid: 0, mode: 0o104755 });
let s = sandboxStatus(BIN, { platform: 'linux', stat: badStat });
ck(s.applicable === true && s.ok === false && s.reason === 'bad-mode',
   '普通用户解压出的 chrome-sandbox（uid=1000, 755）判为不合格');
s = sandboxStatus(BIN, { platform: 'linux', stat: goodStat });
ck(s.ok === true && s.reason === 'ok', 'root:root 4755 判为合格');
s = sandboxStatus(BIN, { platform: 'linux', stat: () => { throw new Error('ENOENT'); } });
ck(s.ok === false && s.reason === 'missing', 'chrome-sandbox 缺失也判为不合格');
s = sandboxStatus(BIN, { platform: 'win32' });
ck(s.applicable === false && s.ok === true, 'Windows 不做 SUID 检查');
s = sandboxStatus(BIN, { platform: 'darwin' });
ck(s.applicable === false, 'macOS 不做 SUID 检查');

/* -------------------------------------------------------------------------- */
group('4. computeLaunch：8 种场景的真实参数决策');
const base = { platform: 'linux', stat: badStat, getuid: () => 1000, env: {} };
let p = computeLaunch(BIN, Object.assign({}, base));
ck(p.downgraded === true && p.extra.join(' ') === NO_SANDBOX_ARGS.join(' '),
   '★ 普通用户 + 权限不合格 → 追加 --no-sandbox --disable-setuid-sandbox，避免卡死');
p = computeLaunch(BIN, Object.assign({}, base, { stat: goodStat }));
ck(p.extra.length === 0 && p.downgraded === false,
   '权限合格 → 原样启动，不加任何参数（不降低安全）');
p = computeLaunch(BIN, Object.assign({}, base, { platform: 'win32' }));
ck(p.extra.length === 0 && p.status.applicable === false,
   'Windows → 零额外参数');
p = computeLaunch(BIN, Object.assign({}, base, { env: { HSA_SANDBOX_OK: '1' } }));
ck(p.extra.length === 0, 'HSA_SANDBOX_OK=1 跳过检查');
p = computeLaunch(BIN, Object.assign({}, base, { env: { HSA_STRICT_SANDBOX: '1' } }));
ck(p.strict === true && p.extra.length === 0,
   'HSA_STRICT_SANDBOX=1 拒绝降级、要求先修权限');

let fixed = null;
p = computeLaunch(BIN, Object.assign({}, base, {
  getuid: () => 0,
  chown: (f, u, g) => { fixed = { f, u, g }; },
  chmod: (f, m) => { if (fixed) fixed.m = m; }
}));
ck(!!fixed && fixed.u === 0 && fixed.g === 0 && fixed.m === 0o4755,
   '★ root 运行时自动 chown 0:0 + chmod 4755（实跑注入的 fs 钩子）');
ck(p.canFixAsRoot === true && p.extra.length === 0 && p.status.ok === true,
   'root 修复后正常启动，不需要 --no-sandbox');
p = computeLaunch(BIN, Object.assign({}, base, {
  getuid: () => 0, chown: () => { throw new Error('EPERM'); }, chmod: () => {}
}));
ck(p.downgraded === true, 'root 但修复失败时仍降级启动，不卡死');
p = computeLaunch(BIN, Object.assign({}, base, { env: { HSA_NO_SANDBOX: '1' }, getuid: () => 0,
  chown: () => {}, chmod: () => {} }));
ck(p.downgraded === true, 'HSA_NO_SANDBOX=1 强制降级（容器 / CI 用）');

/* -------------------------------------------------------------------------- */
group('5. launch() 实跑：真实 spawn 参数与友好提示');
let spawned = null;
const logs = [];
const origLog = console.log;
console.log = (...a) => logs.push(a.join(' '));
const code = launch({
  bin: BIN, platform: 'linux', stat: badStat, getuid: () => 1000, env: {},
  spawn: (bin, args, o) => { spawned = { bin, args, o }; return { on() {} }; }
});
console.log = origLog;
ck(code === 0 && !!spawned, 'launch() 成功返回并真实 spawn');
ck(spawned.args[0] === ROOT, '第一个参数是应用目录（等价 electron .）');
ck(spawned.args.includes('--no-sandbox') && spawned.args.includes('--disable-setuid-sandbox'),
   '降级参数确实出现在最终命令行：' + spawned.args.slice(1).join(' '));
ck(logs.some(l => /sudo chown root:root/.test(l)) && logs.some(l => /sudo chmod 4755/.test(l)),
   '★ 控制台打印两条可直接复制的 sudo 修复命令');
ck(logs.some(l => /临时以 --no-sandbox 启动/.test(l)),
   '★ 明确告知本次已降级，不静默降低安全');
let strictSpawned = false;
console.log = () => {};
const strictCode = launch({
  bin: BIN, platform: 'linux', stat: badStat, getuid: () => 1000,
  env: { HSA_STRICT_SANDBOX: '1' },
  spawn: () => { strictSpawned = true; return { on() {} }; }
});
console.log = origLog;
ck(strictCode === 1 && !strictSpawned, 'strict 模式拒绝启动，必须先修权限');

/* -------------------------------------------------------------------------- */
group('6. debug 启动与自检、双平台文档同步');
ck(/require\('\.\/launch\.js'\)/.test(read('scripts/start-debug.js')),
   'npm run start:debug 复用同一套沙箱处理');
ck(/chrome-sandbox/.test(read('scripts/check-electron.js')) &&
   /sudo chmod 4755/.test(read('scripts/check-electron.js')),
   'npm run doctor / prestart 自检会给出权限修复命令');
const readme = read('README.md');
ck(/chrome-sandbox/.test(readme) && /4755/.test(readme),
   'README 说明 DEB 安装时的 chrome-sandbox 权限处理');
ck(/chmod 4755/.test(read('scripts/deb-postinst')) && /dpkg-query -L human-search-assistant/.test(read('scripts/deb-postinst')),
   'DEB postinst 会为已安装的 chrome-sandbox 设置 root:root / 4755');

console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
process.exit(fail ? 1 : 0);
