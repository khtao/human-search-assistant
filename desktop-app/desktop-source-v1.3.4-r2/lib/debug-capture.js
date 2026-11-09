#!/usr/bin/env node
/* ============================================================================
 * 调试采集器（v1.1.3）
 *
 * 目的：真机「点登录没反应 / 抓不到积分与任务」时，把现场完整落盘，
 *       用户把 zip 交回来即可离线定位，不需要远程桌面或猜。
 *
 * 采集内容（全部在 desktop-app/debug-captures/session-<时间戳>/ 下）：
 *   README.txt              交给开发者的说明（含复现步骤填写位）
 *   environment.json        平台/Electron/Node/窗口/API 可用性/IPC handler 清单
 *   runtime.log             主进程关键链路日志（带时间戳）
 *   events.jsonl            逐条结构化事件（IPC 调用、storage 变更、页面导航）
 *   storage.json            storage.local 快照（脱敏）
 *   manifest.json           所有 HTML 的索引（kind / url / bytes / 是否登录页）
 *   html/*.html             抓取到的真实页面源码
 *
 * 抓取点全部在主进程，不改动 src/ 下的插件源码：
 *   · chrome:scripting:executeScript → 注入读 DOM 拿到的 outerHTML（积分/任务）
 *   · 侧栏 WebContentsView did-finish-load → 登录页 / Rewards 页 HTML
 *   · 后台数据视图 did-finish-load → /dashboard、/earn HTML
 *   · chrome:fetch → 热搜词源等响应体（可选）
 *
 * 默认开启（排障期）；HSA_DEBUG=0 关闭。HSA_DEBUG_REDACT=0 关闭脱敏。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

/* ------------------------------------------------------------------ ZIP（store 模式，无外部依赖） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}
/** 纯 Node 生成 zip（跨平台，Windows 不需装 zip / PowerShell 也可） */
function makeZip(entries) {
  const { time, date } = dosTime(new Date());
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(data);
    // HTML 重复度高，deflate 后提交体积小一个数量级；纯 Node、跨平台。
    const packed = zlib.deflateRawSync(data, { level: 6 });
    const method = 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);      // UTF-8 文件名标志
    lh.writeUInt16LE(method, 8);      // deflate
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(packed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, packed);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(packed.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

/* ------------------------------------------------------------------ 脱敏 */
const REDACT = process.env.HSA_DEBUG_REDACT !== '0';
function redact(text) {
  let s = String(text == null ? '' : text);
  if (!REDACT) return s;
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]');
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer [TOKEN]');
  s = s.replace(/"(?:accessToken|refreshToken|sessionKey|authToken|cookie|set-cookie)"\s*:\s*"[^"]{12,}"/gi,
    (m) => m.replace(/"[^"]{12,}"\s*$/, '"[REDACTED]"'));
  return s;
}

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function slug(url, max = 42) {
  try {
    const u = new URL(String(url));
    return (u.host + u.pathname).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'page';
  } catch { return 'no-url'; }
}

class DebugCapture {
  constructor(opts) {
    const o = opts || {};
    /* v1.1.6：默认禁用，只有命令行显式 HSA_DEBUG=1 才开启。
       npm run start:debug 会设置该变量；日常 npm start 不再采集任何现场。 */
    this.enabled = o.enabled !== undefined ? o.enabled : process.env.HSA_DEBUG === '1';
    this.rootDir = o.rootDir || process.env.HSA_DEBUG_DIR ||
      path.join(__dirname, '..', 'debug-captures');
    this.maxHtml = Number(o.maxHtml || process.env.HSA_DEBUG_MAX_HTML || 120);
    this.maxSessions = Number(o.maxSessions || 5);
    this.sessionDir = null;
    this.htmlCount = 0;
    this.entries = [];        // manifest 索引
    this.startedAt = null;
    this.logLines = [];
    this.eventLines = [];
    this.ipcCounts = {};
    this.env = {};
    /* v1.1.3 性能修复：调试模式默认开启，旧版每次 IPC 都同步 append 两次日志、
       每次 captureHtml 都重写整份 manifest.json，主进程事件循环被 sync I/O
       占满，反而让 fetchRewardsPage 的 12 秒 guard 抢先超时 —— 表现为
       「一开 debug 就抓不到积分」。现在日志/事件/索引全部内存缓冲，
       定时批量落盘；HTML 文件仍即时写（用户要的就是即时现场）。 */
    this._pendingLogs = [];
    this._pendingEvents = [];
    this._manifestDirty = false;
    this._flushTimer = null;
    if (this.enabled) {
      this._flushTimer = setInterval(() => this.flush(), 400);
      if (this._flushTimer.unref) this._flushTimer.unref();
      process.on('exit', () => { try { this.flush(); } catch {} });
    }
    this.start();
  }

