#!/usr/bin/env node
/* ============================================================================
 * Electron 安装自检（npm start 的 prestart）
 *
 * 解决的问题：
 *   node_modules\electron\index.js:17
 *   throw new Error('Electron failed to install correctly, please delete
 *                   node_modules/electron and try installing again');
 *
 * 这不是代码依赖坏了，而是 electron 这个 npm 包的「二进制」没装好：
 *   npm 包本体只有几 KB，安装脚本 install.js 还要从 GitHub Releases
 *   下载约 100MB 的 electron-*-win32-x64.zip，解压到 dist/ 并写 path.txt。
 *   国内直连 GitHub 常超时；一旦 postinstall 没跑完，dist/ 或 path.txt
 *   缺失，require('electron') 就抛上面那句英文错误。
 *
 * 本脚本在启动前把它翻译成中文、给出可执行的修复命令，并顺带检查
 * 「npm audit fix --force 是否偷偷改了 electron 版本」（那会破坏
 * Windows / Ubuntu 使用同一运行时的约束）。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

/* HSA_CHECK_ROOT 仅供安装自检的单元/集成测试注入临时目录，
   真实使用时始终是项目根目录。 */
const ROOT = process.env.HSA_CHECK_ROOT
  ? path.resolve(process.env.HSA_CHECK_ROOT) : path.join(__dirname, '..');
const verbose = process.argv.includes('--verbose') || process.env.HSA_DOCTOR === '1';
let failed = false;

const ok = msg => console.log('  \x1b[32m✓\x1b[0m ' + msg);
const bad = msg => { failed = true; console.log('  \x1b[31m✗\x1b[0m ' + msg); };
const info = msg => console.log('    ' + msg);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

console.log('\n\x1b[1m拟人搜索助手 · Electron 安装自检\x1b[0m');

/* ---------------------------------------------------------------- 1. 期望版本 */
const pkg = readJson(path.join(ROOT, 'package.json')) || {};
const want = (pkg.devDependencies || {}).electron || (pkg.dependencies || {}).electron || '(未声明)';
info('package.json 期望 electron ' + want);

/* ------------------------------------------------ 1b. Node 版本（Electron 45 硬门槛） */
const needNode = String((pkg.engines || {}).node || '>=22.12.0').replace(/^[^\d]*/, '');
const curNode = process.versions.node;
const cmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
if (cmp(curNode, needNode) >= 0) ok('Node ' + curNode + ' 满足 electron@' + want + ' 的要求（>=' + needNode + '）');
else bad('Node ' + curNode + ' 低于 electron@' + want + ' 要求的 ' + needNode +
         ' —— 请升级到 Node 24 LTS 或 26 LTS 后重新安装依赖');
/* Electron 45 自带 Node 24.22.2 运行时；系统 Node 只用于跑 npm / 构建工具。 */

/* --------------------------------------------------- 2. npm 包本体与版本一致性 */
const eDir = path.join(ROOT, 'node_modules', 'electron');
const ePkg = readJson(path.join(eDir, 'package.json'));
if (!ePkg) {
  bad('node_modules/electron 不存在（还没装依赖）');
} else {
  ok('已安装 npm 包 electron@' + ePkg.version);
  if (String(want).replace(/^[^\d]*/, '') !== String(ePkg.version)) {
    bad('版本不一致：package.json 要 ' + want + '，实际是 ' + ePkg.version +
        '（很可能被 npm audit fix --force 改过）');
  } else {
    ok('版本与 package.json 锁定值一致');
  }
  if (verbose) info('包路径：' + eDir);
}

/* --------------------------------------------------------- 3. path.txt / dist */
const pathTxt = path.join(eDir, 'path.txt');
const pathTxtBody = fs.existsSync(pathTxt) ? fs.readFileSync(pathTxt, 'utf8').trim() : '';
if (!pathTxtBody) {
  bad('node_modules/electron/path.txt 缺失或为空 —— 二进制下载步骤没完成');
} else {
  ok('path.txt = ' + pathTxtBody);
  const exe = path.join(eDir, 'dist', pathTxtBody);
  if (!fs.existsSync(exe)) {
    bad('二进制不存在：' + exe);
  } else {
    const size = fs.statSync(exe).size;
    if (size < 1024 * 1024) bad('二进制文件异常小（' + size + ' 字节），下载可能不完整');
    else ok('Electron 可执行文件就位（' + (size / 1024 / 1024).toFixed(1) + ' MB）');
  }
}

/* --------------------------------------------- 4. 真正 require('electron') 一次 */
let resolved = null;
try {
  resolved = require(path.join(eDir, 'index.js'));
  if (typeof resolved === 'string' && resolved.length) ok('require("electron") 返回可执行路径');
  else bad('require("electron") 返回值不是路径：' + String(resolved));
} catch (err) {
  bad('require("electron") 抛错：' + String(err && err.message || err).split('\n')[0]);
}

/* --------------------------------------------- 5. lock 与 package.json 版本一致性 */
const lock = readJson(path.join(ROOT, 'package-lock.json'));
const locked = lock && lock.packages && lock.packages['node_modules/electron'] &&
  lock.packages['node_modules/electron'].version;
