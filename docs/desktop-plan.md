# 桌面端方案（Windows / macOS / Linux 三平台）

> 本文是决策记录 + 施工图。目标：一个 UI 代码库覆盖三平台桌面，核心保持无界面守护进程，后续再换语言。

## 1. 选型结论

| 层 | 选型 | 说明 |
|---|---|---|
| UI 外壳 | **Flutter**（Dart） | Win/macOS/Linux 都是 GA；一套代码三平台；后面 iOS/Android 直接复用同一套 UI 做"控制端"；鸿蒙走 OpenHarmony 的 Flutter 分支 |
| 核心 | 现在是现有 Node core（不改）；后续换 Go | 核心本来就只通过本地 HTTP/JSON API 对外服务，UI 只当客户端，所以"换核心"不用动 UI |
| 通信 | 本地 HTTP API（127.0.0.1）+ token | 现有 lib/gui.js 已实现（token、同源校验、CSP）；Flutter 里就是一个 http client |
| 隧道 | cloudflared 二进制（按平台/架构分发） | Win: cloudflared-windows-amd64.exe；macOS: darwin amd64/arm64；Linux: linux amd64/arm64 |

### 为什么不是别的

| 方案 | 三平台桌面 | 判断 |
|---|---|---|
| **Walk** | 只支持 Windows（Win32 绑定） | 你要 mac/Linux，**排除** |
| Fyne | 支持，纯 Go 一套代码 | 可用，但观感是自绘风格、渲染与生态弱于 Flutter；适合"不想引入 Dart"的场景 |
| Wails | 支持（macOS=WKWebView，Linux=WebKitGTK） | 能直接复用现在的网页，最快，但 Linux 要打包 WebKitGTK；UI 仍是网页 |
| **Flutter** | 支持（GA） | **推荐**：UI 质量最高、后续移动端复用、三平台一致性好；代价是引入 Dart + 包体偏大 |

## 2. 架构

    Flutter 桌面 App（三平台同一套代码）
      |  (1) 本地 HTTP/JSON  127.0.0.1:18400  带 token
      v
    核心守护进程（当前 Node core / 后续 Go core）
      |  (2) 每通道一个本地密码门（只监听回环）
      v
    cloudflared（快速隧道 / 命名隧道 + 自有域名）  ->  Internet

要点：
- UI 关掉不影响隧道（核心 + 托盘独立存活）—— 就是现在的行为，Flutter 版照旧
- 一个核心进程托管多条通道；每条通道独立密码、TTL、目标地址（本机或 192.168.x.x）
- 核心是唯一写 config.json 的地方（避免 UI 与核心抢配置）

## 3. 分阶段施工

| 阶段 | 内容 | 验收 |
|---|---|---|
| **A. Flutter 外壳（先做，最快见效）** | 用 Flutter 重写 UI（三平台一套代码）驱动现有核心；系统托盘、开机自启、更新提示、首启向导 | 三平台能装上、能开/停通道、能复制链接+密码、能看实时日志；现有 295 项后端测试保持全绿 |
| **B. 核心换 Go** | 在同一份 API 契约下把核心重写为 Go（gate/manager/cloudflared/updater/mcp/config） | 现有测试直接指向 Go 核心：72 安全 + 20 上游目标 + 11 端口隔离 + 36 命名隧道 + 31 更新 + 27 MCP + 25 多通道 |
| **C. 移动控制端** | 复用 Flutter 代码做 iOS/Android 控制端（鸿蒙走 OpenHarmony Flutter 分支）：连桌面实例，开关通道、看/分享链接密码、扫码 | 手机上能控制桌面实例；注意手机**不能当主机**（不能拉 cloudflared、不能长期监听端口） |

**为什么 A 在 B 前面**：UI 只依赖 API 契约，先把用户看得见的东西做出来；核心换语言时 UI 一行都不动，风险被隔离在"测试套件能验证的那一层"。

