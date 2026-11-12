# 拟人搜索助手 · 桌面版

**版本 1.3.8｜Electron 45.2.3｜electron-builder 26.18.1｜Ubuntu / Debian x86_64、Windows x64**

一个本地运行的 Electron 桌面应用，用于查看 Bing Rewards 的积分、今日任务与登录状态，并按设定自动完成任务卡片与搜索。所有窗口、官网页面与后台逻辑都跑在应用内置的 Chromium 中，不依赖系统浏览器，也不需要 Playwright。

> 非官方个人辅助工具，与 Microsoft 无隶属关系。请遵守相关网站的服务条款及当地法律法规。

---

## 快速开始

需要 Node.js ≥ 22.12.0。

```bash
npm run ci       # 按 package-lock 精确安装依赖（含 Electron 运行时，走国内镜像）
npm run setup    # 安装锁定依赖 → 自检 → 启动
npm run doctor   # 只做环境与 Electron 安装自检
npm start        # 已装好依赖时直接启动
```

首次启动后，在主界面点登录徽标打开内置官网侧栏完成登录；登录状态保存在 Electron 持久化会话中，所有窗口共享同一份 Cookie。

### 安装 DEB 后的沙箱权限

DEB 安装脚本会把 `chrome-sandbox` 设为 `root:root` / `4755`。若手动安装后启动时提示沙箱权限错误，可执行：

```bash
sudo chown root:root /opt/拟人搜索助手/chrome-sandbox
sudo chmod 4755 /opt/拟人搜索助手/chrome-sandbox
```

容器或 CI 中可设 `HSA_NO_SANDBOX=1` 允许降级启动；`HSA_STRICT_SANDBOX=1` 则拒绝任何降级。

---

## 功能

