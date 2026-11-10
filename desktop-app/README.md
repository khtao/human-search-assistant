# 拟人搜索助手 · Ubuntu 桌面版

**版本：1.3.8｜运行时：Electron 45.2.3｜目标平台：Ubuntu / Debian x86_64**

项目主页与源码仓库：[github.com/khtao/human-search-assistant](https://github.com/khtao/human-search-assistant)。该地址同时写入 `package.json` 的 `homepage` 字段，供 Debian DEB 包元数据使用。

完整交付包同时包含 `desktop-app/` 与 `edge-extension/` 两个目录。应用使用 Electron 原生窗口与内置 Chromium，不依赖系统浏览器，也不需要单独安装 Playwright。运行桌面版回归测试时请保留两个目录的相对位置。

## 功能

- 在桌面窗口中查看 Rewards 登录状态、积分和今日任务。
- 内置官方页面侧栏，可在应用内完成登录和页面交互。
- 主界面与内置页面共享 Electron 持久化会话。
- 提供任务面板、拟人搜索流程、状态同步和系统托盘入口。
- 默认不启用调试现场采集；用户数据保存在本机。

> 本软件为非官方个人辅助工具，与 Microsoft 无隶属关系。请遵守相关网站的服务条款及当地法律法规。

## v1.3.8 升级内容

- **积分赚取日历**：设置页新增日历，按日历网格排布，格子内只显示当日积分、不显示具体日期数字；提供「日 / 周 / 月」三种汇总粒度与上/下周期翻页。后台每次同步把当日积分写入 `pointsHistory[YYYY-MM-DD]`，历史从升级后第一次同步开始积累（最多保留 400 天）。
  - **支付宝收益日历风格**：顶部一个大数字「本月 / 本年累计积分」，下面是三种视图统一的无边框圆角正方形格子（纯色、扁平、无阴影）；过去无积分浅灰、未来不显示方块、有积分淡蓝、今日细描边。格子只显示积分，日期与当日明细放在**悬停提示**里；周 / 月格用极简角标。
- **设置页无小字注释**：所有 `<small>` 说明、`calendar.note`、`auto-disabled-hint` 全部移除，改为跟随语言切换的**自定义悬停浮层**（不用原生黑色 title 框）；日历容器悬停可看配色与排布说明，操作反馈小字 4 秒后自动收起。
- **语言顺序**：中文 → 英文 → 跟随系统；桌面版与浏览器插件的共有设置完全一致。
- **进度详情**：**不新增文本框**，直接复用进度圆圈下方原有的状态行（即原来显示绿色小字的位置）。文案保持单行但比上一版稍详细：同步进度 + 读取页面、今日 / 可用积分、打开哪个页面、点击第几张卡片与卡片名、下一步动作、搜索序号与关键词、收尾任务状态；延迟动作把 `{s}` 替换为**剩余秒数倒计时**。长句省略时悬停状态行可读全文，空闲 12 秒后回落为常规状态文字。
- **桌面版专属功能**（仅桌面版「设置 → 桌面版」显示，插件端不含此组）：
  - 开机自动启动：调用 Electron `app.setLoginItemSettings`，默认关闭。
  - 静默完成任务：默认关闭；**仅隐藏页面过程**（官网侧栏、任务视图、搜索窗口留在离屏视口渲染），不展开主界面、不抢系统焦点。同步、点击、搜索、积分历史与**全部运行详情**都走与正常模式完全相同的链路，后台不感知该开关。

`npm run verify` 已包含 `verify-v138.js` 专项。真实账号下的官网交互未在本次交付中实测。

## 任务卡片点击（v1.3.7）

浏览器插件与桌面版在同步积分和今日任务列表时，同步建立 `taskClickIndex`。索引随积分和任务列表在同一批 storage 写入，避免点击阶段再次下载/解析两页 HTML 或重新扫描整页卡片。

每个任务索引保存：

- 任务身份：名称、描述、积分、所属分类、完成状态。
- 页面来源：`/dashboard` 或 `/earn`。
- 链接信息：完整 href、目标窗口类型及稳定 URL 指纹。
- DOM 特征：`data-bi-id`、`data-offer-id`、`data-testid`、`id`、`aria-label`、标题、页面内锚点序号。
- 索引更新时间与待办数量。索引不保存坐标或 DOM 节点引用，避免页面滚动或重新渲染后使用过期位置。

自动点击时直接读取索引，优先按 href 和稳定属性定位；仅在未命中时才进行有限的懒加载滚动，并继续按同一任务索引查找。定位成功后重新计算实时坐标，通过 `elementFromPoint` 检查点击位置，再使用 `Input.dispatchMouseEvent` 发送 `mouseMoved`、`mousePressed`、`mouseReleased`。

任务卡片流程不使用 `HTMLElement.click()`、合成 `MouseEvent` 或直接打开任务 URL 代替鼠标点击。点击事件发送成功、任务页面打开和积分到账分别记录；无法定位或无法确认响应时不会伪报任务已完成。索引超过 30 分钟会拒绝使用，自动任务开始时会先执行新一轮同步。

## v1.3.7 稳定性修复

- 登录按钮展开官网时，普通 Cookie 变化不再清空已有积分；仅识别已知认证 Cookie 删除或明确退出登录。
- 任务进度只有在已获得积分达到总积分时才显示 100%；确认全部完成后，自动任务不再打开任何任务卡片。
- 桌面设置页面与 Edge 插件设置控件保持一致，并支持「跳过已完成任务卡」。
- 调试缓冲、任务页监听器、消息超时和 WebContentsView 标签引用均增加生命周期上限或清理逻辑。

完整修改说明见项目根目录的 `CHANGELOG_V1.3.7.md` 与 `TASK_CLICK_INDEX_V1.3.7.md`。

## R4：Windows CMD 安全打包与慢速扫描

- `npm run dist:win` 和 `build-win-local.cmd` 现在调用 `scripts/build-win-safe.js`：优先恢复本机缓存中的 Electron 二进制，并将每次构建输出到 `dist/windows-builds/win-...` 独立目录，避免旧版 `dist/win-unpacked` 被占用造成 EBUSY。
- `npm run ci` 后无 `node_modules/electron/dist` 时，安全脚本会自动调用官方 Electron installer，失败时再用项目镜像修复脚本。
- 桌面与插件打开 `/dashboard`、`/earn` 后各等待至少 5 秒，再做不少于 5 秒的慢速分段扫描；点击间隔仍可在设置中调节，默认 10 秒。
- 完整说明见项目根目录 `R4-慢速滚动与Windows编译修复说明.md`。

CMD 示例：

```cmd
cd /d C:\Users\86155\Downloads\human-search-assistant-main\desktop-app
npm run ci
npm run verify
npm run dist:win
```

Windows 构建输出位于新建的 `dist/windows-builds/win-*` 目录中；不会自动覆盖原来的 `dist/win-unpacked`。

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

构建产物位于 `dist/`。文件名以 `HumanSearchAssistant-Ubuntu-1.3.7-` 开头。

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
