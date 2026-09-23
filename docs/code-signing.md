# 代码签名（SignPath，开源免费）

## 为什么需要

Windows 产物全是**未签名**的可执行文件：oct.exe（Node SEA 引擎，80+ MB）、oct_shell.exe（Flutter 外壳）、
安装器 one-click-tunnel-setup-*.exe。刚编出来、没下载信誉、又没签名，Microsoft Defender / Edge 的 SmartScreen
会直接判定「检测到病毒」并**拒绝下载**（oct-shell-windows-x64.zip 已经被拦过多次）。

签名之后：不再被拦、安装器不弹「未知发布者」。这是唯一能根治的办法，改包名、换压缩格式都只是躲一时。

## 为什么用 SignPath

SignPath（https://signpath.io）对开源项目免费（SignPath Foundation），而且**证书由他们持有和管理**——
我们不用每年买 OV/EV 证书，也不用自己保管私钥。签名在他们的服务上完成，CI 只负责送过去、等结果、取回来。

## 需要你做的（只有账号持有者能做）

### 第一步：申请

1. 用 GitHub 账号登录 https://signpath.io ，找到开源免费申请入口（https://signpath.org/ 上有 Apply）。
2. 申请时填：
   - 项目名：one-click-tunnel
   - 仓库：https://github.com/Thunderunruly/one-click-tunnel
   - 许可证：MIT License / Copyright (c) 2026 Haosheng Yao
   - 构建方式：GitHub Actions（公开仓库）
   - 用途一句话：把本机/局域网端口映射到公网的开源工具，给 Windows 用户提供免安装的图形界面与命令行引擎。
3. 等审核（通常几天）。他们会确认项目活跃度——我们的 release 与 CI 都在跑，没问题。

### 第二步：拿到三个值 + 一个 token

审核通过后在 SignPath 网页上：

1. 建 Organization，记下 **organization id**（形如 0f0f0f0f-1111-2222-...）。
2. 建 Project，slug 建议 one-click-tunnel。
3. 建 Signing policy，slug 建议 release-signing（OSS 一般选自动签名）。
4. 建 Artifact configuration，slug 建议 windows-binaries，内容直接用仓库里的 .signpath/artifact-configuration.xml。
5. 生成一个 API token（CI 用，权限限定在签名请求）。
6. GitHub 仓库 → Settings → Secrets and variables → Actions → 新建 Secret：名字 SIGNPATH_API_TOKEN，值填那个 token。

然后把这三样发我（都不是秘密，只是标识符）：organization-id、project-slug、signing-policy-slug。

## 拿到之后我会做的

两条流水线里插签名步骤，顺序很关键：

release.yml（正式版）：
1. node build/make-exe.mjs 编出 oct.exe 与 one-click-tunnel.exe
2. 打一个待签 zip 送 SignPath，签 oct.exe 与 one-click-tunnel.exe，取回已签名文件
3. 再打便携 zip，再用 Inno Setup 打安装器
4. **安装器要单独再签一次**（否则装出来还是「未知发布者」）
5. 最后才算 SHA256SUMS（必须在签名之后，否则校验和对不上）

flutter-shell.yml（预览版）：
1. flutter build windows 出 oct_shell.exe
2. 把 oct_shell.exe（连带 oct.exe）送签
3. 再打 zip / tar.gz

## 注意

- 免费额度有限：SignPath 对 OSS 有每月签名请求上限，所以只在 release 与预览版流水线签，日常测试构建不签。
- cloudflared.exe 不签：Cloudflare 已经签过，再签会破坏它的签名链。
- macOS 不走 SignPath：macOS 签名与公证只能用 Apple 开发者账号（99 美元/年）。当前 macOS 包是 ad-hoc 签名，
  用户首次打开要右键 → 打开。要正经做需要买账号。
- 没配 token 也不会坏：签名步骤会写成「没有 SIGNPATH_API_TOKEN 就跳过」，所以在你申请通过前流水线照旧出未签名的包。
