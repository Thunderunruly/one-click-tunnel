
import subprocess, json, urllib.request, urllib.error, hashlib, os, glob, re, time

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
        r = urllib.request.urlopen(req, timeout=90)
        raw = r.read()
        try: return r.status, json.loads(raw)
        except Exception: return r.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')[:200]

base = 'https://api.github.com/repos/' + REPO
st, rel = api('GET', base + '/releases/tags/v1.2.1')
assets = {a['name']: a for a in rel['assets']}
sums_asset = [a for a in rel['assets'] if 'SHA256SUMS' in a['name']][0]
st, blob = api('GET', sums_asset['url'], accept='application/octet-stream')
sums_txt = blob.decode('utf-8', 'replace') if isinstance(blob, bytes) else str(blob)
want = {}
for line in sums_txt.strip().split('\n'):
    m = re.match(r'^([0-9a-f]{64})\s+\*?(.+)$', line.strip())
    if m: want[m.group(2).strip()] = m.group(1)

# 找用户下载目录里的文件
cands = []
for pat in [os.path.expanduser('~/Downloads/one-click-tunnel*'), os.path.expanduser('~/下载/one-click-tunnel*'), r'D:\*\one-click-tunnel-setup*.exe', r'C:\Users\ASUS\Downloads\*']:
    cands += glob.glob(pat)
cands = sorted(set(c for c in cands if os.path.isfile(c)), key=lambda f: -os.path.getmtime(f))
print('下载目录里找到的候选文件：')
for c in cands[:6]:
    print('   %-70s %8.1f MB  %s' % (c, os.path.getsize(c) / 1048576, time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(c)))))

for c in cands[:6]:
    name = os.path.basename(c)
    # 浏览器可能加 (1)
    key = name if name in want else re.sub(r' \(\d+\)(?=\.[a-z]+$)', '', name)
    if key not in want:
        print('   %s -> 清单里没有同名条目，跳过' % name); continue
    h = hashlib.sha256()
    with open(c, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    d = h.hexdigest()
    print('   %s\\n     文件 sha256 = %s\\n     清单 sha256 = %s\\n     一致: %s' % (name, d, want[key], d == want[key]))
