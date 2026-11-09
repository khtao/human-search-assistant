#!/usr/bin/env node
/* Desktop build configuration and dependency-lock consistency checks. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const builder = read('electron-builder.yml');
const builderWin = read('electron-builder.win.yml');
const build = read('scripts/build-linux.sh');
const npmrc = read('.npmrc');
const lockUrls = Object.values(lock.packages || {}).map(x => x.resolved).filter(Boolean);
let pass = 0, fail = 0;
const ck = (c, m) => {
  if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); }
};
const group = t => console.log('\n\x1b[1m' + t + '\x1b[0m');

group('1. Electron 与构建依赖');
ck(pkg.devDependencies.electron === '45.2.3', 'Electron 精确锁定 45.2.3');
ck(pkg.devDependencies['electron-builder'] === '26.18.1', 'electron-builder 精确锁定 26.18.1');
ck((pkg.engines || {}).node === '>=22.12.0', 'Node.js 最低版本为 22.12.0');
ck(pkg.homepage === 'https://github.com/khtao/human-search-assistant', 'package.json 提供有效项目 homepage，满足 Debian DEB 元数据要求');
ck(Object.keys(pkg.dependencies || {}).length === 0, '没有额外 npm 运行时依赖');
ck(lock.version === pkg.version && lock.packages[''].version === pkg.version,
   'package-lock 根项目版本与 package.json 一致');
ck(lock.packages['node_modules/electron'].version === pkg.devDependencies.electron &&
   lock.packages['node_modules/electron-builder'].version === pkg.devDependencies['electron-builder'],
   'package-lock 与 package.json 依赖版本一致');
ck(lock.packages['node_modules/electron'].integrity && lock.packages['node_modules/electron-builder'].integrity,
   'Electron 与 electron-builder 锁定了完整性校验值');

group('2. Ubuntu DEB 构建入口');
ck(pkg.scripts['build:linux'] === 'sh scripts/build-linux.sh', 'build:linux 调用统一 Linux 构建脚本');
ck(pkg.scripts['dist:deb'] === 'electron-builder --config electron-builder.yml --linux deb --x64', 'dist:deb 显式使用 Linux 专用配置并只生成 x64 DEB');
ck(pkg.scripts['dist:win'] === 'electron-builder --config electron-builder.win.yml --win --x64', 'dist:win 显式使用 Windows 专用配置');
ck(pkg.scripts['pack:win'] === 'electron-builder --config electron-builder.win.yml --win --x64 --dir', 'pack:win 显式使用 Windows 专用配置');
ck(/npm run dist:deb/.test(build) && /dpkg-deb --info/.test(build), '构建脚本生成并校验 DEB');
ck(/target:\s*\n\s*- target: deb/.test(builder), 'Linux 专用配置默认目标为 deb');
ck(!/^win:/m.test(builder) && !/^nsis:/m.test(builder) && !/^portable:/m.test(builder), 'Linux 配置不包含 Windows 专用键，避免 Linux schema 冲突');
ck(/^win:/m.test(builderWin) && /^nsis:/m.test(builderWin) && /^portable:/m.test(builderWin), 'Windows 配置独立保留 NSIS 与 portable 目标');
ck(!/^linux:/m.test(builderWin) && !/^deb:/m.test(builderWin), 'Windows 配置不包含 Linux 专用键');
ck(/desktop:\s*\n\s*entry:\s*\n\s*Name: 拟人搜索助手/.test(builder),
   'Linux 桌面入口按 electron-builder 26 的 desktop.entry 结构配置');
ck(!/desktop:\s*\n\s*Name:/.test(builder), '不再使用旧版错误的扁平 desktop 字段');
ck(/afterInstall: scripts\/deb-postinst/.test(builder), 'DEB 安装后执行沙箱权限修复脚本');
ck(/--config electron-builder\.yml/.test(pkg.scripts['dist:linux']) && /--config electron-builder\.yml/.test(pkg.scripts['dist:appimage']), 'Linux 其他构建入口同样显式使用 Linux 配置');
ck(/!lib\/electron-lite\.js/.test(builder) && /!tests\/\*\*/.test(builder) && /!scripts\/\*\*/.test(builder),
   '安装包排除测试替身、测试数据和开发脚本');
ck(/lib\/core\.js/.test(builder) && /lib\/debug-capture\.js/.test(builder) && /src\/\*\*/.test(builder),
   'Linux 安装包保留桌面运行必需资源');
ck(/lib\/core\.js/.test(builderWin) && /src\/\*\*/.test(builderWin), 'Windows 安装包保留桌面运行必需资源');

group('3. npm 镜像与锁文件地址');
ck(/^registry=https:\/\/registry\.npmmirror\.com\//m.test(npmrc), 'npm registry 使用 npmmirror');
ck(lockUrls.length > 100, 'lockfile 保留完整依赖树');
ck(lockUrls.every(u => u.startsWith('https://registry.npmmirror.com/')),
   '锁文件 tarball 全部使用 HTTPS npmmirror 地址');
ck(!lockUrls.some(u => u.startsWith('http://mirrors.tencent.com/')),
   '锁文件不再依赖旧的 HTTP 腾讯镜像地址');

console.log(`\n\x1b[1m共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项\x1b[0m\n`);
process.exit(fail ? 1 : 0);
