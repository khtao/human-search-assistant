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
# Windows 与 Ubuntu 共用仓库根 release/ 目录；固定文件名，重复编译直接覆盖原文件。
RELEASE=$(CDPATH= cd -- "$ROOT/.." && pwd)/release
mkdir -p "$RELEASE"
# 只清理旧校验和；安装包本身由 electron-builder 按固定文件名直接覆盖。
rm -f "$RELEASE/SHA256SUMS.txt"
npm run dist:deb

DEB="$RELEASE/HumanSearchAssistant-Ubuntu.deb"
[ -f "$DEB" ] || fail "electron-builder 未生成 HumanSearchAssistant-Ubuntu.deb。"
dpkg-deb --info "$DEB" >/dev/null || fail "生成的 .deb 未通过 dpkg-deb 校验。"
(
  cd "$RELEASE"
  sha256sum "HumanSearchAssistant-Ubuntu.deb" > SHA256SUMS.txt
)

echo ""
echo "构建成功（输出目录：$RELEASE，同名文件已覆盖）："
ls -lh "$DEB" "$RELEASE/SHA256SUMS.txt"
echo ""
dpkg-deb -I "$DEB" | sed -n '1,24p'
