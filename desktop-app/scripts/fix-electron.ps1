<#
.SYNOPSIS
  手动下载 Electron Windows 二进制并放到 node_modules/electron/dist，
  用于「npm install 时连 GitHub 超时」的完全离线兜底。

.DESCRIPTION
  npm 包 electron 已经解压到 node_modules，只是 postinstall 的 install.js
  下载二进制失败。本脚本等价于替它完成这一步：
    1. 从国内镜像下载 electron-v<版本>-win32-x64.zip
    2. 解压到 node_modules/electron/dist
    3. 写 node_modules/electron/path.txt = electron.exe
  之后 npm start / npm run dist:win 即可正常使用，无需再跑 install.js。

.PARAMETER Mirror
  镜像根地址，默认是 npmmirror。备用：
    https://registry.npmmirror.com/-/binary/electron/
    https://mirrors.huaweicloud.com/electron/

.PARAMETER Version
  Electron 版本，默认从 package.json 的 devDependencies 读取。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fix-electron.ps1

.EXAMPLE
  npm run fix:electron -- -Mirror https://mirrors.huaweicloud.com/electron/
#>
param(
  [string]$Mirror = 'https://npmmirror.com/mirrors/electron/',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$root = Split-Path -Parent $PSScriptRoot
$electronDir = Join-Path $root 'node_modules\electron'

if (-not $Version) {
  $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $Version = $pkg.devDependencies.electron
}
$Version = ([string]$Version).TrimStart([char[]]@('v', '^', '~', ' '))
if (-not $Version) { throw '无法从 package.json 读取 Electron 版本，请用 -Version 指定。' }

$zipName = "electron-v$Version-win32-x64.zip"
# 镜像目录结构是 <mirror>/<version>/<zipName>
$url = $Mirror.TrimEnd('/') + '/' + $Version + '/' + $zipName
$tmpZip = Join-Path $env:TEMP $zipName
$extract = Join-Path $env:TEMP ('electron-extract-' + [guid]::NewGuid().ToString('N'))
$dest = Join-Path $electronDir 'dist'

if (-not (Test-Path $electronDir)) {
  Write-Host ''
  Write-Warning "未找到 $electronDir"
  Write-Warning '请先执行一次（--ignore-scripts 不会触发下载，所以一定能成功）：'
  Write-Warning '    npm ci --ignore-scripts'
  Write-Host ''
  exit 1
}

Write-Host "Electron 版本 : $Version"
Write-Host "下载地址     : $url"
Write-Host '开始下载（约 100MB，请耐心等待）...'
Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing -TimeoutSec 900

$zipItem = Get-Item $tmpZip
if ($zipItem.Length -lt 10MB) {
  throw "下载文件只有 $($zipItem.Length) 字节，疑似拿到错误页。请换 -Mirror 备用镜像重试。"
}
Write-Host ("下载完成：{0:N1} MB" -f ($zipItem.Length / 1MB))

Write-Host '正在解压...'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($tmpZip, $extract)

# zip 里通常有一层 electron-v<version>-win32-x64/ 目录
$inner = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
if ($inner -and (Test-Path (Join-Path $inner.FullName 'electron.exe'))) {
  $src = $inner.FullName
} else {
  $src = $extract
}
if (-not (Test-Path (Join-Path $src 'electron.exe'))) {
  throw '解压后未找到 electron.exe，压缩包结构可能异常。'
}

Write-Host "安装到 $dest ..."
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
[IO.File]::WriteAllText(
  (Join-Path $electronDir 'path.txt'),
  'electron.exe',
  (New-Object System.Text.UTF8Encoding($false))
)

Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '✓ Electron 二进制就位。' -ForegroundColor Green
Write-Host '  现在可以执行：' -ForegroundColor Green
Write-Host '    npm start          启动桌面应用' -ForegroundColor Green
Write-Host '    npm run dist:win   构建 Windows 安装包（打包工具的镜像已由 .npmrc 配置）' -ForegroundColor Green
Write-Host ''
