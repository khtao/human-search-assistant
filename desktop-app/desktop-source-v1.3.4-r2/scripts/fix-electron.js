#!/usr/bin/env node
/* ============================================================================
 * fix:electron —— 跨平台离线兜底：手动下载并解压 Electron 二进制
 *
 * 适用：npm ci 的 postinstall 因网络超时没跑完（dist/ 或 path.txt 缺失），
 *      且镜像直连也失败时。Windows / Ubuntu 用同一份脚本，行为一致。
 *
 *   npm ci --ignore-scripts
 *   npm run fix:electron
 *   npm run doctor
 *   npm start
 *
 * 只做三件事：拼镜像 URL → 下载 zip → 解压到 node_modules/electron/dist
 * 并写好 path.txt。不修改 package.json / package-lock.json，不碰任何代码。
 * 可用 HSA_ELECTRON_MIRROR 覆盖镜像地址，-Mirror 风格的备用源同理。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = process.env.HSA_CHECK_ROOT
  ? path.resolve(process.env.HSA_CHECK_ROOT) : path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'node_modules', 'electron');
const DIST = path.join(EDIR, 'dist');
const VERBOSE = process.argv.includes('--verbose');

const log = (...a) => console.log(...a);
const info = (...a) => { if (VERBOSE) console.log('   ', ...a); };

function fail(msg) { console.error('\x1b[31m✗ ' + msg + '\x1b[0m'); process.exit(1); }

/* ------------------------------------------------------------ 版本 / 平台映射 */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = (pkg.devDependencies || {}).electron || (pkg.dependencies || {}).electron;
if (!version) fail('package.json 未声明 electron 版本');
const ver = String(version).replace(/^[^\d]*/, '');
const arch = process.arch === 'ia32' ? 'ia32' : process.arch;   // x64 / arm64
const platform = process.platform === 'win32' ? 'win32'
  : process.platform === 'darwin' ? 'darwin' : 'linux';
const exeName = platform === 'win32' ? 'electron.exe' : 'electron';
const zipName = `electron-v${ver}-${platform}-${arch}.zip`;

const mirror = (process.env.HSA_ELECTRON_MIRROR ||
  'https://npmmirror.com/mirrors/electron/').replace(/\/+$/, '/');
const url = `${mirror}${ver}/${zipName}`;
const DRY_RUN = process.argv.includes('--dry-run');

log('\n\x1b[1mElectron 二进制离线修复\x1b[0m');
log('  版本    electron@' + ver);
log('  目标    ' + platform + '-' + arch);
log('  镜像    ' + mirror);
log('  下载    ' + url);

/* --------------------------------------------------------------- 下载（跟随重定向） */
function download(u, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向次数过多'));
    const req = https.get(u, { headers: { 'User-Agent': 'hsa-fix-electron/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        info('重定向 →', res.headers.location);
        return download(new URL(res.headers.location, u).toString(), dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', c => {
        got += c.length;
        if (VERBOSE && total) process.stdout.write(`\r    ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
      });
      res.pipe(out);
      out.on('finish', () => { if (VERBOSE) process.stdout.write('\n'); resolve(dest); });
      out.on('error', reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error('连接超时（60 秒）')));
    req.on('error', reject);
  });
}

function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`],
      { stdio: VERBOSE ? 'inherit' : 'ignore' });
  } else {
    execFileSync('unzip', ['-o', '-q', zip, '-d', dest], { stdio: VERBOSE ? 'inherit' : 'ignore' });
  }
}

async function main() {
  if (DRY_RUN) {
    log('  [dry-run] 目标文件 ' + zipName);
    log('  [dry-run] 解压到   ' + DIST);
    log('  [dry-run] path.txt = ' + exeName);
    log('  [dry-run] URL      ' + url);
    return;
  }
  if (!fs.existsSync(path.join(EDIR, 'package.json'))) {
    fail('node_modules/electron 不存在，请先执行 npm ci --ignore-scripts');
  }
  const tmpZip = path.join(os.tmpdir(), `hsa-${zipName}`);
  try {
    await download(url, tmpZip);
  } catch (err) {
    fail('下载失败：' + err.message +
      '\n  可换镜像重试： set HSA_ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/' +
      '\n  或在能联网的机器下载 ' + zipName + ' 后手动解压到 ' + DIST);
  }
  const size = fs.statSync(tmpZip).size;
  if (size < 1024 * 1024) fail('zip 文件异常小（' + size + ' 字节），可能拿到的是错误页');
  log('  已下载 ' + (size / 1048576).toFixed(1) + ' MB，正在解压…');

  try { unzip(tmpZip, DIST); }
  catch (err) { fail('解压失败：' + err.message + '（Linux 需安装 unzip）'); }

  const exe = path.join(DIST, exeName);
  if (!fs.existsSync(exe)) fail('解压后未找到 ' + exe);
  fs.writeFileSync(path.join(EDIR, 'path.txt'), exeName + '\n', 'utf8');
  try { fs.unlinkSync(tmpZip); } catch {}

  log('  \x1b[32m✓ 完成：' + exe + '\x1b[0m');
  log('  \x1b[32m✓ 已写入 path.txt = ' + exeName + '\x1b[0m');
  log('\n  现在执行： npm run doctor && npm start\n');
}
main().catch(e => fail(e.message));
