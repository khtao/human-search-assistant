# shared/ · 插件版与桌面版的单一真源

本目录存放**两端行为完全一致**的代码与配置。修改请先改这里，再执行：

```bash
node scripts/sync-shared.js          # 同步到两端运行时目录
node scripts/sync-shared.js --check  # 只校验副本是否一致（CI / verify 用）
```

| 文件 | 作用 | 对应题号 |
| --- | --- | --- |
| `hsa-core.js` | UMD 纯逻辑：决策常量、任务卡去重键、点击三态、完成判定、登录三态、快照合并、缓存策略、状态行格式化、UI 配置、严格运行模式（≥5 字当日热搜词、运行期禁用清单、消息白名单），以及诊断数据（运行日志字段裁剪 / 环形上限 / 导出、关键网页实时抓取策略 / 导出） | T01–T09 / D01–D06 / S01 / U02–U10 / 严格模式 / 诊断 |
| `hsa-recovery.js` | UMD 启动卡住自动纠正（一次性检查 + 状态变化复检 + 限时重试） | S02 |
| `hsa-shared.css` | 品牌图标 / 悬停提示 / 日历图例 / 诊断设置区的统一样式 | U02 / U07 / U08 / 诊断 |
| `decisions.json` | 27 个差异项的勾选结果，机器可读 | 全部 |

## 为什么还要复制到两端

浏览器扩展只能加载扩展根目录内的文件，Electron 安装包也只打包 `desktop-app/` 内的文件。
因此 `scripts/sync-shared.js` 把本目录的运行时文件复制到：

- `edge-extension/shared/`：Service Worker 用 `importScripts('shared/hsa-core.js')`，popup 用 `<script>` / `<link>`。
- `desktop-app/shared/`：主进程用 `require('./shared/hsa-core.js')`，host / popup 用 `<script>` / `<link>`。

副本带 `AUTO-GENERATED` 头，`--check` 会逐字节比对（忽略头注释），防止有人只改一边造成新的差异。
`decisions.json` 是文档性数据，运行时不加载，但同样同步以保证包内自洽。

## 加载约定

- 扩展 Service Worker：`importScripts('shared/hsa-core.js')`，随后读 `globalThis.HSA_CORE`。
- 扩展 popup：`shared/hsa-core.js`、`shared/hsa-recovery.js`、`shared/hsa-shared.css`。
- 桌面主进程：`require('./shared/hsa-core.js')`。
- 桌面 host / popup：`../shared/hsa-core.js`、`../shared/hsa-recovery.js`、`../shared/hsa-shared.css`。

`hsa-core.js` 不引用任何宿主 API，可在 Node 里直接单测（见 `tests/shared.test.js`、`tests/strict-run.test.js`、`tests/diagnostics.test.js`）。

## 严格运行模式（两版一致）

- `STRICT_RUN.minKeywordChars = 5`：少于 5 个字的单调词一律拒绝；`strictQueries()` 只从本次抓取的当日热搜池取词（UTC+8 日界），不补词、不拼接、不复用历史词、不重复。
- `strictRuntimeFeatureAllowed()` / `strictAlarmAllowed()`：运行期禁用改词、回首页、拟人随机、滚动、点结果、提醒、定时重入、运行期刷新 / 同步、watchdog 续跑、运行期改设置与提醒预览。
- `strictBlockedMessage()`：运行期消息按白名单放行（仅 `stop` 与只读 `panelState`），其余一律拦截。
- `STRICT_RUN.keptGuardrails`：保留停止、超时、失败上限、页面稳定等待与结果计数，避免运行无法结束。
- 单测见 `tests/strict-run.test.js`，静态落地断言见 `scripts/verify-decisions.js`。

## 拟人增强档（v3.9，两版一致，默认开启）

