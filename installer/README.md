# 一键隧道 OCT（one-click-tunnel）— 免安装 exe 版

> English documentation: https://github.com/Thunderunruly/one-click-tunnel#readme
> English changelog: https://github.com/Thunderunruly/one-click-tunnel/blob/main/CHANGELOG.md

把本机某个端口临时暴露到公网（Cloudflare Quick Tunnel），外面的人必须先输密码才能访问，
到点自动关闭。不需要管理员权限，所有文件都在当前用户目录里。

## 一键安装

1. 把整个文件夹解压到任意位置（例如桌面上的一个文件夹）
2. 双击 install.cmd
3. 装完后桌面/开始菜单会出现「一键隧道」，双击即用

安装位置：%LOCALAPPDATA%\one-click-tunnel （约 135 MB：exe + cloudflared）
卸载：双击安装目录里的 uninstall.cmd，或在「设置 → 应用」里卸载（不留残留）

## 使用

双击「一键隧道」后，窗口里会显示：

- 临时公网地址：https://xxxx-xxxx.trycloudflare.com
- 访问密码：随机生成（也可以自己指定）
- 自动关闭时间：默认 1 小时后自动关闭并退出

把地址 + 密码发给对方即可。对方第一次打开要先输入密码。

也可以命令行运行（参数见 oct.exe --help）：

    oct.exe                         把 127.0.0.1:3000 映射出去，1 小时，随机密码
    oct.exe --port 8090 --ttl 30m   映射 8090 端口，30 分钟
    oct.exe --port 3081 --ttl 6h --password 自定义密码
    oct.exe --no-tunnel             只起本地密码门，不建公网隧道（排障用）

关闭方式：到点自动关闭 / 窗口里 Ctrl+C / 双击 stop.cmd

## 安全设计（摘要）

- 密码门只监听 127.0.0.1，公网流量只能经 Cloudflare 隧道进来
- 会话 Cookie：HMAC 签名 + 独立随机 sid + HttpOnly + SameSite=Lax（https 下带 Secure），登出即刻服务端吊销
- 密码校验用恒定时间比较；同一 IP 连错 8 次锁 5 分钟；另有每分钟请求上限
- 转发前剥掉网关自己的 Cookie / Basic 口令，改写 Host（防 Host 注入），覆盖 X-Forwarded-For（防伪造）
- 拒绝 TRACE/TRACK、CONNECT、绝对形式请求行；未认证不读请求体、不碰上游
- 登录页不泄露目标端口与剩余时间；带 Origin 的跨站提交直接 403
- 到 TTL 自动杀掉隧道进程树；残留 pid 文件会在下次启动时回收
- 日志（logs 目录）只记事件，不记访问密码

安全自测（源码目录里运行，需要 Node 22）：

    node security-test.mjs         离线 72 项（自带 echo 上游，不联网）
    node security-test-live.mjs    联网 17 项（真开一条隧道从公网侧验证）

## 常见问题

- 提示 530 / 打不开：隧道已关闭（到点或手动关的）
- DNS 解析不了 xxxx.trycloudflare.com：某些路由器/运营商 DNS 不解析该域名，
  在浏览器里开启「安全 DNS / DoH」（Cloudflare 或 Google）即可
- 误报毒：单文件 exe 是 Node SEA 打包产物，未做代码签名，可能被 Defender SmartScreen 提示；
  选「仍要运行」即可，或自行用 node build/make-exe.mjs 重新打包
