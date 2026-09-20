
import subprocess, json, urllib.request, time, sys
REPO = 'Thunderunruly/one-click-tunnel'
def token():
    p = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n', capture_output=True, text=True, cwd=r'D:\Program\public-tunnel')
    for line in p.stdout.splitlines():
        if line.startswith('password='): return line[len('password='):].strip()
    return ''
tok = token()
def api(u):
    h = {'User-Agent': 'oct', 'Accept': 'application/vnd.github+json'}
    if tok: h['Authorization'] = 'Bearer ' + tok
    return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=60).read())

deadline = time.time() + 480
last = ''
while time.time() < deadline:
    runs = api('https://api.github.com/repos/' + REPO + '/actions/runs?per_page=5')['workflow_runs']
    f = [r for r in runs if r['name'] == 'Fyne PoC (3 platforms)']
    if not f:
        print('还没看到 PoC 工作流'); time.sleep(20); continue
    r = f[0]
    jobs = api('https://api.github.com/repos/' + REPO + '/actions/runs/' + str(r['id']) + '/jobs')['jobs']
    st = ' | '.join('%s:%s' % (j['name'].replace('build on ', ''), j['status'] + ('/' + str(j.get('conclusion')) if j.get('conclusion') else '')) for j in jobs)
    line = r['status'] + ' :: ' + st
    if line != last: print(line, flush=True); last = line
    if r['status'] == 'completed':
        print('run 完成:', r.get('conclusion'), r['html_url'])
        break
    time.sleep(30)
arts = api('https://api.github.com/repos/' + REPO + '/actions/artifacts?per_page=10')['artifacts']
print('产物:')
for a in arts[:6]:
    print('  %-24s %8.2f MB  expired=%s  id=%s' % (a['name'], a['size_in_bytes'] / 1048576, a['expired'], a['id']))
