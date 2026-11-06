# 拟人搜索助手 v4.2

**纯浏览器扩展（Manifest V3，Edge / Chrome 116+）**。只做拟人搜索：
积分同步、Cookie、任务列表、自动完成任务、通知、趋势图表、设置页等全部放弃。

v4.2 按截图指认做了两件事：**变色对象明确为工具栏那个扩展图标、搜索进行中统一变红**；
以及把搜索方式改成**随机混合**，不新增任何选项。

---

## 1. 工具栏扩展图标：搜索中红，其它时间蓝

变色通过 `chrome.action.setIcon / setBadgeBackgroundColor / setTitle` 作用在
**浏览器工具栏的扩展图标**（你截图里那个蓝色圆角图标）上，不是弹窗里的装饰。

| 状态 | 工具栏图标 | 徽标 |
|---|---|---|
| 手动搜索进行中 | **红色**放大镜，4 帧动画 | `▶` 红底 |
| 定时自动搜索进行中 | **红色**放大镜（左下多一个白点），4 帧动画 | `●` 红底 |
| 空闲 / 已完成 / 出错 / 停止后 | **蓝色**（圆环 / 对勾 / 感叹号） | 无 / `✓` / `!` |

手动与自动都红，靠形状、徽标和弹窗胶囊「自动 ·」区分。

> **看不到变化？** 如果扩展没有固定到工具栏，图标藏在拼图（扩展）菜单里，动画不容易看见：
> 点右上角拼图 → 找到「拟人搜索助手」→ 点图钉**固定**，之后红/蓝变化会直接显示在工具栏。

---

## 2. 搜索方式：每轮随机混合，无额外选项

每轮独立掷两个骰子，组合出四种路径，整轮里混合出现：

| | 粘贴关键词 | 直接改词 |
|---|---|---|
| **回首页** | 回 Bing 首页 → 清空 → 输入热搜词 → 提交 | 先回首页 → 用相关延伸词直接换查询 URL |
| **留在结果页** | 留在 SERP → **清空搜索框** → 输入热搜词 → 提交 | 从当前页「相关搜索」取延伸词 → 直接换查询 URL |

具体落实：

- **粘贴关键词模式先清空搜索框**。真实输入走 `Ctrl+A` + `Backspace`（CDP `modifiers:2`），
  合成事件走 `value=""` + `input/change`。这是「搜索词不会越来越长」的根治点——
  上一轮的词残留在框里会被 `insertText` 拼接。
- **直接改词模式使用相关延伸搜索**，不走粘贴：
  1. 先从当前 Bing 结果页抓可见的「相关搜索 / 也有人搜」链接文本与 `href` 里的 `q=`；
  2. 抓不到（例如刚回首页）再查 Bing 官方 autosuggest 接口，按上一轮词取联想词；
  3. 两者都失败才回退到热搜词，日志标 `改词·热搜回退`，**绝不编造本地词库**。
  4. 拿到词后直接 `scope.navigate` 到 `bing.com/search?q=…`，不碰搜索框。
- **是否回到首页随机**（约 38%），提交方式也随机（回车 / 点搜索按钮），
  结果页滚动、按概率点结果、返回都保留。
- 全程**没有任何新增设置项或界面选项**：次数与定时点仍是仅有的两项可配置内容。
- 日志会标出每轮方式，例如
  `[3/12] 广州天气 预报 · 改词·相关延伸 · 留在结果页`，结束时汇总
  `方式混合：粘贴 7 / 改词 5 · 回首页 4 / 留在结果页 8`。

---

## 3. 定时自动启动（保留）

弹窗「定时启动」卡片：时间选择器加**若干个不同时间点**（最多 10 个，自动去重排序）、
标签 `×` 删除、右侧开关整体启停；没有时间点时开关自动失效。

- 一个**每分钟 tick alarm** 比对当前 `HH:MM`，浏览器重启/休眠/改时间点都能自恢复；
- 当天已触发的 `日期:时间点` 记在本地，同分钟不重复、跨天清空；
- 到点若已有搜索在运行就跳过，不并发；
- 定时启动走**后台标签页**，不抢当前焦点；手动点击仍是前台标签。

---

## 4. 点击「立即停止」立即生效

- **引擎**：每次运行一个 `AbortController`；`ENGINE_STOP` 到达立刻 `stopFlag=true` + `abort()`，
  所有等待监听 signal 立即 resolve，每个 `await` 后 `bail()`。
- **后台**：收到 RPC 同时 `scope.halt()`（打断导航等待）、`collector.halt()`（DOM 事件抛错）、
  `cdp.halt()`（detach + 拒绝所有 `Input.*`），随后立刻把工具栏图标复位为**蓝色空闲**
  并保留已完成轮数；`stopHandled` 防止延迟到达的「运行中」把图标重新点亮。

点停止后不会再有一次鼠标移动、键盘输入、导航或滚动。

---

## 5. 保留的拟人搜索能力

