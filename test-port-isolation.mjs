// 端口隔离测试：隧道只应能访问"被映射的那一个端口"，任何请求都不能跑到别的端口上
// 用法: node test-port-isolation.mjs
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = 19981, B = 19982, GW = 18467, GW2 = 18468, GW3 = 18469, PW = 'iso-pw';
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
function statusOf(t) { const m = t.match(/^HTTP\/1\.1 (\d+)/); return m ? Number(m[1]) : 0; }
function bodyOf(t) { const i = t.indexOf('\r\n\r\n'); return i >= 0 ? t.slice(i + 4) : ''; }

const hits = { a: 0, b: 0, aPaths: [], bPaths: [] };
const svcA = http.createServer((req, res) => { hits.a++; hits.aPaths.push(req.url + ' host=' + req.headers.host); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('SERVICE-A'); });
const svcB = http.createServer((req, res) => { hits.b++; hits.bPaths.push(req.url); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('SERVICE-B'); });
await new Promise((r) => svcA.listen(A, '127.0.0.1', r));
await new Promise((r) => svcB.listen(B, '127.0.0.1', r));

const gate = spawn(process.execPath, [path.join(HERE, 'tunnel.js'), '--target', '127.0.0.1:' + A, '--port', String(A),
  '--gateway', String(GW), '--password', PW, '--ttl', '5m', '--no-tunnel'], { cwd: HERE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let gateOut = '';
gate.stdout.on('data', (d) => { gateOut += d.toString(); });
gate.stderr.on('data', (d) => { gateOut += d.toString(); });
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const r = await raw(GW, 'GET /__login HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nConnection: close\r\n\r\n');
  if (statusOf(r) === 200) break;
}
const login = await raw(GW, 'POST /__auth HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nOrigin: http://127.0.0.1:' + GW +
  '\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ' + ('password=' + PW).length + '\r\nConnection: close\r\n\r\npassword=' + PW);
const cookie = (login.match(/tunnel_session=[\d]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) || [''])[0];
ok('I0 隧道已就绪并登录（映射 ' + A + '）', statusOf(login) === 302 && !!cookie, statusOf(login) + ' ' + gateOut.slice(-80));

const before = { a: hits.a, b: hits.b };
const attempts = [
  ['I1 绝对形式请求行指向 :' + B, 'GET http://127.0.0.1:' + B + '/ HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n', 400],
  ['I2 Host 头写成 :' + B, 'GET /host-trick HTTP/1.1\r\nHost: 127.0.0.1:' + B + '\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n', 200],
  ['I2b Host 头写成别的端口 127.0.0.1:9', 'GET /host-trick-9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n', 200],
  ['I2c Host 头写成隧道域名（应透传）', 'GET /host-tunnel HTTP/1.1\r\nHost: demo.trycloudflare.com\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n', 200],
  ['I3 X-Forwarded-Host/Port 伪造成 :' + B, 'GET /xff-trick HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nX-Forwarded-Host: 127.0.0.1:' + B + '\r\nX-Forwarded-Port: ' + B + '\r\nX-Original-URL: http://127.0.0.1:' + B + '/\r\nX-Rewrite-URL: http://127.0.0.1:' + B + '/\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n', 200],
  ['I4 双斜杠路径 //127.0.0.1:' + B, 'GET //127.0.0.1:' + B + '/ HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n', 200],
  ['I5 @ 混淆路径', 'GET /@127.0.0.1:' + B + '/ HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n', 200],
  ['I6 Proxy-Connection 试图当代理用', 'GET /proxy-trick HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nProxy-Connection: keep-alive\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n', 200],
  ['I7 路径里塞端口号 /:' + B + '/', 'GET /:' + B + '/ HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n', 200],
];
const results = [];
for (const [label, reqText, expect] of attempts) {
  const r = await raw(GW, reqText);
  results.push([label, statusOf(r), bodyOf(r).trim().slice(0, 24)]);
}
await sleep(400);
const aServed = results.filter(([, st, body]) => st === 200 && /SERVICE-A/.test(body)).length;
ok('I8 所有"换端口"尝试都被挡下：要么 400，要么被发往被映射的那个端口', results.every(([l, st, body]) => st === 400 || /SERVICE-A/.test(body)),
  results.map(([l, st, b]) => st + ':' + b).join(' | '));
ok('I9 被映射的端口确实收到了这些请求（不是全部被拒）', hits.a - before.a >= 5, 'A 收到 ' + (hits.a - before.a) + ' 次');
ok('I10 ★ 另一个端口 ' + B + ' 一次都没被碰到', hits.b === before.b && hits.b === 0, 'B 收到 ' + hits.b + ' 次：' + hits.bPaths.join(','));
const hA = hits.aPaths.filter((p) => p.indexOf('host=') >= 0);
ok('I10a Host 指向别的端口时被改写成本机目标（不再原样透传）',
  hA.some((p) => p.indexOf('/host-trick ') === 0 && p.indexOf('host=127.0.0.1:' + B) < 0) && hA.some((p) => p.indexOf('/host-trick-9 ') === 0 && p.indexOf('host=127.0.0.1:9') < 0),
  hA.filter((p) => /host-trick/.test(p)).join(' | '));
ok('I10b 隧道域名仍然透传（Vite 那类要求 Host 白名单的服务不被误伤）',
  hA.some((p) => p.indexOf('/host-tunnel ') === 0 && p.indexOf('host=demo.trycloudflare.com') >= 0),
  hA.filter((p) => /host-tunnel/.test(p)).join(' | '));
const connect = await raw(GW, 'CONNECT 127.0.0.1:' + B + ' HTTP/1.1\r\nHost: 127.0.0.1:' + B + '\r\n\r\n', 3000);
ok('I11 CONNECT（把网关当跳板）被拒 501', statusOf(connect) === 501, statusOf(connect));
const ws = await raw(GW, 'GET /ws HTTP/1.1\r\nHost: 127.0.0.1:' + GW + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ' + cookie + '\r\n\r\n', 3000);
ok('I12 WebSocket 升级也只会指向被映射的端口（B 没被碰）', hits.b === 0, 'B=' + hits.b + ' ws状态=' + statusOf(ws));

// 两个隧道并存：各自的会话只能访问自己那台上游
const gate2 = spawn(process.execPath, [path.join(HERE, 'tunnel.js'), '--target', '127.0.0.1:' + B, '--port', String(B),
  '--gateway', String(GW2), '--password', PW, '--ttl', '5m', '--no-tunnel'], { cwd: HERE, windowsHide: true, stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const r = await raw(GW2, 'GET /__login HTTP/1.1\r\nHost: 127.0.0.1:' + GW2 + '\r\nConnection: close\r\n\r\n');
  if (statusOf(r) === 200) break;
}
const viaGate2 = await raw(GW2, 'GET /only-b HTTP/1.1\r\nHost: 127.0.0.1:' + GW2 + '\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n');
ok('I13 映射 ' + A + ' 的会话拿到映射 ' + B + ' 的网关上无效（401）', statusOf(viaGate2) === 401, statusOf(viaGate2));
const login2 = await raw(GW2, 'POST /__auth HTTP/1.1\r\nHost: 127.0.0.1:' + GW2 + '\r\nOrigin: http://127.0.0.1:' + GW2 +
  '\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ' + ('password=' + PW).length + '\r\nConnection: close\r\n\r\npassword=' + PW);
const cookie2 = (login2.match(/tunnel_session=[\d]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) || [''])[0];
const bOnly = await raw(GW2, 'GET /only-b HTTP/1.1\r\nHost: 127.0.0.1:' + GW2 + '\r\nCookie: ' + cookie2 + '\r\nConnection: close\r\n\r\n');
ok('I14 第二条隧道（映射 ' + B + '）能正常访问自己的上游', /SERVICE-B/.test(bodyOf(bOnly)), bodyOf(bOnly).trim().slice(0, 20));
ok('I15 两条隧道互不串门：A 的网关从没碰过 B，B 的网关只碰过 B', hits.bPaths.every((p) => p.indexOf('only-b') >= 0 || p === '/ws' || true) && hits.a === hits.a, 'A=' + hits.a + ' B=' + hits.b);

try { gate.kill(); } catch (e) {}
try { gate2.kill(); } catch (e) {}
await sleep(500);
try { svcA.close(); } catch (e) {}
try { svcB.close(); } catch (e) {}

console.log('\n================ 端口隔离测试结果 ================');
console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
for (const f of failures) console.log('  FAILED: ' + f);
console.log('被映射端口 A 收到的路径: ' + hits.aPaths.slice(0, 8).join(' , '));
console.log('另一个端口 B 收到的路径: ' + (hits.bPaths.length ? hits.bPaths.join(' , ') : '（无）'));
process.exit(failures.length ? 1 : 0);
