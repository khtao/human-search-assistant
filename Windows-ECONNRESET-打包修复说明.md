# Windows ECONNRESET 打包修复说明

适用于 Electron 45.2.3 / electron-builder 26.18.1 的本项目。

## 错误原因

如果执行 `npm run dist:win` 时，在 `packaging platform=win32` 和下载 Electron 进度显示 100% 后出现 `read ECONNRESET`，说明 Electron 下载连接被重置，不是 Windows YAML 语法错误。

## 本次改动

- `desktop-app/electron-builder.win.yml` 顶层新增 `electronDist: node_modules/electron/dist`，直接使用本地 Electron 二进制，不再由 electron-builder 重复下载 Electron。
- 新增 `desktop-app/build-win-local.cmd`，先检查并修复本地 Electron、执行 doctor，然后调用原 `dist:win` 命令；并为后续所需的 electron-builder 工具下载设置镜像。
- 不修改浏览器插件及桌面版的业务逻辑、测试和依赖版本。

## Windows CMD 编译

打开 **命令提示符（CMD）**，进入项目目录：

```cmd
cd /d C:\Users\86155\Downloads\human-search-assistant-main\desktop-app
build-win-local.cmd
```

已有完整依赖的用户无需重新 `npm install` 或 `npm run ci`。如未安装依赖，先运行 `npm run ci`，再运行 `build-win-local.cmd`。

打包完成后在 `desktop-app\dist` 查看 NSIS 和 Portable EXE。

## 注意

- 必须事先确保 `node_modules\electron\dist\electron.exe` 存在，脚本会尝试执行 `npm run fix:electron` 修复。
- 此方法只消除**打包阶段对 Electron 本体的重复下载**；如果 NSIS、winCodeSign 等其他工具首次下载也发生网络问题，请检查镜像连通性、代理或缓存。
- 本修复包已检查 YAML 语法和源码完整性，但尚未在 Windows 真实编译 EXE。