- `hsa-human.js`：纯函数引擎。`DEFAULT_SETTINGS.runMode = 'human'`；`normalizeSettings()` / `isEnabled()` 支持切回 `strict`。`createProfile(settings, seed)` 用 mulberry32 生成一次运行固定的会话画像（节奏偏差、抖动幅度、贝塞尔弯曲度、词序交换率、浏览率）。`roundBudget()` × `splitRound()` 把单轮预算低方差地分给 6 段并做总量守恒，且**同时提供 `*Ms` 别名**供运行链路取值（否则 `gapMs` 为 `undefined`，轮间等待会被吞掉）；`jitter()` 有界；`bezierPath()` 三次贝塞尔 + 过冲回正；`extraActions()` / `browsePlan()` / `wordOrder()` / `cardSpacing()` 分别负责噪声、结果页浏览、只重排不增词的词策略与卡片随机间隔。低 / 中 / 高 20 次搜索约 15 / 30 / 60 分钟。
- `hsa-fingerprint.js`：`collect()` 读真实值 → `crossCheck()` 交叉校验（屏幕 vs 视口、DPR、CPU/GPU 档位、UA 版本 vs UA-CH brands 等）→ `patcher()` 只清 `navigator.webdriver` 与自动化全局标记、补缺失的 `window.chrome` / `permissions` / `mediaDevices` / `Notification`。**`screen` / `devicePixelRatio` / `hardwareConcurrency` / `userAgent` / `language` / `plugins` 一律不改写**，与「不做 UA 伪装」不冲突。
- `hsa-geo.js`：`probe()` 探测出口 IP（`ipwho.is` / `ipapi.co`），`derive()` 推导自洽的时区 / 语言 / `mkt`，`crossCheck()` 检出 IP-时区 / mkt-国家错配，`scheduleFactor()` 让当地深夜自动拉长间隔，`withMarket()` 给 URL 补市场参数。探测失败降级到系统时区 / 语言，不阻断运行。
- **严格档保留**：`hsa-core.js` 的 `STRICT_RUN` / `strictRunPolicy()` 一行未动；`runMode='strict'` 时两端逐字回到固定中心点击 + 固定 Enter + 固定间隔。词规则（当日 ≥5 字热搜、不补词 / 编词 / 复用 / 改词）、消息白名单、同步闸门、任务列表点击与全完成停止态两档都一致。
- 加载：插件 SW / popup `importScripts` 或 `<script src>`；桌面 `host.html` / `popup.html` 先加载全局，`background.js` 用 `globalThis.* || require('../shared/...')` 回退；Node 静态校验环境可直接 `require`。插件 `manifest.json` 已补 `ipwho.is` / `ipapi.co` 的 `host_permissions`。
- 自检：`HSA_HUMAN.selftest()` / `HSA_GEO.selftest()` / `HSA_FINGERPRINT.selftest()`；单测见 `tests/v39-human-enhanced.test.js`、`tests/v39-human-enhance.test.js`，静态断言见 `scripts/verify-decisions.js` 末两组。

## 手动启动保障（v4.4，两版一致）

- `hsa-stealth.js` `guardDecision(..., manual=true)`：用户主动点「自动完成任务」不受「当日次数上限 / 最小间隔」硬拦，只返回 `warn` 并计入当日运行；定时触发的三项硬约束一字未动。严格档恒关。
- `hsa-core.js` 新增 `staleRunning()`（僵尸 `running` 判定）、`startFailText()`（中英 ≤15 显示宽度的启动失败短文案）、`createSyncGate().clearAllDone()`（手动复核后解除误设的当日停止态）。
- 两端后台 `onMessage` 豁免 `autoComplete` 进入严格守卫，`startManual` 与 `runAutoComplete` 入口双层自愈残留运行态；`handleStart` 不再静默吞掉搜索阶段；点卡短路后写「跳过点卡·继续搜索」日志。
- 两端 popup 对 `res.ok === false` 显示明确短原因并立即复位按钮；移除对已删 `autoTasks.level` 的引用。回归 `tests/v44-manual-start.test.js`（8 组，含 `node:vm` 实跑两端启动分支）。

## 当日运行护栏（v4.3，两版一致）

- `hsa-stealth.js` 新增 `RUN_GUARD` / `runGuardPolicy()` / `guardState()` / `guardDecision()` / `guardRecord()` / `guardReasonText()`：按 UTC+8 日键记录当日运行与跳过，拟人档低/中/高分别最多 4/3/2 次完整运行、最小间隔 30/45/60 分钟、定时触发按 10~15% 确定性概率跳过（不补跑），手动启动不跳过。严格档恒关。
- 两端 `runAutoComplete` 入口逐字同构接线，写 `runGuard` storage 与 `run-guard` 运行日志；被「最小间隔 / 当日上限」拦截时**不占额度**，只有实际运行与概率跳过入账。共享清单仍是 **12** 个文件。
- `directSearchUrl()` 去掉硬编码的首页表单标识参数：直接导航兜底本就没经过搜索框，带该参数属于来源不实且恒定的请求特征。
- 自检 `HSA_STEALTH.selftest()` 已含护栏用例；动态回归 `tests/v43-cleanup-guard.test.js`（10 组）。

## 强度预设与当日词去重（v4.2，两版一致）