- **积分与任务**：三项积分、今日任务列表、登录徽标；数据只在「开始时同步」与「收尾同步」时刷新，空闲时零官网请求。
- **内置官网侧栏**：应用内完成登录、浏览 Rewards 页面，与主界面共享会话。
- **自动完成任务**：同步积分 → 侧栏点击积分卡片 → 拟人搜索 → 收尾同步。
- **积分日历**：设置页按日 / 周 / 月查看积分赚取记录，最多保留 400 天。
- **运行详情**：进度圆圈下方的状态行实时显示同步、点击第几张卡片、下一步动作、搜索关键词与倒计时。
- **系统托盘**：关闭窗口后驻留托盘，托盘菜单可显示主界面或退出。
- **桌面专属设置**：「开机自动启动」一项可切换，另有一行只读信息「内置浏览器：Microsoft Edge · Bing」。「静默完成任务」与「侧栏在独立窗口显示」开关均已移除；官网侧栏固定内嵌在主窗口右侧，自带独立滚动条，主界面与设置共用另一根滚动条。
- **标准 Chrome 标识（v3.7）**：桌面版内置浏览器只去掉 Electron 自身标记，呈现为正常 Chrome。UA 用真实 `process.versions.chrome` 与真实 OS 构造（`app.userAgentFallback`）；`webRequest.onBeforeSendHeaders` 只对 Bing / Rewards / Microsoft 域注入同源 `sec-ch-ua` / `sec-ch-ua-platform`；外部网页 `dom-ready` 注入短脚本对齐 `navigator.userAgentData` 并清理意外暴露的 Node 全局（`nodeIntegration:false` + `contextIsolation:true` 本已隔离）。三处同源，**不伪造** WebGL / 字体 / 屏幕 / 硬件指纹，也不复用外部 Edge Cookie；旧的 `edge-identity.js`（伪造 Microsoft Edge）保持删除。插件版不做任何身份改写。默认主页 `https://www.bing.com/?mkt=zh-CN`、默认搜索 `https://www.bing.com/search?q=` 保留；登录、积分同步、任务侧栏仍显式使用 Rewards 原始 URL。
- **统一同步闸门 / 状态文案（v3.2）**：桌面版与插件版共用 `shared/hsa-core.js` 的 `createSyncGate()`（adapter 注入宿主差异，决策零差异）：`ui-open` 30 分钟冷却、`refreshTasks` 10 秒、`start/finish` 2 秒且强制新数据；并发合并、指纹去重、当日全部完成停止全部任务。桌面旧版 `desktopActivityOrigSync` / `OrigAuto` 里的长文案已删除，改由闸门写入两端同构的 `activityDetail`（短文案 + `fullZh/fullEn` 详细全文）；`hsaRunLog` 补 `platform`，`desktopActivityWrite` 补 `platform/actor/category`，日志字段与插件版对齐。
- **打开主界面同步一次（v3.0）**：popup 初始化与窗口 `show` / `restore` 时各请求一次 `syncOnOpen`，共享判定 `HSA_CORE.syncOnOpenAllowed` 保证「运行中跳过 + 60s 节流」；主进程通过 `ui:opened` 广播通知常驻隐藏的 popup。静默期清理掉的页面快照由这次同步补回。
- **静默态内存压缩（v3.0）**：`MemoryGovernor` 进入静默时无条件释放**全部**内嵌 `WebContentsView`（含原本展开的侧栏），只保留 host 与 popup 两个必需 renderer；`sideViewRestore` 记录 URL/显隐，退出静默 `onExit` 按需重建，`dispose` 不重建。侧栏创建不再预加载 `DEFAULT_BROWSER_HOME`，改为 `loadSideViewDefault()` 在面板真正展开时加载。静默期 `trimStateSnapshots()` 直接 `delete s.html` 移除两份 600KB 整页快照并收紧 runLog；`setAllThrottling(true)` 额外 `wc.stop()`；`onEnter` 清 HTTP 缓存；巡检 2 分钟且重复回收视图。
- **桌面版内存/效率专项（与插件版分别优化）**：`lib/runtime-budget.js` 提供纯逻辑 —— ① `makeWriteThrottle` 把「每条日志一次全量 state 美化 JSON 同步写盘」改为紧凑 JSON + 前导立即写 / 150ms 尾随合并，退出前 `flushStateSync()` 强刷；② `diskState()` 只在落盘副本里把两份页面 HTML 快照裁到 256KB、文本裁到 32KB、日志裁到 240 条，**内存态保持完整**；③ `shouldReleaseIdleView()` 配合 `main.js` 的 30s `unref` 巡检，把空闲 90s 的离屏取数 `WebContentsView` 销毁，下次同步按需重建（运行中 / 任务点击期间绝不释放）；④ 调试开关关闭时跳过每次导航的整页 `outerHTML` 读取，消除渲染进程与主进程的大字符串尖峰。后台脚本另把历史词 1000→160；官网 HTML 上限在 v3.1 恢复为 applet 版的 600KB（v2.9 误压到 256KB 会截断响应体、导致积分/任务解析失败，插件版表现为同步时弹出 rewards 官网标签），打开同步 / 手动刷新另加 `noTabs` 护栏跳过隐藏取数视图。

---

## 自动完成任务

### 执行顺序

1. 点击「自动开始」后**先同步积分与任务状态**。
2. 若积分与任务**全部完成**，默认零动作返回：不重载页面、不点卡片、不搜索。
3. 点击流程开启时**主动重新加载** Bing Rewards 侧栏页面，按 DOM 顺序点击积分卡片。
4. 点击流程结束**关闭侧栏页面**。
5. 按开始时锁定的剩余搜索分数跑拟人搜索。
6. 收尾同步一次，把最终结果显示到界面。

侧栏读不到积分卡或没有可用的主界面任务状态时，回退到 `rewards.bing.com/dashboard`、`/earn` 两页的索引点击。

### v4.2 · 强度预设与当日词去重（与插件版同构）

- 后台 `getSettings()` 调用共享 `HSA_HUMAN.applyRunPreset()`，7 项专业数值由拟人强度整组套用；设置页移除全部数值输入框，改成三组只读摘要（切档联动）。严格档不覆盖。
- `buildQueries()` 从整池取合规词 → 按 UTC+8 日界剔除当日已用 → 取本次条数 → 写 `todayUsedWords`。跨运行、跨宿主重启都不重复。
- 两端共有设置 DOM 仍逐字一致，桌面专有组排在最后；共享 CSS 新增三组摘要样式并同步到两端副本。

### v4.1 · 无可点击卡片时不打开侧栏（与插件版同构）

