
import subprocess, json, urllib.request, os, sys, time
def token():
    p = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n', capture_output=True, text=True, cwd=r'D:\Program\public-tunnel')
    for line in p.stdout.splitlines():
        if line.startswith('password='): return line[len('password='):].strip()
    return ''
tok = token()
def get(url, accept='application/vnd.github+json'):
    h = {'User-Agent': 'oct', 'Accept': accept}
    if tok: h['Authorization'] = 'Bearer ' + tok
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=420).read()
rel = json.loads(get('https://api.github.com/repos/skeeto/w64devkit/releases/latest'))
a = [x for x in rel['assets'] if x['name'].endswith('.7z.exe') and 'x64' in x['name']][0]
dest = r'C:\Users\ASUS\AppData\Local\Temp\w64sfx.exe'
print('下载 %s (%.1f MB) ...' % (a['name'], a['size'] / 1048576), flush=True)
t0 = time.time()
blob = get(a['url'], accept='application/octet-stream')
open(dest, 'wb').write(blob)
print('完成 %.1f MB，用时 %.0f 秒' % (len(blob) / 1048576, time.time() - t0), flush=True)
