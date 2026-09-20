
import subprocess, json, urllib.request, urllib.error, os, zipfile, io, struct, time
REPO = 'Thunderunruly/one-click-tunnel'
LOG = r'D:\Program\public-tunnel\build\_dlpoc.log'
def log(s):
    with open(LOG, 'a', encoding='utf-8') as f: f.write(time.strftime('%H:%M:%S ') + s + '\n')
def tok():
    p = subprocess.run(['git','credential','fill'], input='protocol=https\nhost=github.com\n\n', capture_output=True, text=True, cwd=r'D:\Program\public-tunnel')
    for l in p.stdout.splitlines():
        if l.startswith('password='): return l[9:].strip()
    return ''
t = tok()
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
op = urllib.request.build_opener(NoRedirect)
def get(url, accept='application/vnd.github+json', hdr=None):
    h = {'Authorization': 'Bearer ' + t, 'User-Agent': 'oct', 'Accept': accept}
    if hdr: h.update(hdr)
    try:
        return op.open(urllib.request.Request(url, headers=h), timeout=600).read()
    except urllib.error.HTTPError as e:
        loc = e.headers.get('Location')
        if e.code in (301,302,303,307,308) and loc:
            h2 = {'User-Agent': 'oct'}
            if hdr: h2.update(hdr)
            return urllib.request.urlopen(urllib.request.Request(loc, headers=h2), timeout=600).read()
        raise
try:
    log('开始')
    arts = json.loads(get('https://api.github.com/repos/' + REPO + '/actions/artifacts?per_page=20'))['artifacts']
    win = [a for a in arts if a['name'] == 'oct-poc-windows' and not a['expired']][0]
    log('产物 %s %.2f MB id=%s' % (win['name'], win['size_in_bytes']/1048576, win['id']))
    blob = get(win['archive_download_url'], accept='application/vnd.github+json')
    log('下载完成 %d 字节' % len(blob))
    zf = zipfile.ZipFile(io.BytesIO(blob))
    name = [n for n in zf.namelist() if n.endswith('.exe')][0]
    dest = r'D:\Program\public-tunnel\poc\fyne\oct-poc-windows.exe'
    open(dest, 'wb').write(zf.read(name))
    b = open(dest, 'rb').read()
    pe = struct.unpack_from('<I', b, 0x3C)[0]
    sub = struct.unpack_from('<H', b, pe + 24 + 0x44)[0]
    log('OK 已保存 %s (%.2f MB) subsystem=%d' % (dest, len(b)/1048576, sub))
except Exception as e:
    log('失败: %s: %s' % (type(e).__name__, e))
