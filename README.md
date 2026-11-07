# Rewards 页面读取示例（只读 · 教学用途）

> 把 Microsoft Rewards 页面上**已经显示给你自己看**的积分和任务，解析成结构化数据。
> 一个离线单文件博客 + 一份零依赖解析函数。**本仓库不包含任何自动化功能。**

[English disclaimer](#english-disclaimer) · [合规与免责](#合规与免责重要) · [快速开始](#快速开始)

---

## 这是什么

一个用来**理解页面结构**的小项目：Rewards 的 `/dashboard` 与 `/earn` 两个页面把积分和任务直接写在 HTML 里，本项目演示如何把它们读成三个数字和一张任务表。

| 读到什么 | 来自哪个页面 | 识别方式 |
|---|---|---|
| 可用积分、可领取 | `/dashboard`（`/earn` 也有） | 积分卡上「标签 → 相邻数值」配对 |
| 今日积分 | `/earn` | 同上 |
| 今日任务列表 | 两个页面合并 | 带 `bg-statusSuccessRewardsBg` 绿色积分徽章的卡片 |

入口是 [`index.html`](./index.html)：单文件、离线、打开即自动跑出示例结果。内含 3 张内联 SVG 示意图（数据流向、积分卡解剖、任务卡筛选）、一份可折叠的完整源码，以及两个可运行的示例。

---

## 仓库内容

| 文件 | 说明 |
|---|---|
| `index.html` | 图文博客 + 可运行示例（内置快照 + 实时抓取脚本，脚本在页面内一键复制） |
| `README.md` | 本文件 |

- 内置的示例页面快照按真实结构裁剪并**匿名化**，不含姓名、邮箱、账户 ID 或真实会话数据。
- **不单独分发、不预编译任何浏览器扩展**；`index.html` 里附的 `manifest.json` 仅是一段用于说明权限模型的片段。
- 全文无外部脚本、样式、图片、字体或 CDN，可完全离线打开。

---

## 快速开始

**1. 看结果（离线，推荐先试这个）**

直接双击 `index.html`，或用浏览器打开。页面加载时会自动运行内置示例，显示：

```
可用积分 19,925   今日积分 100   可领取 0
今日任务 100%（110 / 110 分）  ·  搜索 60 / 每日活动 30 / 日常任务 20
```

**2. 实时读取自己的页面（可选，需手动操作）**

1. 在自己的浏览器里登录 `rewards.bing.com`；
2. 打开任意 Rewards 页面，按 F12 进入 Console；
3. 在博客第 ④ 节点「复制实时抓取脚本」，粘贴到 Console 并回车；
4. 结果以 `console.table` 输出。

脚本只做一次 `fetch('/dashboard')` + `fetch('/earn')`，由你**手动单次触发**，不含循环、定时器或后台常驻逻辑。普通第三方网页因浏览器同源策略与登录态要求无法完成这一步，这也是不在托管页面上直接发起请求的原因。

**3. 放进扩展（可选）**

博客第 ④ 节附了最小的 MV3 `manifest.json` 片段。把 `buildReport(dashHtml, earnHtml)` 复制到 background，用带登录态的 `fetch` 拿到两个页面的 HTML 即可；同样建议仅手动单次触发。

---

## 明确不是什么（请先读这一段）

- ❌ **不是**刷分工具、积分加速器、任务自动完成脚本或「助手」类扩展。
- ❌ 不自动发起搜索、不模拟鼠标/键盘、不点击任务卡、不提交任何表单或答题。
- ❌ 不绕过登录、验证码、访问控制或浏览器同源策略；不使用代理、不伪造 UA / 指纹、不处理他人 Cookie 或 Token。
- ❌ 不使用私有接口、不逆向 undocumented API、不提供接口文档或账号数据。
- ❌ 不批量请求、不定时轮询、不后台常驻、不托管服务、不收集或上传任何数据。
- ❌ 不预编译、不分发可安装的扩展包。

本项目唯一做的事情，是**读取使用者本人已登录页面上已经渲染出来的文本与数字**，并在本地做字符串解析。任何超出「单次、手动、本地、只读」范围的使用方式都不属于本项目的设计意图，也不在本项目支持范围内。

---

## 数据与隐私

- 全部计算在浏览器本地完成；**无网络上传、无遥测、无后端、无第三方资源**。
- 实时脚本只请求 `rewards.bing.com` 下两个页面，响应仅用于本地解析，不落盘、不外发。
- 内置示例为匿名化快照；仓库内不含任何真实账户信息。
- 不使用 `localStorage` / `chrome.storage` 持久化任何账户数据（本仓库示例不写入存储）。

---

## 合规与免责（重要）

1. **非官方、无关联。** 本项目是独立的个人教学示例，与 Microsoft Corporation 及其关联方没有任何隶属、授权、 endorsement 或合作关系。`Microsoft`、`Bing`、`Microsoft Rewards` 及相关标识是 Microsoft 的商标或注册商标，此处仅用于描述所讨论的页面，不表示任何关联； trademark rights remain with their respective owners。

2. **使用前请自行查阅官方条款。** 请阅读并遵守 [Microsoft 服务条款](https://www.microsoft.com/servicesagreement)、Microsoft Rewards 的条款与常见问题，以及适用法律法规与隐私政策。**若这些条款禁止任何形式的自动化访问、页面抓取或结构化读取，请不要使用本项目。**

3. **奖励活动有真实操作要求。** Rewards 的搜索与任务奖励通常要求账户本人出于真实目的手动完成。自动化搜索、模拟点击任务卡、批量或高频请求可能不符合条款，并可能导致积分不予计入、已获积分作废、账户功能受限或其他后果。**本项目不包含上述功能，也不提供相关实现、配置或操作指导。**

4. **使用范围。** 仅限读取**本人已登录账户**页面上已显示的信息，用于个人学习与界面理解。不得用于他人账户、共享账户、代操作、商业服务、监控或对账等用途。

5. **结果不保证准确或完整。** 页面结构、文案、CSS 类名与渲染方式随时可能变更；解析结果可能过时、缺项或错误。本项目输出**不得**作为账务核对、申诉、交易、统计上报、财务或任何需要准确性场景的依据。示例中的数值仅用于说明解析逻辑。

6. **按「现状」提供。** 本仓库内容以 "AS IS" 提供，不提供任何明示或默示担保，包括但不限于适销性、特定用途适用性与不侵权担保。作者及贡献者不对任何直接、间接、附带、特殊或后果性损失承担责任，亦不对第三方网站变更造成的损失负责。

7. **不构成法律建议。** 本文不是法律意见，也不能替代你对自身使用场景的合规判断。如有疑问，请咨询专业法律顾问并以官方最新条款为准。

8. **Fork 与二次分发。** 若你在自己的分支中加入了自动化、批量、定时或任何任务操作能力，请勿继续使用本仓库名称、本 README 或 Microsoft 相关标识来暗示与本项目或 Microsoft 的关联；该分支的合规判断与全部责任由你自行承担。

---

## English Disclaimer

> **Summary — please read the full [合规与免责](#合规与免责重要) section above, which governs.**

This repository is an **independent, read-only, educational example** showing how numbers and task labels already displayed on a user's own signed-in Microsoft Rewards pages can be parsed into structured data. It is **not affiliated with, endorsed by, or sponsored by Microsoft Corporation**. `Microsoft`, `Bing` and `Microsoft Rewards` are trademarks of Microsoft; all rights remain with their respective owners.

It is **not** a points-earning tool, automation script, task completer, or distributed browser extension. It does **not** automate searches, simulate mouse/keyboard input, click task cards, bypass sign-in or access controls, use proxies, forge fingerprints, access undocumented APIs, run on a schedule, or transmit data anywhere. All computation happens locally in the browser; the optional live snippet is triggered **once, manually, by the user**.

Before using it, read and comply with the Microsoft Services Agreement, the Microsoft Rewards terms, and applicable law. **If those terms prohibit automated access, scraping, or structured reading of the pages, do not use this project.** Rewards activities generally require genuine manual participation by the account holder; automating searches or tasks may violate the terms and may result in forfeited points or account restrictions. This repository contains no such functionality and provides no guidance for building it.

The output is provided **AS IS**, without warranty of any kind, may be inaccurate or outdated as page markup changes, and must not be relied upon for accounting, disputes, transactions, or any decision-making. The authors assume no liability for any damages arising from its use. Nothing here is legal advice. Forks that add automation must not imply affiliation with this project or with Microsoft and bear full responsibility for their own compliance.

---

## License

本仓库原创的示例代码与文档以 **MIT License** 授权；上述免责声明与合规限制同样适用。第三方商标、页面内容与数据归各自权利人所有，不在授权范围内。

Copyright (c) 2026 Contributors to this repository.
