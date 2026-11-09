#!/usr/bin/env node
/* ============================================================================
 * 导出调试现场包（独立命令，不需要应用正在运行）
 *
 *   npm run debug:pack
 *
 * 会把 desktop-app/debug-captures/ 下最近一次会话打成单个 zip，
 * 直接把这个 zip 提交给开发者即可。纯 Node 生成 zip，Windows / Ubuntu 通用。
 * 也可用应用菜单「导出调试现场包（zip）」在运行中导出当前会话。
 * ========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const { DebugCapture } = require('../lib/debug-capture');

/* enabled:false 避免新建空会话；sessionDir=null 让 pack() 自动选最近一个 */
const dbg = new DebugCapture({ enabled: false });
dbg.sessionDir = null;
const out = dbg.pack();
if (!out) {
  console.error('没有找到调试会话。请先启动应用（调试模式默认开启）：npm start');
  console.error('或显式指定目录：HSA_DEBUG_DIR=<路径> npm run debug:pack');
  process.exit(1);
}
console.log('\n现场包: ' + out);
console.log('大小: ' + (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
console.log('\n提交前请检查 html/ 下的页面是否含个人信息（默认已脱敏邮箱与 token）。');
