# Human Search Assistant · 拟人搜索助手

> 一个本地运行的 Microsoft Rewards 状态看板，附带「自动完成任务卡片与 Bing 搜索」的执行能力。
>

---

## ⚠️ 先读这一段

本项目是**独立开发、非官方的个人工具**，不是 Microsoft 产品，未经 Microsoft 授权、赞助、认证或认可。Microsoft、Bing、Microsoft Rewards、Microsoft Edge 等名称仅用于说明兼容的第三方服务，商标归各自权利人所有。

代码里确实实现了**程序自动提交 Bing 搜索**：由热榜词池生成查询词、用 CDP 模拟真人键鼠输入、按「拟人强度」控制轨迹与停留时长，并支持定时无人值守运行。而 Microsoft Rewards 官方规则将合格 Search 定义为「用户本人出于真实研究目的手动输入文字」，明确排除由 bot、macro 或其他自动化方式提交的查询；官方支持页写明「请勿使用程序、机器人或宏来帮助进行搜索」，重复违规可能导致**账户暂停、已赚积分全部失效**。

因此：**请不要依赖本工具的自动化功能获取积分。** 风险最低、也最符合官方要求的用法是只把它当本地看板，搜索与任务由本人在官网手动完成；积分与进度一律以服务端记录为准。详细的规则对照与规避清单见 [「合规与法律风险规避」](#compliance)。

---

## ✨ 亮点

| 亮点 | 代码里的实现 |
| --- | --- |
| **先同步，再动手** | 主按钮走 `runAutoComplete()` → `syncStart()` → `syncRewardsUnified()`，后台用 `fetch` 读 `rewards.bing.com/dashboard`、`/earn` 与 `/api/getuserinfo?type=1`；同步失败直接「零动作返回」，不点击、不搜索。 |
| **全完成真的不动** | `allDone` 判定要求：非未登录、非估算、任务项 ≥ 3、搜索项已拿满、进度 ≥ 100 且每项完成；满足后返回 `{ reason: 'allDone', skipped: true, clicked: 0, searches: 0 }`。开启「不跳过已完成任务卡」时才会继续点卡片。 |
| **只点该点的卡片** | 扫描时排除已完成、0 分、搜索进度条、连续打卡、兑换 / 推荐 / 推广卡与签到进度（见 `bannedText`、`sidebar-task-cards.js` 的 `REDEEM_URL` / `SEARCH_COUNTER` / `PROMO_TEXT` / `PROGRESS_TEXT`）；桌面版用 `taskClickIndex` 定位任务，重算矩形后再点击。 |
| **真鼠标事件 + 拟人强度** | 通过 `chrome.debugger.attach(..., '1.3')` 发送 `Input.dispatchMouseEvent`（`mouseMoved` → `mousePressed` → `mouseReleased`）与 `Input.dispatchKeyEvent`；`HUMAN_PROFILES` 的 1/2/3 档分别控制步数、过冲、滚动幅度与每轮时长。 |
| **搜索词来自实时热榜** | `HOT_SOURCES = ['bing','baidu','weibo','toutiao','zhihu','sina']`，每轮随机选 2–4 个源取词；取不到时报错「不使用本地词库」，不会退回内置词表。另有 `www.bing.com/AS/Suggestions` 相关词与结果页「相关搜索」。 |
| **默认不自动跑** | `AUTO_DEFAULTS = { enabled: false, times: [], count: 30, level: 3 }`；定时最多 `AUTO_MAX_TIMES = 10` 个时间点，由 `chrome.alarms` 的 `hsaScheduledRun` 触发，同一时间点当天只触发一次。 |
| **积分日历** | 每次同步写入 `pointsHistory`（按本地日期，最多保留 400 天），设置页支持日 / 周 / 月聚合。 |
| **收尾把焦点还给你** | `KEEP_TASK_TABS = true`（任务页保留）、`RESTORE_FOCUS_ON_FINISH = true`，结束时关闭搜索页、调用 `restoreUserFocus()`。 |
| **双语 / 主题 / 桌面专属** | 弹窗内置中英文 `I18N` 表与 `uiLang` / `uiTheme` 持久化；浅色 / 深色 / 跟随系统、减少动画；桌面版另有开机自启、静默完成任务与系统托盘，均默认关闭。 |

---

## 🚀 安装

### 浏览器扩展（`edge-extension/`）

1. 取得仓库源码，保留 `edge-extension/icons/` 目录。
2. 打开 `edge://extensions` 或 `chrome://extensions`，开启「开发人员模式」。
3. 选「加载解压缩的扩展」，目录选 **`edge-extension/`**（不是仓库根目录）。
4. 在浏览器里登录 **rewards.bing.com**；工具不提供账号体系，也不会代登。
5. 点开扩展图标即可看到看板。

`manifest.json` 申请的权限：`tabs`、`storage`、`scripting`、`alarms`、`debugger`、`sidePanel`；`host_permissions` 覆盖 `bing.com` / `*.bing.com` 及 5 个第三方热榜域名（百度、微博、头条、知乎、新浪 RSS），Bing 自带的热榜源落在 `*.bing.com` 下；`content_scripts` 只注入 `*/rewards/panelflyout*`（`flyout-bridge.js`）。`debugger` 权限用于 CDP 真键鼠输入，浏览器会在调试会话建立时显示提示横幅。扩展页 CSP 为 `script-src 'self'; object-src 'none'; frame-src https://*.bing.com https://bing.com;`。

### 桌面版（`desktop-app/`）

需要 Node.js ≥ 22.12.0（见 `package.json` 的 `engines`）；依赖为 Electron 45.2.3 与 electron-builder 26.18.1。

```bash
cd desktop-app
npm run ci       # 按 package-lock 精确安装依赖
npm run setup    # 安装 → 自检 → 启动
npm run doctor   # 只做环境与 Electron 自检
npm start        # 依赖已装好时直接启动
```

首次启动后，点主界面的登录徽标，在内置窗口登录 Rewards；登录态保存在 Electron 持久化会话中，所有窗口共享同一份 Cookie。

打包与验证（均为 `package.json` 中已定义的脚本）：

```bash
npm run build:linux    # 依赖 → 自检 → 验证 → DEB → SHA256SUMS
npm run dist:linux     # 只打 DEB
npm run dist:appimage  # AppImage
npm run dist:win       # 需在 Windows CMD 下执行
npm run verify         # 8 个离线回归脚本
```

仓库只包含源码与验证脚本，**不含预构建 `.deb`**；DEB 应在目标 Ubuntu/Debian x86_64 系统上构建。DEB 安装后若提示沙箱权限，`desktop-app/README.md` 给出 `chrome-sandbox` 的 `root:root` / `4755` 修复命令；容器 / CI 可设 `HSA_NO_SANDBOX=1` 允许降级启动，`HSA_STRICT_SANDBOX=1` 则拒绝降级。本次重写**未运行** `npm run verify`，不对其通过情况作任何声明。

---

## 🧭 使用方法

### 1. 看板

打开弹窗即可看进度环、三项积分、今日任务列表与登录状态；「今日任务 → 刷新」会触发一次 `syncRewardsUnified()`。此模式不执行搜索、不点击卡片。**建议保持定时自动运行关闭。**

### 2. 主按钮：一次执行实际做了什么

以 `edge-extension/background.js` 的 `runAutoComplete()` 为准（`desktop-app/src/background.js` 为同源的桌面实现）：

1. **同步**：`syncStart()` 读取积分、搜索配额与今日任务；失败（未登录 / 页面不可读）则写回 `idle` 并零动作返回。
2. **判定全完成**：按上文 `allDone` 条件判断，满足则直接返回；`dontSkipCompletedCards = false` 时不会重载页面、不点卡片、不搜索。
3. **点击待完成卡片**：`completePendingTaskCards()` 打开 / 扫描 Rewards 侧栏或 dashboard / earn 页面，按 DOM 顺序用 CDP 真鼠标点击；相邻点击间隔扩展默认 5000 ms、桌面默认 10000 ms，可在设置里调 1–60 秒。弹出的任务标签页保留不关闭。
4. **执行搜索**：`handleStart()` 启动流程，`runFlow()` 中调用 `searchLoop()`，按剩余搜索配额生成查询词，访问 `www.bing.com/search?q=...`，混合「粘贴关键词 / 相关词改词 / 回首页」等路径，每轮时长基准 16–29 秒（再乘以强度档系数 0.7–1.0），并做滚动、结果点击等拟人动作；`POINTS_PER_SEARCH = 3` 只用于本地估算。
5. **收尾**：`presetSyncFinish()` 再同步一次，写入 `endPoints` / `finalEarned`（起始积分未知时 `earnedIsEstimate = true`）、`lastRun` 与 `pointsHistory`；关闭搜索页、恢复运行前的标签页焦点。

### 3. 设置项

| 设置 | 默认值 | 依据 |
| --- | --- | --- |
| 语言 | 跟随系统（中文 / English / 跟随系统） | `popup.html` 的语言分段按钮、`I18N` 表、`uiLang` |
| 主题 | 跟随系统（浅色 / 深色 / 跟随系统） | `applyTheme()`，`localStorage.theme` / `uiTheme` |
| 减少动画 | 关 | `DEFAULTS.reduceMotion` |
| 卡片点击间隔 | 扩展 5 s / 桌面 10 s，范围 1–60 s | `TASK_CLICK_INTERVAL_MS`、`cardClickIntervalSec`、`taskClickSpacing()` |
| 不跳过已完成任务卡 | 关 | `dontSkipCompletedCards: false`；开启后即使全完成也点所有积分卡 |
| 定时自动运行 | 关 | `AUTO_DEFAULTS.enabled: false` |
| 启动时间 | 空；留空点「添加」首个为 08:00，之后在最晚时间上 +30 分钟，自动去重排序，最多 10 个 | `defaultAutoTime()`、`AUTO_MAX_TIMES` |
| 搜索次数上限 | 30（可填 1–150） | `AUTO_DEFAULTS.count`，`clampInt(..., 1, 150)` |
| 拟人强度 | 3（低 / 中 / 高） | `HUMAN_PROFILES` 1–3 |
| 积分日历 | 日 / 周 / 月，最多 400 天 | `recordPointsHistory()`、`pointsHistory` |
| 开机自动启动 / 静默完成任务 | 均关，仅桌面版 | `desktop-app/main.js` 的 `state.launchAtLogin` / `state.silentRun` |
| 恢复默认设置 | 需二次点击确认（3 秒内） | `popup.js` 的 `resetBtn` 处理 |

定时由 `chrome.alarms` 的 `hsaScheduledRun` 唤醒，`maybeRunAutoTasks()` 会检查总开关、时间点是否在列表里、当天是否已触发以及是否已有任务在运行。

### 5. 常见问题

- **积分显示「—」或出现登录页**：后台 `fetch` 没拿到登录态；先在浏览器 / 内置窗口登录 `rewards.bing.com`，再点「刷新」。
- **全部做完了点按钮**：零动作返回；若想强制逐张点卡片，只能开启「不跳过已完成任务卡」（代码里没有主按钮的 `force` 参数）。
- **有些卡片没被点**：命中了上文排除规则；控制台会打印跳过原因。
- **点了卡片没涨分**：点击成功不等于服务端计分；`hitByCount()` 比较前后任务完成数，`presetSyncFinish()` 用积分差计算 `finalEarned`，起始积分未知时标记为估算。以 Rewards 页面为准。

---

## 🔒 数据与网络

**本地存储**：扩展用 `chrome.storage.local`（`settings`、`autoTasks`、`autoTaskLog`、`pointsHistory`、`todayTasks`、`lastRun`、`currentQuery` 等）；桌面版落到 `userData/storage.json`。弹窗的 `theme` / `reduceMotion` 另存 `localStorage`。桌面调试采集默认关闭，开启后会把脱敏页面 HTML 写入 `debug-captures/`（提交前请自行检查其中是否含用户名、积分等信息）。

**代码中出现的网络请求**（全部为读取类 GET，未发现向自建服务器 POST / 上传本地数据；Rewards 相关请求带 `credentials: 'include'` 使用会话 Cookie）：

| 用途 | 端点 |
| --- | --- |
| 积分 / 任务同步 | `rewards.bing.com/dashboard`、`rewards.bing.com/earn`、`rewards.bing.com/api/getuserinfo?type=1` |
| Rewards 侧栏 | `cn.bing.com/rewards/panelflyout`、`www.bing.com/rewards/panelflyout` |
| 搜索 | `www.bing.com/search?q=...`、`www.bing.com/AS/Suggestions`、`www.bing.com/news/trendingtopics` |
| 热搜词源 | `top.baidu.com/board?tab=realtime`、`weibo.com/ajax/side/hotSearch`、`www.toutiao.com/hot-event/hot-board/`、`www.zhihu.com/api/v3/feed/topstory/hot-lists/total`、`rss.sina.com.cn/news/marquee/ddt.xml` |

**登录态与 Cookie 属于敏感会话凭证**：不要分享、不要贴进 Issue、不要放进截图或公开仓库；分享运行日志 / 调试采集前先移除身份与会话信息。

## ⚖️ 合规与法律风险规避

### 官方规则（已核对原文，以最新文本为准）

- [Microsoft 服务协议](https://www.microsoft.com/en-us/servicesagreement/) 的 Rewards 章节：Search 指「用户本人出于真实研究目的手动输入文字以获取 Bing 搜索结果」，**不包含**由 bot、macro 或其他自动化 / 欺诈方式提交的查询；计划仅限个人、非商业使用。
- [限制 Microsoft Rewards 中的搜索](https://support.microsoft.com/zh-cn/topic/439be015-897e-4a5f-ae01-b3aff4ea2404)：「请勿使用程序、机器人或宏来帮助进行搜索」；避免快速背靠背搜索、把字母数字刷进 Bing、快速点文章等短时间攒分行为；**重复违规可能导致账户暂停并使所有已赚积分失效**。
- [了解 Microsoft Rewards](https://support.microsoft.com/zh-cn/accounts-billing/rewards/learn-about-microsoft-rewards)：机器人、宏或其他自动方法输入的查询不计入搜索积分。

### 本仓库代码里与之直接相关的事实

1. `searchLoop()` 自动生成并提交查询词，`cdpInsertText()` / `cdpKey()` 用 CDP 把文字与回车送进 Bing 搜索框——这是程序输入，不是用户手动输入。
2. `HUMAN_PROFILES`、`GO_HOME_RATE`、`RELATED_RATE`、`ENTER_RATE`、`CLICK_RESULT_RATE`、`RESULT_HOLD_MIN/MAX` 用随机轨迹、随机回首页 / 改词、结果页停留与滚动来模拟真人；`autoTasks` 与 `hsaScheduledRun` 支持无人值守定时运行，桌面版还有「静默完成任务」。这些都属于官方排除的自动化方式。
3. 代码用 `HUMAN_VERIFY_OFFICIAL = true`、`hitByCount()` 与收尾积分差做本地核对，并可能把 `finalEarned` 标为估算；**本地核对不等于官方确认计分**，一切以服务端为准。
4. `host_permissions` 里的 5 个第三方热榜域名（加上 Bing 自带热榜源共 6 个词源）只用于取搜索词，工具不代理登录、不批量注册账号、不内置绕过风控的逻辑；但自动化本身已足够触发上述限制。

### 规避建议

1. **只当看板用**：在 Rewards 官网 / Bing 由本人手动搜索与完成任务，把本工具用于查看进度、积分日历与本地日志。
2. **保持自动化关闭**：`定时自动运行` 默认关闭，不要开启；桌面版的开机自启、静默完成任务也保持默认关闭。
3. **不用自动化攒分**：不把自动执行当作日常获取积分的手段；不使用多账号、VPN / 代理隐藏地区或任何规避平台检测的做法（官方条款亦提示 VPN 可能导致账户取消与积分没收）。
4. **接受后果自担**：自动化可能拿不到积分、已获积分作废或账户受限；页面结构、接口与规则变化也可能让功能失效，不要以本工具作为任务完成的唯一依据。
5. **分发前处理仓库现状**：保留「非官方、未经授权 / 赞助 / 认证」声明；Microsoft / Bing / Rewards 名称只用纯文本引用，不使用徽标或产品图标；`desktop-app/tests/` 中保存了从官网抓取的静态资源（如 `MsRewardsLogo.svg`、`RAFSearchAndEarnHVA.png` 等），公开分发前需核实这些第三方素材的使用权限；补上 `LICENSE`（当前为 `UNLICENSED` / 无许可证文件，公开代码不自动授予复制、修改、再分发权利）；清理根 README 的冲突标记与失效链接。
6. 本节仅陈述代码事实与已核对的官方文本，**不构成法律意见，也不保证任何使用方式合规**；公开发布、分发二进制包或投入实际使用前，请自行核实适用条款及当地法律，必要时咨询律师。

---

## 📎 📮 反馈与权利说明

问题与建议欢迎通过仓库 Issue 反馈；**切勿公开账户 Cookie、密码、令牌或个人浏览记录**。

