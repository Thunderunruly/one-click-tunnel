// 端到端联网测试：真开一条 Cloudflare 快速隧道，从公网侧验证安全行为
// 用法: node security-test-live.mjs
// 说明: 本机默认 DNS（路由器）不解析 *.trycloudflare.com 快速隧道域名，
//       所以这里用公共 DNS(1.1.1.1) 做解析，再按解析出的 IP 发真实 HTTPS 请求。
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 默认测源码 tunnel.js；设 TUNNEL_ENTRY=dist\\oct.exe 可直接测打包后的 exe
const TUNNEL = process.env.TUNNEL_ENTRY ? path.resolve(HERE, process.env.TUNNEL_ENTRY) : path.join(HERE, 'tunnel.js');
const NODE = process.execPath;
const PACKAGED = TUNNEL.toLowerCase().endsWith('.exe');
const TOOL_DIR = path.dirname(TUNNEL);
function spawnTunnel(args) {
  return PACKAGED ? spawn(TUNNEL, args, { cwd: TOOL_DIR, windowsHide: true }) : spawn(NODE, [TUNNEL].concat(args), { cwd: TOOL_DIR, windowsHide: true });
}
const UP_PORT = 19903;
const GW = 18303;
const PW = 'live-' + crypto.randomBytes(4).toString('hex');
const DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hits = [];
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c.toString(); });
  req.on('end', () => {
    hits.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('echo-ok');
  });
});

let child = null;
let childOut = '';
function killTree(pid) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch (e) {}
}

const resolver = new dns.promises.Resolver();
resolver.setServers(DNS_SERVERS);
let ipv4 = null;
let hostName = '';
function lookupPublic(hostname, opts, cb) {
  const done = () => {
    if (opts && opts.all) return cb(null, [{ address: ipv4, family: 4 }]);
    cb(null, ipv4, 4);
  };
  if (ipv4) return done();
  resolver.resolve4(hostname).then((a) => { ipv4 = a[0]; done(); }).catch((e) => cb(e));
}

