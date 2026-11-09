# 拟人搜索助手 · Ubuntu 桌面版

**版本：1.3.4｜运行时：Electron 45.2.3｜目标平台：Ubuntu / Debian x86_64**

项目主页与源码仓库：[github.com/khtao/human-search-assistant](https://github.com/khtao/human-search-assistant)。该地址同时写入 `package.json` 的 `homepage` 字段，供 Debian DEB 包元数据使用。

本仓库只保留桌面版项目。应用使用 Electron 原生窗口与内置 Chromium，不依赖系统浏览器，也不需要单独安装 Playwright。

## 功能

- 在桌面窗口中查看 Rewards 登录状态、积分和今日任务。
- 内置官方页面侧栏，可在应用内完成登录和页面交互。
- 主界面与内置页面共享 Electron 持久化会话。
- 提供任务面板、拟人搜索流程、状态同步和系统托盘入口。
- 默认不启用调试现场采集；用户数据保存在本机。

> 本软件为非官方个人辅助工具，与 Microsoft 无隶属关系。请遵守相关网站的服务条款及当地法律法规。

## Ubuntu 编译为 DEB

### 环境要求

- Ubuntu 22.04 / 24.04，或兼容的 Debian x86_64。
- Node.js **22.12.0 或更高版本**（建议 Node.js 24 LTS）。
- npm、`dpkg-deb`、`fakeroot`。
- 可访问 npm registry 和 Electron 二进制镜像的网络。

安装系统工具：

```bash
sudo apt update
sudo apt install -y build-essential dpkg-dev fakeroot
```

### 一键构建

在项目根目录执行：

```bash
npm run build:linux
```

脚本会依次完成：

1. 检查 Linux x86_64、Node.js 和打包工具版本。
2. 检查本地依赖；缺失时运行 `npm run ci` 安装锁定版本。
3. 检查 Electron 二进制及其安装状态。
4. 运行桌面版回归验证。
5. 使用 electron-builder 生成 `.deb`，并输出 SHA-256 校验文件。

构建产物位于 `dist/`。文件名以 `HumanSearchAssistant-Ubuntu-1.3.4-` 开头。

如果只想直接调用 electron-builder：

```bash
npm run ci
npm run dist:deb
```

Linux 与 Windows 使用独立的 electron-builder 配置文件，避免在 Linux 构建时校验 Windows 专属选项。Windows 构建入口仍保留：`npm run dist:win`（需在 Windows 环境执行）。

如需在已知测试环境中跳过回归验证，可执行 `HSA_SKIP_VERIFY=1 npm run build:linux`；正常交付建议不要跳过。

### 安装与卸载

```bash
sudo apt install ./dist/*.deb
```

也可以双击 `.deb`，通过系统软件安装器完成安装。启动方式：

```bash
human-search-assistant
```

或从桌面应用菜单打开“拟人搜索助手”。卸载：

```bash
sudo apt remove human-search-assistant
```

安装脚本会检查 Electron `chrome-sandbox` 并设置其标准 root 所有权与 4755 权限，避免普通解压安装时常见的 SUID sandbox 启动错误。

## 从源码运行

```bash
npm run ci
npm run doctor
npm start
```

首次启动后，通过应用菜单或内置页面登录。登录状态保存在 Electron 的持久化会话中。

## 验证

```bash
npm run verify          # 默认回归验证链
npm run verify:launch   # Linux / Electron 启动链
npm run verify:browser  # Playwright + Chromium 浏览器集成验证（需额外安装测试环境）
npm run verify:e2e      # 已登录场景端到端验证（需额外安装测试环境）
```

## 项目结构

```text
.
├── main.js                    # Electron 主进程与窗口/会话/IPC 管理
├── preload.js                 # 安全桥接与桌面 API 适配
├── host.html                  # 后台扩展逻辑承载页
├── src/                       # 桌面版实际使用的 UI、任务逻辑和图标
├── lib/core.js                # 公共核心逻辑
├── lib/debug-capture.js       # 用户主动开启时的调试现场采集
├── scripts/                   # 构建、启动、自检和回归验证脚本
├── tests/fixtures/            # 官网页面测试快照
├── tests/github-upload/       # 单份上传版基准，仅用于源码回归验证
├── build/                     # 应用图标
├── electron-builder.yml       # Ubuntu / Debian 专用配置
├── electron-builder.win.yml   # Windows 专用配置
└── package.json
```

`src/` 是桌面版加载的实际运行代码，不是需要删除的独立浏览器插件副本。`tests/github-upload/` 仅用于验证关键任务逻辑与原始基准的差异，不会进入安装包。真实浏览器验证需要额外准备 Playwright 和 Chromium；常规 `npm run verify` 不依赖这两项。

## 数据与隐私

应用状态文件默认位于 Electron `userData` 目录下的 `storage.json`；登录 Cookie 由 Electron 持久化会话管理。调试采集默认关闭；仅在显式调试模式下生成 `debug-captures/` 现场目录。请勿将个人登录数据或调试现场包公开分享。

## 版本与依赖

- Electron：`45.2.3`
- electron-builder：`26.18.1`
- Node.js：`>=22.12.0`
- 运行时 npm 依赖：无（Electron 由安装包内置）
