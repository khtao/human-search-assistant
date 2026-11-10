# v1.3.8 R3 修复说明：CDP、任务滚动、点击间隔、积分日历

本源码包以 v1.3.8 R2 为基础，保留上一个版本的 Windows 托盘修复、Electron 本地打包配置和任务卡片定位增强，同时将以下改动应用于 Edge 浏览器插件及桌面版。

## 1. 插件的 CDP 点击与可见滚动

- 浏览器插件打开 `/dashboard`、`/earn` 后，扫描任务前即尝试通过 `chrome.debugger.attach` 建立 CDP 会话。这里的“CDP 模式”指扩展接入浏览器调试协议，并不要求人工打开开发者工具。
- 附加成功时，扫描过程发送 `Input.dispatchMouseEvent` 的 `mouseWheel` 事件，并同步逐段滚动页面及内部可滚动容器；每段等待页面异步加载后扫描任务卡片，最后恢复页首。
- 即使调试协议附加失败，也会滚动扫描任务、打印明确原因，但**不会退化成 DOM 合成点击**。只有成功建立 CDP、定位坐标正确时才执行 `mouseMoved` / `mousePressed` / `mouseReleased`。
- 扫描结果会与同步索引合并，处理点击后新出现的卡片，降低漏卡概率。
- 调试信息：Edge 进入 `edge://extensions/`，在该扩展的 Service Worker 选择“检查”，运行任务后查找 `[AutoTask][CDP]`、`[AutoTask][Scroll]` 和 `[AutoTask]` 日志。若其他开发工具占用调试会话或扩展权限被拒绝，日志会报告原因。

## 2. 卡片点击间隔（两个版本）

- 默认 **10 秒**；设置中新增“卡片点击间隔（秒）”，可设 **1–60 秒**。
- 该间隔对齐相邻两次实际鼠标点击，避免扫描和重新定位耗时被误计为已经完成间隔。
- 修改设置后存入本地 storage，下次启动仍保留。建议先保持 10 秒。

## 3. 积分日历（两个版本）

- **周视图**：使用整行周卡片，列出每周积分总数，并以 7 个日状态点显示周内领取情况。
- **月视图**：以 12 个月的汇总卡片展示当月积分与有积分的天数。
- **导航状态**：上一周期/下一周期没有正积分数据时，按钮使用灰色样式；页面本身无积分记录时，导航也保持灰色。按钮仍可用于翻到历史空白月份或年份。
- 插件和桌面版使用一致的结构、样式与本地积分历史数据。

## Windows CMD 编译

解压项目到任意目录，假设是 `C:\Users\86155\Downloads\human-search-assistant-main`：

```cmd
cd /d C:\Users\86155\Downloads\human-search-assistant-main\desktop-app
npm run ci
npm run doctor
npm run verify
build-win-local.cmd
```

已正确安装 Electron 的情况下可跳过 `npm run ci`。EXE 输出到 `desktop-app\dist`。工具脚本 `build-win-local.cmd` 采用本地 Electron 优先方式，减少网络下载中断。

## Edge 插件安装

1. 进入 Edge 地址栏 `edge://extensions/` 并开启“开发人员模式”。
2. 禁用或移除旧插件，避免同一账号同时运行多个版本。
3. 点击“加载解压缩的扩展”，选择本项目的 `edge-extension` 目录。
4. 在插件设置中检查“卡片点击间隔（秒）”，默认 10。

## 检验范围及限制

已运行项目回归测试、R3 逻辑专项测试、离线 Chromium 滚动/日历测试，以及 Windows 构建脚本的静态检查。**尚未在实际 Windows 托盘和登录后的 Microsoft Rewards 页面执行全流程点击，也未在本环境生成 Windows EXE**。实际识别效果可能受到 Rewards 页面动态布局、CDP 权限与页面加载状态影响；遇到失败请保留上述 Worker 日志。