function hreq(pathname, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const headers = Object.assign({ Host: hostName, 'User-Agent': 'sec-test' }, opts.headers || {});
    const body = opts.body || '';
    if (body) headers['content-length'] = Buffer.byteLength(body);
    const req = https.request({ host: hostName, port: 443, path: pathname, method: opts.method || 'GET', headers: headers, servername: hostName, lookup: lookupPublic, timeout: 25000 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, setCookies: res.headers['set-cookie'] || [], body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, setCookies: [], body: '', err: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, setCookies: [], body: '', err: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
  child = spawnTunnel(['--port', String(UP_PORT), '--gateway', String(GW), '--password', PW, '--ttl', '4m']);
  child.stdout.on('data', (d) => { childOut += d.toString(); });
  child.stderr.on('data', (d) => { childOut += d.toString(); });
  let url = null;
  const dl = Date.now() + 60000;
  while (Date.now() < dl && !url) { const m = childOut.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) url = m[0]; else await sleep(500); }
  ok('L0 拿到公网地址', !!url, childOut.trim().slice(-160));
  if (!url) return;
  hostName = new URL(url).hostname;
  let resolved = false;
  const dnsDl = Date.now() + 90000;
  while (Date.now() < dnsDl && !resolved) {
    try { const a = await resolver.resolve4(hostName); ipv4 = a[0]; resolved = true; }
    catch (e) { await sleep(3000); }
  }
  ok('L0b 公共 DNS 已能解析该隧道域名', resolved, hostName + ' ip=' + ipv4);
  if (!resolved) return;
  console.log('  (隧道 ' + url + ' -> 解析 ' + ipv4 + ')');

  const r1 = await hreq('/', { headers: { accept: 'text/html' } });
  ok('L1 公网未认证浏览器请求 302 到 /__login', r1.status === 302 && String(r1.headers.location) === '/__login', r1.status + ' ' + r1.headers.location + ' ' + r1.err);

  const r2 = await hreq('/__status');
  ok('L2 公网 /__status 未认证 403', r2.status === 403, r2.status + ' ' + r2.err);

  const r3 = await hreq('/__auth', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=wrong' });
  ok('L3 公网错误密码 401', r3.status === 401, r3.status + ' ' + r3.err);

  const r4 = await hreq('/__auth', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(PW) });
  const sc = r4.setCookies.join(' | ');
  const cookie = sc ? String(sc).split(';')[0] : '';
  ok('L4 公网正确密码 302 并下发会话', r4.status === 302 && cookie.indexOf('tunnel_session=') === 0, r4.status + ' ' + sc + ' ' + r4.err);
  const scl = sc.toLowerCase();
  ok('L4b 公网 Cookie 带 Secure + HttpOnly + SameSite', scl.indexOf('secure') >= 0 && scl.indexOf('httponly') >= 0 && scl.indexOf('samesite=lax') >= 0, sc);

  hits.length = 0;
  const r5 = await hreq('/live-path?x=1', { headers: { cookie: cookie } });
  ok('L5 带会话访问公网地址返回上游内容', r5.status === 200 && r5.body === 'echo-ok', r5.status + ' ' + JSON.stringify(r5.body.slice(0, 40)));
  ok('L5b 上游确实收到请求', hits.length === 1 && hits[0].url === '/live-path?x=1', 'hits=' + hits.length);

  const hh = hits.length ? hits[0].headers : {};
  ok('L6b 上游看到 https 语义', String(hh['x-forwarded-proto']) === 'https', String(hh['x-forwarded-proto']));
  ok('L6c 上游 Host 为隧道域名', String(hh['x-forwarded-host'] || '').indexOf('trycloudflare.com') >= 0, String(hh['x-forwarded-host']));
  ok('L6d 上游看不到网关会话 Cookie', String(hh['cookie'] || '').indexOf('tunnel_session') < 0, String(hh['cookie']));
  ok('L6e 上游 XFF 是真实公网 IP（不是回环）', /^\d+\.\d+\.\d+\.\d+$/.test(String(hh['x-forwarded-for'])) && String(hh['x-forwarded-for']).indexOf('127.') !== 0, String(hh['x-forwarded-for']));

  hits.length = 0;
  const r6 = await hreq('/spoof', { headers: { cookie: cookie, 'CF-Connecting-IP': '1.2.3.4', 'X-Real-IP': '1.2.3.4', 'X-Forwarded-For': '1.2.3.4' } });
  const spoofXff = hits.length ? String(hits[0].headers['x-forwarded-for']) : '';
  ok('L6 伪造 CF-Connecting-IP/XFF 不生效（被边缘拦截或被网关改写）', r6.status === 403 || (r6.status === 200 && spoofXff !== '1.2.3.4'), 'status=' + r6.status + ' xff=' + spoofXff);

  const r7 = await hreq('/', { method: 'TRACE' });
  ok('L7 公网 TRACE 405', r7.status === 405, r7.status + ' ' + r7.err);

  const r8 = await hreq('/', { headers: { cookie: cookie.slice(0, -2) + 'AA' } });
  ok('L8 篡改后的 Cookie 公网 401', r8.status === 401, r8.status + ' ' + r8.err);

  const r9 = await hreq('/__auth', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: 'password=' + encodeURIComponent(PW) });
  ok('L9 公网跨站 Origin 提交被拒 403', r9.status === 403, r9.status + ' ' + r9.err);
}

main().catch((e) => { failures.push('EXCEPTION: ' + (e && e.message ? e.message : e)); console.log(e); })
  .finally(async () => {
    if (child && child.pid) killTree(child.pid);
    try { upstream.close(); } catch (e) {}
    await sleep(800);
    console.log('\n================ 公网端到端结果 ================');
    console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(failures.length ? 1 : 0);
  });
