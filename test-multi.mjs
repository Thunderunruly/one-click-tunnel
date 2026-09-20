// 多通道管理器测试：同时跑多个通道、各自独立密码、启停互不影响、TTL 到点自关
// 用法: node test-multi.mjs          离线（通道用 noTunnel，只起本地密码门）
//       set LIVE=1 && node test-multi.mjs   额外真开一条 Cloudflare 隧道验证多通道并存
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { Config } = require(path.join(HERE, 'lib', 'config.js'));
const { TunnelManager } = require(path.join(HERE, 'lib', 'manager.js'));

const LIVE = process.env.LIVE === '1';
const UPA = 19911;
const UPB = 19912;
const UP_C = 19913;
const GWA = 18311;
const GWB = 18312;
const GWC = 18313;
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
    let sock = null;
    const fin = () => { if (done) return; done = true; try { if (sock) sock.destroy(); } catch (e) {} resolve(Buffer.concat(chunks).toString('latin1')); };
    try { sock = net.connect(port, '127.0.0.1'); } catch (e) { return fin(); }
    sock.on('connect', () => { try { sock.write(text); } catch (e) {} });
    sock.on('data', (d) => chunks.push(d));
    sock.on('close', fin);
    sock.on('error', fin);
    setTimeout(fin, timeoutMs || 4000);
  });
}
function status(text) { const m = text.match(/^HTTP\/1\.1 (\d+)/); return m ? Number(m[1]) : 0; }
function body(text) {
  const i = text.indexOf('\r\n\r\n');
  if (i < 0) return '';
  let b = text.slice(i + 4);
  if (/transfer-encoding:\s*chunked/i.test(text)) {
    let out = '';
    for (;;) {
      const p = b.indexOf('\r\n');
      if (p < 0) break;
      const size = parseInt(b.slice(0, p), 16);
      if (!size || isNaN(size)) break;
      out += b.slice(p + 2, p + 2 + size);
      b = b.slice(p + 2 + size + 2);
    }
    return out;
  }
  return b;
}
function get(port, cookie, acceptHtml) {
  const h = ['GET / HTTP/1.1', 'Host: 127.0.0.1:' + port, 'Connection: close'];
  if (cookie) h.push('Cookie: ' + cookie);
  if (acceptHtml) h.push('Accept: text/html');
  return raw(port, h.join('\r\n') + '\r\n\r\n');
}
function login(port, password) {
  const b = 'password=' + encodeURIComponent(password);
  return raw(port, ['POST /__auth HTTP/1.1', 'Host: 127.0.0.1:' + port, 'Origin: http://127.0.0.1:' + port,
    'Content-Type: application/x-www-form-urlencoded', 'Content-Length: ' + Buffer.byteLength(b), 'Connection: close', '', b].join('\r\n'));
}
function cookieOf(text) {
  const m = text.match(/set-cookie:\s*tunnel_session=\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i);
  return m ? m[0].split(/:\s*/)[1].trim() : '';
}
function portClosed(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(v); };
    s.on('connect', () => fin(false));
    s.on('error', () => fin(true));
    setTimeout(() => fin(false), 2500);
  });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-multi-'));
const cfgFile = path.join(tmpDir, 'config.json');
const servers = [];
let mgr = null;

function echoServer(port, tag) {
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('echo-' + tag); });
  servers.push(srv);
  return new Promise((r) => srv.listen(port, '127.0.0.1', r));
}

