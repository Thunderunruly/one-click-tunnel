# OCT desktop shell (Flutter)

Windows / macOS / Linux 桌面外壳。**不含任何隧道逻辑**，只做三件事：

1. 找到并（必要时）拉起本地核心 `oct` / `oct.exe`；
2. 通过本地 HTTP API `http://127.0.0.1:18400` 读写通道状态（请求头 `x-tunnel-token`，token 从 `config.json` 自动发现）；
3. 把结果画成界面：纯 logo 启动页 → 通道列表 → 详情卡片 → 实时日志 → 托盘。

## 目录

```
app/flutter/
  pubspec.yaml       # 依赖：http / window_manager / tray_manager
  lib/main.dart      # 全部界面 + Core（HTTP 客户端）
```

## 本地运行

需要 Flutter SDK（3.19+）：

```bash
cd app/flutter
flutter pub get
flutter run -d windows     # 或 -d macos / -d linux
```

核心没在跑时，外壳会尝试在**同目录**（以及 `%LOCALAPPDATA%\one-click-tunnel`、`%PROGRAMDATA%\one-click-tunnel`）里找 `oct.exe` / `oct`，然后执行 `oct app`。

token（`config.json` 里的 `gui.token`）按这个顺序找：`ONE_CLICK_TUNNEL_DIR` → 程序所在目录 → 上一级目录 → `%LOCALAPPDATA%\one-click-tunnel` → `%LOCALAPPDATA%\Programs\one-click-tunnel` → `%PROGRAMDATA%\one-click-tunnel` → `%ProgramFiles%\one-click-tunnel`（macOS/Linux 用各自的用户数据目录）。
所以最简单的用法：把外壳解压到 `oct.exe` 旁边；读不到 token 时界面会直接提示。

## 打包

```bash
flutter build windows --release   # build/windows/x64/runner/Release/
flutter build macos   --release   # build/macos/Build/Products/Release/
flutter build linux   --release   # build/linux/x64/release/bundle/
```

三平台自动构建见 `.github/workflows/flutter-shell.yml`：手动触发或推 `flutter-*` 标签 → 发布到 `flutter-shell` 预发布。

## 界面结构

| 区域 | 内容 |
| --- | --- |
| 启动页 | 纯 logo + 进度条 + “正在连接核心…”（核心没起就自动拉一次） |
| 顶栏 | 核心在线/离线 + 版本号、全部启动、全部停止、刷新 |
| 左栏 | 通道列表（状态点 / 名称 / 目标 → 公网地址） |
| 右栏 | 状态卡（链接 + 复制链接和密码）、参数卡（目标/TTL/类型/密码/网关）、操作卡（启动/停止） |
| 底部 | 实时日志（1s 轮询 `/api/log`） |
| 托盘 | 运行时生成图标 + 菜单（打开窗口 / 全部启动 / 全部停止 / 退出） |
| 关闭按钮 | 弹窗二选一：最小化到托盘 / 退出程序（退出先停掉所有通道） |

## 为什么外壳可以随便换

核心（Node SEA 打包的 `oct.exe`）与外壳之间只有那份 HTTP API 契约（见 `docs/desktop-plan.md` 第 6 节）。
所以外壳可以先用 Flutter、之后再换 Fyne/Tauri，核心一行不用改；反过来，以后把核心换成 Go 时，
这个 Flutter 外壳也不需要改。
