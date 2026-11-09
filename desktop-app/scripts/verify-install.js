#!/usr/bin/env node
/* ============================================================================
 * 依赖安装链路的真实场景测试（不是静态断言）
 *
 * 在临时目录里真实构造 node_modules/electron 的 6 种状态，
 * 真实执行 scripts/check-electron.js 并断言它的退出码与中文提示，
 * 覆盖用户遇到的 `Electron failed to install correctly` 以及
 * `npm audit fix --force` 改版本这两类问题。
 * 另外真实执行 fix-electron.js --dry-run，验证 URL 拼接跨平台正确。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHECK = path.join(ROOT, 'scripts', 'check-electron.js');
const FIX = path.join(ROOT, 'scripts', 'fix-electron.js');
/* 期望版本一律从真实 package.json 读取，测试不随依赖升级而失效 */
const REAL_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const WANT_VER = REAL_PKG.devDependencies.electron;
const WANT_BUILDER = REAL_PKG.devDependencies['electron-builder'];
const NODE_FLOOR = String((REAL_PKG.engines || {}).node || '>=22.12.0').replace(/^[^\d]*/, '');
let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* 与真实 electron 包 index.js 等价的最小实现：读 path.txt，缺了就抛同样的错 */
const INDEX_JS = `'use strict';
const fs = require('fs'), path = require('path');
const p = path.join(__dirname, 'path.txt');
if (!fs.existsSync(p)) throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again');
const n = fs.readFileSync(p, 'utf8').trim();
const exe = path.join(__dirname, 'dist', n);
if (!fs.existsSync(exe)) throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again');
module.exports = exe;
`;

/* 造一个「装好了」的假 electron 包：package.json + index.js + path.txt + dist/electron.exe */
function makeRoot(opts) {
  const o = Object.assign({ version: WANT_VER, pathTxt: true, exe: true,
                            exeSize: 8 * 1024 * 1024, hasPkg: true, mirror: true,
                            lockVersion: WANT_VER, nodeEngine: '>=20.0.0' }, opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsa-inst-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'human-search-assistant-desktop', version: '1.1.2',
    devDependencies: { electron: WANT_VER, 'electron-builder': WANT_BUILDER },
    engines: { node: o.nodeEngine }
  }), 'utf8');
  /* check-electron.js 现在会校验 lock 与 package.json 版本一致，临时目录必须带上 */
  if (o.lockVersion !== null) {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
      name: 'human-search-assistant-desktop', version: '1.1.2', lockfileVersion: 3,
      packages: { '': { devDependencies: { electron: WANT_VER } },
        'node_modules/electron': { version: o.lockVersion } }
    }), 'utf8');
  }
  if (o.mirror) fs.writeFileSync(path.join(dir, '.npmrc'),
    'registry=https://registry.npmmirror.com/\n' +
    'electron_mirror=https://npmmirror.com/mirrors/electron/\n', 'utf8');
  if (!o.hasPkg) return dir;
  const e = path.join(dir, 'node_modules', 'electron');
  fs.mkdirSync(path.join(e, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(e, 'package.json'),
    JSON.stringify({ name: 'electron', version: o.version }), 'utf8');
  fs.writeFileSync(path.join(e, 'index.js'), INDEX_JS, 'utf8');
  if (o.pathTxt) fs.writeFileSync(path.join(e, 'path.txt'), 'electron.exe\n', 'utf8');
  if (o.exe) fs.writeFileSync(path.join(e, 'dist', 'electron.exe'), Buffer.alloc(o.exeSize, 1));
  return dir;
}

function runCheck(root) {
  return spawnSync(process.execPath, [CHECK], {
    env: Object.assign({}, process.env, { HSA_CHECK_ROOT: root }),
    encoding: 'utf8'
  });
}