async function main() {
  await echoServer(UPA, 'A');
  await echoServer(UPB, 'B');
  await echoServer(UP_C, 'C');
  fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, profiles: [] }, null, 2));
  const cfg = new Config(cfgFile).load();
  const a = cfg.addProfile({ id: 'alpha', name: 'Alpha', port: UPA, gateway: GWA, ttl: '2m', passwordMode: 'random', enabled: true, autoStart: true, noTunnel: true });
  const b = cfg.addProfile({ id: 'beta', name: 'Beta', port: UPB, gateway: GWB, ttl: '90s', passwordMode: 'fixed', password: 'fixed-pw-123', enabled: true, noTunnel: true });
  const c = cfg.addProfile({ id: 'gamma', name: 'Gamma', port: UP_C, gateway: GWC, ttl: '5m', enabled: false, noTunnel: true });
  if (LIVE) cfg.addProfile({ id: 'live', name: 'Live', port: UPA, gateway: GWA + 10, ttl: '3m', passwordMode: 'fixed', password: 'live-pw-1', enabled: true });

  mgr = new TunnelManager(cfg, { baseDir: tmpDir });

  ok('M1 启动前两个网关端口都空着', (await portClosed(GWA)) && (await portClosed(GWB)));

  const auto = await mgr.startEnabled();
  await sleep(400);
  ok('M2 autoStart 只启动 autoStart 的通道', auto.length === 1 && auto[0] === 'alpha', JSON.stringify(auto));

  const stA = mgr.status('alpha');
  const stB0 = mgr.status('beta');
  ok('M3 alpha 起来后状态为 running', stA.running && stA.phase === 'running', JSON.stringify({ r: stA.running, p: stA.phase, e: stA.error }));
  ok('M4 alpha 随机密码已生成', /^[A-Za-z0-9]{10}$/.test(stA.password), stA.password);
  ok('M5 beta 未启动（没有 autoStart）', !stB0.running);

  await mgr.start('beta');
  const stB = mgr.status('beta');
  ok('M6 beta 起来后状态为 running', stB.running && stB.phase === 'running', JSON.stringify({ r: stB.running, e: stB.error }));
  ok('M7 两个通道同时在跑，互不干扰', mgr.status('alpha').running && mgr.status('beta').running);
  ok('M8 各自网关端口不同', stA.gateway === GWA && stB.gateway === GWB);
  ok('M9 beta 用的是手动密码', stB.password === 'fixed-pw-123', stB.password);
  ok('M10 两个通道密码不同（随机 vs 手动）', stA.password !== stB.password);
  ok('M11 TTL 各自独立(alpha=2m, beta=90s)', Math.abs(stA.remainingMs - 120000) < 20000 && Math.abs(stB.remainingMs - 90000) < 20000, stA.remainingMs + '/' + stB.remainingMs);

  const wrongA = status(await login(GWA, 'nope'));
  ok('M12 alpha 网关错误密码 401', wrongA === 401, wrongA);
  const rightA = await login(GWA, stA.password);
  const ckA = cookieOf(rightA);
  ok('M13 alpha 网关正确密码拿到会话', status(rightA) === 302 && ckA.indexOf('tunnel_session=') === 0, status(rightA) + ' ' + ckA);
  const viaA = body(await get(GWA, ckA));
  ok('M14 alpha 会话只能访问 alpha 的上游', viaA === 'echo-A', viaA.slice(0, 40));
  const crossB = status(await get(GWB, ckA));
  ok('M15 alpha 的会话拿到 beta 网关上无效（会话密钥各进程独立）', crossB === 401, crossB);

  const rightB = await login(GWB, stB.password);
  const ckB = cookieOf(rightB);
  ok('M16 beta 手动密码登录成功', status(rightB) === 302 && ckB.indexOf('tunnel_session=') === 0, status(rightB));
  const viaB = body(await get(GWB, ckB));
  ok('M17 beta 会话只能访问 beta 的上游', viaB === 'echo-B', viaB.slice(0, 40));

  let disabledErr = '';
  try { await mgr.start('gamma'); } catch (e) { disabledErr = e.message; }
  ok('M18 禁用的通道不能启动', disabledErr.indexOf('禁用') >= 0, disabledErr);

  await mgr.stop('beta');
  await sleep(600);
  ok('M19 单独关闭 beta 后 alpha 仍在跑', !mgr.status('beta').running && mgr.status('alpha').running, JSON.stringify({ b: mgr.status('beta').running, a: mgr.status('alpha').running }));
  ok('M20 beta 的网关端口已释放', await portClosed(GWB));
  ok('M21 beta 的状态文件记录了停止', mgr.readState('beta').running === false && mgr.readState('beta').url === '');

  const stFile = path.join(tmpDir, 'state', 'tunnel-alpha.json');
  const raw1 = JSON.parse(fs.readFileSync(stFile, 'utf8'));
  ok('M22 状态文件含端口/网关/密码/到期时间', raw1.port === UPA && raw1.gateway === GWA && !!raw1.password && raw1.expiresAt > Date.now(), JSON.stringify(Object.keys(raw1)));

  if (LIVE) {
    const live = await mgr.start('live');
    ok('M23 真隧道通道能起来（联网）', live.running && /trycloudflare\.com/.test(live.url), live.url + ' ' + live.error);
    const lw = status(await login(GWA + 10, 'nope'));
    ok('M24 真隧道网关拒绝错误密码', lw === 401, lw);
    await mgr.stop('live');
  }

  await mgr.stopAll();
  await sleep(800);
  ok('M25 全部停止后所有网关端口都关闭', (await portClosed(GWA)) && (await portClosed(GWB)) && (await portClosed(GWC)));
  const all = mgr.status();
  ok('M26 全部停止后没有 running 的通道', all.every((s) => !s.running), JSON.stringify(all.map((s) => s.running)));
  ok('M27 没有残留的 cloudflared（noTunnel 模式本就不该有）', all.every((s) => !s.cloudflaredPid), JSON.stringify(all.map((s) => s.cloudflaredPid)));
}

main().catch((e) => { failures.push('EXCEPTION: ' + (e && e.message ? e.message : e)); console.log(e); })
  .finally(async () => {
    try { if (mgr) await mgr.stopAll(); } catch (e) {}
    try { if (mgr) mgr.dispose(); } catch (e) {}
    for (const s of servers) { try { s.close(); } catch (e) {} }
    await sleep(500);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    console.log('\n================ 多通道测试结果 ================');
    console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(failures.length ? 1 : 0);
  });
