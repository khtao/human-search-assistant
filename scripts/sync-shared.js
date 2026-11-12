#!/usr/bin/env node
/* ============================================================================
 * 把 shared/ 的单一真源同步到两个运行时目录。
 *   node scripts/sync-shared.js           写入副本
 *   node scripts/sync-shared.js --check   只校验，不写文件（退出码 1 表示不一致）
 * 副本带 AUTO-GENERATED 头；校验时忽略该头，逐字节比对正文。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'shared');
const TARGETS = [
  path.join(ROOT, 'edge-extension', 'shared'),
  path.join(ROOT, 'desktop-app', 'shared')
];
const FILES = ['hsa-core.js', 'hsa-recovery.js', 'hsa-shared.css',
               'hsa-zip.js', 'hsa-hover-tip.js', 'hsa-pull-refresh.js',
               'hsa-calendar.js', 'hsa-human.js', 'hsa-fingerprint.js',
               'hsa-geo.js', 'hsa-stealth.js', 'decisions.json'];
const HEADER = '/* AUTO-GENERATED from shared/ — do not edit; run node scripts/sync-shared.js */\n';

function body(src) {
  const s = String(src).replace(/\r\n/g, '\n');
  return s.startsWith(HEADER) ? s.slice(HEADER.length) : s;
}
function generated(src, name) {
  if (name.endsWith(".json")) return src; // JSON 不能带注释
  return HEADER + src;
}
function read(p) { return fs.readFileSync(p, 'utf8'); }

function verify() {
  const problems = [];
  for (const dir of TARGETS) {
    for (const name of FILES) {
      const dst = path.join(dir, name);
      if (!fs.existsSync(dst)) { problems.push('缺失: ' + path.relative(ROOT, dst)); continue; }
      if (body(read(dst)) !== body(read(path.join(SRC, name)))) {
        problems.push('内容不一致: ' + path.relative(ROOT, dst));
      }
    }
  }
  return problems;
}

function sync() {
  for (const dir of TARGETS) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of FILES) {
      const src = read(path.join(SRC, name));
      fs.writeFileSync(path.join(dir, name), generated(src, name), 'utf8');
    }
  }
}

function main() {
  const check = process.argv.includes('--check');
  if (check) {
    const problems = verify();
    if (problems.length) {
      console.error('共享副本校验失败：\n  - ' + problems.join('\n  - '));
      process.exit(1);
    }
    console.log('共享副本校验通过：' + TARGETS.length + ' 个目录 × ' + FILES.length + ' 个文件');
    return;
  }
  sync();
  const problems = verify();
  if (problems.length) {
    console.error('同步后校验失败：' + problems.join('; '));
    process.exit(1);
  }
  console.log('已同步 shared/ → edge-extension/shared/ 与 desktop-app/shared/（' + FILES.join(', ') + '）');
}

if (require.main === module) main();
module.exports = { verify, sync, FILES, TARGETS };
