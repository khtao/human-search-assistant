#!/usr/bin/env node
'use strict';
/* Windows-only builder entry. Works after npm ci when Electron install scripts
 * were suppressed. Unique output protects against locked dist\win-unpacked.
 * --dry-run is a Linux/CI-compatible configuration-only check. */
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const ROOT_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const BIN = path.join(ROOT_DIST, 'electron.exe');
const BUILDER = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const isDirOnly = process.argv.includes('--dir');
const dryRun = process.argv.includes('--dry-run');
const mirror = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0,14);
const outputRel = path.join('dist', 'windows-builds', `win-${stamp}-${process.pid}`);
const configArgs = ['--config', 'electron-builder.win.yml', '--win', '--x64',
  ...(isDirOnly ? ['--dir'] : []), `--config.directories.output=${outputRel}`];
function run(cmd, args, env = process.env) {
  const p = spawnSync(cmd, args, {cwd: ROOT, stdio:'inherit', env, windowsHide:true});
  if (p.error) { console.error('[HSA] Cannot run '+cmd+': '+p.error.message); return 1; }
  return p.status === null ? 1 : p.status;
}
function validElectron() {
  try { return fs.statSync(BIN).size > 5*1024*1024; } catch { return false; }
}
function prepare() {
  if (validElectron()) return true;
  const nodePkg = path.join(ROOT,'node_modules','electron','package.json');
  if (!fs.existsSync(nodePkg)) {
    console.error('[HSA] Missing npm dependencies. First run: npm run ci');
    return false;
  }
  // The official installer checks the existing @electron/get download cache.
  const installer = path.join(ROOT,'node_modules','electron','install.js');
  const env = {...process.env, ELECTRON_MIRROR: mirror};
  if (fs.existsSync(installer)) {
    console.log('[HSA] Restoring missing Electron binary via cached official installer...');
    if (run(process.execPath, [installer], env) === 0 && validElectron()) return true;
  }
  console.log('[HSA] Official installer failed; trying the project mirror recovery...');
  if (run(process.execPath, [path.join(__dirname,'fix-electron.js')], env) === 0 && validElectron()) return true;
  console.error('[HSA] Electron still missing: '+BIN+'\nCheck network/mirror, then run npm run fix:electron.');
  return false;
}
function main() {
  if (dryRun) {
    console.log(JSON.stringify({builder:'electron-builder/cli.js', electronDist:'node_modules/electron/dist',
      output:outputRel, arguments:configArgs, cacheFirst:true, uniqueOutput:true,dirOnly:isDirOnly},null,2));
    return 0;
  }
  // 打包前确认主进程 require 的 lib 模块都在 files 白名单里。
  // 漏列会让 app.asar 启动即报 "Cannot find module './lib/xxx'"。
  const check = path.join(__dirname, 'verify-packaged-lib.js');
  if (run(process.execPath, [check]) !== 0) {
    console.error('[HSA] Packaged lib manifest check failed; EXE not built.');
    return 1;
  }
  if (process.platform !== 'win32') {
    console.error('[HSA] Windows EXE packages must be built in Windows CMD.');
    return 1;
  }
  if (!prepare()) return 1;
  if (!fs.existsSync(BUILDER)) {
    console.error('[HSA] electron-builder missing. First run: npm run ci');
    return 1;
  }
  // Keep legacy output untouched: another installed/debugging Electron process may own it.
  console.log('[HSA] Using local Electron: '+BIN);
  console.log('[HSA] Isolated output: '+outputRel);
  const env = {...process.env,
    ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
      'https://npmmirror.com/mirrors/electron-builder-binaries/'};
  const status = run(process.execPath,[BUILDER,...configArgs],env);
  if (status === 0) console.log('[HSA] Complete: '+path.join(ROOT,outputRel));
  else console.error('[HSA] Build failed; previous output and binaries have not been deleted.');
  return status;
}
process.exitCode = main();
