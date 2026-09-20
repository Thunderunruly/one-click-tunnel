
import subprocess, json, urllib.request, urllib.error, os, zipfile, io, struct
REPO = 'Thunderunruly/one-click-tunnel'
def token():
    p = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n', capture_output=True, text=True, cwd=r'D:\Program\public-tunnel')
    for line in p.stdout.splitlines():
        if line.startswith('password='): return line[len('password='):].strip()
    return ''
tok = token()
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)
def fetch(url, accept='application/vnd.github+json'):
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + tok, 'User-Agent': 'oct', 'Accept': accept})
    try:
        return opener.open(req, timeout=300).read()
    except urllib.error.HTTPError as e:
        loc = e.headers.get('Location')
        if e.code in (301, 302, 303, 307, 308) and loc:
            return urllib.request.urlopen(urllib.request.Request(loc, headers={'User-Agent': 'oct'}), timeout=300).read()
        raise
arts = json.loads(fetch('https://api.github.com/repos/' + REPO + '/actions/artifacts?per_page=10'))['artifacts']
win = [a for a in arts if a['name'] == 'oct-poc-windows'][0]
print('下载', win['name'], '%.1f MB' % (win['size_in_bytes'] / 1048576), flush=True)
blob = fetch(win['archive_download_url'])
zf = zipfile.ZipFile(io.BytesIO(blob))
name = [n for n in zf.namelist() if n.endswith('.exe')][0]
dest = r'D:\Program\public-tunnel\poc\fyne\oct-poc-windows.exe'
open(dest, 'wb').write(zf.read(name))
print('已保存 %s (%.2f MB)' % (dest, os.path.getsize(dest) / 1048576))
b = open(dest, 'rb').read()
pe = struct.unpack_from('<I', b, 0x3C)[0]
sub = struct.unpack_from('<H', b, pe + 24 + 0x44)[0]
print('PE subsystem=%d -> %s' % (sub, 'GUI（不弹控制台）' if sub == 2 else 'Console'))
