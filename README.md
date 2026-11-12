# Human Search Assistant · 拟人搜索助手

> 一个本地运行的 Microsoft Rewards 状态看板，附带「自动完成任务卡片与 Bing 搜索」的执行能力。
>
> 本包为**插件版 / 桌面版差异统一版**：27 项已勾选决策的落地情况、共享 `shared/` 目录结构与回归命令见 [实施说明.md](实施说明.md)。
>
> 本包默认启用**拟人增强档（v3.9）**：在「搜索词只取当日 ≥5 字热搜原文」这一硬规则不变的前提下，叠加会话画像、贝塞尔鼠标轨迹、有界节奏抖动、结果页浏览与环境 / 地理一致性；设置里切到「严格」即逐字回到 v3.7 的固定中心点击 + 固定间隔（详见 [实施说明.md](实施说明.md) 第二十五章）。
>
> 设置页新增**运行日志导出**与**关键网页实时抓取**：日常运行只写运行日志，关键页面按需实时抓取最新数据（详见 [实施说明.md](实施说明.md) 第八节）。
>
> **v4.0 风险规避**：分段浏览节奏、拟真分块键入、单次配额上限、深夜定时跳过与启动抖动、出口 IP 结果缓存、焦点模拟仅覆盖输入阶段。只降低行为可区分性，**不承诺不被判定**，也不能把自动化变成符合服务条款的手动搜索（详见 [实施说明.md](实施说明.md) 第二十六章）。
>
> **v4.2 简化设置**：7 项专业数值已收进「拟人强度」的三组预设（低 / 中 / 高），设置页只做只读展示；搜索词按 UTC+8 日界当天不重复（详见 [实施说明.md](实施说明.md) 第二十八章）。
>
> **v4.3 清理与护栏**：冲突的「搜索次数上限」已删除；当日运行次数、最小间隔与定时概率跳过把四段式摊薄。客户端手段只降低行为可区分性，**不能把自动化变成符合服务条款的手动搜索**（详见 [实施说明.md](实施说明.md) 第二十九章）。
>
> **v4.4 手动启动**：用户主动点击不再受当日次数 / 最小间隔硬拦（只记警告），残留运行态与误设停止态会自愈；所有失败原因在界面明确显示（详见 [实施说明.md](实施说明.md) 第三十章）。
>

---

## ⚠️ 先读这一段

本项目是**独立开发、非官方的个人工具**，不是 Microsoft 产品，未经 Microsoft 授权、赞助、认证或认可。Microsoft、Bing、Microsoft Rewards、Microsoft Edge 等名称仅用于说明兼容的第三方服务，商标归各自权利人所有。

代码里确实实现了**程序自动提交 Bing 搜索**：由当日热搜池生成 ≥5 字查询词、用 CDP 模拟真人键鼠输入按固定节奏执行，并支持定时无人值守运行。而 Microsoft Rewards 官方规则将合格 Search 定义为「用户本人出于真实研究目的手动输入文字」，明确排除由 bot、macro 或其他自动化方式提交的查询；官方支持页写明「请勿使用程序、机器人或宏来帮助进行搜索」，重复违规可能导致**账户暂停、已赚积分全部失效**。