- 共享 `HSA_CORE.isNonClickableTaskItem()` 把「今日 Bing 搜索」等搜索进度项排除出点击计划；`hasClickableCards()` 双来源判定。
- 后台 `completePendingTaskCards` 入口（覆盖 `human / tasklist / sidebar / rewards` 全部模式）先短路；主进程 `chrome:task:clickAll` 在 `showSidePanel()` 与 `loadSidebarFlyout()` 之前也短路，返回 `sidebarOpened:false`。
- 包装层在待点列表为 0 时不推送「点卡 0/0」；短路写 `no-clickable-cards` 运行日志。主界面任务列表与搜索配额判定不变。

### v4.0 · 运行风险规避（与插件版同构）

- 共享 `shared/hsa-stealth.js`，`host.html` 与插件 `background.js` 同步加载；后台 `runAutoComplete` 一次运行锁定 `STEALTH`，`searchLoop` 用 `SESSION_PLAN` 缩放六段预算并在段末离席。
- 定时链路：`maybeRunAutoTasks()` 命中时间点后先做深夜跳过，`startAutoRun()` 非手动分支加启动抖动；插件侧在 `rebuildAutoAlarm()` 与 `onScheduledRun()` 做同样两件事（宿主注入方式不同，决策函数同源）。
- 结果页点开结果改走贝塞尔真鼠标轨迹；提交后释放 `Emulation.setFocusEmulationEnabled`，避免后台标签「自认有焦点」整轮常驻。`main.js` 的卡片拟人链路未改。
- 设置页 02「运行设置」新增拟真键入 / 分段浏览节奏 / 避开深夜 3 个开关与单次配额上限、启动抖动上限 2 个数值项；两端共有 DOM 逐字一致。严格档六项特性恒关。

### v3.9 · 全维度拟人增强（与插件版同构）

- **运行设置**：02 组把「运行节奏 + 拟人强度」合并，新增运行模式（严格 / 拟人增强）、5 个拟人特征开关、5 项基准间隔。默认拟人增强档 / 中强度（20 次搜索 ≈ 30 分钟）。
- **搜索拟人化**：强度预算 → 6 段随机均匀分配；贝塞尔轨迹 + 时间抖动 + 偶发多余动作 + 结果页浏览 + 会话画像词策略；地理作息系数参与每轮预算。
- **卡片拟人化**：`main.js` 两条点击路径都先走贝塞尔轨迹，`waitClickSpacing` 改用 `HSA_HUMAN.cardSpacing()` 随机间隔；参数由后台 `panel.clickAll` 透传 `runMode / humanLevel / geoFactor`。
- **指纹 / 地理**：拟人档启动时在搜索标签页注入 `HSA_FINGERPRINT.collect / patcher` 做交叉校验与清理；`HSA_GEO.probe()` 探测出口 IP 并降级。
- 三个新共享模块由 `sync-shared.js` 同步到 `desktop-app/shared/`，`host.html` 额外加载供后台使用。严格档代码路径完整保留。

### v3.8 · 设置页重新分类与美化

- 分组顺序与插件版完全一致：01 外观 / 02 运行节奏 / 03 自动任务 / 04 积分日历 / 05 数据与诊断；**06 桌面版专有**排在最后（开机自启、Chrome 标识只读说明）。共有 DOM 两端逐字一致。
- 5 项固定间隔从「自动完成任务」拆出，集中到「运行节奏」两列网格，纵向占用减少约一半；全部数字输入统一样式。
- 样式只在 `shared/hsa-shared.css` 维护，由 `sync-shared.js` 同步到两端，避免再出现两端各写一套的情况。

### v3.7 · 完成态权威化 / 拟人搜索间隔 / 标准 Chrome 标识

- **跳过已完成真正生效**：旧版运行时计划只取 `taskClickIndex.items`（从 SPA HTML 解析，完成标记常缺失 → 已完成的卡照点）。同步阶段现在用主界面 `todayTasks.items` 经 `HSA_CORE.applyTaskCompletion()` 覆盖完成态；两端运行时统一走 `buildTaskPlan()`，状态行走 `taskPlanNames()`。插件版 `runTaskStates` 走同一个共享函数，两端逻辑相同。
- **拟人搜索间隔可配置**：设置页新增键鼠动作间隔 / 页面稳定等待 / 搜索轮间间隔 / 单轮等待 4 项（秒），与卡片点击间隔共用 `INTERVALS` 与 `strictRunPolicy(settings)`；一次运行读取一次，仍是固定节奏，不恢复随机拟人行为。
- **标准 Chrome 标识**：见上方「标准 Chrome 标识」条目，仅桌面版。