function main() {
  group('1. 真实执行 check-electron.js：6 种安装状态');
  const dirs = [];
  try {
    // A 完好
    let r = runCheck(makeRoot({}));
    ck(r.status === 0 && /全部通过/.test(r.stdout), '完整安装 → 退出 0，提示可启动');
    ck(/版本与 package\.json 锁定值一致/.test(r.stdout), '完整安装 → 版本一致性通过');

    // B dist 缺失（用户的核心报错）
    const b = makeRoot({ exe: false }); dirs.push(b);
    r = runCheck(b);
    ck(r.status === 1 && /二进制不存在/.test(r.stdout), 'dist 缺失 → 明确报「二进制不存在」');
    ck(/npm ci/.test(r.stdout) && /Remove-Item/.test(r.stdout), 'dist 缺失 → 给出可执行的修复命令');

    // C path.txt 缺失（postinstall 中断）
    const c = makeRoot({ pathTxt: false }); dirs.push(c);
    r = runCheck(c);
    ck(r.status === 1 && /path\.txt 缺失/.test(r.stdout), 'path.txt 缺失 → 精确定位');
    ck(/Electron failed to install correctly/.test(r.stdout), 'path.txt 缺失 → 复现用户看到的那句英文错误');

    // D audit fix --force 改了版本
    const other = '99.0.0';
    const d = makeRoot({ version: other, lockVersion: other }); dirs.push(d);
    r = runCheck(d);
    ck(r.status === 1 && /版本不一致/.test(r.stdout) && new RegExp(other.replace(/\./g, '\\.')).test(r.stdout),
       '版本被改成 ' + other + ' → 检出并点名实际版本');
    ck(/npm audit fix --force/.test(r.stdout), '版本异常 → 提示不要跑 audit fix --force');

    // D2 依赖升级后旧 lock 没重建（用户最易踩的坑）
    const d2 = makeRoot({ lockVersion: '28.3.3' }); dirs.push(d2);
    r = runCheck(d2);
    ck(r.status === 1 && /package-lock\.json 里是 electron@28\.3\.3/.test(r.stdout) &&
       /npm install 重建 lock/.test(r.stdout),
       '旧 lock（28.3.3）与新 package.json（' + WANT_VER + '）不一致 → 明确提示先 npm install');

    // D3 Node 版本低于 Electron 45 的硬门槛
    const d3 = makeRoot({ nodeEngine: '>=99.0.0' }); dirs.push(d3);
    r = runCheck(d3);
    ck(r.status === 1 && /低于 electron@/.test(r.stdout) && new RegExp('99\\.0\\.0').test(r.stdout),
       'Node 低于模拟门槛 99.0.0 → 自检报出引擎门槛');

    // E 下载截断
    const e = makeRoot({ exeSize: 2048 }); dirs.push(e);
    r = runCheck(e);
    ck(r.status === 1 && /异常小/.test(r.stdout), '二进制被截断（2KB）→ 判为下载不完整');

    // F 包都没装
    const f = makeRoot({ hasPkg: false }); dirs.push(f);
    r = runCheck(f);
    ck(r.status === 1 && /node_modules\/electron 不存在/.test(r.stdout), '未装依赖 → 提示先安装');

    // G 镜像缺失只是提示，不算失败
    const g = makeRoot({ mirror: false }); dirs.push(g);
    r = runCheck(g);
    ck(r.status === 0, '无 .npmrc 镜像仍能启动（海外网络可忽略）');
  } finally { /* 临时目录在最后统一清理 */ }

  group('2. 真实执行 fix-electron.js --dry-run：URL 拼接跨平台一致');
  const dry = spawnSync(process.execPath, [FIX, '--dry-run'], {
    env: Object.assign({}, process.env,
      { HSA_ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' }),
    encoding: 'utf8'
  });
  const out = dry.stdout || '';
  const plat = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
  ck(dry.status === 0, 'dry-run 不联网、退出 0');
  ck(out.includes('electron-v' + WANT_VER + '-' + plat + '.zip'),
     'zip 名与当前平台/架构匹配：electron-v' + WANT_VER + '-' + plat + '.zip');
  ck(out.includes('https://npmmirror.com/mirrors/electron/' + WANT_VER + '/'),
     '镜像 URL 含版本目录 ' + WANT_VER + '/');
  ck(out.includes('path.txt = ' + (process.platform === 'win32' ? 'electron.exe' : 'electron')),
     'path.txt 内容与平台匹配');
  ck(!/下载失败|解压失败/.test(out), 'dry-run 没有触发任何真实下载/解压');

  group('3. 工程配置');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ck(pkg.scripts.prestart === 'node scripts/check-electron.js', 'npm start 前自动跑安装自检');
  ck(pkg.devDependencies.electron === WANT_VER &&
     pkg.devDependencies['electron-builder'] === WANT_BUILDER,
     '依赖已升级到 electron ' + WANT_VER + ' / electron-builder ' + WANT_BUILDER);
  ck((pkg.engines || {}).node === '>=' + NODE_FLOOR, 'package.json 声明 Node ' + NODE_FLOOR + ' 门槛');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  ck(lock.packages['node_modules/electron'].version === WANT_VER &&
     !!lock.packages['node_modules/electron'].integrity,
     '真实 lockfile 已重建：electron ' + WANT_VER + ' 且带 integrity');
  ck(lock.packages['node_modules/electron-builder'].version === WANT_BUILDER,
     '真实 lockfile 中 electron-builder ' + WANT_BUILDER);
  const npmrc = fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
  ck(/^registry\s*=\s*https:\/\/registry\.npmmirror\.com\//m.test(npmrc),
     '.npmrc 使用 npmmirror registry（用户提供的镜像站）');
  ck(readme.includes('45.2.3') && readme.includes('26.18.1'),
     '文档记录升级后的依赖版本');
  ck(pkg.scripts.doctor === 'node scripts/check-electron.js --verbose', '提供 npm run doctor');
  ck(pkg.scripts['fix:electron'] === 'node scripts/fix-electron.js', 'fix:electron 走跨平台 Node 脚本');
  /* v1.3.4：未知 project config 已从 .npmrc 移除，改由 wrapper 注入环境变量 */
  const npmrcKeys = npmrc.split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => l.split('=')[0].trim());
  ck(npmrcKeys.every(k => ['registry', 'audit', 'fund'].includes(k)),
     '.npmrc 只剩 npm 内置键，npm 11+ 不再报 Unknown project config');
  const mirror = fs.readFileSync(path.join(ROOT, 'scripts', 'npm-mirror.js'), 'utf8');
  ck(/ELECTRON_MIRROR/.test(mirror) &&
     /npm_config_electron_builder_binaries_mirror/.test(mirror),
     'Electron / electron-builder 镜像由 npm run ci 以环境变量注入');
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  ck(readme.includes('npm run ci') && readme.includes('npm run build:linux'),
     '文档包含依赖安装与 Ubuntu DEB 构建流程');

  console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
}
main();
