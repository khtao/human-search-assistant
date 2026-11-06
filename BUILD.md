# 构建与部署

## 环境

- Node.js >= 18、系统 `zip` 与 `unzip` 命令
- Python 3 + Pillow（**仅在重新生成图标时需要**）

## 完整流程

```bash
cd ms-rewards-assistant-v3
python3 tools/make_icons.py       # 3 静态 + 手动/自动各 4 帧 × 4 尺寸 = 44 个 PNG（可选）
node tests/selftest.mjs           # 31 项离线自检
node tests/import-smoke.mjs       # chrome mock 下真实导入 18 个模块
node build.mjs                    # 校验 → ZIP → CRX3 签名
node tests/verify-crx.mjs         # 独立验签 + ZIP 一致性 + 扩展 ID + 红蓝图标字节比对
```

`npm test` 等价于依次跑三个测试脚本（需先 `node build.mjs`）。

`build.mjs` 的检查项：

1. 所有 `.js/.mjs` 的 `node --check` 语法校验；
2. 所有相对 import 路径存在；
3. **manifest**：MV3、禁止 `options_ui`、禁止 `content_scripts`；必需权限 `storage/alarms/tabs/activeTab/scripting/webNavigation/debugger/offscreen`；禁止 `cookies/notifications/proxy/downloads/history/bookmarks/webRequestBlocking`；`host_permissions` 必须且只能是 Bing + 5 个热搜域白名单；
4. **架构裁剪**：`src/` 下任何 JS 都不得出现 `getuserinfo`、`parseDashboard`、`manualCookie`、`chrome.cookies`、`chrome.notifications`、`runTasks`、`sync.run`、`putDaily`、`FALLBACK_TERMS`、`SessionChain`；`chrome.alarms` 只允许出现在 `scheduler.js` 与 `service-worker.js`；`src/options/` 与 `src/content/` 必须不存在；
5. **搜索次数可设置**：`settings.js` 必须含 `normalizeRepeat` / `MIN_ROUNDS=1` / `MAX_ROUNDS=60` / 默认 12，且不得把 `repeat` 强制覆盖为默认值；弹窗必须有 `repeat`、`btnStart`、`btnStop` 与对应 RPC；
6. **定时启动**：`settings.js` 含 `normalizeTimes` / `MAX_TIMES=10` / `autoRunEnabled` / `autoRunTimes`；`scheduler.js` 含 tick alarm、`getFired`/`markFired`、`BUSY_STATES`；后台接入 `onAlarm` 与 `rebuild()`；引擎按 `params.auto` 区分状态并让定时启动用后台标签页；弹窗含 `autoEnabled`/`timeInput`/`btnAddTime`/`timeList`；
7. **工具栏图标配色**：直接 import `messages.js` 断言 `search` 与 `auto` 为红、其余全部为蓝；`auto` 用独立的 `auto_f*` 动画帧；`iconPaths(auto, 2)["16"] === "icons/auto_f2_16.png"`；`state.js` 必须调用 `chrome.action.setIcon` 与 `setBadgeBackgroundColor`（变色对象是工具栏扩展图标）；
8. **混合随机搜索方式**：引擎每轮 `rng.bool(0.38)`（是否回首页）× `rng.bool(0.42)`（粘贴/改词）；粘贴路径 `cdp.clearInput` 必须出现在 `cdp.insertText` 之前，`cdp.js` 用 `Ctrl+A + Backspace`、`collector.js` 用 `value=""` + input/change；改词路径必须调用 `collect.related` 与 `suggest.related` 并用 `searchUrl` 直接换查询 URL；`suggest.js` 必须指向官方 autosuggest 且失败可降级；不得出现 `relatedMode`/`homeRate` 等新设置项；
9. **随机热搜**：`keywords.js` 含 `HOT_SOURCES` 与随机挑源、不含本地词库；起始页必须是 Bing 搜索官网；查询改写与会话链必须关闭；
10. **立即停止**：`util.sleep` 支持 AbortSignal；引擎含 `AbortController` / `controller?.abort()` / `signal` / `bail()`；后台 `stopEngine` 同步 `scope.halt()`、`collector.halt()`、`cdp.halt()`、`releaseScope()`、`finishState(STATE.IDLE)`；`cdp.js` 在 halted 时拒绝所有命令；
11. **SW 约束**：`src/background/*.js` 不得含动态 `import()`（w3c/ServiceWorker#1356）；
12. manifest 引用资源、popup / offscreen 页面、调度与联想词模块、以及用到的 44 个状态图标；
13. ZIP（排除 `dist/`、`*.pem`、`tests/`、`tools/`）；
14. CRX3 签名与 `dist/extension-id.txt`。

`dist/key.pem` 首次构建自动生成，**不会进入 ZIP / CRX**；保留它可固定扩展 ID。

## 产物

| 文件 | 用途 |
|---|---|
| `dist/human-search-assistant.zip` | 解压后「加载已解压的扩展程序」，日常安装方式 |
| `dist/human-search-assistant.crx` | 已签名 CRX3，企业策略侧载 / 自建分发 |
| `dist/extension-id.txt` | 扩展 ID（`ijpnnhkfkigngejokmcmgjiefncamoeh`） |