因此：**请不要依赖本工具的自动化功能获取积分。** 风险最低、也最符合官方要求的用法是只把它当本地看板，搜索与任务由本人在官网手动完成；积分与进度一律以服务端记录为准。详细的规则对照与规避清单见 [「合规与法律风险规避」](#compliance)。

---

## ✨ 亮点

| 亮点 | 代码里的实现 |
| --- | --- |
| **先同步，再动手** | 主按钮走 `runAutoComplete()` → `syncStart()` → `syncRewardsUnified()`，后台用 `fetch` 读 `rewards.bing.com/dashboard`、`/earn` 与 `/api/getuserinfo?type=1`；同步失败直接「零动作返回」，不点击、不搜索。 |
| **全完成真的不动** | `allDone` 判定要求：非未登录、非估算、任务项 ≥ 3、搜索项已拿满、进度 ≥ 100 且每项完成；满足后返回 `{ reason: 'allDone', skipped: true, clicked: 0, searches: 0 }`；`syncGate.noteAllDone()` 当日停止所有任务与定时同步，跨 UTC+8 日界自动解除。v3.3 起不再有任何设置或 `force` 参数能绕过该停止态。 |
| **只按任务列表点击（v3.7 修正）** | 两端都以同步生成的任务列表（`taskClickIndex.items` / `runTaskStates`）为**唯一依据**，只跳过已完成，其它判别一律不用。**完成态的权威是主界面任务列表 `todayTasks.items`**：共享 `HSA_CORE.applyTaskCompletion()` 在同步阶段把它的完成态按名称覆盖到点击索引（`cardsFromRewardsHtml()` 从 SPA HTML 解析出的 `isCompleted` 常缺失，旧版因此一张都不跳过）；两端运行时统一走 `HSA_CORE.buildTaskPlan()` → `pendingTaskClicks()`，唯一过滤仍是 `pendingTaskItems()`。0 分、`kind`、`scored`、`syncMatched`、侧栏 DOM 完成标记、黑名单全部只作诊断；DOM 扫描只补定位。状态行走同一个 `taskPlanNames()`，`m` 恒等于真实计划长度。 |
| **真鼠标事件（默认拟人增强 / 严格档固定）** | 通过 `chrome.debugger.attach(..., '1.3')` 发送 `Input.dispatchMouseEvent` 与 `Input.dispatchKeyEvent`。**默认拟人增强档**走 `HSA_HUMAN.bezierPath()` 三次贝塞尔轨迹 + 轻微过冲回正 + 随机均匀分段间隔，结果页适度滚动、偶发多余动作、偶尔点开一条结果再返回；**严格档**仍是固定中心点击、固定 Enter、固定间隔，禁用轨迹 / 过冲 / 滚动 / 点结果。两端同源，桌面 `main.js` 的卡片点击也走同一套轨迹与随机间隔。 |
| **搜索词只取当日热搜原文** | `HOT_SOURCES = ['bing','baidu','weibo','toutiao','zhihu','sina']` 固定全量抓取；词长必须 ≥5 个字，按 UTC+8 判定为「当日」。少于 5 字的单调词、历史缓存词、本地词库、Bing autosuggest 与结果页「相关搜索」一律禁用；词不够就少跑几轮，绝不补词 / 拼接 / 复用。 |
| **积分日历（两端逐字一致）** | 共享 `shared/hsa-calendar.js` 统一模型 / 渲染 / 导航 / 复位；`<details>` 可折叠、紧凑零空白。日视图只列当月有积分的日期，周视图裁剪到当月边界绝不跨月，月视图只列有积分的月；打开设置自动复位到日视图 + 最近有积分月并展开；导航只放行有积分周期。样式单一真源在 `shared/hsa-shared.css`。 |
| **运行提示词两端一致** | v3.5 起 `HSA_CORE.RUN_LINES` / `runActivity()` 是唯一文案源，桌面 `desktopActivityWrite` / `desktopActivityPush` 与插件 `hsaActivityPush` 都只传 `(state, ctx)`。可见文案 ≤15 显示宽度、**只报当前动作、不提示下一步**；卡片名 / 页面 / 积分 / 执行顺序 / 完整列表 / 系统时间进 `fullZh` / `fullEn`，供悬浮提示、读屏与运行日志。 |
| **插件后台静默运行** | v3.6 起插件版运行期**不切换活动标签、不把浏览器窗口拉到前台**：`openOrNavigate` 强制后台创建 / 导航，`ensureTabActive` 只关自动丢弃，`Page.bringToFront` 短路，结束也不把用户拉回原标签。可靠性由 CDP 层保活保证——`Emulation.setFocusEmulationEnabled` + `Page.setWebLifecycleState(active)` 让后台标签正常渲染与派发输入 / 点击；稳定等待改查本次运行自己的标签。用户显式点「打开官网 / 登录」仍正常激活标签。 |
| **拟人搜索间隔设置（v3.7）** | 两端设置页新增 4 项间隔：**键鼠动作间隔**（默认 0.6 秒，0.1–5）、**页面稳定等待**（3 秒，0.5–15）、**搜索轮间间隔**（10 秒，1–60）、**单轮等待**（3 秒，0.5–15），与原有**卡片点击间隔**（10 秒，1–60）一起构成完整节奏设置。共享 `INTERVALS` / `normalizeIntervals()` 统一换算成毫秒并夹取区间，`strictRunPolicy(settings)` 在一次运行开始时读取一次、整轮固定；严格运行期仍禁止改设置。可配置的是**固定间隔**，不恢复随机延时 / 拟人轨迹 / 滚动 / 点结果。 | 
| **全维度拟人增强（v3.9）** | 按「保留严格档 · 新增拟人增强档」落地：默认 `runMode='human'`，设置页把「运行节奏 + 拟人强度」合并为 **02 运行设置**。低/中/高强度对应完成 **20 次自动搜索 ≈ 15 / 30 / 60 分钟**；每轮预算按「会话偏差 × 当地作息系数」拆成 6 段（`move/type/submit/settle/browse/gap`），**所有间隔随机但大致均匀分配**（低方差抖动 + 总量守恒，段间最大/最小比 < 1.6）。全维度噪声：**时间抖动、三次贝塞尔鼠标轨迹（含轻微过冲回正）、偶发多余动作、结果页正常浏览（滚动 / 偶尔点开结果再返回）、会话画像与词策略**（当日 ≥5 字热搜原文只轻微重排，不补词/编词/复用）；**卡片点击也按随机间隔一个一个开**，桌面两条点击路径都走贝塞尔轨迹。新增 `shared/hsa-human.js` / `hsa-fingerprint.js` / `hsa-geo.js` 三个共享模块（清单 8 → 11）。`strictRunPolicy()` 与严格档原逻辑完全不动，`runMode='strict'` 可随时切回固定节奏。 |
| **拟人增强档（v3.9，默认）** | 三个新共享模块：`hsa-human.js`（会话画像 / 强度预算 / 6 段随机均匀分配 / 贝塞尔轨迹 / 词序 / 卡片间隔）、`hsa-fingerprint.js`（环境指纹交叉校验，只清自动化标记、补缺失对象，**绝不改写 UA / 屏幕 / 硬件值**）、`hsa-geo.js`（出口 IP / 时区 / 语言 / 搜索市场 / 当地作息自洽，探测失败优雅降级）。默认 `runMode='human'`、`humanLevel='mid'`（20 次搜索 ≈ 30 分钟）；低 / 中 / 高 ≈ 15 / 30 / 60 分钟。词仍是当日 ≥5 字热搜原文，只做轻微相邻重排，**不补词 / 不编词 / 不复用 / 不回首页 / 不改词**。设置页 02「运行设置」提供运行模式、强度、5 个特征开关与 5 项基准间隔；切到「严格」即完整回到 v3.7 固定节奏。共享清单 8 → **11** 个文件。 |
| **运行风险规避（v4.0）** | 新增共享 `hsa-stealth.js`（清单 11 → **12**）。节奏侧：一次运行拆 2–4 个浏览段、段间一次较长离席、段级与轮内预算起伏且**总时长精确守恒**（15/30/60 分钟不变）；单次运行默认只跑剩余配额的 **60%**，定时启动时间有界抖动，当地 0–6 点定时直接跳过（手动不受限）。过程侧：整段粘贴改**分块上屏 + 非均匀键间隔 + 偶发退格纠错**（`finalText` 逐字等于原词），Enter 恒提交改概率性点搜索按钮（失败回退），结果页点开结果由 DOM 合成点击改**贝塞尔真鼠标轨迹**。环境侧：出口 IP 结果同日缓存减少异常外联，焦点模拟只在输入阶段开启、提交后立即释放。**严格档六项特性恒关**，词规则、消息白名单、同步闸门、任务列表点击与全完成停止态全部不回退。 |
| **非卡片项跳过（v4.1）** | 「今日 Bing 搜索」是搜索进度项、不是可点击任务卡片。共享 `HSA_CORE.isNonClickableTaskItem()` 按 `section/kind/source=search` 或「名称匹配且无真实 http(s) 链接」识别，`pendingTaskItems()` 在「已完成」之外再排除这类项；两端入口用同一个 `hasClickableCards()`（点击索引 + 主界面任务列表双来源）判定，**待点卡片为 0 时直接返回，不打开 Bing 侧栏 / panelflyout / 官网回退页**。桌面主进程的短路在 `showSidePanel` 与 `loadSidebarFlyout` 之前；插件内部侧栏与独立标签页两条路径都有同构防线。主界面任务列表、`isAllDone` 配额判定与搜索阶段完全不受影响，状态行不再出现「点卡 0/0」。 |
| **强度预设与当日词去重（v4.2）** | 设置页移除 7 个令人头痛的专业数值输入框，改由**拟人强度低/中/高**统一管理，只读展示**三组**预设：① 配额与启动（单次配额上限、启动抖动上限）② 动作节奏（卡片点击间隔、键鼠动作间隔）③ 页面与轮次（页面稳定等待、搜索轮间间隔、单轮等待）。切档即整组套用，旧存档里的手动值不再生效；严格档沿用固定默认值。共享 `HSA_HUMAN.applyRunPreset()` / `presetValues()` 为单一真源，两端 `getSettings()` 与 UI 逐字同构。另按 **UTC+8 日界**持久化当日已用搜索词，跨运行、跨宿主重启都不重复；当日合规词用完就如实少跑或停止，**不补词 / 不编词 / 不拼接 / 不复用历史词**。详见 [实施说明.md](实施说明.md) 第二十八章。 |
| **手动启动链路修复（v4.4）** | 两端同步排查出 5 处会让「自动完成任务」点不动的拦截点：v4.3 当日护栏对手动也硬拦、严格消息守卫吃掉启动请求、僵尸 `running` 无自愈、当日停止态无手动复核、popup 对失败结果静默。修复后手动启动一律可达且失败原因可见；「只剩搜索任务」时跳过点卡但搜索阶段继续。逐项审计见 [实施说明.md](实施说明.md) 第三十章。 |
| **设置项清理与运行护栏（v4.3）** | 移除与「单次配额上限」双重封顶的「搜索次数上限」，搜索次数只剩**剩余配额 × 强度预设**一个真源；清理 `defaultCount` / `pace` / `autoStop` / `holdRange` 等死键与虚拟输入框，强度不再双写 `autoTasks.level`。新增**当日运行频次护栏**（低 4 / 中 3 / 高 2 次、最小间隔 30/45/60 分钟、定时 10~15% 概率跳过且不补跑），并去掉兜底导航里来源不实的首页表单参数。六类风险矩阵与「刻意未做」清单见 [实施说明.md](实施说明.md) 第二十九章。 |
| **设置页重排与美化（v3.8）** | 两端设置页按用户心智重新分成 6 组并统一顺序：**01 外观**（语言 / 主题 / 减少动画）→ **02 运行设置**（v3.9 由「运行节奏」与「拟人强度」合并）→ **03 自动任务**（定时、次数、启动时间）→ **04 积分日历**（可折叠）→ **05 数据与诊断**（日志与关键页抓取）→ **06 桌面专有**（开机自启、Chrome 标识，仅桌面）。共有部分两端**逐字一致**，桌面专有组排在最后。外观统一由 `shared/hsa-shared.css` 单一真源提供：渐变序号徽标 + 组标题 + 一行说明、圆角卡片 hover 微亮、行 hover 高亮、**全部数字输入统一尺寸与聚焦态**（之前只有卡片点击间隔有样式）、间隔项两列网格（窄屏自动单列）、日历 summary 补同款徽标、虚线式「恢复默认」、`reduce-motion` 下关闭入场动画。新增 7 个双语文案键，两端字典零缺失。 |
| **设置页诊断数据** | 「记录运行日志」开关（默认开）：日志含系统时间、用户操作、运行过程、运行结果、错误信息，环形上限 600 条，不写网页 HTML / 快照；「导出运行日志」生成 `hsa-runlog-*.json`；「抓取关键网页（HTML zip）」强制 `fresh` + `cache:no-store` 实时抓取 `/dashboard`、`/earn` 与 **Bing 侧边栏**，导出 `hsa-keypages-*.zip`（manifest.json + 3 个 HTML，失败页保留占位说明），不复用缓存 / 可见快照 / 面板 / 隐藏数据视图。 |
| **下拉刷新 · 仿微信小程序（两端一致）** | 视觉复刻 minirefresh `applet` 主题：**50px 透明下拉区、三个 8px 圆点 ball-beat（默认 0.3 透明度、刷新时交错缩放）、内容区域随下拉整体 `translateY`、无成功动画直接回弹**；文案沿用 default 主题语义（下拉刷新 / 释放刷新 / 加载中... / 刷新成功 / 刷新失败）但视觉隐藏，仅严格运行期拦截与刷新失败时露出小字。共享 `hsa-pull-refresh.js` 统一手势状态机（触摸 / 鼠标拖拽 / 顶部滚轮），不引入第三方库；指示器 `pointer-events: none` 且不进入滚动容器，不产生第二根滚动条；刷新复用 `refreshTasks` 并写用户操作日志。 |
| **同步闸门 / 短状态文案（v3.2）** | 两端共用 `HSA_CORE.createSyncGate()` 同一份实现：打开主界面 **30 分钟**冷却、手动刷新 10 秒、任务链路 2 秒且 `force` 拿最新；single-flight 合并并发、业务指纹相同标「已是最新」、当日全部完成后停止所有任务（清续跑/提醒闹钟，保留次日调度，跨 UTC+8 日界自动恢复）。可见状态文案统一 ≤15 个中文显示宽度（英文等宽），如「同步完成 90/495」「今日已满·停止任务」；完整来源/耗时/系统时间放 aria-label 与悬浮提示。两端同步状态文案、日志字段完全一致。 |
| **同步弹官网修复（v3.1）** | 定位到 applet 版之后插件版异常的两层原因：v2.9 把官网 HTML 缓存上限 96KB 误当成响应体截断上限，砍掉 `/dashboard` / `/earn` 后半段内嵌积分/任务数据，导致同步降级 `readRewardsPage` → `chrome.tabs.create` 打开可见 rewards 标签；v3.0「打开主界面同步一次」让这条降级每次打开都触发。修复：响应体完整交给解析器、缓存只收 ≤600KB 的完整页面（条目 1 / TTL 45s 不变），所有同步入口加 `noTabs` 护栏彻底禁止开标签；桌面版同样把误压的 256KB 恢复 600KB 并跳过隐藏取数视图。 |
| **打开主界面同步一次（v3.0）** | 两端在打开主界面时各做**一次** fresh 官网同步：**正在运行时一律跳过**（popup 读 `running` 先挡一层，后台严格运行期消息白名单再兜一层）；60 秒内重复打开由共享 `HSA_CORE.syncOnOpenAllowed` 节流，避免桌面窗口反复 show/focus 造成密集请求。插件版每次打开 popup 都是新文档，DOMContentLoaded 即触发；桌面 popup 常驻隐藏到托盘，由主进程在 `show` / `restore` 时广播 `ui:opened` 触发，两端行为一致。同步只刷新积分与今日任务、写 `syncNotice`，不启动任务、不改设置、不触碰侧栏。静默期清掉的大快照也由这次打开同步补回。 |
| **桌面静默内存（v3.0）** | 静默时把常驻 renderer 从最多 7 个压到 2 个（host + popup）：无条件销毁侧栏视图（以前面板展开着最小化会留一个完整 Rewards/Bing SPA）、两个取数视图、任务视图、结果视图；记下侧栏 URL 与显隐状态，退出静默按需重建（运行中 / 退出进程绝不重建）。侧栏创建时不再预加载 Bing 首页，只在真正展开时加载。静默期从内存移除两份 600KB 整页 HTML 快照、日志裁到 240 条、停止隐藏 renderer 正在进行的加载、清 HTTP 缓存（不碰 Cookie），巡检从 10 分钟缩到 2 分钟且会重复回收静默期新建视图。 |
| **桌面版标准 Chrome 标识（v3.7）** | 桌面内置浏览器**只去掉 Electron 标记**，呈现为一台正常 Chrome：`app.userAgentFallback` 用真实 `process.versions.chrome` + 真实 OS 构造标准 UA；`webRequest.onBeforeSendHeaders` 仅对 Bing / Rewards / Microsoft 域注入同源的 `sec-ch-ua` / `sec-ch-ua-platform` / `sec-ch-ua-mobile`；每个外部网页 `dom-ready` 注入一段短脚本把 `navigator.userAgentData` 对齐到同一版本，并防御性清理意外暴露的 Node 全局。三处版本 / 平台同源，**不伪造** WebGL、字体、屏幕、devicePixelRatio、硬件指纹，也不启动外部 Edge。插件版本来运行在真实浏览器里，**仍不做任何身份改写**；两端热搜请求仍不伪造 `User-Agent`，站点必需 `Referer` 保留，默认主页 / 搜索引擎仍为 **Bing**。内存按平台分别优化：**插件版** `edge-extension/lib/mv3-budget.js` —— HTML 缓存 4×600KB/120s → 1×600KB/45s（v3.1 修正：600KB 只作缓存准入门槛，**官网响应体永不截断**）、日志 16 条/250ms 批量合并写入（上限 180）、历史词 1000→120、页面快照 600→256KB；**桌面版** `desktop-app/lib/runtime-budget.js` —— 全量 state 写盘改前导立即 + 150ms 尾随合并（紧凑 JSON、落盘副本裁大快照）、调试关闭时不再读整页 HTML、离屏取数视图空闲 90s 回收、日志 600→240、历史词 1000→160。 |
| **环境指纹一致性（v3.9）** | 原则是「一致性 > 伪装」：**不硬编码任何硬件值**，只读取真实 `screen / innerWidth / devicePixelRatio / hardwareConcurrency / WebGL GPU / 时区 / 语言 / UA / UA-CH brands` 并做 5 项交叉校验（屏幕↔视口、DPR↔物理尺寸、CPU↔GPU 档次、时区↔语言↔地区、UA 版本↔brands）；只做两件事：① 去掉自动化标记（`navigator.webdriver`、phantom/selenium 全局），② 补齐 headless 下缺失对象的**存在性**（`window.chrome` / `permissions` / `mediaDevices` / `Notification`）。报告写入运行日志，冲突逐项列出，不改写任何数值。 |
| **地理位置一致性（v3.9）** | 运行时探测出口 IP（`ipwho.is` / `ipapi.co`，2.5 秒超时），推导一整套自洽参数：**时区 / 语言 / Accept-Language / Bing `mkt` / 当地作息**；`crossCheck` 逐项校验「IP 国家↔时区↔语言↔mkt↔当地作息」冲突。当地凌晨 0–6 点把间隔拉长 2.4 倍（**降速而非停止任务**），避免「凌晨 3 点还在高频搜索」；探测失败**优雅降级到系统时区/语言**，不让脚本跑不起来。两端 `host_permissions` 已补两个探测域名。 |
| **默认不自动跑** | `AUTO_DEFAULTS = { enabled: false, times: [], count: 30, level: 3 }`；定时最多 `AUTO_MAX_TIMES = 10` 个时间点，由 `chrome.alarms` 的 `hsaScheduledRun` 触发，同一时间点当天只触发一次。 |
| **积分日历** | 每次同步写入 `pointsHistory`（按本地日期，最多保留 400 天），设置页支持日 / 周 / 月聚合。 |
| **收尾不抢焦点（v3.6）** | 插件版 `QUIET_BACKGROUND = true`：运行期不切换活动标签、不聚焦浏览器窗口，结束也不把用户拉回原标签；`KEEP_TASK_TABS = true` 保留任务页，`restoreUserFocus()` 只清理历史记录。可靠性由 CDP 焦点模拟 + 生命周期保活保证。桌面版是独立窗口，无此问题。 |
| **双语 / 主题 / 桌面专属** | 弹窗内置中英文 `I18N` 表与 `uiLang` / `uiTheme` 持久化；浅色 / 深色 / 跟随系统、减少动画；桌面版另有开机自启与系统托盘，均默认关闭；设置页只读展示「内置浏览器：Microsoft Edge · Bing」；侧栏固定内嵌在主窗口右侧，自带独立滚动条。 |

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
2. **判定全完成**：按上文 `allDone` 条件判断，满足则零动作直接返回——不重载页面、不点卡片、不搜索；并写入当日完成停止态，跨日自动恢复。两端完全一致，无例外开关。
3. **只按任务列表点击**：`completePendingTaskCards()` 以同步生成的任务列表为唯一计划（共享 `pendingTaskItems` + `planTaskClicks`），自动跳过已完成项，其余逐项到 Rewards 侧栏或 dashboard / earn 页面定位并点击；按宿主能力优先采用官网卡片的真实交互路径（桌面可用 CDP 真鼠标，不可用时降级页面交互并逐卡记录触发方式）。定位不到的项记失败但不从计划里删除。相邻点击间隔两版统一默认 10 秒，可在设置里调 1–60 秒；弹出的任务标签页保留不关闭。
4. **执行搜索**：`handleStart()` 启动流程，`runFlow()` 中调用 `searchLoop()`；次数由「今日剩余搜索配额 × 拟人强度预设的单次配额上限」唯一决定（v4.3 起不再叠加「搜索次数上限」），从当日热搜池取 ≥5 字合规词，访问 `www.bing.com/search?q=...`；选词前按 UTC+8 日界剔除当天已用词。入口还有当日运行次数 / 最小间隔 / 定时概率跳过三道护栏。**默认拟人增强档**把强度预算 × 会话偏差 × 地理作息系数随机但低方差地分给 `move / type / submit / settle / browse / gap` 六段，并按会话分段缩放、段间离席；输入走分块拟真键入，点击与结果页浏览走贝塞尔真鼠标轨迹，提交概率性点搜索按钮；**严格档**仍是固定中心点击 → 输入 → 固定 Enter → 页面稳定等待 → 固定轮间。两档都**不回首页、不改词、不编词、不复用历史词**；`POINTS_PER_SEARCH = 3` 只用于本地估算。
5. **收尾**：`presetSyncFinish()` 再同步一次，写入 `endPoints` / `finalEarned`（起始积分未知时 `earnedIsEstimate = true`）、`lastRun` 与 `pointsHistory`；关闭搜索页、恢复运行前的标签页焦点。

### 3. 设置项

| 设置 | 默认值 | 依据 |
| --- | --- | --- |
| 语言 | 跟随系统（中文 / English / 跟随系统） | `popup.html` 的语言分段按钮、`I18N` 表、`uiLang` |
| 主题 | 跟随系统（浅色 / 深色 / 跟随系统） | `applyTheme()`，`localStorage.theme` / `uiTheme` |
| 减少动画 | 关 | `DEFAULTS.reduceMotion` |
| 卡片点击间隔 | 扩展 5 s / 桌面 10 s，范围 1–60 s | `TASK_CLICK_INTERVAL_MS`、`cardClickIntervalSec`、`taskClickSpacing()` |
| 定时自动运行 | 关 | `AUTO_DEFAULTS.enabled: false` |
| 启动时间 | 空；留空点「添加」首个为 08:00，之后在最晚时间上 +30 分钟，自动去重排序，最多 10 个 | `defaultAutoTime()`、`AUTO_MAX_TIMES` |
| 搜索次数上限 | 30（可填 1–150） | `AUTO_DEFAULTS.count`，`clampInt(..., 1, 150)` |
| 拟人强度 | 3（保留设置项，严格模式不生效） | `HUMAN_PROFILES` 定义保留，运行期禁用 |
| 积分日历 | 日 / 周 / 月，最多 400 天 | `recordPointsHistory()`、`pointsHistory` |
| 开机自动启动 | 关，仅桌面版 | `desktop-app/main.js` 的 `state.launchAtLogin` |
| 恢复默认设置 | 需二次点击确认（3 秒内） | `popup.js` 的 `resetBtn` 处理 |

定时由 `chrome.alarms` 的 `hsaScheduledRun` 唤醒，`maybeRunAutoTasks()` 会检查总开关、时间点是否在列表里、当天是否已触发以及是否已有任务在运行。

### 5. 常见问题

- **积分显示「—」或出现登录页**：后台 `fetch` 没拿到登录态；先在浏览器 / 内置窗口登录 `rewards.bing.com`，再点「刷新」。
- **全部做完了点按钮**：零动作返回并当日停止所有任务；v3.3 起相关设置项与 `force` 例外均已移除，如需次日重跑等跨 UTC+8 日界即可。
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
2. **严格档**已禁用 `HUMAN_PROFILES` / `GO_HOME_RATE` / `RELATED_RATE` / `ENTER_RATE` / `CLICK_RESULT_RATE` / `RESULT_HOLD_MIN/MAX` 的随机轨迹、回首页 / 改词、滚动与随机停留；**默认拟人增强档**启用轨迹、抖动、滚动、点结果与会话画像，但仍不回首页、不改词、不补词。`autoTasks` 与 `hsaScheduledRun` 在运行期不会重入，提醒、运行期刷新 / 同步与 watchdog 续跑同样禁用，运行期改设置仍被白名单拦截。桌面版的「静默完成任务」开关已移除，页面与侧栏一律按用户可见行为运行。这些仍属于官方排除的自动化方式。
3. 代码用 `HUMAN_VERIFY_OFFICIAL = true`、`hitByCount()` 与收尾积分差做本地核对，并可能把 `finalEarned` 标为估算；**本地核对不等于官方确认计分**，一切以服务端为准。
4. `host_permissions` 里的 5 个第三方热榜域名（加上 Bing 自带热榜源共 6 个词源）只用于取搜索词，工具不代理登录、不批量注册账号、不内置绕过风控的逻辑；但自动化本身已足够触发上述限制。

### 规避建议

1. **只当看板用**：在 Rewards 官网 / Bing 由本人手动搜索与完成任务，把本工具用于查看进度、积分日历与本地日志。
2. **保持自动化关闭**：`定时自动运行` 默认关闭，不要开启；桌面版的开机自启也保持默认关闭。
3. **不用自动化攒分**：不把自动执行当作日常获取积分的手段；不使用多账号、VPN / 代理隐藏地区或任何规避平台检测的做法（官方条款亦提示 VPN 可能导致账户取消与积分没收）。
4. **接受后果自担**：自动化可能拿不到积分、已获积分作废或账户受限；页面结构、接口与规则变化也可能让功能失效，不要以本工具作为任务完成的唯一依据。
5. **分发前处理仓库现状**：保留「非官方、未经授权 / 赞助 / 认证」声明；Microsoft / Bing / Rewards 名称只用纯文本引用，不使用徽标或产品图标；`desktop-app/tests/` 中保存了从官网抓取的静态资源（如 `MsRewardsLogo.svg`、`RAFSearchAndEarnHVA.png` 等），公开分发前需核实这些第三方素材的使用权限；补上 `LICENSE`（当前为 `UNLICENSED` / 无许可证文件，公开代码不自动授予复制、修改、再分发权利）；清理根 README 的冲突标记与失效链接。
6. 本节仅陈述代码事实与已核对的官方文本，**不构成法律意见，也不保证任何使用方式合规**；公开发布、分发二进制包或投入实际使用前，请自行核实适用条款及当地法律，必要时咨询律师。

---

## 📎 📮 反馈与权利说明

问题与建议欢迎通过仓库 Issue 反馈；**切勿公开账户 Cookie、密码、令牌或个人浏览记录**。

