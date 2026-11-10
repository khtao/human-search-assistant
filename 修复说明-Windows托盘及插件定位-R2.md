# v1.3.8-R2：Windows 托盘与 Edge 插件任务卡片定位修复

本源码包基于用户提供的 v1.3.8 Windows 本地 Electron 打包修复版。保留 Windows `electronDist: node_modules/electron/dist`，以及上次桌面任务点击定位补丁。

## 修复内容

1. **Windows 托盘**：`desktop-app/electron-builder.win.yml` 现在同时打包 `build/icon.ico` 和 `build/icon.png`。`main.js` 在 Windows 下优先使用外部 `resources/tray-icons/icon.ico`；失败时改用 PNG，再回退到源码目录 `build/`。托盘双击/单击可恢复窗口；最小化窗口先还原。托盘无法建立时，关闭 X 会退出程序，而不是让窗口隐藏后无法找回。
2. **Edge 卡片识别**：`edge-extension/background.js` 不再只用 `+10` 格式识别卡片，还识别积分徽章中的 `10`，特定任务链接中未带加号的数字、`data-offer-id`/`data-bi-id`/按钮和 `cursor:pointer` 卡片。跳过不可见/完成卡片遵循设置。
3. **定位与安全**：浏览器端以链接或 offer ID 作为优先身份，支持同名同积分但 ID 不同的任务；重读实时视口坐标，跳过重名歧义与被遮挡的卡片，保留 CDP 鼠标事件，不退回 DOM 合成点击。
4. **动态页面**：两页按外部/内部滚动容器逐段收集；点击最后一张计划任务后会补扫一次，发现新渲染任务再继续处理。

## CMD 构建（Windows 10/11）

进入解压后的 `desktop-app` 目录：

```cmd
cd /d C:\Users\86155\Downloads\human-search-assistant-main\desktop-app
npm run ci
npm run doctor
npm run verify
build-win-local.cmd
```

如果已经安装过相同 Electron 版本，且 `npm run doctor` 全部通过，可跳过 `npm run ci`，直接运行 `build-win-local.cmd`。EXE 输出位于 `desktop-app\dist\`。

## Edge 插件安装

访问 `edge://extensions/`，打开“开发人员模式”，选择“加载解压缩的扩展”，选择完整包内的 `edge-extension` 文件夹。之前安装过旧版时，请先重新加载插件（如无效果可禁用/移除旧版，避免两份同时运行）。

## 测试及边界

- `npm run verify`：运行项目内置回归及 R2 Node 测试，R2 覆盖托盘资源/初始化回退和同名任务身份去重。
- `python scripts/verify-r2-browser.py`：**可选**，需安装 Python Playwright 和 Chromium；在离线模拟 Rewards 卡片页面验证定位及可点击性。
- 当前环境完成了语法检查和模拟 Chromium 页面测试，但未在用户 Windows 托盘通知区域或真实 Microsoft Rewards 登录页面进行端到端验证。新卡片可能因地区、账号、页面结构不同而表现不同；“发送 CDP 鼠标事件”也不等于官方已经给任务计分。

本次仅在原有项目基础上修复特定问题，未加入第三方运行时依赖，也没有修改用于同步积分的桌面后台源码。