- `hsa-human.js`：`PRESET_GROUPS` 定义三组（quota / action / page）共 7 个键，`RUN_PRESETS` 给低 / 中 / 高三档各一组值；`applyRunPreset(settings)` 供两端 `getSettings()` 整组套用（严格档原样返回），`presetValues(level, mode)` 供设置页只读渲染。共享清单仍是 **12** 个文件。
- `hsa-core.js`：`todayUsedState()` 按 `hotDayKey()`（UTC+8）读当日已用词，`mergeUsedWords()` 兼容旧 `usedWords` 纯数组，`dropUsedWords()` 在整池合规词里剔除已用，`todayUsedPush()` 把本次词计入 `{day, words}`。两端 `buildQueries()` 同构接线，存储 key `todayUsedWords`；换日自动失效，**不依赖 24h 清理闹钟**。
- 词规则不变：只用本次抓取的当日 ≥5 字热搜原文；不补词 / 不编词 / 不拼接 / 不复用历史词 / 不循环重复。词用完就少跑或报错停止。
- 自检 `HSA_HUMAN.selftest()` 已含预设校验；动态回归 `tests/v42-presets-dedupe.test.js`（10 组），静态断言见 `scripts/verify-decisions.js` 末两组。

## 非卡片项跳过（v4.1，两版一致）

- `isNonClickableTaskItem(it)`：只回答「这项是不是卡片」。结构字段是 `search` 进度项、或名称匹配「今日 Bing 搜索 / Bing search today」等且**没有真实 http(s) 链接** → 非卡片；有链接的同名项仍按可点卡片处理。`pendingTaskItems()` 的唯一过滤扩为「非卡片 + 已完成」，其余一项不删、不合并、不重排。
- `hasClickableCards(primary, secondary, summary)`：点击索引 / 运行态任务列表 + 主界面任务列表双来源，两者都无待点卡片才短路，避免同步失败误跳过真实卡片。两端 `hasPendingClickableCards()` / `skipCardPhaseIfEmpty()` 逐字同构，短路时写 `no-clickable-cards` 日志。
- 主界面任务列表仍保留搜索进度项供 UI 与 `isAllDone` 判定；搜索阶段照常进行，只是不再为一张不存在的卡打开侧栏。动态回归见 `tests/v41-no-clickable-cards.test.js`。

## 运行风险规避（v4.0，两版一致，拟人档默认开启）

- `hsa-stealth.js`：纯函数引擎。`sessionPlan()` 把 N 轮拆成 2–4 个浏览段，段间离席总量不超过强度预算的 25%，其余回补给各段 `scale`，**总时长精确守恒**；`scaleFor(i)` 用确定性微扰让同段内每轮也不同。`capSearches()` 默认只跑剩余配额 60%，`shouldDefer()` 让定时触发在当地 0–6 点跳过（手动不受限），`scheduleJitter()` 给定时启动加有界随机偏移，`geoCacheValid()` 缓存出口 IP 结果。
- 过程：`keystrokePlan()` 按 1–3 字分块上屏、非均匀键间隔、偶发停顿与退格纠错，**`finalText` 逐字等于输入的当日热搜原文**；`submitPlan()` 在拟人档按概率改用搜索按钮（失败回退 Enter）。两端 `stealthTypeQuery` / `stealthSubmitQuery` / `releaseFocusEmulation` 逐字同构。
- **严格档六项特性恒关**（`runMode='strict'`）：固定节奏、整段粘贴、固定 Enter、单次跑满、无启动抖动、深夜不跳过。`hsa-core.js` 的 `STRICT_RUN` 与 `strictRunPolicy()` 一行未动。
- 自检 `HSA_STEALTH.selftest()`；动态回归 `tests/v40-stealth.test.js`（12 组），静态断言见 `scripts/verify-decisions.js` 末两组。

## 诊断数据（两版一致）

- `RUNLOG.maxEntries = 200`：`runLogAppend()` 只保留白名单轻量字段（时间、事件、状态、中英文案、页码 / 卡片 / 查询词等），网页 HTML、快照、积分明细一律不进日志；`runLogExport()` 输出 `hsa-runlog/1` JSON。
- `keyPagePolicy()`：关键页面 `/dashboard`、`/earn` 强制 `fresh: true`、`cacheAllowed / snapshotAllowed / panelAllowed / dataViewAllowed = false`，来源 `live-network`；`keyPageExport()` 输出 `hsa-keypages/1` JSON（含本次实时 HTML）。
- 两端后台 `hsaCaptureKeyPages()` 直连 `fetch(url, { credentials:'include', cache:'no-store', signal })`，不经过 120 秒 HTML 缓存、可见快照、面板或隐藏数据视图；抓到的 HTML 只随本次导出返回，不落进日常日志。
- 严格运行期：`exportRunLog` 在消息白名单（只读，不触发抓取）；`captureKeyPages` 被白名单拦截，即「日常运行只有运行日志」。
- 单测见 `tests/diagnostics.test.js`，静态落地断言见 `scripts/verify-decisions.js` 的「诊断 ·」条目。
