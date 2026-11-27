# ESP OTA Uploader for Arduino IDE 2

给 **Arduino IDE 2** 加一个"手动指定 IP 的 ESP OTA"上传入口。

## 解决什么问题

Arduino IDE 2 上传 OTA 依赖 **mDNS 发现**网络端口。以下场景会发现不到设备：

- 设备与电脑不在同一个广播域（多级路由、FTTR 主从光猫）
- 交换机 / AP 开了 IGMP Snooping，组播被过滤（mDNS 是 `224.0.0.251` 组播）
- 公司/学校网络禁组播

典型报错：

```
espota.exe: error: argument -p/--port: invalid int value: '{upload.port.properties.port}'
```

此时 IDE 已经拿到 IP，但拿不到端口号——因为 mDNS 没工作。

本扩展绕过发现流程，**直接问你 IP**，用单播直连上传。

## 功能

| 项 | 说明 |
|---|---|
| 芯片 | **ESP32 全系 + ESP8266**（都用官方 espota） |
| 端口 | 按 IP 自动识别芯片（查 `arduino-cli board list`）：ESP32 → 3232，ESP8266 → 8266；识别不到时先试 3232，失败自动换 8266 重试 |
| 密码 | 上传时随 IP 一起询问，记住上次输入；认证失败会再给一次机会 |
| 入口 | 状态栏按钮 / 命令面板 / 快捷键 |
| 进度 | 状态栏百分比 + 通知区进度条 |
| 固件来源 | 直接用 IDE 的构建产物，不重复编译 |

> GitHub：https://github.com/ymyjwbckadnhz/arduino-ide-esp-ota
> Gitee 镜像：https://gitee.com/OvO_rain/arduino-ide-esp-ota

## 安装

**没有应用商店**，手动放置：

```bash
# Windows
copy esp-ota-uploader-1.0.0.vsix %USERPROFILE%\.arduinoIDE\plugins\

# macOS / Linux
cp esp-ota-uploader-1.0.0.vsix ~/.arduinoIDE/plugins/
```

目录不存在就自己建一个，然后**重启 Arduino IDE**。

## 使用

1. 在 IDE 里打开 sketch，选好开发板
2. 按 `Ctrl+R` **编译一次**（扩展读取的是编译产物，不会自己编译）
3. 点状态栏的 **OTA** 按钮，或：
   - 命令面板 `Ctrl+Shift+P` → `ESP OTA: Upload to IP`
   - 快捷键 `Ctrl+Alt+U`
4. 连着两步输入：

   ```
   OTA 目标 IP（1/2）     ← 预填上次的 IP，回车沿用
   OTA 密码（2/2）        ← 预填已保存的密码（掩码），回车沿用
   ```

IP 和密码都会记住，之后每次上传就是**两次回车**。

密码框里输入 `-` 表示清除密码（设备没设密码时用）。

## 配置

| 设置项 | 默认 | 说明 |
|---|---|---|
| `espOta.password` | 空 | ArduinoOTA 密码的初始值（之后以上次输入为准） |
| `espOta.port` | 0 | 0 = 自动（3232 / 8266） |

## 为什么没有"工具菜单"入口

Arduino IDE 2 是 Theia（Electron）架构，插件可以注册**命令面板条目、快捷键、状态栏按钮、设置项**，但**顶部菜单栏（文件/编辑/项目/工具/帮助）由 Arduino 自己的后端生成，插件无法往里加项**。

所以本扩展用**状态栏按钮**当作常驻入口——位置固定、一键可点，比菜单少两层点击。

## 已知限制

- **必须先编译**：扩展只负责上传。它读 IDE 的构建缓存
  （`<userData>/arduino/sketches/<hash>/<sketch>.ino.bin`），自己不调用 `arduino-cli`。
- 不能在 IDE 运行时外部调用 `arduino-cli compile`：IDE 的 daemon 占着 CLI 锁，外部编译会一直卡住。
- `vscode-arduino-api` 在部分 IDE 版本拿不到 `currentSketch`，扩展会退回"当前编辑器所在目录"推断 sketch。
- espota 走 **UDP**，用 TCP 探测端口会误判成"拒绝连接"。

## 开发

```bash
npm install
npm run compile

# 打包（Windows，不依赖 vsce）
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

产物：`esp-ota-uploader-<version>.vsix`，复制到 `.arduinoIDE/plugins/` 即生效。

调试日志写在系统临时目录的 `esp-ota.log`。

## 许可

MIT
