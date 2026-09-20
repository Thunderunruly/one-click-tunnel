# one-click-tunnel

[![CI](https://github.com/Thunderunruly/one-click-tunnel/actions/workflows/ci.yml/badge.svg)](https://github.com/Thunderunruly/one-click-tunnel/actions/workflows/ci.yml)
[![Release](https://github.com/Thunderunruly/one-click-tunnel/actions/workflows/release.yml/badge.svg)](https://github.com/Thunderunruly/one-click-tunnel/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-blue.svg)](#)

One-click temporary public tunnels for Windows, built on Cloudflare Quick Tunnels — with a password gate in front of
your service, a local config page, a system tray icon, a CLI **and** an MCP server (so an AI agent can manage tunnels too).
No admin rights, no dependencies, single-file executable.

## Install

From the [latest release](https://github.com/Thunderunruly/one-click-tunnel/releases):

| Download | What it is |
| --- | --- |
| one-click-tunnel-setup-<version>.exe | One-click installer (per-user, no admin). Adds Start Menu / Desktop shortcuts and an uninstall entry. |
| one-click-tunnel-<version>-win-x64.zip | Portable bundle: unpack and double-click install.cmd |

Verify your download against SHA256SUMS.txt in the release assets.

## What it does

- Publishes a local port to a temporary https://xxxx.trycloudflare.com URL that **requires a password**
- The password gate binds to 127.0.0.1 only, so public traffic must come through the tunnel
- Everything auto-closes when the TTL expires (per tunnel)
- Run **many tunnels at once**, each with its own local port, gateway port, password and expiry time
- Manage them from the config page, the tray icon, the CLI, or let an AI agent do it over MCP

## Four ways to start / manage tunnels

    # 1. graphical config page + tray (recommended)
    public-tunnel.exe gui --open

    # 2. tray only (background daemon is started automatically)
    public-tunnel.exe tray

    # 3. command line, many tunnels
    public-tunnel.exe add --name web --port 3000 --ttl 1h --auto-start
    public-tunnel.exe start web
    public-tunnel.exe list
    public-tunnel.exe stop --all

    # 4. MCP: let an AI host drive it
    public-tunnel.exe mcp

The classic single-tunnel flags still work exactly as before:

    public-tunnel.exe --port 3000 --ttl 1h --password mypassword

## Where is the tray icon?

The tray is **not** part of the web page - a browser page cannot own a notification-area icon. The background
daemon starts a tiny Windows process (PowerShell WinForms, no extra dependency) that shows the icon:

- Windows 11 hides new tray icons by default: click the **^** (show hidden icons) next to the clock, or open
  设置 → 个性化 → 任务栏 → 其他系统托盘图标 and switch "one-click-tunnel / 临时公网映射" on to keep it visible.
- The icon only lives while the daemon runs. In 1.2.x the daemon lived in the console window, so closing that
  window killed the tray as well. From 1.3.0 the launcher is windowless and the daemon is detached, so closing
  the app window keeps the tunnels **and** the tray alive.
- Start it manually any time: public-tunnel.exe tray  (reuses the running daemon; exits if one is already there)
- Turn it off: config page -> 全局设置 -> 托盘, or tray.enabled=false in config.json.
- If the daemon dies, the tray closes itself within ~10 seconds (watchdog), so no ghost icons are left behind.

## Desktop app (no console window)

The shortcut starts the background daemon **hidden** and opens the config page inside a chromeless desktop
window (Edge/Chrome app mode: no address bar, no tabs, its own taskbar entry and icon). Closing that window
does **not** stop the tunnels - the tray icon stays, and the tray menu (or the "全部关闭" shortcut) quits
everything. No cmd window appears: the shortcut runs a .vbs launcher and the daemon is spawned detached+hidden.

    public-tunnel.exe app             # open the desktop window (starts the daemon when needed)
    public-tunnel.exe gui --browser   # use a normal browser tab instead of the app window

## Config file (config.json, next to the exe)

    {
      "version": 1,
      "gui":  { "port": 18400, "token": "<auto generated>", "openBrowser": true },
      "mcp":  { "enabled": true, "allowStart": true, "allowStop": true },
      "tray": { "enabled": true },
      "defaults": { "ttl": "1h", "passwordMode": "random", "gatewayStart": 18080, "rateLimit": 3000 },
      "update": { "enabled": true, "repo": "Thunderunruly/one-click-tunnel",
                  "apiBase": "https://api.github.com", "checkIntervalHours": 6,
                  "autoDownload": false, "includePrerelease": false,
                  "downloadMirror": "", "ignoredVersion": "" },
      "profiles": [
        { "id": "web", "name": "web 3000", "enabled": true, "autoStart": false,
          "port": 3000, "gateway": 18080, "ttl": "30m",
          "passwordMode": "random", "password": "", "host": "127.0.0.1" }
      ]
    }

One profile = one local port + one gateway port + one password + one TTL. Each profile runs as its own child process,
so session keys, rate limits, lockouts and timers are isolated per tunnel.

## MCP (AI integration)

    {
      "mcpServers": {
        "one-click-tunnel": {
          "command": "C:\\Users\\<you>\\AppData\\Local\\one-click-tunnel\\public-tunnel.exe",
          "args": ["mcp"]
        }
      }
    }

Tools exposed: list_tunnels, create_tunnel, start_tunnel, stop_tunnel, update_tunnel, delete_tunnel,
set_password, tunnel_status, stop_all. Tunnels created by the AI show up in the config page and can be
stopped by hand at any time. Use mcp.allowStart / mcp.allowStop to limit what the AI may do.

## Updates

The program checks the GitHub release channel for a newer version (default: every 6 hours, configurable) and shows a
banner on the config page when one exists. You can also check on demand:

    public-tunnel.exe update               # check now
    public-tunnel.exe update --notes       # print the release notes
    public-tunnel.exe update --download    # download the installer into updates\ (SHA-256 verified)
    public-tunnel.exe update --install     # silently run the downloaded setup.exe
    public-tunnel.exe version              # print the current version

- Downloads are verified against the release SHA256SUMS.txt; a mismatch deletes the file and fails loudly.
- Auto-download (never auto-install) can be enabled with update.autoDownload.
- Behind a blocked network, point update.apiBase at a GitHub API mirror and/or set update.downloadMirror to something
  like https://your-mirror.example/{url} -- the {url} placeholder is replaced with the real asset URL.
- Ignore a version from the banner (it is stored as update.ignoredVersion).
- AI hosts get the same capability through the MCP tool check_update.

## Security

- Password gate on 127.0.0.1 only; constant-time password comparison; per-IP lockout (8 failures / 5 min) and rate limit
- Session cookie: HMAC signature, random per-session id, HttpOnly, SameSite=Lax, Secure over https, server-side revocation on logout
- Requests are sanitised before proxying: hop-by-hop headers stripped, Host rewritten unless allow-listed,
  X-Forwarded-For / X-Real-IP overwritten with the real client IP, gateway credentials never forwarded upstream
- TRACE/TRACK, CONNECT and absolute-form request lines rejected; unauthenticated requests never reach your service
- Config page: loopback only, token required, same-origin enforced on writes, strict CSP, no external resources
- TTL auto-shutdown, process-tree cleanup, orphan cloudflared reaping, logs never contain the password

Verified by re-runnable suites (offline unless noted):

    npm test                      # 72 + 25 + 29 + 27 checks
    npm run test:exe              # packaged exe: CLI / GUI / self-spawn
    npm run test:installer        # installer end-to-end
    npm run test:live             # real Cloudflare tunnel from the public side (needs internet)

## Build from source

    git clone https://github.com/Thunderunruly/one-click-tunnel.git
    cd one-click-tunnel
    node build/make-exe.mjs       # dist/public-tunnel.exe (single file, Node SEA)
    node build/make-zip.mjs       # release/one-click-tunnel-<version>-win-x64.zip
    node build/make-setup.mjs     # release/one-click-tunnel-setup-<version>.exe (needs Inno Setup 6)

Releases are produced automatically by GitHub Actions: push a tag like v1.1.0 and the
[Release workflow](.github/workflows/release.yml) runs the test suites, builds the exe, the portable zip and the
Inno Setup installer, then publishes them to the GitHub release.

MIT licensed. cloudflared is a separate binary by Cloudflare (Apache-2.0).

---

# 中文文档（从下面开始）

# 临时公网映射小工具（public-tunnel）

把本机某个端口**临时**映射到公网，带**访问密码**和**定时自动关闭**。

## 快速开始

双击 `start.cmd`（默认映射 3000，1 小时后自动关闭，自动生成密码并打印）。

命令行用法：

```bat
start.cmd                                   :: 映射 3000，TTL 1h，随机密码
start.cmd --port 8090 --ttl 30m             :: 映射 8090，30 分钟后自动关闭
start.cmd --port 8091 --ttl 1h --password mypass123
```

或直接：

```bash
node tunnel.js --port 3000 --ttl 1h --password 你的密码
```

## 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `--port, -p` | 要映射的本机端口 | 3000 |
| `--ttl, -t` | 有效期：`90s` / `30m` / `1h` / 秒数 | 1h |
| `--password, -P` | 访问密码（不传则自动生成并打印） | 随机 |
| `--gateway, -g` | 本地网关端口 | 18080 |
| `--host` | 网关监听地址（**别改成 0.0.0.0**） | 127.0.0.1 |

## 工作方式

```
公网浏览器 ──https──> Cloudflare 隧道 ──> 本机 127.0.0.1:18080（密码门） ──> 127.0.0.1:<port>（你的服务）
```

- 密码门只监听 127.0.0.1，**本机端口不直接暴露**
- 外部访问：浏览器第一次会跳到密码页，输对后发一个 HttpOnly Cookie（12 小时或到 TTL）
- 命令行/脚本访问：支持 HTTP Basic Auth（`curl -u :密码`）
- 同一 IP 连续 8 次密码错误 → 锁 5 分钟
- 到 TTL：杀掉隧道 + 关闭网关 + 进程退出；`Ctrl+C` 同样会清理；日志写在 `logs/`

## 安全设计（威胁模型 + 实测结论）

链路：`公网 → Cloudflare 快速隧道 → 127.0.0.1:网关(密码门) → 127.0.0.1:<被映射端口>`
网关**只监听回环**，本机被映射的服务端口不直接对外。

| 威胁 | 防护 | 实测结果 |
|---|---|---|
| 陌生人拿到 URL | 必须输对密码才放行（`HttpOnly; SameSite=Lax; Secure` Cookie，或 Basic Auth） | 未登录 302→/__login；错密码 401；对密码 200 |
| 暴力破解 | 同 IP 连错 8 次锁 5 分钟（**按 CF-Connecting-IP 记账**，不是按 remoteAddress）+ 每 IP 每分钟限流 | 第 9 次 429；换 IP 正常；`--rate-limit 5` 时第 6 次 429 |
| 我的会话/口令泄露给上游服务 | 转发前剥掉 `tunnel_session` Cookie 与 Basic 网关口令 | 上游回显 `cookie=null`、`authorization=null` |
| Host 头注入上游 | 只对 `*.trycloudflare.com`/本机透传 Host，其它一律改写为 `127.0.0.1:<port>` | `Host: evil.com` → 上游看到 `127.0.0.1:18099` |
| 绝对形式请求行 / 请求走私 | 只接受以 `/` 开头的 origin-form，其它 400 | `--request-target http://evil/` → 400 |
| 点击劫持（被嵌 iframe） | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` | `/__login` 响应头可见 |
| MIME 嗅探 / Referrer 泄露隧道 URL | `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store` | 同上 |
| 同网段绕过隧道直连网关 | `--host` 只允许回环，非回环直接拒绝启动 | `--host 0.0.0.0` → 拒绝并退出 |
| 忘记关闭 | TTL 到点自动关（默认 1h）+ `Ctrl+C` + `stop.cmd` | 到点后公网地址变 530，进程零残留 |
| 误杀别人的隧道 | `stop.cmd` 按实例 pid 文件精确关闭（不再 `taskkill /IM cloudflared.exe`） | 关掉 18083 后，5777 那条隧道仍正常 |
| cloudflared 被掉包 | 下载后校验 MZ 头 + 打印 SHA-256；支持 `--cloudflared <路径>` / `--no-download` | 日志里有 SHA-256 |

**没做 / 不覆盖（诚实说明）**

1. 密码是**一个共享口令**，不是多用户账号体系，也没有二次验证
2. 快速隧道的 URL 本身仍是公网可解析的，安全性**完全依赖密码**：密码+URL 一起泄露 = 门开了
3. 只保护「到你本机服务」这一段；被映射服务自身的漏洞（接口越权、Swagger 暴露等）不在本工具职责内 —— 所以**别直接映射 8090/8091**（Swagger 白名单看 remoteAddr，经隧道会变成 127.0.0.1）
4. 密码只打印在终端窗口，**不写入 logs/**；但如果你把 stdout 重定向到文件，密码就会落到那个文件
5. 不做 DDoS 防护（Cloudflare 侧有基础防护），本机限流只是防刷
6. 不做来源 IP 白名单（快速隧道没有固定入口 IP）——需要的话得用 Cloudflare Access（要账号/域名）

## 参数补充（安全相关）

| 参数 | 说明 |
|---|---|
| `--rate-limit <n>` | 每客户端 IP 每分钟请求上限（默认 3000） |
| `--allow-host <域名>` | 额外允许透传 Host 的域名（可重复） |
| `--cloudflared <路径>` | 用自带的 cloudflared，不联网下载 |
| `--no-download` | 禁止自动下载 cloudflared |
| `--force-public-gateway` | 允许 `--host` 绑非回环（**危险**，绕过隧道也能直连网关） |


---

# 打包 / 安装 / 安全测试（第 2、3 轮加固）

## 技术栈与打包方式

- 整个工具是纯 Node.js 单文件脚本（tunnel.js），只用 node:http / node:https / node:crypto / node:fs /
  node:path / node:child_process 等内置模块，零第三方依赖。
- 因此用官方 Node SEA（Single Executable Application）打包成免安装单文件 exe，不需要 pkg / electron：

      node build\make-exe.mjs     # dist\public-tunnel.exe (83 MB) + dist\cloudflared.exe (52 MB) + 安装脚本
      node build\make-zip.mjs     # release\public-tunnel-win-x64-1.0.0.zip (49 MB)，解压双击 install.cmd 即可

- 打包后 __dirname 指向虚拟快照，脚本自动改用 path.dirname(process.execPath) 定位 cloudflared.exe /
  logs / pid 文件（用 node:sea 的 isSea() 判定，同时兼容 pkg 的 process.pkg）。

## 一键安装（免管理员）

1. 解压 zip，双击 install.cmd
2. 装到 %LOCALAPPDATA%\public-tunnel，创建桌面 + 开始菜单快捷方式，并写入 HKCU 卸载项（「设置 → 应用」可卸载）
3. 卸载：uninstall.cmd 或「设置 → 应用」，会先结束残留进程再删目录，不留残留

注意：.ps1 必须保存成 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 ANSI 读，中文变乱码并报语法错。

## 安全测试（可重复运行）

      node security-test.mjs                 离线 72 项（自带 echo 上游，不联网、不建隧道）
      node security-test-live.mjs            联网 17 项（真开一条 Cloudflare 隧道，从公网侧验证）
      node build	est-installer.mjs          安装器 18 项（装到临时目录 → 校验 → 运行 → 卸载 → 校验清干净）
      set TUNNEL_ENTRY=dist\public-tunnel.exe   加这个变量，前两套用例改测打包后的 exe

覆盖：未认证边界（401/302/403、不碰上游、不读请求体）、Cookie 签名/过期/吊销、Basic、跨站 Origin、
TRACE/CONNECT/绝对形式请求行、Host 改写与透传、XFF 与 x-real-ip 改写、路径与请求行 CRLF 注入、
冲突 Content-Length、限流与按 IP 锁定隔离、非法参数、TTL 自动关闭、冲突端口、pid 残留、
日志不记录密码，以及公网侧真机验证。

## 第 2、3 轮修掉的安全问题

1. 会话 Cookie 完全相同：原来 exp 恒等于 expiresAt 且无随机量，每把 Cookie 一模一样，
   泄露一把等于全员通用，且登出吊销后重新登录又下发同一把。改为 exp.sid.sig（随机 sid + HMAC），按 sid 精确吊销。
2. 登录页泄露目标端口与剩余时间 → 移除，只保留「受密码保护、到点自动关闭」。
3. /__status 未认证可读（暴露端口与到期时间）→ 需认证，否则 403。
4. /__auth 缺 Origin 校验（第三方站点可 CSRF 诱导登录）→ Origin 必须与 Host 同源，否则 403。
5. 客户端 X-Forwarded-For 被追加透传给上游 → 覆盖为网关判定出的客户端 IP，同时写 x-real-ip。
6. x-forwarded-proto 本地可伪造（影响 Cookie Secure 与上游 https 语义）→ 仅采信确实来自 Cloudflare 的请求。
7. TRACE/TRACK、CONNECT 未拒绝 → 405 / 501（防止被当代理跳板）。
8. 限流表与失败计数表无限增长（长期运行内存耗尽）→ 每 5 分钟清理过期项。
9. --ttl 非法值静默退回 1h（安全语义错误）→ 直接报错退出；并支持 d 单位。
10. 清理顺序错误：原来先删 pid 文件再杀进程 → 改为先杀后删，并在启动时按 pid 文件回收上次硬杀留下的孤儿 cloudflared。
11. 打包后路径错：SEA 下 __dirname 不可用 → HERE 自适应（见上）。
12. 安装脚本编码：ps1 无 BOM 导致中文乱码/语法错 → 统一 UTF-8 with BOM。

## 已知残留风险（未消除 / 未验证）

- 直连本机 127.0.0.1:<gateway> 时，请求方可自带 CF-Connecting-IP 影响限流键与上游 XFF；
  能直连回环说明本机已可执行代码，故未额外处理。
- exe 未做代码签名，Windows SmartScreen 可能提示「未知发布者」。
- cloudflared.exe 是外部二进制，脚本只把 SHA-256 打到日志，未做签名/哈希白名单校验。
- 某些路由器 DNS 不解析 *.trycloudflare.com 快速隧道域名（本机就是），浏览器需开「安全 DNS / DoH」；
  公网测试脚本因此用 1.1.1.1 解析。
- 修改 tunnel.js 后必须重启已运行的实例才会生效（脚本启动时一次性加载）。


---

# 1.1 版：多通道 + 图形化配置页（可最小化到托盘）+ MCP(AI) + CLI

## 三种开启方式（同一份配置、同一份状态）

1. 命令行（经典单通道，参数和以前完全一样）
   tunnel --port 3000 --ttl 1h --password 自定义
2. 图形化配置页 + 托盘（推荐）
   tunnel gui --open        打开配置页 http://127.0.0.1:18400/?token=xxx ，并最小化到托盘
   tunnel tray              只留托盘图标（守护进程自动拉起）
   配置页里可以：多通道同时开、启用/停用、启动/停止、改 TTL、选随机密码或手动密码、
   看剩余时间与公网地址、复制密码、查看日志、删除通道
3. MCP（给 AI 用）
   tunnel mcp               以 stdio 提供 MCP 服务，AI 可以直接开/关/改通道

也可以只用 CLI 的多通道子命令（后台守护进程执行）：

    tunnel list                          列出所有通道与状态
    tunnel add --name 前端 --port 3000 --ttl 1h --auto-start
    tunnel start 前端 | --all            启动（可同时开多个）
    tunnel stop  前端 | --all
    tunnel enable|disable <id>           启用 / 停用
    tunnel regen <id>                    换一次随机密码
    tunnel config show | config set gui.port 18400
    tunnel daemon status|start|stop      后台守护进程

## config.json（放在 exe 同级目录，首次运行自动生成）

    {
      "version": 1,
      "gui":   { "port": 18400, "token": "自动生成", "openBrowser": true },
      "mcp":   { "enabled": true, "allowStart": true, "allowStop": true },
      "tray":  { "enabled": true },
      "defaults": { "ttl": "1h", "passwordMode": "random", "host": "127.0.0.1",
                    "gatewayStart": 18080, "rateLimit": 3000 },
      "profiles": [
        { "id": "前端-3000", "name": "前端 3000", "enabled": true, "autoStart": false,
          "port": 3000, "gateway": 18080, "ttl": "1h",
          "passwordMode": "random", "password": "", "host": "127.0.0.1",
          "rateLimit": 3000, "upstreamHost": "", "allowHosts": [], "noTunnel": false }
      ]
    }

一个通道(profile) = 一个本机端口 + 一个独立网关端口 + 一个独立密码 + 一个独立 TTL。
每个通道单独一个子进程（本程序自己），所以会话密钥、限流、锁定、TTL 全部互相隔离。

## MCP 配置（Claude Desktop / Cursor / 任何 MCP 宿主）

    {
      "mcpServers": {
        "public-tunnel": {
          "command": "C:\\Users\\<你>\\AppData\\Local\\public-tunnel\\public-tunnel.exe",
          "args": ["mcp"]
        }
      }
    }

提供的工具：list_tunnels、create_tunnel、start_tunnel、stop_tunnel、update_tunnel、
delete_tunnel、set_password、tunnel_status、stop_all。
（AI 开的通道在配置页里一样能看到、能手动关。是否允许 AI 启停由 mcp.allowStart/allowStop 控制。）

## 安全模型（新增部分）

- 配置页只监听 127.0.0.1，并且每个请求再校验一次来源 socket 必须是回环
- 所有 /api/*（除 /api/health）都要 token（命令行里带 ?token= 打开一次即写入 HttpOnly+SameSite=Strict Cookie）
- 写操作要求同源：Origin/Referer 必须与 Host 一致，Sec-Fetch-Site 必须是 same-origin/none（防别的网页 CSRF 开隧道）
- 页面带 CSP（default-src none、禁外链）、X-Frame-Options DENY、no-store，不引用任何外部资源
- 通道子进程沿用原有全部加固（恒定时间密码、HMAC+随机 sid 会话、按 IP 锁定与限流、
  Host 白名单改写、XFF 覆盖、拒绝 TRACE/CONNECT、TTL 自关、pid 残留回收）
- 托盘用系统自带 WinForms（零依赖），父进程退出时托盘自动消失

## 测试

    node security-test.mjs           72 项  经典单通道安全
    node security-test-live.mjs      17 项  公网真机（联网）
    node security-test-gui.mjs       29 项  GUI/守护进程 API 鉴权与 CSRF
    node test-multi.mjs              25 项  多通道同时运行、隔离、启停
    node test-mcp.mjs                27 项  MCP 协议与工具
    node test-exe.mjs                13 项  打包后的 exe（CLI/GUI/子进程自举）
    node test-tray.mjs                9 项  托盘冒烟（需 Windows 桌面会话）
    node build/test-installer.mjs    18 项  安装器端到端


---

# 1.2 版：自动更新

程序会自动从 GitHub Release 拉取版本信息并比较，发现新版就在配置页顶部弹提示条：

- 默认每 6 小时检查一次（update.checkIntervalHours 可改；update.enabled=false 关闭；也可以点"立即检查更新"）
- 提示条按钮：下载安装包 / 静默安装 / 打开发布页 / 查看更新说明 / 忽略此版本
- 命令行：tunnel update [--notes|--download|--install|--ignore|--json]，tunnel version
- AI：MCP 工具 check_update（可选顺便下载）
- 安全：下载后用 release 里的 SHA256SUMS.txt 校验，SHA-256 不匹配就删除文件并报错；默认只下载不自动安装
  （自动下载可开 update.autoDownload，静默安装只在你显式点按钮或用 --install 时执行）
- 被墙的网络：把 update.apiBase 换成 GitHub API 镜像，把 update.downloadMirror 设成形如 https://mirror.example/{url}
- 检查结果缓存在 state/update.json，配置页 / CLI / MCP 共用同一份，避免频繁请求（还会用 ETag 做 304 协商）

    node test-update.mjs      # 31 项：检查/缓存/ETag/预发布/下载校验/镜像/忽略/各种异常路径（本地假 GitHub API，离线可跑）


---

# 1.3 版：桌面窗口（不再弹 cmd）+ 端口示例中立化

- 快捷方式现在执行 launch.vbs（wscript，**完全没有命令行窗口**）：隐藏启动后台守护进程 → 打开**桌面窗口**
- 桌面窗口 = Edge/Chrome 的 app 模式：没有地址栏、没有标签页，任务栏里是一个独立的应用窗口和图标
- 关掉窗口**不会**停止隧道：托盘图标继续在，托盘菜单里可以「全部启动/全部停止/退出」
- 附加：开始菜单里多了一个「one-click-tunnel 全部关闭」（stop-all.vbs，无控制台，关完弹提示）
- 手动打开窗口：tunnel app（守护进程没跑会自动拉起）；想用普通浏览器标签页：tunnel gui --browser
- 默认端口和文档示例从 5777 改成中性的 3000（tunnel 不带 --port 时默认映射 127.0.0.1:3000）


---

# 1.3.1：托盘健壮性 + 说明

- 单实例互斥锁：不会出现一堆重复的托盘图标（已有托盘时新的直接退出）
- 看门狗改成"守护进程还活着吗"：连续 3 次取不到状态就自己消失，不再依赖父进程 pid（避免 pid 复用留下僵尸图标）
- 命令行提示与配置页都写清楚了：图标在任务栏右下角，Win11 默认收进 ^ 溢出区，可拖出来固定显示
- 网页里永远不会有托盘：浏览器页面拿不到通知区域图标，托盘是后台进程提供的