### v3.6 · 只按任务列表点击 / 全完成零动作

桌面版与插件版都以同步生成的任务列表（`taskClickIndex.items` / 插件 `runTaskStates`）为**唯一依据**。共享 `HSA_CORE.pendingTaskItems()` 的**唯一过滤条件**是列表项自带的完成标记（`completed` / `done`）——自动跳过已完成任务卡；`planTaskClicks()` 除此之外一项不删、不合并、不重排。0 分、`kind`（推荐 / 兑换 / 推广）、`scored`、`syncMatched`、侧栏 DOM 完成标记、标题 / URL 黑名单全部降为诊断字段。页面 DOM 扫描只补定位，回退路径也只用任务列表项（不再把实时 DOM 卡 push 进计划）；匹配不到记失败但保留，状态行 `m` 恒等于待点列表长度。

积分与任务**全部完成**时仍由 `sync.allDone` 零动作返回，并由 `syncGate.noteAllDone()` 当日停止所有任务与定时同步（跨 UTC+8 日界自动恢复）；没有任何设置项或 `force` 参数能绕过该停止态。`sidebar-task-cards.js` 的 `planSidebarClicks(cards, skipCompleted)` 只作为库级/离线验证能力保留，运行时不再调用。

### 判定规则

- **点哪张只看任务列表**：v3.7 起完成态以主界面 `todayTasks.items` 为权威（同步阶段覆盖到点击索引），唯一过滤是「已完成」，其余一项不删；侧栏 DOM 的完成标记、积分徽章、卡片类型、黑名单都只作诊断，不参与决策；DOM 扫描仅用来把列表项定位到真实可点元素。
- **不使用其它判别方式**：搜索配额、推荐 / 邀请、兑换 / 奖品、推广活动、签到进度条以及 0 分卡片都不再被扫描层排除；是否点击只看任务列表。
- **真鼠标点击**：统一走 CDP `Input.dispatchMouseEvent`，点击前重算坐标并做遮挡检查，不使用 `el.click()` 或直接导航任务 URL。

`HSA_SIDEBAR_TEST_FILE=<保存页路径>` 可让应用直接加载本地侧栏页面做人工验证。

---

## 内存与长期运行

应用常驻托盘时，原先侧栏、任务视图、任务结果视图与两个后台取数视图会一直保持完整的官网页面渲染进程。现在由 `lib/memory-governor.js` 管理一个**托盘静默低占用状态**：

- **进入条件**：主窗口隐藏到托盘、且没有任务运行，延迟 4 秒生效（避免短暂切窗）。
- **进入动作**：销毁 5 个空闲视图的渲染进程、清理 `attachedViews` / `tabs` / `loginTabIds` 登记、允许 Chromium 对隐藏渲染进程节流、裁剪 storage 中的大 HTML 快照、尽力触发一次 V8 GC。
- **退出条件**：窗口重新显示、从托盘恢复、或任务启动 —— 立即恢复保活。所有 `ensureXxx()` 都是惰性重建，无需额外恢复逻辑。
- **任务运行期间绝不释放视图**：`isBusy()` 同时检查 `running`、`phase` 与点击流程标志。
- 静默期有一个 10 分钟、已 `unref` 的低频巡检定时器；活跃态与任务运行期主进程没有任何周期定时器。

配套修复的长期运行泄漏：

| 问题 | 处理 |
| --- | --- |
| fetch 超时后底层请求仍在下载响应体 | 携带 `AbortSignal`，超时 / 主动取消时真正 `abort()` 并注销控制器 |
| 视图反复重建但 `attachedViews` 不清 | 销毁时同步摘挂载、清登记、停加载 |
| 每次导航都 `setTimeout(900)` 推快照 | 每个 `webContents` 只保留一个可取消定时器 |
| 整页 `outerHTML` 无上限写进 `storage.json` | 写入即截到 600 KB，`text` 截到 64 KB |
| 调试采集缓冲无界 | 日志 / 事件 / 索引全部有界，关闭时释放 |
| 渲染进程 V8 堆无约束 | 启动时设 `--max-old-space-size=384 --expose-gc` |

保活开关（`disable-background-timer-throttling` 等三个）保持不变 —— 削弱它们会让后台任务页面加载不全；降内存靠销毁空闲视图而非削弱保活。

