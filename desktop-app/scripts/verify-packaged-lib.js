#!/usr/bin/env node
/* ============================================================================
 * 打包清单防呆校验：main.js / preload.js 顶层 require('./lib/xxx') 的每个模块，
 * 必须在 Linux 与 Windows 两个 electron-builder 配置的 files 白名单里出现。
 *
 * 背景：v1.3.8-s1 新增 lib/sidebar-task-cards.js 后只改了源码，没改 yml，
 * 结果 app.asar 里缺文件，启动时报
 *   Error: Cannot find module './lib/sidebar-task-cards'
 * 这个校验把「新增 lib 模块」和「打包清单」绑在一起，防止再次漏项。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
function ck(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log('  ✓ ' + msg);
}

/** 从源码里抓出所有相对 lib 的 require（含双引号写法）。 */
function requiredLibModules(sources) {
  const found = new Set();
  for (const src of sources) {
    const re = /require\(\s*['"]\.\/lib\/([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) found.add('lib/' + m[1].replace(/\.js$/, '') + '.js');
  }
  return [...found].sort();
}

/** 解析 yml 里 files: 段，返回白名单与显式排除项。 */
function fileAllowList(yml) {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex(l => /^files:\s*$/.test(l));
  assert.ok(start >= 0, 'electron-builder 配置缺少 files: 段');
  const allow = [], excluded = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) continue;
    /* 顶格且不是列表项 → 下一个顶层配置段，结束 */
    if (/^\S/.test(raw) && !raw.startsWith(' ')) break;
    const m = raw.match(/^\s*-\s+(.+?)\s*$/);
    if (!m) continue;
    const v = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (v.startsWith('!')) excluded.push(v.slice(1));
    else allow.push(v);
  }
  return { allow, excluded };
}

function listed(allow, file) {
  return allow.some(a => {
    if (a === file) return true;
    /* lib/**\/* 之类的通配也覆盖 */
    if (a === 'lib/**/*' || a === 'lib/**' || a === 'lib/*') return file.startsWith('lib/');
    if (a.endsWith('/**/*')) return file.startsWith(a.slice(0, -5));
    return false;
  });
}

console.log('\n打包清单防呆校验 · require(\'./lib/*\') ↔ electron-builder files\n');

const sources = ['main.js', 'preload.js']
  .filter(p => fs.existsSync(path.join(ROOT, p)))
  .map(p => read(p));
const modules = requiredLibModules(sources);
ck(modules.length >= 3, '识别出 ' + modules.length + ' 个被主进程 require 的 lib 模块：'
  + modules.join(', '));

for (const cfg of ['electron-builder.yml', 'electron-builder.win.yml']) {
  const yml = read(cfg);
  const { allow, excluded } = fileAllowList(yml);
  ck(allow.length > 0, cfg + ' 的 files 白名单可解析（' + allow.length + ' 条，'
    + excluded.length + ' 条排除）');
  /* 被显式排除的模块（如仅调试用的 electron-lite）不要求进包 */
  const needed = modules.filter(m => !excluded.some(e => e === m || e === 'lib/**/*'));
  ck(needed.length >= 3, cfg + ' 需打包的 lib 模块：' + needed.join(', '));
  ck(needed.includes('lib/sidebar-task-cards.js'), cfg + ' 侧栏识别模块确实被 main.js 顶层 require');
  for (const mod of needed) {
    ck(listed(allow, mod), cfg + ' 已包含 ' + mod);
  }
  ck(yml.includes('asar: true'), cfg + ' 使用 asar 打包（漏列模块会直接导致启动崩溃）');
}

console.log('\n共 ' + pass + ' 项，通过 ' + pass + ' 项，失败 0 项');
console.log('提示：新增 lib 模块后若本脚本报错，请把模块名补进两个 yml 的 files 段。');
