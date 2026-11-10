#!/usr/bin/env node
/* ============================================================================
 * 修补已构建产物里的 app.asar（零依赖，不需要重新 build，不需要 npm install）
 *
 * 起因：v1.3.8-s1 新增 lib/sidebar-task-cards.js，但两个 electron-builder
 * 配置的 files 白名单漏列了它。用旧配置打出的 app.asar 一启动就报：
 *   Error: Cannot find module './lib/sidebar-task-cards'
 *
 * 本脚本直接按 asar 归档格式把源码 lib/ 下缺失的模块补进现有归档，
 * 保留所有原有节点、offset 与 integrity，并自动备份原文件。
 *
 * 用法（在 desktop-app 源码目录执行）：
 *   node scripts/fix-existing-asar.js                       # 修补 dist/linux-unpacked/resources/app.asar
 *   node scripts/fix-existing-asar.js --check              # 只检查，不改文件
 *   node scripts/fix-existing-asar.js /path/to/app.asar    # 指定归档路径
 *
 * 修补后仍建议重新构建一次（npm run dist:linux），让配置修复永久生效；
 * 本脚本用于让手上这份已构建的 dist 立刻能启动。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const targetArg = args.find(a => !a.startsWith('--'));
const ASAR = targetArg ? path.resolve(targetArg)
  : path.join(ROOT, 'dist', 'linux-unpacked', 'resources', 'app.asar');

const ALIGN = 4;
const align4 = n => n + ((ALIGN - (n % ALIGN)) % ALIGN);

/* ---- asar 归档格式（与 @electron/asar 的 chromium-pickle 实现一致） ----
 * [0..4]   UInt32LE = 4                sizePickle 的 payload 长度
 * [4..8]   UInt32LE = headerBuf.length
 * [8..8+headerBuf.length]  headerPickle:
 *     [0..4] payloadSize
 *     [4..8] JSON 字符串字节数
 *     [8..]  JSON 字符串（按 4 字节补 0 对齐）
 * [8+headerBuf.length ..]  所有已打包文件内容依次拼接
 * header.files 是目录树；文件节点 { size, offset, integrity? }，
 * offset 是相对「内容区起点」的字符串。
 * ------------------------------------------------------------------------ */
function readArchive(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 16) throw new Error('文件过短，不是有效的 asar 归档');
  if (buf.readUInt32LE(0) !== 4) throw new Error('头部 pickle 长度异常，不是有效的 asar 归档');
  const headerSize = buf.readUInt32LE(4);
  if (headerSize <= 8 || 8 + headerSize > buf.length) throw new Error('header 长度异常');
  const hb = buf.slice(8, 8 + headerSize);
  const strLen = hb.readUInt32LE(4);
  if (strLen <= 0 || 8 + strLen > hb.length) throw new Error('header 字符串长度异常');
  let header;
  try { header = JSON.parse(hb.slice(8, 8 + strLen).toString('utf8')); }
  catch (e) { throw new Error('header JSON 解析失败：' + e.message); }
  if (!header || !header.files) throw new Error('header 缺少 files 树');
  return { buf, header, contentStart: 8 + headerSize };
}

function pickleString(str) {
  const data = Buffer.from(str, 'utf8');
  const payload = 4 + align4(data.length); // writeInt(4) + writeBytes(已对齐)
  const out = Buffer.alloc(4 + payload);
  out.writeUInt32LE(payload, 0);
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
}
function pickleHeaderSize(len) {
  const out = Buffer.alloc(8);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(len, 4);
  return out;
}

/** 与 @electron/asar integrity.js 一致：满块逐个 hash，最后 push 剩余块（可为空）。 */
function makeIntegrity(content, sample) {
  const algorithm = (sample && sample.algorithm) || 'SHA256';
  const blockSize = (sample && sample.blockSize) || 4 * 1024 * 1024;
  const hash = b => crypto.createHash(algorithm).update(b).digest('hex');
  const blocks = [];
  const full = Math.floor(content.length / blockSize);
  for (let i = 0; i < full; i++) blocks.push(hash(content.slice(i * blockSize, (i + 1) * blockSize)));
  blocks.push(hash(content.slice(full * blockSize)));
  return { algorithm, hash: hash(content), blockSize, blocks };
}

function findIntegritySample(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.integrity) return node.integrity;
  /* 目录节点是 { files: {...} }；根 header.files 本身就是「名字 → 节点」映射 */
  const children = node.files || node;
  for (const child of Object.values(children)) {
    if (child && typeof child === 'object') {
      const hit = findIntegritySample(child);
      if (hit) return hit;
    }
  }
  return null;
}

/** 从归档里读出某个文件的内容，用于判断 main.js 是不是新版。 */
function readArchivedFile(archive, name) {
  const node = archive.header.files[name];
  if (!node || node.files || node.offset == null) return null;
  const start = archive.contentStart + Number(node.offset);
  return archive.buf.slice(start, start + Number(node.size));
}

