// 上游目标（本机 / 局域网设备）测试：地址校验 + 真把"局域网设备"通过密码门转出去
// 用法: node test-upstream.mjs
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const U = require(path.join(HERE, 'lib', 'upstream.js'));
let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function raw(port, text, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const s = net.connect(port, '127.0.0.1');
    const fin = () => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(Buffer.concat(chunks).toString('latin1')); };
    s.on('connect', () => s.write(text));
    s.on('data', (d) => chunks.push(d));
    s.on('close', fin); s.on('error', fin);
    setTimeout(fin, timeoutMs || 5000);
  });
}
function pickLanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      const p = it.address.split('.').map(Number);
      const priv = p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
      if (priv) return it.address;
    }
  }
  return '';
}

console.log('== 地址校验（默认只允许本机/局域网）==');
const cases = [
  ['192.168.1.50:8080', true, 'lan'],
  ['10.0.0.9:81', true, 'lan'],
  ['172.20.5.5:81', true, 'lan'],
  ['127.0.0.1:3000', true, 'loopback'],
  ['localhost:3000', true, 'loopback'],
  ['[::1]:3000', true, 'loopback'],
  ['8.8.8.8:80', false, ''],
  ['172.32.5.5:81', false, ''],
  ['169.254.169.254:80', false, ''],
  ['0.0.0.0:8080', false, ''],
  ['http://192.168.1.5:80', false, ''],
];
let idx = 0;
for (const [t, allowed, kind] of cases) {
  idx++;
  let r = null, err = '';
  try { r = await U.resolveTarget({ target: t, port: 3000 }); } catch (e) { err = e.message; }
  const good = allowed ? (!!r && r.kind === kind) : (!r && !!err);
  ok('U' + idx + ' ' + t + ' → ' + (allowed ? ('允许（' + kind + '）') : '默认拒绝'), good, r ? JSON.stringify({ kind: r.kind, host: r.host, port: r.port }) : err.slice(0, 70));
}
const pub = await U.resolveTarget({ target: '8.8.8.8:80', allowPublic: true }).then((r) => r).catch(() => null);
ok('U12 显式 allowPublic 后才允许公网目标', !!pub && pub.kind === 'public');
const noPort = await U.resolveTarget({ target: '192.168.1.50', port: 3000 });
ok('U13 省略端口时用 --port 的值', noPort.port === 3000 && noPort.host === '192.168.1.50');

console.log('== 端口/参数校验 ==');
ok('U14 端口非法直接报错', await U.resolveTarget({ target: '192.168.1.5:70000' }).then(() => false).catch(() => true));
ok('U15 带 http:// 前缀会被拦下', await U.resolveTarget({ target: 'http://192.168.1.5:80' }).then(() => false).catch((e) => /不要带/.test(e.message)));

console.log('== 端到端：把"局域网设备"通过密码门转出去 ==');
const lanIp = pickLanIp();
if (!lanIp) {
  console.log('  （本机没有私有 IPv4，跳过端到端部分）');
} else {
  console.log('  用本机局域网地址模拟设备: ' + lanIp);
  const DEV = 19977, GW = 18465, PW = 'lan-pw';
  let sawHost = '';
  const device = http.createServer((req, res) => {
    sawHost = String(req.headers.host || '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('LAN-DEVICE-OK');
  });
  await new Promise((r) => device.listen(DEV, lanIp, r));
  const gate = spawn(process.execPath, [path.join(HERE, 'tunnel.js'), '--target', lanIp + ':' + DEV,
    '--gateway', String(GW), '--password', PW, '--ttl', '5m', '--no-tunnel'], { cwd: HERE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let gateOut = '';
  gate.stdout.on('data', (d) => { gateOut += d.toString(); });
  gate.stderr.on('data', (d) => { gateOut += d.toString(); });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const r = await raw(GW, 'GET /__login HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nConnection: close\r\n\r\n');
    if (r.startsWith('HTTP/1.1 200')) break;
  }
  ok('U16 门已就绪且日志显示目标类型（局域网设备）', /局域网设备/.test(gateOut), gateOut.split('\n').filter((l) => /目标|上游/.test(l)).join(' | ').slice(0, 120));
  const noAuth = await raw(GW, 'GET / HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nConnection: close\r\n\r\n');
  ok('U17 局域网设备同样要先过密码（未认证 401）', /^HTTP\/1\.1 401/.test(noAuth), noAuth.split('\r\n')[0]);
  const login = await raw(GW, 'POST /__auth HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nOrigin: http://127.0.0.1:' + GW +
    '\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ' + ('password=' + PW).length + '\r\nConnection: close\r\n\r\npassword=' + PW);
  const cookie = (login.match(/tunnel_session=[\d]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) || [''])[0];
  const via = await raw(GW, 'GET /x HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n');
  ok('U18 认证后确实转到了局域网设备（拿到它的响应）', /LAN-DEVICE-OK/.test(via), via.slice(-60).replace(/\r?\n/g, ' '));
  ok('U19 上游看到的 Host 是设备地址（不是 127.0.0.1）', sawHost === lanIp + ':' + DEV, sawHost);
  try { gate.kill(); } catch (e) {}
  await sleep(400);
  try { device.close(); } catch (e) {}
}

console.log('== 公网目标被拒绝时进程怎么退出 ==');
const bad = spawnSync(process.execPath, [path.join(HERE, 'tunnel.js'), '--target', '8.8.8.8:80', '--no-tunnel', '--gateway', '18466'], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 30000 });
ok('U20 公网目标：退出码 2 + 可读提示', bad.status === 2 && /公网地址/.test((bad.stderr || '') + (bad.stdout || '')), 'rc=' + bad.status + ' ' + String(bad.stderr || '').trim().slice(0, 80));

console.log('\n================ 上游目标测试结果 ================');
console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
for (const f of failures) console.log('  FAILED: ' + f);
process.exit(failures.length ? 1 : 0);
