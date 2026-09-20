
import subprocess, json, urllib.request, urllib.error, hashlib, re

REPO = 'Thunderunruly/one-click-tunnel'
p = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
                   capture_output=True, text=True, cwd=r'D:\Program\public-tunnel')
token = ''
for line in p.stdout.splitlines():
    if line.startswith('password='):
        token = line[len('password='):].strip()

def api(method, url, body=None, accept='application/vnd.github+json'):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
        headers={'Authorization': 'Bearer ' + token, 'User-Agent': 'oct', 'Accept': accept, 'Content-Type': 'application/json'})
    try:
        r = urllib.request.urlopen(req, timeout=300)
        raw = r.read()
        try: return r.status, json.loads(raw)
        except Exception: return r.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')[:200]

base = 'https://api.github.com/repos/' + REPO
st, rel = api('GET', base + '/releases/tags/v1.2.1')
assets = {a['name']: a for a in rel['assets']}
sums = api('GET', [a for a in rel['assets'] if 'SHA256SUMS' in a['name']][0]['url'], accept='application/octet-stream')[1].decode('utf-8', 'replace')
want = {}
for line in sums.strip().split('\n'):
    m = re.match(r'^([0-9a-f]{64})\s+\*?(.+)$', line.strip())
    if m: want[m.group(2).strip()] = m.group(1)
print('== 校验线上发布物是否与清单一致 ==')
for name in ['one-click-tunnel-setup-1.2.1.exe', 'one-click-tunnel-1.2.1-win-x64.zip']:
    if name not in assets: continue
    blob = api('GET', assets[name]['url'], accept='application/octet-stream')[1]
    if not isinstance(blob, bytes):
        print('  %s 下载失败: %s' % (name, str(blob)[:100])); continue
    h = hashlib.sha256(blob).hexdigest()
    print('  %-42s %6.1f MB  sha256=%s  与清单一致: %s' % (name, len(blob) / 1048576, h[:16] + '...', h == want.get(name)))

BODY = '''## 一键安装（Windows 10/11，免管理员）

1. 想省事：下载 **one-click-tunnel-setup-{V}.exe**，双击安装，开始菜单/桌面会出现快捷方式
2. 想免安装：下载 **one-click-tunnel-{V}-win-x64.zip**，解压后双击 install.cmd

装好后双击快捷方式即可：会打开本地图形化配置页（后台守护进程 + 托盘图标），
可以同时开多条隧道，每条独立端口、独立密码、独立到期时间。

## 浏览器 / Windows 会警告，这是正常的

这个包**没有代码签名证书**（个人项目，证书一年几百到上千元），所以：

- Chrome / Edge 下载时会提示「通常不会下载 one-click-tunnel-setup-{V}.exe」→ 点下载项右侧的「…」→ 选择「保留」；
  或者干脆下 zip 版，zip 一般不会被拦
- 第一次运行会弹 SmartScreen「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」
- 也可以右键文件 → 属性 → 勾选「解除锁定」（浏览器给下载文件加的标记），再运行就不弹了

这只是「未签名 + 下载量少」的启发式拦截，**不是病毒报毒**。想确认文件没被篡改，自己核对哈希即可
（SHA256SUMS.txt 在同一次发布的 Assets 里）：

    Get-FileHash .\\one-click-tunnel-setup-{V}.exe -Algorithm SHA256
    certutil -hashfile one-click-tunnel-{V}-win-x64.zip SHA256

与 SHA256SUMS.txt 里对应那一行完全一致 => 文件就是 CI 从源码构建出来的那一份。

## 这一版包含

- **多通道**：同时开多条隧道，每条独立本机端口 / 网关端口 / 密码 / TTL，互不影响
- **图形化配置页**（只监听 127.0.0.1，需 token）+ **系统托盘**，可最小化到托盘常驻
- **MCP 服务**：Claude / Cursor 等 AI 宿主可直接开 / 关 / 改通道（工具 check_update 还能查更新）
- **自动更新**：程序自己拉 Release 比较版本，下载安装包会用 SHA256SUMS.txt 校验，不匹配直接删除
- **安全**：恒定时间密码比较、HMAC + 随机 sid 会话、按 IP 锁定与限流、Host 白名单改写、
  XFF 覆盖、拒绝 TRACE/CONNECT、TTL 自动关停、pid 残留回收；配置页 token + 同源校验 + CSP
- 可重复运行的安全测试：72 + 25 + 33 + 31 + 27 + 18 项（见仓库 README）
'''

for tag in ['v1.2.1', 'v1.2.0']:
    st, r = api('GET', base + '/releases/tags/' + tag)
    if st != 200:
        print('取 %s release 失败: %s' % (tag, st)); continue
    ver = tag.lstrip('v')
    body = BODY.replace('{V}', ver)
    st2, res = api('PATCH', base + '/releases/' + str(r['id']), {'body': body, 'name': 'one-click-tunnel ' + ver})
    print('更新 %s 的发布说明 -> %s （%d 字）' % (tag, st2, len(body)))
