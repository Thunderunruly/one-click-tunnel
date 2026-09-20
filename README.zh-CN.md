# 临时公网映射小工具（public-tunnel）

[English](README.md) · [更新日志](CHANGELOG.md) · [下载最新版](https://github.com/Thunderunruly/one-click-tunnel/releases/latest)

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

## 自有域名（命名隧道，地址永久固定）

快速隧道每次都是随机地址（`xxxx.trycloudflare.com`，重启就换）。如果你的域名托管在 Cloudflare，
可以让通道用一个**永久固定**的地址：

    tunnel login                        浏览器授权一次（选择你的域名）
    tunnel domain web app.example.com   建命名隧道 + 加 DNS 记录 + 写回配置
    tunnel start web                    之后就一直走 https://app.example.com

- 授权证书存在 `state/cloudflare/cert.pem`，一个账号只需要登录一次
- 建隧道时会把凭据复制到 `state/cloudflare/`，并把配置改成 `mode=named` + `ttl=forever`
- **公网地址背后仍然是本机密码门**：域名固定不等于对外开放，访问依旧要密码
- `tunnel info [id]` 看类型/域名/隧道ID/还差什么；`--dry-run` 只生成配置不启动（排障用）
- 配置页里有「登录 Cloudflare」按钮，每条通道卡片上可以切换 快速/命名 隧道并绑定域名
- AI 也能做：MCP 工具 `cloudflare_login` / `set_custom_domain` / `cloudflare_status`
- 前提：域名 DNS 由 Cloudflare 托管（免费版就行）

生成的 cloudflared 配置（`state/cloudflare/<id>.cloudflared.yml`）把域名指向**本地密码门**，业务端口不会被直接暴露。

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

## 为什么不用 Go 重写（有实测数据）

密码门是 I/O 密集型，不是 CPU 密集型。本地回环基准（`build/bench.mjs`，4000 请求 / 40 并发 / keep-alive）：
密码门只增加 **p50 +0.62ms**、保留约 86% 的原始吞吐（14.0k vs 16.3k req/s）；而真实链路
Internet -> Cloudflare 边缘 -> cloudflared -> 密码门 -> 你的应用 里，耗时主要是网络和 cloudflared
（**cloudflared 本身就是 Go 写的**）。

| 指标 | 实测值 |
| --- | --- |
| 密码门额外延迟 | p50 +0.62ms、p95 +1.25ms |
| 吞吐 | 经过门 14,035 req/s；直连 16,260 req/s |
| 单通道内存 | 密码门 72 MB + cloudflared 46 MB |
| 冷启动 | 55 ms |
| 产物体积 | exe 83.4 MB、cloudflared 52.4 MB、便携 zip 49.2 MB |

用 Go 重写主要能换来更小的二进制（约 10MB）和更少的内存，属于**分发/资源占用**的收益，不是性能收益，
所以决定保留 Node 实现。随时可以 `node build/bench.mjs`（或 `npm run bench`）复测；将来真遇到这个量级的负载，
再拿数据重新评估。

## 无控制台启动器（不依赖 VBScript）

桌面/开始菜单快捷方式指向 `one-click-tunnel.exe` —— 一个约 7KB 的原生小程序，源码在 build/launcher/Launcher.cs，
用 Windows 自带的 csc.exe 编译（`node build/make-launcher.mjs`）。它是 **GUI 子系统**程序（PE Subsystem=2），
隐藏启动 `public-tunnel.exe app` 后立刻退出，**不会闪出命令行窗口**。
这同时去掉了对 VBScript 的依赖（微软正在弃用它，Win11 24H2 起是可选功能）。

## 把局域网设备映射出去（不只是本机端口）

默认目标是 `127.0.0.1:<port>`。要把局域网里的另一台设备（NAS、摄像头、打印机面板、别的机器上的服务）发出去，
直接指定目标地址：

    public-tunnel.exe --target 192.168.1.50:8080 --ttl 1h
    public-tunnel.exe add --name nas --port 5000 --target 192.168.1.50:5000

- **默认允许**：回环、10/8、172.16/12、192.168/16、fc00::/7，以及解析到这些地址的主机名
- **默认拒绝**：公网地址、0.0.0.0/::、组播、链路本地（169.254.x.x，含云元数据 169.254.169.254），
  避免这个工具变成开放代理；确实需要时用 --allow-public-target
- 密码门一模一样生效；设备看到的 Host 头是**它自己的地址**（原来给的是 127.0.0.1:网关，设备不认），要改可用 --upstream-host
- https 上游：--target-secure（自签证书配 --target-insecure-tls）
- 配置页有「目标地址」输入框；MCP 的 create_tunnel 支持 target；tunnel info 会显示目标地址