function main() {
  console.log('\napp.asar 缺失模块修补工具（零依赖）\n');
  if (!fs.existsSync(ASAR)) {
    console.error('找不到归档文件：' + ASAR);
    console.error('请传入 app.asar 的完整路径，例如：');
    console.error('  node scripts/fix-existing-asar.js ~/下载/desktop-app-modified/desktop-app/dist/linux-unpacked/resources/app.asar');
    process.exit(1);
  }
  console.log('目标归档：' + ASAR);

  const archive = readArchive(ASAR);
  console.log('归档解析成功 · header ' + (archive.contentStart - 8) + ' 字节 · 内容区 '
    + (archive.buf.length - archive.contentStart) + ' 字节');

  /* 只补 main.js / preload.js 真正 require 的 lib 模块，避免把调试用模块塞进去 */
  const src = ['main.js', 'preload.js']
    .filter(p => fs.existsSync(path.join(ROOT, p)))
    .map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n');
  const wanted = new Set();
  const re = /require\(\s*['"]\.\/lib\/([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) wanted.add('lib/' + m[1].replace(/\.js$/, '') + '.js');
  /* electron-lite.js 在打包配置里被显式排除（仅调试/降级用），不补 */
  wanted.delete('lib/electron-lite.js');

  const libDir = archive.header.files.lib;
  if (!libDir || !libDir.files) {
    console.error('归档里没有 lib/ 目录节点，结构异常，停止修补。');
    process.exit(1);
  }
  const missing = [...wanted].filter(f => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) && !libDir.files[path.basename(f)];
  });
  const already = [...wanted].filter(f => libDir.files[path.basename(f)]);

  console.log('\n主进程依赖的 lib 模块：' + [...wanted].join(', '));
  console.log('归档已包含：' + (already.join(', ') || '（无）'));
  if (!missing.length) {
    console.log('归档缺失：无 —— 无需修补。');
    const mainJs = readArchivedFile(archive, 'main.js');
    if (mainJs && !mainJs.toString('utf8').includes('sidebar-task-cards')) {
      console.log('\n注意：归档里的 main.js 是旧版本（未引用侧栏模块），启动不会报模块缺失，');
      console.log('      但也没有本次的侧栏点击改造。要启用新功能请重新构建：npm run dist:linux');
    } else {
      console.log('归档里的 main.js 已是新版，直接启动即可。');
    }
    return;
  }
  console.log('归档缺失：' + missing.join(', '));
  if (CHECK_ONLY) {
    console.log('\n--check 模式：未修改任何文件。去掉 --check 即可修补。');
    return;
  }

  const sample = findIntegritySample(archive.header.files);
  const withIntegrity = !!sample;
  console.log('归档' + (withIntegrity ? '带' : '不带') + ' integrity 校验，新节点保持一致');
  let contentLength = archive.buf.length - archive.contentStart;
  const chunks = [];
  for (const file of missing) {
    const content = fs.readFileSync(path.join(ROOT, file));
    const node = { size: content.length, offset: String(contentLength) };
    if (withIntegrity) node.integrity = makeIntegrity(content, sample);
    libDir.files[path.basename(file)] = node;
    contentLength += content.length;
    chunks.push(content);
    console.log('  + 补入 ' + file + '（' + content.length + ' 字节，offset ' + node.offset + '）');
  }

  const newHeaderBuf = pickleString(JSON.stringify(archive.header));
  const out = Buffer.concat([
    pickleHeaderSize(newHeaderBuf.length),
    newHeaderBuf,
    archive.buf.slice(archive.contentStart),
    ...chunks
  ]);

  /* 写回前自检：重新解析新归档，确认所有目标文件可读且内容一致 */
  const tmpCheck = ASAR + '.selfcheck-' + process.pid;
  fs.writeFileSync(tmpCheck, out);
  try {
    const verify = readArchive(tmpCheck);
    for (const file of missing) {
      const node = verify.header.files.lib.files[path.basename(file)];
      if (!node) throw new Error('自检失败：' + file + ' 节点丢失');
      const got = verify.buf.slice(verify.contentStart + Number(node.offset),
        verify.contentStart + Number(node.offset) + Number(node.size));
      const srcBuf = fs.readFileSync(path.join(ROOT, file));
      if (!got.equals(srcBuf)) throw new Error('自检失败：' + file + ' 内容不一致');
    }
    /* 顺带确认原有文件仍可读 */
    for (const f of ['main.js', 'package.json']) {
      const n = verify.header.files[f];
      if (n && !n.files && verify.buf.length >= verify.contentStart + Number(n.offset) + Number(n.size))
        continue;
      throw new Error('自检失败：原有 ' + f + ' 偏移越界');
    }
  } finally {
    fs.unlinkSync(tmpCheck);
  }
  console.log('写回前自检通过：原有节点偏移有效，补入文件内容逐字节一致');

  const bak = ASAR + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(ASAR, bak);
  const tmp = ASAR + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, ASAR);
  console.log('\n已修补：' + ASAR);
  console.log('原文件备份：' + bak);
  console.log('现在可以直接启动：./human-search-assistant --no-sandbox');
  console.log('\n提示：这只是让当前 dist 立刻可用。请尽快用修复后的配置重新构建');
  console.log('      （npm run dist:linux），以后新打的包就不会再漏文件。');
}

try { main(); }
catch (err) {
  console.error('\n修补失败：' + (err && err.stack || err));
  console.error('原归档未被修改（脚本在写回前才创建备份并替换）。');
  process.exit(1);
}
