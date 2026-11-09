# Human Search Assistant · 拟人搜索助手（v2.9）

Manifest V3 浏览器扩展（Chrome / Edge 116+）。基于上传的 Rewards Search Automator 外壳，
把搜索内核换成 [khtao/human-search-assistant](https://github.com/khtao/human-search-assistant) v4.2 的拟人搜索实现。
扩展名、界面文案与图标均为中性原创设计，原扩展署名已全部移除。---

## v2.0 变更（按真实页面 DOM 重写，修「只开页面不点击任务」）

用你保存的两份真实页面（`首页 – Microsoft Rewards.html` / `积分赚取 – Microsoft Rewards.html`）
对照后，发现旧版的任务识别**与真实结构完全对不上**，所以扫描结果恒为 0，页面开了却一张不点。

### 真实 DOM 长什么样

| | `/dashboard` 每日活动 | `/earn` 日常任务 |
|---|---|---|
| 可点元素 | `<a target="_blank" rel="noopener noreferrer" href="https://www.bing.com/search?q=…">` | `<a target="_blank" href="…/search?q=Bing Homepage quiz` 或 `…/spotlight/imagepuzzle">` |
| 标题 | `<p class="text-globalBody2Strong">` | 同左 |
| 积分 | `<p>+10</p>`，徽章是 `bg-statusInformativeTintBg` | `<div class="… bg-statusSuccessRewardsBg …"><svg/><p>5</p></div>` |
| 完成态 | 无标记（待完成） | 卡片右下角「已完成」 |
| 分组 h2 | `每日活动` | `日常任务`（punchcard 在 `任务` 下、href 含 `/earn/quest/`） |

**致命差异**：`/dashboard` 页面里 `bg-statusSuccessRewardsBg` 这串字符**只出现在 RSC flight payload
的转义文本**（`\\"className\\":\\"…bg-statusSuccessRewardsBg…\\"`），真实 DOM 里一个这样的元素都没有。
旧版 `listPendingCards` 以 `[class*="bg-statusSuccessRewardsBg"]` 为唯一入口遍历徽章 →
dashboard 徽章数 = 0 → 一张卡片都收不到。earn 页即便有徽章，`badge.closest(…)` 也会先命中
内层 `rounded-cornerCardDefault` 的 `<div>` 而不是 `<a>`。

### 改法

- **以 `a[href]` 为唯一入口**：积分双通道——绿色徽章 `<p>` 纯数字（earn 的 5 分），
  或整卡文本 `+N`（dashboard 的 +10）；再加「数字紧贴完成词」兜底。
- **链接白名单**：只收 `*.bing.com`，排除 `/redeem`、`/referandearn`、`/apps/wallpaper`、
  `/earn/quest/`（月度 punchcard）、站内导航，以及含「可用积分/今日积分/可领取/兑换」的指标卡。
- **定位与点击都落在 `<a>` 本身**：`focusCardByIndex` 返回 `<a>` 的 rect 和 href/target，
  `data-yb-task-idx` 被 hydration 冲掉时按同一套扫描顺序回退；同名同分卡靠 idx 区分。
- **不再因分组 `unknown` 丢卡**：h2 只用于排序与日志，页面顺序（dashboard → earn）已保证先每日后日常。
- **CDP 不可用时不再白点**：旧 `domClick` 只发合成 `MouseEvent`，对 `<a>` 不产生导航；
  降级改为 `HTMLElement.click()`（会触发 `target=_blank` 默认行为）。
- **载体页临时置 active**：后台标签页的 CDP 点击可能不触发 `window.open`，点击前 `ensureTabActive`，
  点开的任务页再置回后台保留。
- **兜底开页**：点击后 1.2~1.6s 内若没有新标签页弹出，按 href `chrome.tabs.create({active:false})`
  打开，保证任务一定在新标签页落地；日志会标注「兜底新标签页打开」及次数。
- **就绪判定放宽**：URL 前缀匹配（`/dashboard` 与 `/` 互认、`/earn/` 尾斜杠），
  等页面出现 `a[href]`/`h2` 再稳 1.5s；每轮注入结果带 `path`，与目标不符就等待重试，
  绝不把上一页的旧 DOM 当成新页误点。空扫描放宽到 5 轮 × 1.2s。
- **诊断日志**：每页打印「识别到 N 张任务卡，其中已完成跳过 M 张，页面标题「…」」，
  收尾打印 `dashboard=N(卡3/完成0) / earn=M(卡4/完成4)`、CDP 是否可用、兜底开页次数。
  以后再出现「不点击」，看这两行就能定位是识别、完成态还是点击环节的问题。

### 关于这两份快照本身

- `/dashboard`：3 张 +10 卡都**没有「已完成」标记** → v2.0 会逐个模拟点击并在新标签页打开。
- `/earn`：4 张 5 分卡**都已标记「已完成」**（含「你是否知道答案？」×2）→ 默认跳过，
  这是正确行为，不是漏点。若确实要强制重点，把 `background.js` 顶部的
  `FORCE_CLICK_COMPLETED` 改为 `true`。
- 其他开关：`KEEP_TASK_CLICK_ACTIVE`（载体页前台）、`FALLBACK_OPEN_TASK_URL`（兜底开页），默认都为 true。

---

## v1.9 变更（dashboard 与 earn 两页都点）

`/dashboard` 和 `/earn` **两页都存在可点击任务**，必须逐页独立扫描、各自点击。
v1.8 虽然循环了两个 URL，但实际会漏点，三个原因：

1. **跨页共享已点集合**：`done` 是两层循环共用的一个 `Set`，两页常渲染同一批今日任务，
   第一页点过的 `名称|积分` 会让第二页整页被判为「已点过」而跳过。
2. **切页不等页面加载**：`openOrNavigate` 一返回就注入，切到 earn 时往往还在显示
   dashboard 的旧 DOM；两轮空扫描即 `break`，第二页等于没扫。
3. **同名同分卡片无法区分**：如「你是否知道答案？」×2 都是 5 分，用 `名称|积分` 当键
   会定位到同一张卡，第二张永远点不到。

对应修法：

- **每页独立 `done`**：`completePendingTaskCards` 每次循环新建 `Set`，一页点过不影响另一页；
  日志按 `dashboard=N / earn=M` 分别汇报本页点击数。
- **页面就绪等待**：新增 `waitForTaskPageReady()`，导航后等 `tab.status === 'complete'`、
  URL 落在目标路径（`/dashboard` 与根路径 `/` 都算）、再稳 `SETTLE_MS` 才注入；
  命中登录域或超时只跳过本页，**另一页仍继续尝试**。
- **登录页识别**：用户贴的两种形态都能识别——URL 仍是 `rewards.bing.com/dashboard`
  但内容是「登录到 Microsoft 帐户需要启用 JavaScript」，以及 earn 页的简短登录文案。
  命中时记 `stat.signedOut` 并在日志明确提示，不再当成「没有任务」静默跳过。
- **页面内序号 idx**：`listPendingCards` 给每张卡片打 `data-yb-task-idx` 并返回 idx，
  `focusCardByIndex` 按属性定位；页面被 Next.js 重渲染导致属性丢失时，
  按同一套遍历规则数第 idx 个回退。同名同分卡也能逐张点到。
- **统一 5s 调度**：改为按「点击时刻」对齐的 `taskClickSpacing()`，在每次点击**之前**
  补差等待。跨卡片、跨轮次、跨页切换都保证相邻两次点击相隔 5s；
  点击后另等 0.9~1.4s 让新标签页弹出并登记为「保留」（这段时间计入 5s 内，不叠加）。
- `DASHBOARD_URL` 由根路径改为用户明确给出的 `https://rewards.bing.com/dashboard`；
  `TASK_PAGES = [DASHBOARD_URL, EARN_URL]` 是唯一的两页清单。

任务标签页保留、搜索页保持焦点/结束关闭、每日任务 → 日常任务 → 搜索的顺序，全部沿用 v1.8。

---

## v1.8 变更（任务点击顺序 · 标签页保留 · 搜索页前台保活）

### 自动完成任务的顺序与节奏

- **先点任务，再搜索**：卡片点击严格按「每日活动 / 每日任务 → 日常任务」排序，
  「搜索」分组的进度卡不点，由后面的拟人搜索补足剩余分数。
- **逐个点击、固定 5s 间隔**：`TASK_CLICK_INTERVAL_MS = 5000`，跨 dashboard / earn 两页同样生效；
  等待用可中断的 `nap()`，点「停止」立即退出，同时保活 MV3 service worker。
- 仍是 `chrome.debugger` + CDP 真实鼠标点击，不改成 JS `element.click()`。

### 任务标签页保留 / 搜索标签页关闭

- 点击卡片弹出的任务标签页**不再关闭**，改为后台静默打开（`active:false`、`autoDiscardable:false`）。
- Rewards 载体页（`taskClickTabId`）与读积分用的 `rewardsTabId` 也保留并复用同一个标签页，
  不会因为反复运行越堆越多；`closeTab()` 对这两个 key 直接返回，只有 `searchTabId` 走关闭。
- **搜索标签页在结束 / 停止 / 出错时照常关闭**。设置页「测试拟人搜索」仍强制清理自己打开的遗留页。
- 下方 v1.7 / v1.6 段落里「用完即关 `rewardsTabId`」「注入读 DOM（用完关页）」等描述
  **已被 v1.8 覆盖**：主流程改为保留并复用该标签页，只有测试功能仍强制关闭。

### 搜索页焦点保活（修复「非焦点页面搜索会暂停」）

Chrome 会对非激活标签页做定时器 / 输入 / 渲染节流，窗口不在系统前台时更明显，
表现为 `waitForTab` 超时、CDP 输入不生效、页面脚本挂起。v1.8 做了四层防护：

1. 搜索标签页用 `active:true` 创建，开局即 `ensureTabActive`；
2. **每一轮搜索开始前**重新拉回焦点（用户中途切走，下一轮自动回来），
   并把所在窗口 `focused:true`；
3. CDP `Page.bringToFront` + `Emulation.setFocusEmulationEnabled`，
   让页面始终「自认为」有焦点，任务载体页的后台点击也因此不受影响；
4. 搜索结束 / 停止 / 出错后 `restoreUserFocus()` 把焦点还给用户运行前所在的标签页。

四个行为都可改：`KEEP_TASK_TABS`、`KEEP_SEARCH_TAB_FOCUSED`、
`FOCUS_WINDOW_TOO`、`RESTORE_FOCUS_ON_FINISH`（`background.js` 顶部）。
搜索期间浏览器窗口会被持续拉回前台，这是保证不暂停的代价；不想被抢焦点可把
`KEEP_SEARCH_TAB_FOCUSED` 设为 `false`（焦点模拟仍保留，但可能再次遇到节流）。

---

## v1.7 变更

### 图标与顶部圆环

- 标题左侧图标**直接引用 `icons/icon48.png`**（32×32 显示），不再用内联 SVG 现画；四尺寸图标均为本项目自行设计，不引用上游仓库资源。
- 顶部圆环改为**「今日任务」进度**：与下方「今日任务 100%（110 / 110 分）」一致，但**只显示百分比**（如 `100%`），不显示积分、不显示搜索次数，也不再随搜索/冷却状态旋转。副标题为「今日任务 / Today's tasks」。

### 悬停提示精简

三张积分卡的 tooltip 改为短文案：

| 卡 | 中文 | English |
|---|---|---|
| 可用积分 | Rewards 面板余额 | Rewards balance |
| 今日积分 | 今日已获积分 | Points earned today |
| 可领取 | 待领取积分 | Points to claim |

加载 / 未登录提示同步简化为「读取中… / Loading…」「请先登录 / Sign in first」。

### 100% 时点击「自动完成任务」什么都不做

任务进度为 100% 且所有卡片都已完成时，后台直接返回 `skipped`，**不刷新、不打开 `rewards.bing.com`、不点卡片、不搜索、不写运行状态**；弹窗按钮立即恢复可点击，不再进入「启动中 / 停止」态。

### 测试拟人搜索结束后自动关页

- 测试用的 Bing 后台标签页在 `finally` 里关闭（原本就有）。
- 新增：测试期间因任务刷新可能打开的 `rewardsTabId`、任务点击用的 `taskClickTabId` 一并关闭。
- 任务解析的注入兜底用完即关 `rewardsTabId`；未登录 / 公开 About 页也会清理遗留标签页，不再把 `https://rewards.bing.com/` 留在浏览器里。**（v1.8 起主流程改为保留复用，仅测试功能仍强制关闭）**
- `isSignInPage` 增加对公开 **About – Microsoft Rewards** 页的识别，避免把未登录页面当成积分面板去解析。

---

## 首页（v1.6 起）

- 「自动完成任务」按钮在三张积分卡（可用积分 / 今日积分 / 可领取）**正下方**。
- 首页无搜索次数输入；次数按今日 Bing 搜索剩余分数 ÷ 每次搜索积分自动决定，上限在设置页。
- 删除「今日搜索积分已领完 / 今日 Bing 搜索：60/60 分…」提示模块与 Bing 搜索进度条。
- 任务卡片**只做展示**，不是链接。

## 今日任务

- 第一条固定是「今日 Bing 搜索」（如 60/60 分）。
- 只列有积分徽章的任务，分组为「搜索 / 每日活动 / 日常任务」：
  - 每日活动 3 张 ×10：罗马温和历史漫步、布里斯班河阳光温暖、不死水母
  - 日常任务 4 张 ×5：你是否知道答案？ ×2、完成此拼图、周中拼图
- **无「其他任务」分组**：月度 punchcard（50 分）不算今日任务。
- 无积分推广卡自动过滤。
- 任务积分合计与「今日积分」不一致属正常（周任务、额外奖励分），两者互不换算、不比较。

## 三项积分

直接解析 `https://rewards.bing.com/dashboard` 与 `https://rewards.bing.com/earn` 的指标卡，兼容 Next.js SSR DOM 与 RSC flight payload；示例：可用积分 19,925 / 今日积分 100 / 可领取 0。不再用任务合计推算。

## 自动完成任务

首页按钮与设置页定时调度共用流程：

1. 刷新两个页面的任务与积分（**若已 100% 则整步跳过**）。
2. **默认从 Bing 侧栏点卡片**：`injectAllFrames` + 穿透 shadow DOM，按 `+N` 文本启发式识别「每日活动 / 日常任务」卡片；CDP 真鼠标 → 页面内事件序列 + `el.click()` → 按 href 兜底开页，三级降级；每日活动 → 日常任务排序、统一 5s 间隔，「已完成 / 20/20」跳过，**任务标签页保留不关闭**。`TASK_MODE='sidebar'`/`'rewards'` 可切换：默认侧栏，`'rewards'` 回退到 v2.0 的两页模式。
3. 任务点完后再进行搜索：次数 = `ceil((今日搜索上限 − 已得分) ÷ 3)`，不超过设置页上限；满额时跳过搜索。搜索标签页全程保持焦点，结束 / 停止时关闭。
4. 按拟人强度执行搜索，结束刷新任务与积分。

设置页保留：总开关、搜索次数上限、多个启动时间、拟人强度（低 / 中 / 高）、「测试拟人搜索」。

---

## 解析与兜底

- 任务卡片：绿色徽章 `bg-statusSuccessRewardsBg` + 数字；RSC `dailySetItems` 与可见 DOM `<a>` 卡片都读，两页面合并去重。
- 兜底顺序：真实页面卡片 → 注入读 DOM（v1.8 起保留复用，不再用完关页）→ 旧版「今日进度」表格 → 已有活动合成（标「估算」）。
- 未登录 / 公开 About 页识别后，三项积分显示 `—`，不写假的 0 分。

---

## 安装

1. 解压 ZIP → `chrome://extensions` / `edge://extensions` → 开发人员模式 →「加载已解压的扩展程序」。
2. 登录 `rewards.bing.com`，点开扩展即会读取；首页「刷新」可手动重取。
3. 首次建议先跑「设置 → 测试拟人搜索 → 运行测试」，确认热搜源与 CDP 正常，并观察标签页是否自动关闭。

---

## 验证情况

- `node --check` 全部 JS 通过；`test_sidebar.js` **38 项全通过**（网页 flyout / shadow DOM / iframe 坐标偏移 / 父子去重 / 已完成与 idx 稳定 / 事件序列 / 诊断）；`real_html_fixture.json` 由**两份用户提供的真实保存页**抽取，`test_task_cards.js` **48 项全通过**：dashboard 3 张 +10 待完成卡、earn 4 张 5 分已完成卡（含同名 ×2）、`<a>` 定位与 href/target、属性丢失回退、`a.click()` 降级、exclude、登录页、路径匹配、`readTaskCardsFromDom` 展示解析同源；双语字典中英键一一对应（167 键）
- 真实页面 HTML 夹具：三项积分 19,925 / 100 / 0、8 项任务（首条搜索、无其他任务）
- **展示解析同源**：`readTaskCardsFromDom` 也改为 `a[href]` 入口。旧版在 `/dashboard` 上读到 0 张卡片，
  会让「今日任务」列表失真，甚至把进度误判成 100% 而触发整轮跳过；现在两页分别读到 3 张未完成 / 4 张已完成。
- **真实保存页识别复核**：`/dashboard` 3 张 `+10`、`target=_blank` 每日活动；`/earn` 4 张 `5` 分已完成，punchcard / 兑换 / 壁纸链接均正确排除
- **100% 时点击自动完成**：返回 skipped、不开标签页、不写 running、不触发搜索
- **两页独立点击**：mock DOM 夹具验证 dashboard 3 张 / earn 4 张（含同名卡 ×2）均被收取并分别定位，跨页已点集合互不影响
- **侧栏**：载体页与弹出的任务标签页保留；**搜索页**：结束 / 停止 / 出错时关闭，焦点还给用户运行前所在的标签页（`runAutoComplete` 开头记录，`handleStart` 不覆盖）
- **测试结束**：关闭 Bing 测试页 + 遗留 Rewards / 任务点击页（测试独立强制清理）
- 公开 About 页识别、未登录不写假数据、四级兜底
- jsdom：品牌图标取 `icons/icon48.png`、圆环显示 100% / 今日任务、已删除模块、按钮位置、双语
- 自动任务调度与端到端随机搜索路径多次复测正常收尾

- **v2.2 注入层**：`test_sidebar_v22.js` **37 项全通过**（隔离作用域自包含、精确展开 `#id_rh_w`、iframe URL、任务链接指纹识别、已完成跳过、exclude、scroll/click 事件序列、iframe 坐标偏移、rewards 回退、登录页）
- **根因复现**：旧版 `scanSidebarTasks` 在隔离作用域抛 `ReferenceError: sidebarHeaders is not defined`，被 catch 吞成空数组

- **v2.3 任务列表链路**：`test_tasklist_v23.js` **48 项全通过**（真实保存页解析、\u0026 归一化、截断 URL 补全、URL 指纹一致性、按 URL 精确找 `<a>`、5 段事件 + 原生 click、文本/积分回退、task.list 反推、登录页识别）
- **端到端兜底**：`test_tasklist_integration.js` **19 项全通过**（mock 全部页面注入失败时，3 条真实任务仍各自打开新标签页、不关闭、每次点击都经 5s 调度；注入成功时不多开）

- **v2.4 卡片点击链路**：`test_cardclick_v24.js` **41 项全通过**（源码层确认无直接开页、找不到卡片时 0 开页并告警、找到卡片点击才成功、CDP 真鼠标、iframe frame 回注、点击失败重试后仍 0 开页、登录态硬失败、任务页不关闭、5s 调度）
- 解析/注入层回归：`test_tasklist_v23.js` 48 项、`test_sidebar_v22.js` 37 项全通过
- **旧断言已失效**：`test_tasklist_integration.js` 原用于验证"兜底开页有效"，v2.4 起转发到新测试

- **v2.5**：`test_human_v25.js` **56 项全通过**（源码层确认无 CDP / 无 fetch / 无直接开页；真实保存页 DOM 夹具上扫描 3 张、整页滚动、5 段鼠标事件 + 原生 click、idx 失效按 href 回退、已完成跳过、登录页识别、0 张时列出所有链接；后台两页流程端到端 3 次点击 / 5s 调度 / 任务页保留）

- **v2.6**：`test_real_mouse_v26.js` **39 项全通过**（源码断言、侧栏 Offer 识别、展开侧栏、按 offerIndex 点击、CDP 真鼠标优先 / 降级标注 / 找到即停）；独立脚本 `test_rewards_click_playwright.py` **9 项全通过**（真实鼠标序列、不用 element.click、flyout 优先、不 goto 任务链接）；历史四套回归共 182 项全通过

- **v2.7**：`test_aim_v27.js` **37 项全通过**（截图布局的矩形徽章卡识别、搜索进度卡排除、aim 实时坐标、布局下移 80px 后坐标自适应、按标题重定位、后台确实用 aim 新坐标而非 scan 旧坐标、扫描前先 attach）；历史六套回归 262 项 + Python 9 项全通过

- **v2.8**：`test_whitelist_v28.js` **41 项全通过**（混杂 6 张卡只留 3 张真任务；已完成/进度/推广/头部/超上限逐条带原因跳过；徽章布局独占不叠加；官方白名单 + 点后计分核验；官方标题为英文/内部 ID 时撤销过滤不清零）；历史七套回归 299 项 + Python 9 项全通过

- **v2.9**：`test_alldone_v29.js` **58 项全通过**（human/rewards/tasklist/sidebar 四种模式缓存 100% 均零动作、不写 running、零网络请求；官方接口全完成 / 有未完成 / 超时 / 401 /数据不足 / force 各分支；弹窗绿色小字文案与样式、render 覆盖保护、skippedCards 不再误判）；Python 新增 5 项全完成判定用例；历史八套回归 340 项全通过

**沙盒无真实浏览器，未做真机联网验证。** 官方接口能否读到你的登录态，只能在本机验证。 官方计分以服务端最终记录为准，沙盒无法替你验证到账。 真实计分结果只能在你本机已登录的浏览器里验证。 直接导航任务 URL 不计完成这一约束来自你的实测，沙盒无法替你验证计分结果。 侧栏 iframe 内容文件（`flyout.html`）未随保存页提供，
侧栏内部卡片结构以运行时 `dumpSidebar` 导出为准。

---

## 使用须知

1. 中文热搜词 + zh-CN 首页可能与 Rewards「PC 搜索」计分口径不一致。若 Rewards 侧栏是
   **浏览器内置侧边栏 UI（非网页 DOM）**，扩展注入与 CDP 都够不到；`dumpSidebar` 会显示
   `hasTrigger=false`，此时请把面板展开后的完整页面另存（含 `_files/flyout.html`）发来。连续 3 轮无积分增长会进入冷却等待；达到每日上限会提前停止。
2. 搜索期间扩展会持续把搜索标签页/浏览器窗口保持在焦点（防止后台节流暂停），会抢占你正在用的窗口；定时运行时尤其明显，可按需关闭 `KEEP_SEARCH_TAB_FOCUSED`。
3. 若 Rewards 侧栏属于**浏览器内置 UI**而非网页 DOM，扩展无法点击（见 v2.1「硬边界」）；此时只能用系统级自动化按屏幕坐标操作。
4. 自动化搜索可能不符合 Microsoft Rewards 服务条款：奖励搜索要求本人出于真实研究目的手动进行，机器人 / 宏产生的搜索不属于合格搜索，可能导致无法获得积分、积分作废或账户受限。本项目不伪装指纹、不使用代理、不绕过登录，风险由使用者自行承担，以官方要求为准。
