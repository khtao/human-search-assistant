# 拟人搜索助手 v1.3.8 · 任务卡定位修复版（2026-11-09）

这是基于用户提供的完整 `human-search-assistant-main.zip` 修复的**源码项目**，同时包含 Edge 浏览器插件和 Electron Windows/Ubuntu 桌面版。没有打包成已编译 `.exe`。

## 改动

- 浏览器插件：保留同步阶段任务定位索引，但点击时补充逐段滚动 DOM 扫描。对于索引缺失的卡片，加入实时列表，按 URL/任务身份去重，避免只点同步索引中的部分任务。
- 浏览器插件：找不到卡片时，尝试从顶部到末端扫描主页面和 overflow 内层滚动区；使用当前 DOM 坐标与遮挡校验，禁止按旧序号盲点。依然仅使用 Chrome DevTools Protocol 鼠标事件。
- 桌面版：将实时可识别的 `+N` 任务卡与同步索引合并，补全漏项；针对每张任务执行外层与内层滚动查找，避免固定 6 次向下滚动导致漏点。
- 两端都继续检查卡片的 URL / 标识 / 标题 / 积分，找不到或被遮挡时跳过，不将无效点击算作成功。
- Windows `electron-builder.win.yml`：修正 `win.signingHashAlgorithms` 至 `win.signtoolOptions.signingHashAlgorithms`，兼容已锁定的 electron-builder 26.18.1。
- 新增 `npm run verify:repair`，测试动态滚动回找、重复任务去重和 DOM 实时发现；旧测试中与“只依赖索引、不得重新扫描”冲突的断言已更新为新预期。

## Windows CMD 编译桌面版

安装 Node.js 22.12.0+，解压项目后在 CMD 中运行（注意修改为自己的路径）：

```cmd
cd /d C:\Users\86155\Downloads\human-search-assistant-main\desktop-app
npm run ci
npm run doctor
npm run verify
npm run dist:win
```

生成的安装版 / 便携版位于 `desktop-app\dist`。`npm run ci` 是安装依赖，不是打包。

## Edge 浏览器插件

打开 `edge://extensions` → 开启「开发者模式」→「加载解压缩的扩展」→ 选择项目目录下的 `edge-extension`。已经加载过旧版时要点击扩展的刷新按钮。

## 验证说明与限制

- 已对关键 JS 文件执行 `node --check`，运行项目回归测试和新增的无网络单元测试。
- **没有在登录的 Microsoft Rewards 真实页面上完成全任务端到端点击验证**，页面结构、地域活动、动态渲染和权限可能仍导致个别卡片无法定位；点击命令成功也不等于积分已经到账。
- 实时扫描优先识别带稳定链接/身份和可见积分信息的卡片；没有安全身份或 DOM 未加载的卡片将跳过，而非点击可能错误的目标。
- 原始用户上传项目中的测试样例文件及全部源码结构保留；不包含依赖安装目录或 Windows 编译产物。