if (!locked) {
  bad('package-lock.json 缺失或未记录 electron 版本 —— 先跑 npm install 生成 lock，之后才能 npm ci');
} else if (String(locked) !== String(want)) {
  bad('package-lock.json 里是 electron@' + locked + '，package.json 要 ' + want +
      ' —— 依赖升级后必须先用 npm install 重建 lock，直接 npm ci 会报不同步');
} else {
  ok('package-lock.json 与 package.json 版本一致（' + locked + '，npm ci 可复现）');
}

/* ------------------------------------------------------------ 6. 镜像配置提示 */
const npmrc = path.join(ROOT, '.npmrc');
const npmrcBody = fs.existsSync(npmrc) ? fs.readFileSync(npmrc, 'utf8') : '';
if (/^registry\s*=\s*https?:\/\//im.test(npmrcBody)) ok('.npmrc 已配置 npm registry 国内镜像');
else info('未配置 registry 镜像（海外网络可忽略）');
/* v1.3.4：二进制镜像改由 scripts/npm-mirror.js 以环境变量注入，
   .npmrc 只保留 npm 内置键（避免 npm 11+ 的 Unknown project config 警告）。 */
const mirrorScript = path.join(ROOT, 'scripts', 'npm-mirror.js');
if (fs.existsSync(mirrorScript) &&
    /ELECTRON_MIRROR/.test(fs.readFileSync(mirrorScript, 'utf8')))
  ok('Electron / electron-builder 二进制镜像由 npm run ci 注入（.npmrc 无未知配置项）');
else info('缺少 scripts/npm-mirror.js，npm ci 时二进制可能直连 GitHub Releases');

/* ------------------------------------------- 6b. Ubuntu / Linux SUID 沙箱（非致命） */
if (process.platform === 'linux' && resolved) {
  const sandbox = path.join(path.dirname(resolved), 'chrome-sandbox');
  try {
    const st = fs.statSync(sandbox);
    const good = st.uid === 0 && (Number(st.mode) & 0o7777) === 0o4755;
    if (good) ok('chrome-sandbox 权限正确（root:root 4755）');
    else {
      info('\x1b[33m⚠ chrome-sandbox 权限不合格（uid=' + st.uid + ', mode=' +
           (Number(st.mode) & 0o7777).toString(8) + '）—— 直接启动会 SIGTRAP\x1b[0m');
      info('  npm start 已内置处理：会提示并临时以 --no-sandbox 启动；');
      info('  要保留沙箱请执行下面两条命令后重新 npm start：');
      info('    sudo chown root:root "' + sandbox + '"');
      info('    sudo chmod 4755 "' + sandbox + '"');
    }
  } catch { info('chrome-sandbox 不存在（非标准 Electron 安装，启动时会自动处理）'); }
}

/* --------------------------------------------------------------- 结论与修复指引 */
if (failed) {
  console.log('\n\x1b[33m──────── 修复步骤（Windows PowerShell） ────────\x1b[0m');
  console.log([
    '',
    '  cd "<解压目录>\\desktop-app"',
    '  node -v               # 必须 >= 22.12.0（建议 Node 24 LTS / 26 LTS）',
    '  Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue',
    '  npm run ci            # 带镜像重装；首次或 lock 不同步时用 npm run setup',
    '  npm run doctor        # 本自检，应全部 ✓',
    '  npm start             # prestart 会自动再跑一次自检',
    '',
    '  Ubuntu / macOS： rm -rf node_modules && npm run ci && npm run doctor && npm start',
    '',
    '  之后 Windows / Ubuntu 都用同一个 lock 跑 npm run ci（镜像由脚本注入），',
    '  两边必然装到同一份 Electron 45.2.3 运行时。',
    '',
    '  ⚠ 不要执行 npm audit fix --force',
    '    它会跨大版本强升 electron / electron-builder，改动 package-lock.json，',
    '    并可能删除已解压的 dist/ 却不重跑 postinstall —— 这正是本错误的常见来源。',
    '    本工程只有 2 个 devDependencies、0 个运行时依赖，没有需要 force 修的冲突。',
    '    它还可能把 Node 版本要求绕过，让 postinstall 静默失败。',
    '',
    '  若安装仍卡在下载二进制（国内网络）：',
    '    1) 用 npm run ci / npm run setup（自动注入镜像环境变量）；',
    '       .npmrc 只保留 registry，避免 npm 11+ 的 Unknown project config 警告；',
    '    2) 也可在 PowerShell 设环境变量：',
    '       setx ELECTRON_MIRROR "https://npmmirror.com/mirrors/electron/"',
    '    3) 完全离线兜底： npm ci --ignore-scripts',
    '                     然后 npm run fix:electron   (Windows / Ubuntu 同一脚本)',
    '',
    '  Electron 45.2.3 内置 Node 24.22.2 + Chromium 156；系统 Node 只跑 npm，',
    '  但 electron 45 的依赖（@electron/get 等）要求 Node >= 22.12.0。',
    ''
  ].join('\n'));
  process.exit(1);
}

console.log('\n\x1b[32m全部通过，可以启动。\x1b[0m\n');
process.exit(0);
