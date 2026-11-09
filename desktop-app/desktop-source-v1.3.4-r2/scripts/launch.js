#!/usr/bin/env node
/* ============================================================================
 * 跨平台启动包装（npm start）
 *
 * Ubuntu 真机日志：
 *   [FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:172]
 *   The SUID sandbox helper binary was found, but is not configured
 *   correctly. ... chrome-sandbox is owned by root and has mode 4755.
 *   electron exited with signal SIGTRAP
 *
 * 原因：Electron 的 Linux setuid sandbox 要求 node_modules/electron/dist/
 * chrome-sandbox 属于 root 且权限 4755。从 zip / 普通用户解压出来的文件
 * owner 是当前用户，直接 `electron .` 启动即 SIGTRAP。这与代码、依赖、
 * Electron 版本都无关；自检里 path.txt / 二进制 224MB 全部 ✓ 也照样崩。
 *
 * 处理策略（不静默降低安全）：
 *   1. 权限合格              → 原样启动，不加任何参数
 *   2. root 运行且权限不合格  → 自动 chown 0:0 + chmod 4755 后正常启动
 *   3. 普通用户且权限不合格  → 打印 sudo 修复命令，并临时追加
 *                              --no-sandbox --disable-setuid-sandbox 启动，
 *                              保证不被卡死，同时在控制台明确提示降级
 *   4. HSA_STRICT_SANDBOX=1  → 拒绝降级，直接退出并要求修复权限
 *   5. HSA_NO_SANDBOX=1      → 强制降级（CI / 容器里用）
 *   6. HSA_SANDBOX_OK=1      → 跳过检查（已自行修好权限时节省一次 stat）
 *
 * Windows / macOS 不做任何检查。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NO_SANDBOX_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

/** 判断 chrome-sandbox 是否满足 setuid sandbox 要求。可注入 stat 便于测试。 */
function sandboxStatus(bin, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  if (platform !== 'linux') return { applicable: false, ok: true, reason: 'non-linux' };

  const stat = o.stat || fs.statSync;
  const sandbox = path.join(path.dirname(bin), 'chrome-sandbox');
  let st;
  try { st = stat(sandbox); }
  catch (e) { return { applicable: true, ok: false, sandbox, reason: 'missing' }; }

  const mode = Number(st.mode) & 0o7777;
  const ok = Number(st.uid) === 0 && mode === 0o4755;
  return {
    applicable: true, ok, sandbox,
    uid: Number(st.uid), mode,
    reason: ok ? 'ok' : 'bad-mode'
  };
}

/** 纯函数：算出应追加的参数与是否需要降级。 */
function computeLaunch(bin, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const status = sandboxStatus(bin, o);
  const extra = [];

  if (env.HSA_SANDBOX_OK === '1' || !status.applicable || status.ok) {
    return { status, extra, downgraded: false, canFixAsRoot: false };
  }

  const uid = typeof o.getuid === 'function' ? o.getuid()
    : (typeof process.getuid === 'function' ? process.getuid() : -1);

  /* root：直接把权限修好，不需要降级 */
  if (uid === 0 && !o.noAutoFix && env.HSA_NO_SANDBOX !== '1') {
    try {
      const chown = o.chown || fs.chownSync;
      const chmod = o.chmod || fs.chmodSync;
      chown(status.sandbox, 0, 0);
      chmod(status.sandbox, 0o4755);
      return { status: Object.assign({}, status, { ok: true, reason: 'fixed-as-root' }),
        extra, downgraded: false, canFixAsRoot: true };
    } catch (e) {
      return { status: Object.assign({}, status, { reason: 'root-fix-failed' }),
        extra: NO_SANDBOX_ARGS.slice(), downgraded: true, canFixAsRoot: false };
    }
  }

  if (env.HSA_STRICT_SANDBOX === '1') {
    return { status, extra, downgraded: false, strict: true, canFixAsRoot: false };
  }
  return { status, extra: NO_SANDBOX_ARGS.slice(), downgraded: true, canFixAsRoot: false };
}

function printAdvice(status, downgraded, strict) {
  const rel = path.relative(ROOT, status.sandbox) || status.sandbox;
  console.log('\n\x1b[33m──────── Ubuntu / Linux · Chromium SUID 沙箱 ────────\x1b[0m');
  console.log('  检测到：' + rel + '（uid=' + status.uid + ', mode=' +
    (status.mode === undefined ? '?' : status.mode.toString(8)) + '）');
  console.log('  Electron 要求该文件属于 root 且权限为 4755，否则启动即 SIGTRAP。');
  console.log('\n  \x1b[1m推荐修复（保留沙箱，执行后重新 npm start）：\x1b[0m');
  console.log('    sudo chown root:root "' + status.sandbox + '"');
  console.log('    sudo chmod 4755 "' + status.sandbox + '"');
  console.log('\n  或者写入用户级配置（可选）：');
  console.log('    echo 1 | sudo tee /proc/sys/kernel/unprivileged_userns_clone');
  if (strict) {
    console.log('\n  \x1b[31mHSA_STRICT_SANDBOX=1：拒绝降级，请先修复权限。\x1b[0m\n');
  } else if (downgraded) {
    console.log('\n  \x1b[33m本次已临时以 --no-sandbox 启动以避免卡死；');
    console.log('  请尽快执行上面的两条 sudo 命令恢复 Chromium 沙箱。\x1b[0m\n');
  }
  console.log('');
}

function launch(opts) {
  const o = opts || {};
  let bin;
  try { bin = o.bin || require('electron'); }
  catch (e) {
    console.error('未检测到 Electron 二进制，请先 npm run ci（或 npm run fix:electron）。');
    return 1;
  }
  const plan = computeLaunch(bin, o);
  if (plan.status.applicable && !plan.status.ok && !plan.canFixAsRoot) {
    printAdvice(plan.status, plan.downgraded, plan.strict);
    if (plan.strict) return 1;
  } else if (plan.canFixAsRoot) {
    console.log('  \x1b[32m✓\x1b[0m 已自动修复 chrome-sandbox 权限（root:root 4755）\n');
  }

  const args = [ROOT, ...plan.extra, ...(o.extraArgs || [])];
  const spawnFn = o.spawn || spawn;
  const child = spawnFn(bin, args, {
    env: o.env || process.env,
    stdio: 'inherit',
    cwd: ROOT
  });
  if (child && typeof child.on === 'function') {
    child.on('exit', code => process.exit(code == null ? 1 : code));
  }
  return 0;
}

module.exports = { sandboxStatus, computeLaunch, launch, NO_SANDBOX_ARGS };

if (require.main === module) {
  process.exitCode = launch();
}