| 项 | 说明 |
|---|---|
| 热搜词 | 每轮从 **Bing 趋势 / 百度 / 微博 / 今日头条 / 知乎 / 新浪 RSS** 随机挑 2~4 个源抓取；**无本地词库**，全失败明确报错 |
| 相关延伸词 | 当前 SERP 的相关搜索链接 + Bing autosuggest，均失败才回退热搜词 |
| 搜索词长度 | 每轮词截断 30 字，不改写、不接会话链 |
| 起始页 | `https://www.bing.com/?mkt=zh-CN` |
| 节奏 | 时间预算、贝塞尔 + 最小急动度轨迹、1/f 粉红噪声、对数正态长尾、昼夜节律、阅读模型 |
| 输入 | `chrome.debugger` + CDP 真实鼠标/键盘；不可用时降级合成事件 |
| 单页面硬约束 | `assertScope` 校验所有导航/注入/CDP；MAIN world 守卫把 `window.open` 与 `target=_blank` 收敛回同一标签；无静态 `content_scripts` |
| 长跑 | offscreen document + 心跳，绕开 MV3 SW 30 秒空闲回收 |

固化参数：强度 3、轮内 16~29 秒、轮间 3~12 秒、结果点击 0.35、回车 0.5、滚动 1.2 屏。

---

## 6. 权限

| 权限 | 用途 |
|---|---|
| `storage` | 搜索次数、定时点、日志、当天已触发记录 |
| `alarms` | 每分钟 tick 定时启动 |
| `tabs` / `activeTab` / `scripting` / `webNavigation` | 唯一作用域标签页、搜索框定位、相关搜索词采集 |
| `debugger` | 真实键鼠输入（含 Ctrl+A 清空） |
| `offscreen` | 长跑引擎 |
| `https://*.bing.com/*` + 5 个热搜域 | 搜索页、官方 autosuggest 与 6 路真实热搜源 |

**已移除**：`cookies`、`notifications`，以及全部设置页与内容脚本。

---

## 7. 安装与使用

1. 解压 `dist/human-search-assistant.zip` → `edge://extensions` / `chrome://extensions` → 开发人员模式 → **加载已解压的扩展程序**。
2. 点右上角拼图 → 把「拟人搜索助手」**固定到工具栏**（否则看不到图标变色）。
3. 设置搜索次数 → 加若干定时点并打开开关（或直接「开始搜索」）。
4. 中途结束点「立即停止」，工具栏图标立刻回蓝。

CRX 为已签名 CRX3，需企业策略侧载，见 `BUILD.md`。扩展 ID：`ijpnnhkfkigngejokmcmgjiefncamoeh`。

---

## 8. 验证

```bash
node tests/selftest.mjs           # 31 项离线自检
node tests/import-smoke.mjs       # chrome mock 下真实导入 18 个模块
node build.mjs                    # 语法 / 导入 / 权限 / 架构硬约束 → ZIP → CRX3
node tests/verify-crx.mjs         # 独立验签、ZIP 一致性、扩展 ID、图标字节比对
```

`build.mjs` 强制检查：源码全局不得出现 `getuserinfo` / `parseDashboard` / `manualCookie` /
`chrome.cookies` / `chrome.notifications` / `runTasks` / `sync.run` / `putDaily` /
`FALLBACK_TERMS` / `SessionChain`；`chrome.alarms` 只允许在 `scheduler.js` 与 `service-worker.js`；
manifest 必须有 `alarms`、不得有 `cookies`/`notifications`/`options_ui`/`content_scripts`；
**`search` 与 `auto` 状态颜色必须为红、其余全部为蓝**，且变色必须调用 `chrome.action`；
粘贴前清空（`cdp.clearInput` 在 `cdp.insertText` 之前、真实按键 `Ctrl+A+Backspace`、
合成事件 `value=""` + input/change）、改词用 `collect.related` + `suggest.related` + `encodeURIComponent`、
四种方式都出现、不得出现 `relatedMode`/`homeRate` 之类设置项；
`util.sleep` 支持 AbortSignal；引擎含 `AbortController`/`abort()`/`bail()`；
后台 `stopEngine` 同步三处 `halt()` + `releaseScope()` + `finishState(IDLE)`。

自检用真实 `AbortController` 验证「5 秒等待在 20ms 后中断」，用可注入 fetch 验证联想词解析
（去重、过滤、排除自身、失败返回空），用可注入钟点验证定时只触发一次，并验证 halt 后
CDP `attach` 返回 false、`probe` 抛错、导航等待 <100ms 结束；验签还会比对
`search_f0` / `auto_f0` 确实都不是蓝色 `idle` 图标、且彼此字节不同。

**沙盒没有浏览器，未做真机联网验证。** 首次请看弹窗日志的 `schedule` / `keywords` /
`search_start` / `modes` / `stop` 行。

---

## 9. 使用须知

- 开启 CDP 真实输入时浏览器会显示「正在调试此浏览器」提示条；点停止会立刻 detach。
- 定时启动会静默开一个后台标签页，运行中工具栏图标变红。
- 热搜源与联想词都不可达时搜索明确报错或回退热搜词，不会用本地词库顶替。
- **自动化搜索可能不符合 Microsoft Rewards 服务条款**：奖励搜索要求本人出于真实研究目的手动进行，
  机器人/宏产生的搜索不属于合格搜索，可能导致无法获得积分、积分作废或账户受限。
  本项目不伪装指纹、不使用代理、不绕过登录、不代用户赚取积分；风险由使用者自行承担，以官方要求为准。
