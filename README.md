# Human Search Assistant v1.3.8

This source bundle contains both the Electron desktop application and the Edge/Chromium browser extension.

## What changed in v1.3.8

- **Points earning calendar** (Settings): a calendar-style grid showing only the points earned per cell, with no date numbers. Switch between Day / Week / Month aggregation; history is recorded on every points sync (`pointsHistory`, keyed by local date).
- **Language order**: 中文 → English → 跟随系统 (Chinese → English → System) on both platforms.
- **Detailed progress text** reuses the existing status line below the ring (no new text box): one concise but informative bilingual line — sync progress + which pages, today/available points, page/card name and index, next action, search index + keyword, plus a live **countdown** for delayed actions. Long lines ellipsize and reveal the full text on hover. Written as `activityDetail` with an `until` timestamp.
- **Desktop-only options** (off by default, shown only in the desktop settings): launch at login and silent task completion. Silent mode hides page views only; the sync / click / search flow and all progress details are identical to a normal run. The extension does not show this group.
- **Calendar (Alipay-style earnings calendar)**: a large period-total figure on top, then flat rounded-square cells — past days without points are light grey, future days show no cell, days with points are light blue, today gets a thin ring. Cells show points only; the date and details appear on hover.
- **No inline hints in settings**: all explanatory small print was moved to a lightweight custom hover tooltip (bilingual, follows language switches) instead of the native black title box.

Historical v1.3.7 notes follow.

## What changed in v1.3.7

The Rewards synchronization pass now builds a `taskClickIndex` from the same Dashboard and Earn page responses used for points and task-list parsing. The index stores task identity, page, href, target, and stable DOM attributes (for example `data-bi-id`, `data-offer-id`, `id`, and `aria-label`); it never stores stale coordinates or DOM references.

Automatic clicking consumes that index directly. It no longer performs a second full-page card scan. Before each click it resolves the indexed task in the current DOM, recomputes the live rectangle, verifies the hit-test point, and sends Chromium CDP mouse input (`mouseMoved` → `mousePressed` → `mouseReleased`). A small bounded scroll/retry is used only when the indexed card is not currently rendered. DOM `.click()`, synthetic mouse events, and direct URL opening are not used as substitutes.

Click dispatch, task-page response, and points credit remain separate statuses. An index older than 30 minutes is rejected; automatic runs refresh it before clicking.

See [CHANGELOG_V1.3.8.md](CHANGELOG_V1.3.8.md) for the v1.3.8 upgrade details, and [TASK_CLICK_INDEX_V1.3.7.md](TASK_CLICK_INDEX_V1.3.7.md) / [CHANGELOG_V1.3.7.md](CHANGELOG_V1.3.7.md) for the previous release.

## Browser extension

1. Extract the archive.
2. Open `edge://extensions` or `chrome://extensions`.
3. Enable Developer mode.
4. Select **Load unpacked** and choose `edge-extension/`.

The extension requires the `debugger` permission for CDP mouse input.

## Ubuntu desktop application

See `desktop-app/README.md`. On Ubuntu/Debian x86_64, install the system build tools and run from `desktop-app/`:

```bash
sudo apt install -y build-essential dpkg-dev fakeroot
npm run build:linux
```

The DEB build itself should be performed on the target Ubuntu/Debian system. This delivery contains source code and verification scripts, not a prebuilt `.deb`.

## Verification

From `desktop-app/`:

```bash
npm run verify
```

<<<<<<< HEAD
The default suite includes the original regression checks, the CDP mouse-click checks, 38 task-index checks, 50 v1.3.7 stability/parity checks, and 166 v1.3.8 upgrade checks. The full suite passed 710 checks with zero failures in the build container.
=======
## 🚀 三分钟开始

1. **解压** 发布包到任意文件夹（请保留 `icons/` 目录）。
2. 打开 `chrome://extensions` → 右上角开启「开发者模式」 → 「加载已解压的扩展程序」 → 选择该文件夹。
3. 在浏览器里**登录你的 Microsoft Rewards 账户**（这一步只能你来，工具不会也不能代登）。
4. 点开扩展图标，按一下「自动完成任务」。