主进程暴露 `chrome:memory:stats`，可查看进入 / 退出次数、已释放视图数、裁剪字节数与 GC 次数。

---

## 调试采集

默认**关闭**，日常运行零开销。需要抓取现场时：

```bash
npm run start:debug      # 等价于 HSA_DEBUG=1 npm start
npm run debug:pack       # 把最近一次会话打包成 zip
npm run debug:dir        # 查看现场目录
```

采集内容写入 `debug-captures/session-<时间戳>/`：环境信息、主进程运行日志、结构化事件、脱敏后的页面 HTML 与索引。默认脱敏邮箱与 token，`HSA_DEBUG_REDACT=0` 可关闭；`HSA_DEBUG_MAX_HTML` 控制单次会话 HTML 上限（默认 120），只保留最近 5 个会话。提交前请自行检查页面里可能包含的用户名与积分。

---

## 项目结构

```
main.js                     Electron 主进程：窗口 / 托盘 / IPC / 视图 / 内存治理
preload.js                  chrome.* API 兼容层
host.html                   后台逻辑宿主窗口
lib/core.js                 通用工具（storage 差异、tab 对象、alarm 延时）
lib/debug-capture.js        调试现场采集
lib/sidebar-task-cards.js   侧栏卡片识别与点击计划
lib/memory-governor.js      托盘静默 / 内存治理状态机
src/background.js           后台业务流程（同步、点击、搜索、积分日历）
src/popup.*                 主界面
scripts/                    启动、自检、构建、验证、修补工具
tests/                      上传的测试侧栏页面（离线验证用）
```

---

## 打包

```bash
npm run build:linux      # 完整流程：依赖 → 自检 → 验证 → DEB → SHA256SUMS
npm run dist:linux       # 只打 DEB
npm run dist:appimage    # AppImage
npm run pack:linux       # 只生成 dist/linux-unpacked 目录（最快）
npm run dist:win         # Windows 需在 Windows CMD 下执行
```

`electron-builder.yml`（Linux）与 `electron-builder.win.yml`（Windows）都启用了 `asar`，并用 `files` 白名单精确列出主进程顶层 `require` 的 `lib/` 模块。`npm run verify:packaged` 会扫描所有 `require('./lib/*')` 并核对两个清单，漏列会直接校验失败。

### 启动报 `Cannot find module './lib/xxx'`

说明手上这份 `app.asar` 是用旧清单打出来的（曾漏列 `lib/sidebar-task-cards.js`）。堆栈后面的 Wayland / Vulkan 提示只是 GPU 日志，不是崩溃原因。

不重新构建也能立刻修好，零依赖、不用装包：

```bash
npm run fix:asar
# 或指定路径
node scripts/fix-existing-asar.js /path/to/dist/linux-unpacked/resources/app.asar
```

脚本自动备份为 `app.asar.bak-<时间戳>`，写回前逐字节自检，原有节点偏移与 integrity 全部保留；`--check` 只检查不修改。若提示归档里的 `main.js` 是旧版本，说明这份产物早于侧栏改造，请用修好的配置重新打包。

---

## 验证

```bash
npm run verify          # 完整回归链，只依赖 desktop-app/ 目录
npm run verify:desktop  # 同上（保留的兼容别名）
npm run verify:memory   # 内存治理：接线静态断言 + 状态机动态模拟
npm run verify:sidebar  # 侧栏点击：上传测试侧栏实测两份点击清单
npm run verify:packaged # 打包清单防呆
npm run verify:main     # 主进程 IPC 集成（Electron API 替身）
npm run verify:sync     # 启动 / 状态同步链路
npm run verify:install  # 安装与依赖自检
npm run verify:deps     # 版本、锁文件、构建配置
npm run verify:launch   # Linux / Electron 启动链
npm run verify:debug    # 调试采集
```

`npm run verify` 依次运行 8 个专项，约 280 项断言，全部离线完成。`verify:sidebar` 会用 `tests/必应任务侧栏 · 拟人搜索助手_files/panelflyout.html` 跑真实 DOM 识别，并故意把侧栏的完成标记反转，验证点击清单只看主界面任务状态；环境缺少 Chromium 时它会跳过动态部分并明确提示，不影响退出码。

真实账号下的官网交互未在离线验证中覆盖，请用 `HSA_SIDEBAR_TEST_FILE` 或手动启动做人工确认。