  start() {
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
      // 只保留最近 N 个会话，避免长期占用磁盘
      const olds = fs.readdirSync(this.rootDir)
        .filter(n => n.startsWith('session-'))
        .sort().reverse().slice(this.maxSessions - 1);
      for (const n of olds) {
        try { fs.rmSync(path.join(this.rootDir, n), { recursive: true, force: true }); } catch {}
      }
      this.startedAt = new Date();
      this.sessionDir = path.join(this.rootDir, 'session-' + stamp(this.startedAt) + '-' + process.pid);
      fs.mkdirSync(path.join(this.sessionDir, 'html'), { recursive: true });
      this.write('README.txt', [
        '拟人搜索助手 · 调试现场',
        '========================================',
        '生成时间: ' + this.startedAt.toISOString(),
        '会话目录: ' + this.sessionDir,
        '',
        '请直接把「导出调试包」生成的 zip 发给开发者，或把整个 session-* 目录压缩后提交。',
        '',
        '【复现步骤请在此补充】(可编辑本文件后再打包)：',
        '  1. 启动命令: npm start / npm run setup',
        '  2. 是否登录: 已登录 / 未登录 / 不确定',
        '  3. 点击了什么: 登录按钮 / 刷新 / 自动完成任务',
        '  4. 期望: 右侧展开官网、三张卡显示积分、今日任务列表出现',
        '  5. 实际: （例如「点了没反应」「一直显示正在读取今日任务…」）',
        '',
        '文件说明:',
        '  environment.json  平台、Electron/Node 版本、窗口与 API 可用性、IPC 注册清单',
        '  runtime.log       主进程链路日志（含 IPC 调用、心跳、看门狗、导航）',
        '  events.jsonl      逐条结构化事件',
        '  storage.json      storage.local 快照',
        '  manifest.json     html/ 下每个文件的来源、URL、字节数、判定结果',
        '  html/*.html       真实抓到的页面源码（积分/任务/登录页）',
        '',
        '隐私: 默认已脱敏邮箱与 token；页面仍可能含用户名与积分，提交前请自行检查。',
        '      Cookie / 密码不会写入本目录。',
        ''
      ].join('\n'));
      console.log('\n\x1b[36m[debug] 调试模式已开启\x1b[0m');
      console.log('\x1b[36m[debug] 现场目录: ' + this.sessionDir + '\x1b[0m');
      console.log('\x1b[36m[debug] 关闭方法: HSA_DEBUG=0 npm start\x1b[0m\n');
    } catch (err) {
      this.enabled = false;
      console.warn('[debug] 无法创建调试目录，已禁用: ' + err.message);
    }
  }

  write(rel, content) {
    if (!this.enabled || !this.sessionDir) return null;
    try {
      const p = path.join(this.sessionDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return p;
    } catch { return null; }
  }

  log(scope, msg, data) {
    const line = `[${new Date().toISOString()}] [${scope}] ${String(msg)}` +
      (data === undefined ? '' : ' ' + JSON.stringify(data));
    this.logLines.push(line);
    if (this.enabled) {
      this._pendingLogs.push(line);
      this.event({ t: Date.now(), type: 'log', scope, msg, data });
    }
    if (process.env.HSA_DEBUG_CONSOLE === '1') console.log(line);
  }

  event(ev) {
    this.eventLines.push(ev);
    if (this.enabled) this._pendingEvents.push(ev);
  }

  /** 记录一次 IPC 调用（用于判断「点击登录到底有没有发出消息」） */
  ipc(channel, detail) {
    this.ipcCounts[channel] = (this.ipcCounts[channel] || 0) + 1;
    this.event({ t: Date.now(), type: 'ipc', channel, count: this.ipcCounts[channel], detail });
    /* runtime.log 里也留一行 channel 名，方便直接看出「点击登录到底有没有发消息」。
       只 push 到内存缓冲、不额外 event，避免旧版双写拖慢主进程。 */
    if (this.enabled) {
      this._pendingLogs.push(`[${new Date().toISOString()}] [ipc] ${channel}` +
        (detail === undefined ? '' : ' ' + JSON.stringify(detail)));
    }
  }

  /** 批量落盘：由 400ms 定时器 / pack() / 进程退出触发，不再每次 IPC 同步写盘 */
  flush() {
    if (!this.enabled || !this.sessionDir) return;
    try {
      if (this._pendingLogs.length) {
        fs.appendFileSync(path.join(this.sessionDir, 'runtime.log'),
          this._pendingLogs.join('\n') + '\n', 'utf8');
        this._pendingLogs.length = 0;
      }
      if (this._pendingEvents.length) {
        fs.appendFileSync(path.join(this.sessionDir, 'events.jsonl'),
          this._pendingEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
        this._pendingEvents.length = 0;
      }
      if (this._manifestDirty) {
        this.write('manifest.json', JSON.stringify({
          session: path.basename(this.sessionDir),
          startedAt: this.startedAt ? this.startedAt.toISOString() : null,
          count: this.entries.length, redacted: REDACT, files: this.entries
        }, null, 2));
        this._manifestDirty = false;
      }
    } catch {}
  }

  /** 核心：保存一次抓到的页面 HTML */
  captureHtml(kind, url, html, meta) {
    if (!this.enabled || !this.sessionDir) return null;
    if (this.htmlCount >= this.maxHtml) {
      this.log('debug', '达到单次会话 HTML 上限，跳过保存', { kind, url });
      return null;
    }
    const body = redact(String(html == null ? '' : html));
    const buf = Buffer.from(body, 'utf8');
    const n = ++this.htmlCount;
    const isLogin = /login\.live\.com|login\.microsoftonline|account\.live\.com|\/signin|\/login/i.test(String(url || '') + ' ' + body.slice(0, 4000));
    const file = `html/${String(n).padStart(4, '0')}-${kind}-${slug(url)}${isLogin ? '-LOGIN' : ''}.html`;
    try {
      fs.writeFileSync(path.join(this.sessionDir, file), buf);
    } catch (err) { this.log('debug', 'HTML 写盘失败: ' + err.message, { kind }); return null; }
    const rec = Object.assign({
      n, file, kind, url: String(url || ''), bytes: buf.length,
      at: new Date().toISOString(), isLoginPage: isLogin,
      redacted: REDACT
    }, meta || {});
    this.entries.push(rec);
    this._manifestDirty = true;      // 索引延后到 flush() 批量写
    this.event({ t: Date.now(), type: 'html', kind, url, bytes: buf.length, isLoginPage: isLogin, file });
    this.log('html', `${kind} → ${file} (${buf.length} bytes${isLogin ? ', 登录页' : ''})`, meta || {});
    return file;
  }

  setEnvironment(env) {
    this.env = Object.assign({}, this.env, env);
    this.write('environment.json', JSON.stringify(Object.assign({
      capturedAt: new Date().toISOString(),
      platform: process.platform, arch: process.arch,
      node: process.versions.node, cwd: process.cwd(),
      pid: process.pid, debugDir: this.rootDir
    }, this.env, { ipcCounts: this.ipcCounts }), null, 2));
  }

  snapshotStorage(state) {
    if (!this.enabled) return;
    const safe = {};
    for (const [k, v] of Object.entries(state || {})) {
      if (/token|password|secret|cookie/i.test(k)) { safe[k] = '[REDACTED]'; continue; }
      try { safe[k] = JSON.parse(redact(JSON.stringify(v))); } catch { safe[k] = String(v); }
    }
    this.write('storage.json', JSON.stringify(safe, null, 2));
  }

  /** 导出为单个 zip，返回路径；可在应用内菜单或独立命令调用 */
  pack() {
    if (!this.sessionDir || !fs.existsSync(this.sessionDir)) {
      // 独立命令：打包最近一个会话
      const dirs = fs.existsSync(this.rootDir)
        ? fs.readdirSync(this.rootDir).filter(n => n.startsWith('session-')).sort() : [];
      if (!dirs.length) return null;
      this.sessionDir = path.join(this.rootDir, dirs[dirs.length - 1]);
    }
    this.flush();                    // 打包前把缓冲的日志/事件/索引全部落盘
    this.setEnvironment({ packedAt: new Date().toISOString(), ipcCounts: this.ipcCounts });
    const base = this.sessionDir;
    /* 独立命令（npm run debug:pack）打包历史会话时 this.entries 为空，
       从该会话的 manifest.json 恢复索引，SUMMARY 里的 HTML 数量才准确。 */
    if (!this.entries.length) {
      try {
        const mf = path.join(base, 'manifest.json');
        if (fs.existsSync(mf)) this.entries = (JSON.parse(fs.readFileSync(mf, 'utf8')).files || []);
      } catch {}
    }
    const entries = [];
    const walk = (dir, prefix) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, prefix + name + '/');
        else entries.push({ name: prefix + name, data: fs.readFileSync(p) });
      }
    };
    walk(base, path.basename(base) + '/');
    // 附一份便于直接阅读的链路摘要
    entries.push({ name: path.basename(base) + '/SUMMARY.txt', data: [
      '会话: ' + path.basename(base),
      'HTML 文件数: ' + this.entries.length,
      'HTML 清单: ' + (this.entries.length
        ? this.entries.map(e => e.file + ' (' + e.bytes + 'B' + (e.isLoginPage ? ', 登录页' : '') + ')').join('\n  ')
        : '（无）'),
      'IPC 调用统计: ' + JSON.stringify(this.ipcCounts, null, 2),
      '',
      '最近 40 条日志:',
      ...this.logLines.slice(-40)
    ].join('\n') });
    const out = path.join(this.rootDir, '调试包-' + stamp(new Date()) + '.zip');
    try { fs.writeFileSync(out, makeZip(entries)); } catch (err) {
      console.error('[debug] 打包失败: ' + err.message); return null;
    }
    console.log('\x1b[32m[debug] 调试包已生成: ' + out + '\x1b[0m');
    return out;
  }
}

module.exports = { DebugCapture, makeZip, redact, crc32 };
