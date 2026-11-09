#!/bin/sh
# Ubuntu / Debian x64: build the native Electron .deb package.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

fail() {
  printf '\n[build] ERROR: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = "Linux" ] || fail "该脚本只能在 Linux（Ubuntu/Debian）环境运行。"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "当前架构为 $(uname -m)，本构建脚本目前只支持 x86_64/amd64。" ;;
esac

command -v node >/dev/null 2>&1 || fail "未找到 Node.js。请安装 Node.js >= 22.12.0。"
command -v npm >/dev/null 2>&1 || fail "未找到 npm。"
command -v dpkg-deb >/dev/null 2>&1 || fail "未找到 dpkg-deb。请安装 dpkg-dev。"
command -v fakeroot >/dev/null 2>&1 || fail "未找到 fakeroot。请先安装 fakeroot。"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
  fail "当前 Node.js 为 $(node -v)，需要 >=22.12.0（建议 Node 24 LTS）。"
fi

if [ ! -x node_modules/.bin/electron-builder ] || [ ! -f node_modules/electron/dist/electron ]; then
  echo "[1/4] 安装锁定依赖（含 Electron 运行时）..."
  npm run ci
else
  echo "[1/4] 检测到本地 Electron 与 electron-builder，跳过依赖安装。"
fi

echo "[2/4] 检查 Electron 安装..."
node scripts/check-electron.js --verbose

echo "[3/4] 运行桌面版回归验证..."
if [ "${HSA_SKIP_VERIFY:-0}" != "1" ]; then
  npm run verify
else
  echo "HSA_SKIP_VERIFY=1：按环境设置跳过回归验证。"
fi

echo "[4/4] 构建 Ubuntu / Debian x64 .deb..."
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist"/HumanSearchAssistant-Ubuntu-*.deb "$ROOT/dist/SHA256SUMS.txt"
npm run dist:deb

DEB=$(find "$ROOT/dist" -maxdepth 1 -type f -name '*.deb' -print | sort | tail -n 1)
[ -n "$DEB" ] || fail "electron-builder 未生成 .deb 文件。"
dpkg-deb --info "$DEB" >/dev/null || fail "生成的 .deb 未通过 dpkg-deb 校验。"
(
  cd "$ROOT/dist"
  sha256sum "$(basename "$DEB")" > SHA256SUMS.txt
)

echo ""
echo "构建成功："
ls -lh "$DEB" "$ROOT/dist/SHA256SUMS.txt"
echo ""
dpkg-deb -I "$DEB" | sed -n '1,24p'
