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

## 诊断数据（两版一致）

- `RUNLOG.maxEntries = 200`：`runLogAppend()` 只保留白名单轻量字段（时间、事件、状态、中英文案、页码 / 卡片 / 查询词等），网页 HTML、快照、积分明细一律不进日志；`runLogExport()` 输出 `hsa-runlog/1` JSON。
- `keyPagePolicy()`：关键页面 `/dashboard`、`/earn` 强制 `fresh: true`、`cacheAllowed / snapshotAllowed / panelAllowed / dataViewAllowed = false`，来源 `live-network`；`keyPageExport()` 输出 `hsa-keypages/1` JSON（含本次实时 HTML）。
- 两端后台 `hsaCaptureKeyPages()` 直连 `fetch(url, { credentials:'include', cache:'no-store', signal })`，不经过 120 秒 HTML 缓存、可见快照、面板或隐藏数据视图；抓到的 HTML 只随本次导出返回，不落进日常日志。
- 严格运行期：`exportRunLog` 在消息白名单（只读，不触发抓取）；`captureKeyPages` 被白名单拦截，即「日常运行只有运行日志」。
- 单测见 `tests/diagnostics.test.js`，静态落地断言见 `scripts/verify-decisions.js` 的「诊断 ·」条目。
