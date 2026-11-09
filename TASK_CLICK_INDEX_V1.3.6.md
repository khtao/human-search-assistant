# v1.3.6 — 同步阶段任务定位索引

## 目标

把“同步积分/任务列表”和“自动点击任务卡片”连接成同一条数据链路。同步阶段已经解析过任务卡片，点击阶段不应再次抓取两页 HTML、重新收集所有卡片。

## 同步阶段新增

`buildTaskClickIndex(pages, items)` 从本次同步的 Dashboard / Earn HTML 建立 `taskClickIndex`，并与 `pointsSummary`、`todayTasks`、`todaySearch`、`loginStatus` 同批写入 storage。

每个索引项包含任务名称、描述、积分、分类、完成状态、所属页面、完整 href、target，以及 data-bi-id、data-offer-id、data-testid、id、aria-label、title、anchorIndex 等 DOM 定位特征。索引不保存 x/y 坐标或 DOM 引用。对可见 DOM / 注入补充任务，若能匹配本页锚点或具有可用 href，也会补入索引；估算项不进入点击索引。

## 点击阶段变化

- Edge 插件读取 `taskClickIndex`，按页面分组，不再调用全页任务扫描收集卡片。
- Electron 桌面版通过 preload 把索引传入主进程，主进程不再执行旧 `TASK_SCAN_SRC` 全页扫描。
- 优先按 href、data-bi-id、offer/test ID、id、aria-label 定位；没有稳定属性时使用标题 + 积分进行受限匹配。
- 索引未命中时最多执行 5 次有限滚动/重试，仍使用同一个索引项，不重新建立任务清单。
- 每次点击前重新读取实时坐标，并检查 elementFromPoint；最终只使用 CDP 鼠标输入。
- 索引超过 30 分钟拒绝使用；自动任务开始时的同步会生成新索引。
- 点击事件、任务页面打开、积分到账分开记录，不把发送鼠标事件当成任务完成。

## 版本

- Desktop package: 1.3.6
- Edge extension manifest: 1.3.6
- Electron: 45.2.3
- electron-builder: 26.18.1

## 验证

新增 `verify-task-index-v136.js`，覆盖同步索引生成、Dashboard/Earn 分组、URL 与 DOM 属性提取、完成态、坐标不缓存、Edge 点击消费索引、Electron IPC 传递、主进程不再全页扫描等 38 项检查。
