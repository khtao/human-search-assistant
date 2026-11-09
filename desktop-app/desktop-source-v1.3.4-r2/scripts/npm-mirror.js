#!/usr/bin/env node
/* ============================================================================
 * npm 安装包装：把 Electron / electron-builder 镜像以「环境变量」注入
 *
 * 背景：npm 11+ 对项目 .npmrc 里的未知 project config 会报
 *   Unknown project config "electron_mirror". This will stop working ...
 * 这些键本来不是 npm 配置项，只是 npm 会把 .npmrc 的 key=value 透传成
 * npm_config_<key> 环境变量给生命周期脚本（electron/install.js、
 * @electron/get、electron-builder 的下载器读的正是它们）。
 *
 * 本脚本直接设置这些环境变量再 spawn npm，因此：
 *   · 项目 .npmrc 只剩 npm 内置键 → 零警告
 *   · 国内镜像能力完全保留，且不新增任何依赖
 *   · Windows / Ubuntu 用同一条 `npm run ci` / `npm run setup`
 *
 * 用法：
 *   npm run ci            # == 带镜像的 npm ci
 *   npm run setup         # == 带镜像的 npm install + doctor + start
 *   或： node scripts/npm-mirror.js install --ignore-scripts
 * ========================================================================== */
'use strict';
const { spawnSync } = require('child_process');

const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
const BUILDER_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';
const NODE_DIST = 'https://npmmirror.com/mirrors/node';

/* 两种写法都给：@electron/get / electron-builder 新旧版本读取的键名不同 */
const env = Object.assign({}, process.env, {
  ELECTRON_MIRROR,
  npm_config_electron_mirror: ELECTRON_MIRROR,
  ELECTRON_BUILDER_BINARIES_MIRROR: BUILDER_MIRROR,
  npm_config_electron_builder_binaries_mirror: BUILDER_MIRROR,
  npm_config_disturl: NODE_DIST
});

const args = process.argv.slice(2);
if (!args.length) args.push('install');

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const res = spawnSync(npmCmd, args, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (res.error) {
  console.error('无法启动 npm：' + (res.error && res.error.message || res.error));
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