## 4. 三平台系统集成清单

| 项 | Windows | macOS | Linux |
|---|---|---|---|
| 安装包 | Inno Setup（已有） | .dmg / .pkg（pkgbuild + productbuild） | .deb / .rpm / AppImage |
| 托盘 | Flutter tray 插件 | 菜单栏图标 | 需要 libappindicator 或 XEmbed 回退 |
| 开机自启 | 启动文件夹快捷方式（已有）/ 注册表 Run | LaunchAgent plist（~/Library/LaunchAgents） | ~/.config/autostart/*.desktop 或 systemd --user |
| cloudflared | 随包分发 .exe | 随包分发二进制（chmod +x） | 随包分发二进制（chmod +x） |
| 代码签名 | 未签名 -> SmartScreen 提示"仍要运行" | **未签名会被 Gatekeeper 拦**；正式分发需 Apple 开发者账号（99 美元/年）+ 公证 | 一般不需要；.deb 可加 GPG 签名 |
| 端口 | 网关 18400（回环）、通道网关 18080+ | 同 | 同（都 >1024，无需 root） |
| 配置/日志目录 | %LOCALAPPDATA%\one-click-tunnel | ~/Library/Application Support/one-click-tunnel | ~/.config/one-click-tunnel（XDG） |

## 5. UI 设计（三平台共用一套信息架构）

窗口：默认 1100x720（最小 900x600）。三栏 + 底部日志抽屉 + 顶部工具条。

- **左：通道列表**（状态点 绿=运行 / 琥珀=启动中 / 灰=停止 / 红=出错，名称，目标->公网，剩余时间胶囊）
- **中：详情** = 状态卡（公网 URL 大字、复制链接+密码、二维码）/ 密码（打码、随机<->手动）/ 参数（目标地址、TTL 含"永不关闭"、隧道类型 快速<->命名隧道+自有域名）/ 操作（启动/停止/重启/删除隧道）
- **下：日志抽屉**（实时 cloudflared 输出 + 一键复制）
- **托盘**：打开窗口 / 全部启动 / 全部停止 / 复制最近一条链接 / 退出
- **首启向导 3 步**：映射什么（本机端口 or 局域网设备）-> 有效期与密码 -> 完成（链接+密码+二维码）
- **视觉**：深色 #0f1115 背景 / #171a21 卡片 / 圆角 14；强调色 #2563eb；状态色 #22c55e / #f59e0b / #ef4444；URL、端口、密码、域名一律等宽字体

## 6. UI 需要的 API（就是现有这些，不用改契约）

    GET  /api/state                    通道列表 + 状态 + 更新状态 + Cloudflare 状态
    POST /api/profile | /api/delete    新建/修改/删除通道
    POST /api/action                   start|stop|startAll|stopAll|enable|disable|regenPassword
    GET  /api/log?id=                  单通道日志
    POST /api/cloudflare               login|setupTask|deleteTunnel|autostart|status
    GET  /api/cloudflare?task=<id>     实时任务输出（登录 / 建隧道绑域名）
    GET  /api/update  POST             检查更新 / 下载 / 静默安装 / 忽略版本
    GET  /api/health                   存活探测（无 token，供 UI 判断核心在不在）

## 7. 风险与未验证

- **macOS 公证**：未签名/未公证的 .app 需要用户"右键 -> 打开"绕过；正式分发必须买开发者账号
- **Linux 依赖**：Flutter Linux 需要 GTK3 + OpenGL（发行版一般都有）；AppImage 可自带
- **包体**：Flutter 桌面版比 Fyne/Wails 大（每平台约 25-40MB + cloudflared 52MB）
- **托盘在 Linux**：部分桌面环境（GNOME 默认）需要扩展才显示托盘图标 -> 需回退方案（关窗口不退出，而不是只靠托盘）
- 本文只是决策与施工图，**尚未开始写 Flutter 代码**