## CRX 侧载（可选）

**Windows**（`HKLM\SOFTWARE\Policies\Microsoft\Edge\Extensions`）
```
<扩展ID> = "https://你的内网/human-search-assistant.crx"
```
并在 `ExtensionInstallSources` 里放行该来源（Chrome 用 `HKLM\SOFTWARE\Policies\Google\Chrome\...` 对应键）。

**Linux**（`/etc/opt/edge/policies/managed/search.json`）
```json
{
  "ExtensionInstallForcelist": ["<扩展ID>;https://你的内网/human-search-assistant.crx"],
  "ExtensionInstallSources": ["https://你的内网/*"]
}
```

个人使用无需这一步。

## 图标配色规则

`tools/make_icons.py` 里 `BLUE = #2f6fed`、`RED = #e03131`：

- `idle` / `done` / `error` → 蓝色底，形状不同（圆环 / 对勾 / 感叹号）；
- `search_f0..3` → **红色**放大镜，手动搜索时 4 帧动画；
- `auto_f0..3` → **红色**放大镜 + 左下白点，定时自动搜索时 4 帧动画。

即：**搜索进行中一律红，其它任何时间一律蓝**。手动/自动靠白点、徽标（`▶` / `●`）与弹窗胶囊区分。

`src/lib/messages.js` 的 `STATE_META` 决定状态→图标与徽标颜色，必须与生成脚本一致；构建脚本会两边对照校验，验签脚本还会比对三份图标字节（`search_f0` / `auto_f0` 都不得等于蓝色 `idle`，且彼此不等）。改配色后重新跑 `python3 tools/make_icons.py`。

变色由 `state.js` 调用 `chrome.action.setIcon` 落在工具栏扩展图标上；若扩展没被固定到工具栏，用户看不到实时变化，需在拼图菜单里点图钉固定。

## 开发调试

- 改代码后在 `edge://extensions` 点「重新加载」；SW 日志在「检查视图 → service worker」，引擎日志在 offscreen 页面。
- 弹窗日志区显示最近 8 条；也可在 SW 控制台看 `chrome.storage.local` 的 `logs`。
- 定时调试：把 `scheduler.handleAlarm()` 的 `deps.now` 注入固定 `HH:MM` 即可离线复现，不必等真实钟点；`chrome.storage.local` 的 `fired` 记录当天已触发点，删掉它可手动重放。
- 作用域标签页 id 存在 `runState.scopeTabId`；运行中该页工具栏图标会有徽标与 4 帧动画。
- 新增 RPC：在 `src/background/service-worker.js` 的 `OPS` 表注册，调用方统一走 `src/lib/rpc.js` 的 `call()`；任何涉及标签页的操作先 `scope.assertScope(tabId)`。
- 调固化参数：直接改 `src/lib/settings.js` 的 `DEFAULT_SETTINGS`，**不要重新引入设置页**。
- 改停止逻辑时务必同时改三层：引擎 `AbortController`、后台 `stopEngine` 硬闸、以及 `cdp/collector/scope` 的 `halt()`。自检会验证中断耗时 < 300ms。

## 目录约定

```
manifest.json
package.json
build.mjs
icons/{idle,done,error}_{16,32,48,128}.png
icons/{search,auto}_f{0..3}_{16,32,48,128}.png
src/lib/util.js                Rng / 可中断 sleep / clamp / hhmm
src/lib/settings.js            搜索次数 + 定时点（仅两项可设置）与固化参数
src/lib/messages.js            消息协议、5 个运行状态、红蓝配色
src/lib/keywords.js            6 路真实热搜源随机抓取
src/lib/queries.js             查询质量统计（无改写/无会话链）
src/lib/human.js               贝塞尔轨迹 / 粘贴节奏 / 滚动计划
src/lib/entropy.js             1/f 噪声 / 昼夜节律
src/lib/budget.js              可中断的轮内时间预算
src/lib/rpc.js                 RPC 封装
src/background/store.js        storage 封装（含当天已触发记录）
src/background/state.js        图标 / 徽标 / 状态广播
src/background/scheduler.js    每分钟 tick 定时启动
src/background/suggest.js      Bing 官方 autosuggest 相关延伸词
src/background/scope.js        单标签作用域 + halt() 中断导航
src/background/collector.js    搜索框定位 / 清空 / 相关搜索词 / DOM 合成事件
src/background/cdp.js          真实键鼠输入（含 Ctrl+A 清空）+ halt() 硬闸
src/background/service-worker.js  RPC 入口、定时接入与立即停止
src/offscreen/offscreen.js      长跑引擎：只做拟人搜索
src/offscreen/offscreen.html
src/popup/{popup.html,popup.css,popup.js}
tests/{selftest.mjs,import-smoke.mjs,verify-crx.mjs}
tools/make_icons.py
dist/                          构建产物，不参与打包
```

**没有 `src/options/`、没有 `src/content/`、没有同步与 Cookie 相关文件。**
