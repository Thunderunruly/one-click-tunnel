# 更新日志 Changelog

---

# 1.5.3：局域网设备映射（--target）+ 修更新提示自相矛盾

1. 上游目标可指定为局域网设备：tunnel --target 192.168.1.50:8080 / tunnel add --name nas --port 5000 --target 192.168.1.50:5000；
   配置页新增「目标地址」输入框，MCP 的 create_tunnel 也支持 target
2. 默认只允许本机/局域网地址（10/8、172.16/12、192.168/16、回环、fc00::/7），
   公网地址 / 0.0.0.0 / 组播 / 链路本地（含 169.254.169.254）默认拒绝，需要时用 --allow-public-target，
   避免这个工具被当成开放代理
3. 目标是局域网设备时，转发给设备的 Host 头改写成设备自己的地址（原来是 127.0.0.1:网关，设备不认）
4. 支持 https 上游：--target-secure（自签证书可配合 --target-insecure-tls）
5. 修：升级后配置页拿旧缓存提示"发现新版本 1.4.0（当前 1.5.1）"——hasUpdate 改成现场按当前版本重算，升级后立刻重查
6. 测试：node test-upstream.mjs 20 项（地址校验 + 真把局域网设备通过密码门转出去 + 公网目标被拒）

---

# 1.5.2：原生无控制台启动器（不再依赖 VBScript）

- 新增 build/launcher/Launcher.cs + build/make-launcher.mjs：用系统自带 csc.exe 编译出
  dist/one-click-tunnel.exe（GUI 子系统，约 7KB）。启动时隐藏调起 public-tunnel.exe app，
  完全不会弹命令行窗口，也不依赖 VBScript（微软正在弃用 VBScript，Win11 24H2 起是可选功能）
- 快捷方式改为指向它：桌面/开始菜单 = one-click-tunnel.exe；另有「全部关闭」= one-click-tunnel.exe --stop-all
- 安装脚本 / Inno Setup / 开机自启 全部改用原生启动器；launch.vbs、stop-all.vbs 已删除
- 测试：node test-launcher.mjs 8 项（PE Subsystem=GUI、能找到并驱动主程序、缺文件时有可读提示）

---

# 1.5.1：修掉开机自启启动器（launch.vbs）解析失败

- 现象：双击桌面/开始菜单快捷方式弹出 "Windows Script Host ... 无效字符 800A0408"
- 原因：launch.vbs / stop-all.vbs 是 UTF-8（无 BOM）+ LF 换行 + 中文注释，WSH 按 ANSI 解析直接报错
- 修复：两个 .vbs 改成 WSH 原生支持的 UTF-16LE + BOM + CRLF，并用 cscript 实测解析通过
- 另：.gitattributes 里把 *.vbs 标记为 binary，避免 git 再次改行尾/编码
- 已经装了 1.5.0 的：直接在安装目录里跑 start.cmd 也能用；或重新安装 1.5.1 覆盖

---

# 1.5.0：四件高级功能

1. 配置页实时输出：Cloudflare 登录 / 建隧道绑域名 改成后台任务，页面显示 cloudflared 的实时输出（不再干等）
2. 一个隧道绑多个域名：配置文件 hostnames 数组，ingress 每个域名一条，route dns 逐个创建（CLI/GUI/MCP 都支持）
3. 开机自启 + 常驻：tunnel autostart install（免管理员，写"启动"文件夹）；命名隧道 + autoStart + keepAlive
   会在意外退出后自动拉起（10 分钟内最多 6 次），做到域名随时可访问
4. 隧道删除按钮 + 证书提醒：配置页可删 Cloudflare 隧道并改回快速隧道（tunnel undomain --force）；
   解析 cert.pem 的到期时间，CLI/配置页显示剩余天数，少于 30 天会提醒重新登录

---

# 1.4.0：自有域名（命名隧道，地址永久固定）

- 新增 **命名隧道**：`tunnel login` 浏览器授权一次，`tunnel domain <id> app.example.com` 自动建隧道 +
  加 DNS 记录 + 写回配置，地址永久固定（不再是每次随机的 trycloudflare 地址）
- TTL 支持 `forever`：命名隧道默认不自动关闭，域名长期有效
- 公网域名背后仍然是**本机密码门**：生成的 cloudflared 配置把 ingress 指向 127.0.0.1:<网关>，业务端口不直接暴露
- 新增 `tunnel info [id]`（类型/域名/隧道ID/凭据/还差什么）与 `--dry-run`（只生成配置并打印命令）
- 配置页：Cloudflare 登录按钮 + 每条通道可切 快速/命名 并绑定域名；MCP 新增
  `cloudflare_login` / `set_custom_domain` / `cloudflare_status`
- 测试：`node test-named.mjs` 30 项（离线：纯函数 + dry-run 集成 + 各类异常）


每个版本的用户可见变化。发布说明（含下载与校验方式）见 https://github.com/Thunderunruly/one-click-tunnel/releases

Release notes are written in Chinese; per-release notes (download + SHA-256 verification) live on the Releases page.

---

# 1.3.1：托盘健壮性 + 说明

- 单实例互斥锁：不会出现一堆重复的托盘图标（已有托盘时新的直接退出）
- 看门狗改成"守护进程还活着吗"：连续 3 次取不到状态就自己消失，不再依赖父进程 pid（避免 pid 复用留下僵尸图标）
- 命令行提示与配置页都写清楚了：图标在任务栏右下角，Win11 默认收进 ^ 溢出区，可拖出来固定显示
- 网页里永远不会有托盘：浏览器页面拿不到通知区域图标，托盘是后台进程提供的

---

# 1.3 版：桌面窗口（不再弹 cmd）+ 端口示例中立化

- 快捷方式现在执行 launch.vbs（wscript，**完全没有命令行窗口**）：隐藏启动后台守护进程 → 打开**桌面窗口**
- 桌面窗口 = Edge/Chrome 的 app 模式：没有地址栏、没有标签页，任务栏里是一个独立的应用窗口和图标
- 关掉窗口**不会**停止隧道：托盘图标继续在，托盘菜单里可以「全部启动/全部停止/退出」
- 附加：开始菜单里多了一个「one-click-tunnel 全部关闭」（stop-all.vbs，无控制台，关完弹提示）
- 手动打开窗口：tunnel app（守护进程没跑会自动拉起）；想用普通浏览器标签页：tunnel gui --browser
- 默认端口和文档示例从 5777 改成中性的 3000（tunnel 不带 --port 时默认映射 127.0.0.1:3000）

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