> 想改设置：点右上角齿轮。想立刻看最新状态：点「今日任务 → 刷新」。
> 定时运行需要同时打开设置里的「定时自动运行」总开关。

**环境**：Chrome / Edge 116+，Windows、macOS 或带图形桌面的 Linux。实际可用性取决于浏览器版本、网络环境与第三方页面结构。

---

## 🔍 按一下按钮，究竟发生了什么

固定顺序，**同步永远在最前面**：

1. **先同步状态**（只读，不打开任何页面）
   本地今日状态 → 官方任务接口 → 必要时复用你**已经打开**的 Bing / Rewards 标签页再读一次 → 仍拿不到才做一次完整的页面状态同步。
2. **判定全完成**
   搜索配额 + 每日任务 + 更多活动全部完成，且数据完整可信 → **零动作返回**，弹窗显示绿色小字。数据不全、未登录、超时，一律当作「还有任务」，绝不因为拿不到信息就跳过。
3. **确实还有任务时**，才进入执行阶段：打开侧边栏 → 逐张滚动并点击待完成卡片（相邻点击间隔默认 10 秒（可在设置中调整 1–60 秒），弹出的任务标签页保留不关闭）→ 按剩余分数执行搜索（搜索页保持焦点、结束关闭）。
4. **收尾**：把焦点还给你运行前所在的标签页，再同步一次状态，刷新进度环。

手动按钮和定时触发走的是同一条流程，所以"做完了不打扰"对两者都成立。

控制台会打印同步来源、每张卡片的识别与瞄准坐标、跳过原因，以及官方是否确认计分——出问题时一眼能定位。

---

## ⚙️ 设置与定时

- **定时自动运行**：总开关 + 最多 10 个本地时间点，到点在后台执行同一套「先同步再动手」流程。
- **启动时间**：留空直接点「添加」时，第一个时间点默认为当地时间 08:00，之后在当前最晚时间点上顺延 30 分钟；手动填写 HH:MM 则以输入为准，自动去重排序。
- **运行强度**：1–3 档，影响搜索用词与节奏。
- **等待 Bing 冷却**：默认开启。每轮搜索后都会核对官方搜索计分进度与可用余额；一旦连续多轮积分不再增长（或官方进度持续读不到），就暂停并等待设定时长（10 / 15 / 20 分钟）后自动继续，弹窗圆环下方显示剩余倒计时。最多等待 6 次，仍无增长则提前结束并明确提示，不再空跑。关闭该开关后不进入等待。
- **主题 / 语言**：浅色、深色；语言可选中文、English 或跟随系统（默认，按浏览器/系统语言自动判定），也可在「恢复默认设置」中复位。

---

## 🔒 数据只留在本机

- 配置、积分历史、任务状态与运行日志都保存在浏览器本地存储，**不会上传到任何服务器**。
- 工具会直接访问 Microsoft / Bing 的页面或接口；这些请求受目标网站自身的隐私政策约束。
- **登录态与 Cookie 属于敏感会话凭证**：请勿分享给他人、粘贴到 Issue、放进截图或提交到公开仓库；如曾泄露，请在对应服务退出会话或重新登录，使旧凭证失效。
- 分享日志前，请先移除其中任何身份或会话信息。

---

## ⚠️ 使用前请务必读完：合规与使用风险

**本项目是独立开发、非官方的个人辅助工具**，不是 Microsoft 产品，未经 Microsoft 授权、赞助、认证或认可，也不代表 Microsoft。文中提及的 Microsoft、Bing、Microsoft Edge 与 Microsoft Rewards，仅用于说明所涉及的第三方服务及兼容环境；相关商标归各自权利人所有。

