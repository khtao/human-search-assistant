# shared/ · 插件版与桌面版的单一真源

本目录存放**两端行为完全一致**的代码与配置。修改请先改这里，再执行：

```bash
node scripts/sync-shared.js          # 同步到两端运行时目录
node scripts/sync-shared.js --check  # 只校验副本是否一致（CI / verify 用）
```

| 文件 | 作用 | 对应题号 |
| --- | --- | --- |
| `hsa-core.js` | UMD 纯逻辑：决策常量、任务卡去重键、点击三态、完成判定、登录三态、快照合并、缓存策略、状态行格式化、UI 配置 | T01–T09 / D01–D06 / S01 / U02–U10 |
| `hsa-recovery.js` | UMD 启动卡住自动纠正（一次性检查 + 状态变化复检 + 限时重试） | S02 |
| `hsa-shared.css` | 品牌图标 / 悬停提示 / 日历图例的统一样式 | U02 / U07 / U08 |
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

`hsa-core.js` 不引用任何宿主 API，可在 Node 里直接单测（见 `tests/shared.test.js`）。
