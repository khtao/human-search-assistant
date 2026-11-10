# 拟人搜索助手 v1.3.8 R4｜页面等待、慢速扫描与 Windows 打包修复

本修复以 R3.1 完整源码为基础，包含浏览器插件 `edge-extension/` 与桌面版 `desktop-app/`。

## 自动任务：两端统一的页面扫描节奏

在自动任务的卡片阶段，针对以下两个页面分别执行：

- `https://rewards.bing.com/dashboard`
- `https://rewards.bing.com/earn`

流程为：**打开页面并等待加载 → 至少再等 5 秒 → 至少 12 个独立扫描/滚动步骤，每步至少 520 毫秒（合计不少于 6.24 秒） → 合并实时 DOM 卡片和同步索引 → 重新验证坐标 → 发送 CDP 鼠标点击**。

滚动会按小步逐段移动，避免以前直接跳到页面底部导致 SPA 虚拟列表和懒加载内容无法逐步出现。遇到页面内部滚动容器时也会分段查找。浏览器插件在已取得 CDP 调试会话时使用真实 `mouseWheel` 事件，同时用页面滚动定位校准扫描位置；桌面版使用 Electron CDP 滚轮事件，出现不可用时仍通过页面滚动定位扫描（**不会**改用 DOM 合成点击冒充 CDP 点击）。

若页面短到没有滚动空间，仍保持至少 5 秒的分段扫描时间，但无法产生实际滚动位移。点击间隔保留默认 **10 秒**，可在设置中调整 **1～60 秒**。停止操作可提前中断任务，因而停止时不会强制等满五秒。

## Windows：CMD 编译

下载并解压完整项目后，在系统自带的命令提示符（CMD）执行，路径替换为你的实际解压位置：

```cmd
cd /d C:\Users\86155\Downloads\human-search-assistant-main\desktop-app
npm run ci
npm run verify
npm run dist:win
```

也可使用：

```cmd
build-win-local.cmd
```

**两个打包入口现在都走 `scripts/build-win-safe.js`**。脚本会：

1. 检查本地 `node_modules\electron\dist\electron.exe`。如果 `npm run ci` 之后该文件消失，先通过 Electron 官方 `install.js` 尝试复用本机 `@electron/get` 缓存恢复；失败时再使用项目 `fix-electron.js` 的镜像下载流程。
2. 继续使用 `electron-builder.win.yml` 和本地 Electron 45.2.3，避免二次下载 Electron。
3. 每次打包都生成一个新的输出目录，例如 `desktop-app\dist\windows-builds\win-20261109090000-12345\`，不删除或覆盖旧版 `dist\win-unpacked`，以降低后台进程占用造成的 `EBUSY`。
4. 构建成功后，在 CMD 打印本次输出文件夹的位置。

如果依赖文件根本不存在，先 `npm run ci`。如果本地没有 Electron 缓存且网络连接持续重置，恢复 Electron 仍可能因网络问题失败；此时请保证能够访问镜像后再执行 `npm run fix:electron`。不能保证无网络环境自动完成首次安装。

## 验证

```cmd
npm run verify
```

默认验证现在额外包含 `scripts/verify-r4.js`：模拟两端滚动的每步延时、任务页等待与 Windows 构建参数，不涉及真实微软账号，也不生成 Windows EXE。另有 Chromium 离线页面测试：

```cmd
python scripts/verify-r3-browser.py
```

以上为静态与模拟测试；**Windows 实机 EXE 构建、系统托盘以及真实 Rewards 登录页面上全部任务的识别、点击和计分，仍需在用户本机验证**。

软件为非官方个人辅助工具，与 Microsoft 无隶属关系；使用时请遵守相关网站的服务条款。