**请优先使用人工操作。** Microsoft Rewards 的适用条款对奖励搜索有明确限制：奖励搜索须为**用户本人出于真实研究目的手动进行**的搜索；由机器人、宏、脚本或其他自动化方式产生的搜索**不属于合格搜索**。Microsoft 亦明确建议不要使用程序、机器人或宏辅助 Rewards 搜索。

因此，请务必了解并接受：

- **请勿依赖本工具的自动化功能获取积分。** 使用自动化功能可能导致**无法获得积分、积分作废或账户受限**，相应后果由使用者自行承担；以人工操作和官方要求为准。
- 工具提供的任务卡片点击与搜索执行能力，仅用于本地查看、整理与减少重复操作，**是否使用、何时使用由你自行判断**，部分操作需要你进一步参与。
- **自动点击活动卡片不等于完成活动，也不保证获得积分。** 某些活动需要答题、领取或其他实际互动；进度及积分**一律以服务端最终记录为准**。
- 页面结构、第三方接口或服务规则变化后，部分功能可能失效；不要依赖它作为任务完成的唯一依据。
- 本说明仅用于提示已知风险，**不构成法律意见**，也不保证本项目或任何特定使用方式合规。在公开发布、分发二进制包或投入实际使用前，请自行核实适用服务条款及当地法律。

建议自行查阅（以官方最新文本为准）：**Microsoft 服务协议**、**Microsoft Rewards 搜索限制说明**、**Microsoft 商标与品牌使用规范**。

> 如果你只是想看今日进度，本工具完全可以当作一个纯本地看板使用，不启用任何自动化能力。

---

## 🧩 常见问题

**装好第一次点按钮，还是会打开页面？**
现在每次执行都会先同步状态再判定。若同步确实拿不到（未登录、接口不可用或数据不全），工具会按页面真实状态继续，并在控制台打印同步来源与原因。请先在浏览器里登录 Rewards 再试。

**全部做完了，点按钮会怎样？**
零动作：不开侧边栏、不点卡片、不搜索、不写运行状态；进度环下方显示绿色小字「任务已完成，无需任何动作」。想强制重跑，可在控制台带 `force` 参数调用。

**积分显示「—」或出现登录页？**
后台只读抓取没有拿到登录态。先在浏览器标签页里登录 Rewards，再点「今日任务 → 刷新」。自动化无法替你登录。

**为什么有些卡片没被点？**
已完成、0 分、搜索进度、连续打卡、兑换入口、更多活动推广卡都会跳过，控制台逐条打印标题、积分和跳过原因。这是刻意的：只点给分且未完成的任务。

**点了卡片却没涨分？**
点击成功不等于完成。工具会在点击后核对服务端状态，未确认时明确标注「可能需要答题 / 进一步互动」。请以 Rewards 页面或官方记录为准。

---

## 📮 反馈与权利说明

问题与建议欢迎通过仓库 Issue 反馈；**切勿公开账户 Cookie、密码、令牌或个人浏览记录**。

本工具为个人自用 / 学习交流用途，未随附项目级开源许可证；公开或分享代码不自动授予复制、修改、再分发等权利。所依赖的第三方组件，其许可协议各自独立适用。

自动化测试覆盖状态同步、全完成零动作、卡片白名单、点击坐标与回归流程；但**单元测试不能替代真实浏览器、登录环境与第三方页面上的端到端验证**。

---

*Human Search Assistant v1.0 · 非官方工具 · 以官方要求为准*


## v1.3.8 R3：CDP 滚动、点击间隔与积分日历

两端默认任务卡片点击间隔为 **10 秒**，在设置中可调整为 **1–60 秒**。Edge 插件先尝试 CDP，再执行完整页面及内部滚动扫描；无法建立 CDP 会话时仍扫描但不执行合成点击。周/月积分日历已更新，无积分的相邻周期导航以灰色显示。详细说明见 `修复说明-R3-CDP滚动-间隔-日历.md`。
>>>>>>> fb5efdd15db37cf18e87c9be2597e688bc7a03cf
