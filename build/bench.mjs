// 简单基准：本地 echo 上游 vs 经过密码门，测吞吐/延迟，以及进程内存与冷启动
// 用法: node build/bench.mjs
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UP = 19991, GW = 18461, PW = 'bench-pw';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function raw(port, text) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const s = net.connect(port, '127.0.0.1');
    const fin = () => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(Buffer.concat(chunks).toString('latin1')); };
    s.on('connect', () => s.write(text));
    s.on('data', (d) => chunks.push(d));
    s.on('close', fin); s.on('error', fin);
    setTimeout(fin, 5000);
  });
}
function rss(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue).WorkingSet64'], { encoding: 'utf8', windowsHide: true });
  const n = Number((r.stdout || '').trim());
  return isNaN(n) ? 0 : Math.round(n / 1048576);
}
async function load(port, headers, total, conc, agent) {
  const lat = [];
  let next = 0;
  async function worker() {
    while (next < total) {
      next++;
      const t0 = process.hrtime.bigint();
      await new Promise((res) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', agent, headers }, (r) => {
          r.resume();
          r.on('end', () => { lat.push(Number(process.hrtime.bigint() - t0) / 1e6); res(); });
        });
        req.on('error', () => res());
        req.end();
      });
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: conc }, worker));
  const ms = Date.now() - t0;
  lat.sort((a, b) => a - b);
  const pick = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] || 0;
  return { rps: Math.round(total / (ms / 1000)), p50: pick(0.5).toFixed(2), p95: pick(0.95).toFixed(2), p99: pick(0.99).toFixed(2), n: lat.length };
}

const up = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('echo-ok'); });
await new Promise((r) => up.listen(UP, '127.0.0.1', r));

const gate = spawn(process.execPath, [path.join(ROOT, 'tunnel.js'), '--port', String(UP), '--gateway', String(GW),
  '--password', PW, '--ttl', '10m', '--no-tunnel'], { cwd: ROOT, windowsHide: true, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { await sleep(250); const r = await raw(GW, 'GET /__login HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nConnection: close\r\n\r\n'); if (r.startsWith('HTTP/1.1 200')) break; }

const login = await raw(GW, 'POST /__auth HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nOrigin: http://127.0.0.1:' + GW +
  '\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ' + ('password=' + PW).length + '\r\nConnection: close\r\n\r\npassword=' + PW);
const cookie = (login.match(/tunnel_session=[\d]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) || [''])[0];

const agent = new http.Agent({ keepAlive: true, maxSockets: 40 });
await load(UP, {}, 300, 40, agent);
const direct = await load(UP, {}, 4000, 40, agent);
await load(GW, { cookie }, 300, 40, agent);
const gated = await load(GW, { cookie }, 4000, 40, agent);

console.log('== 吞吐 / 延迟（本地，keep-alive，40 并发，4000 请求）==');
console.log('  直连上游       : ' + direct.rps + ' req/s   p50=' + direct.p50 + 'ms  p95=' + direct.p95 + 'ms  p99=' + direct.p99 + 'ms');
console.log('  经过密码门     : ' + gated.rps + ' req/s   p50=' + gated.p50 + 'ms  p95=' + gated.p95 + 'ms  p99=' + gated.p99 + 'ms');
console.log('  密码门额外开销 : p50 +' + (gated.p50 - direct.p50).toFixed(2) + 'ms   （HMA/Cookie 校验 + 代理转发 + 头部清洗）');

console.log('\n== 内存（一个通道 = 一个本机密码门进程 + 一个 cloudflared 进程）==');
console.log('  密码门进程 RSS : ' + rss(gate.pid) + ' MB');
const cfRss = spawnSync('powershell', ['-NoProfile', '-Command',
  '@(Get-Process -Name cloudflared -ErrorAction SilentlyContinue | Select-Object -First 1).WorkingSet64'], { encoding: 'utf8', windowsHide: true });
console.log('  cloudflared RSS: ' + (Math.round(Number((cfRss.stdout || '0').trim()) / 1048576) || '未在运行（本机当前无隧道）') + ' MB');

console.log('\n== 冷启动 / 体积 ==');
for (const [label, cmd, args] of [['node tunnel.js --help', process.execPath, [path.join(ROOT, 'tunnel.js'), '--help']],
  ['dist/oct.exe --help', path.join(ROOT, 'dist', 'oct.exe'), ['--help']]]) {
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    spawnSync(cmd, args, { windowsHide: true, stdio: 'ignore' });
    times.push(Date.now() - t0);
  }
  console.log('  ' + label.padEnd(30) + ': ' + times.join(' / ') + ' ms');
}
const fs = await import('node:fs');
const sz = (p) => { try { return (fs.statSync(p).size / 1048576).toFixed(1) + ' MB'; } catch (e) { return '-'; } };
console.log('  oct.exe             : ' + sz(path.join(ROOT, 'dist', 'oct.exe')));
console.log('  cloudflared.exe               : ' + sz(path.join(ROOT, 'dist', 'cloudflared.exe')));
const zip = fs.readdirSync(path.join(ROOT, 'release')).filter((f) => f.endsWith('.zip')).pop();
console.log('  便携安装包 zip                : ' + sz(path.join(ROOT, 'release', zip)));

try { gate.kill(); } catch (e) {}
try { up.close(); } catch (e) {}
await sleep(500);
process.exit(0);
