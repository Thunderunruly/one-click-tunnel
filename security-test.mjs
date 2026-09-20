// public-tunnel 安全测试套件（自带 echo 上游，全部本地回环，不建公网隧道）
// 用法: node security-test.mjs        （退出码 0 = 全部通过）
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 默认测源码 tunnel.js；设 TUNNEL_ENTRY=dist\\public-tunnel.exe 可直接测打包后的 exe
const TUNNEL = process.env.TUNNEL_ENTRY ? path.resolve(HERE, process.env.TUNNEL_ENTRY) : path.join(HERE, 'tunnel.js');
const NODE = process.execPath;
const PACKAGED = TUNNEL.toLowerCase().endsWith('.exe');
const TOOL_DIR = path.dirname(TUNNEL);
function spawnTunnel(extraArgs) {
  return PACKAGED ? spawn(TUNNEL, extraArgs, { cwd: TOOL_DIR, windowsHide: true }) : spawn(NODE, [TUNNEL].concat(extraArgs), { cwd: TOOL_DIR, windowsHide: true });
}
const PW = 'test-pw-12345';
const UPSTREAM_PORT = 19901;
const GW_MAIN = 18211;
const GW_RATE = 18212;
const GW_TTL = 18213;
const T0 = Date.now();

let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- raw HTTP ----------------
function raw(port, text, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    let sock = null;
    const finish = () => {
      if (done) return;
      done = true;
      try { if (sock) sock.destroy(); } catch (e) {}
      resolve(Buffer.concat(chunks).toString('latin1'));
    };
    try { sock = net.connect(port, '127.0.0.1'); } catch (e) { return finish(); }
    sock.on('connect', () => { try { sock.write(text); } catch (e) {} });
    sock.on('data', (d) => { chunks.push(d); if (opts.firstByte) finish(); });
    sock.on('close', finish);
    sock.on('error', finish);
    setTimeout(finish, opts.timeout || 5000);
  });
}

function parseResp(text) {
  const idx = text.indexOf('\r\n\r\n');
  const head = idx >= 0 ? text.slice(0, idx) : text;
  let body = idx >= 0 ? text.slice(idx + 4) : '';
  const lines = head.split('\r\n');
  const status = Number(((lines[0] || '').split(' ')[1]) || 0);
  const headers = {};
  const setCookies = [];
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'set-cookie') setCookies.push(v); else headers[k] = v;
  }
  if (String(headers['transfer-encoding'] || '').toLowerCase().indexOf('chunked') >= 0) {
    let out = '';
    let rest = body;
    for (;;) {
      const p = rest.indexOf('\r\n');
      if (p < 0) break;
      const size = parseInt(rest.slice(0, p), 16);
      if (!size || isNaN(size)) break;
      out += rest.slice(p + 2, p + 2 + size);
      rest = rest.slice(p + 2 + size + 2);
    }
    body = out;
  }
  return { status: status, headers: headers, setCookies: setCookies, body: body, head: head, firstLine: lines[0] || '' };
}

function request(port, method, target, headers, body, opts) {
  const h = Object.assign({ Host: '127.0.0.1:' + port, Connection: 'close' }, headers || {});
  let text = method + ' ' + target + ' HTTP/1.1\r\n';
  for (const k of Object.keys(h)) if (h[k] !== undefined && h[k] !== null) text += k + ': ' + h[k] + '\r\n';
  const b = body === undefined ? '' : String(body);
  if (b) text += 'Content-Length: ' + Buffer.byteLength(b) + '\r\n';
  text += '\r\n' + b;
  return raw(port, text, opts).then(parseResp);
}

function cookieOf(resp) {
  if (!resp.setCookies.length) return '';
  return String(resp.setCookies[0]).split(';')[0];
}
function form(obj) {
  return Object.keys(obj).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');
}

// ---------------- echo 上游 ----------------
const hits = [];
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c.toString(); });
  req.on('end', () => {
    hits.push({ url: req.url, method: req.method, headers: req.headers, body: b });
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'echo' });
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers }));
  });
});
upstream.on('upgrade', (req, socket) => {
  hits.push({ url: req.url, method: 'UPGRADE', headers: req.headers, body: '' });
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.destroy();
});

// ---------------- 子进程管理 ----------------
function gatewayOf(args) {
  for (let i = 0; i < args.length; i++) if (args[i] === '--gateway') return Number(args[i + 1]);
  return 18080;
}
class Tunnel {
  constructor(args, label) {
    this.args = args; this.label = label || 'tunnel';
    this.out = ''; this.err = ''; this.exited = null; this.child = null; this.gw = gatewayOf(args);
  }
  async start() {
    this.child = spawnTunnel(this.args);
    this.pid = this.child.pid;
    this.child.stdout.on('data', (d) => { this.out += d.toString(); });
    this.child.stderr.on('data', (d) => { this.err += d.toString(); });
    this.exitP = new Promise((r) => { this.child.on('exit', (code) => { this.exited = code; r(code); }); });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (this.exited !== null) throw new Error(this.label + ' 提前退出 code=' + this.exited + ' err=' + this.err.trim());
      const r = parseResp(await raw(this.gw, 'GET /__login HTTP/1.1\r\nHost: 127.0.0.1:' + this.gw + '\r\nConnection: close\r\n\r\n'));
      if (r.status === 200) return this;
      await sleep(120);
    }
    throw new Error(this.label + ' 未就绪');
  }
  stop() { try { if (this.child) this.child.kill(); } catch (e) {} }
}

function runChild(args, timeoutMs) {
  return new Promise((resolve) => {
    const c = spawnTunnel(args);
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.stderr.on('data', (d) => { err += d.toString(); });
    let done = false;
    const finish = (code, timedOut) => {
      if (done) return;
      done = true;
      try { c.kill(); } catch (e) {}
      resolve({ code: code, out: out, err: err, timedOut: !!timedOut });
    };
    c.on('exit', (code) => finish(code, false));
    setTimeout(() => finish(null, true), timeoutMs || 8000);
  });
}

function portClosed(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(v); };
    s.on('connect', () => fin(false));
    s.on('error', () => fin(true));
    setTimeout(() => fin(false), 2000);
  });
}

// ---------------- 测试主体 ----------------
const main = new Tunnel(['--port', String(UPSTREAM_PORT), '--gateway', String(GW_MAIN), '--password', PW, '--ttl', '30m', '--no-tunnel'], 'main');
const rate = new Tunnel(['--port', String(UPSTREAM_PORT), '--gateway', String(GW_RATE), '--password', PW, '--ttl', '10m', '--rate-limit', '5', '--no-tunnel'], 'rate');
let cookie = '';
let revokedCookie = '';

async function run() {
  section('A. 启动参数校验');
  {
    const a1 = await runChild(['--port', '0', '--no-tunnel', '--gateway', '18221'], 6000);
    ok('A1 端口 0 被拒绝(exit 2)', a1.code === 2, 'code=' + a1.code);
    const a2 = await runChild(['--port', '70000', '--no-tunnel', '--gateway', '18221'], 6000);
    ok('A2 端口 70000 被拒绝(exit 2)', a2.code === 2, 'code=' + a2.code);
    const a3 = await runChild(['--port', '19901', '--gateway', '18221', '--host', '0.0.0.0'], 6000);
    ok('A3 非回环 --host 被拒绝(exit 2)', a3.code === 2, 'code=' + a3.code);
    ok('A3b 拒绝原因是中文提示', a3.err.indexOf('拒绝启动') >= 0, a3.err.trim().slice(0, 80));
    const a4 = await runChild(['--port', '19901', '--ttl', 'abc', '--no-tunnel', '--gateway', '18221'], 6000);
    ok('A4 非法 TTL 报错退出(exit 1)', a4.code === 1, 'code=' + a4.code);
    const a5 = await runChild(['--help'], 6000);
    ok('A5 --help 正常退出且列出 --no-tunnel', a5.code === 0 && a5.out.indexOf('--no-tunnel') >= 0, 'code=' + a5.code);
  }

  section('B. 未认证边界');
  {
    const hitsBefore = hits.length;
    const b1 = await request(GW_MAIN, 'GET', '/', { Accept: 'text/html' });
    ok('B1 浏览器请求 302 到 /__login', b1.status === 302 && String(b1.headers.location) === '/__login', b1.status + ' ' + b1.headers.location);
    const b2 = await request(GW_MAIN, 'GET', '/api/anything');
    ok('B2 接口请求 401 且带 Basic 挑战', b2.status === 401 && String(b2.headers['www-authenticate'] || '').indexOf('Basic') === 0, b2.status);
    ok('B2b 401 响应体不泄露上游内容', b2.body.indexOf('x-upstream') < 0 && b2.body.indexOf('echo') < 0, b2.body.slice(0, 80));
    ok('B3 未认证请求没有打到上游', hits.length === hitsBefore, 'hits ' + hitsBefore + '->' + hits.length);
    const b4 = await request(GW_MAIN, 'GET', '/__status');
    ok('B4 /__status 未认证 403', b4.status === 403, b4.status);
    ok('B4b /__status 403 不含端口/到期信息', b4.body.indexOf('expiresAt') < 0 && b4.body.indexOf(String(UPSTREAM_PORT)) < 0, b4.body.slice(0, 80));
    const b5 = await request(GW_MAIN, 'GET', '/__login');
    ok('B5 登录页 200', b5.status === 200);
    ok('B5b 登录页不泄露目标端口', b5.body.indexOf(String(UPSTREAM_PORT)) < 0);
    ok('B5c 登录页不泄露剩余时间', b5.body.indexOf('剩余') < 0 && b5.body.indexOf('目标端口') < 0);
    const b6 = await request(GW_MAIN, 'TRACE', '/');
    ok('B6 TRACE 被拒绝 405', b6.status === 405, b6.status);
    const b7 = parseResp(await raw(GW_MAIN, 'GET http://evil.example/ HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'));
    ok('B7 绝对形式请求行 400', b7.status === 400, b7.status);
    const b8 = parseResp(await raw(GW_MAIN, 'CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n', { firstByte: true }));
    ok('B8 CONNECT 被拒绝 501', b8.status === 501, b8.firstLine);
    const b9 = parseResp(await raw(GW_MAIN, 'GET / HTTP/1.1\r\nHost: 127.0.0.1:' + GW_MAIN + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n', { firstByte: true }));
    ok('B9 未认证 WebSocket 升级 401', b9.status === 401, b9.firstLine);
    const t0 = Date.now();
    const b10 = parseResp(await raw(GW_MAIN, 'POST /x HTTP/1.1\r\nHost: 127.0.0.1:' + GW_MAIN + '\r\nConnection: close\r\nContent-Length: 20000000\r\n\r\n', { timeout: 5000 }));
    ok('B10 超大 Content-Length 未认证快速 401', b10.status === 401 && Date.now() - t0 < 3000, b10.status + ' ' + (Date.now() - t0) + 'ms');
    const b11 = await request(GW_MAIN, 'GET', '/../../../../Windows/win.ini');
    ok('B11 路径穿越未认证 401（不读本地文件）', b11.status === 401 && b11.body.indexOf('[fonts]') < 0, b11.status);
  }

  section('C. 密码门认证');
  {
    const c1 = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://127.0.0.1:' + GW_MAIN, 'Content-Type': 'application/x-www-form-urlencoded' }, form({ password: 'wrong-pw' }));
    ok('C1 错误密码 401', c1.status === 401, c1.status);
    const c2 = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://127.0.0.1:' + GW_MAIN, 'Content-Type': 'application/x-www-form-urlencoded' }, form({ password: PW }));
    cookie = cookieOf(c2);
    ok('C2 正确密码 302', c2.status === 302, c2.status);
    ok('C2b 下发 tunnel_session Cookie', cookie.indexOf('tunnel_session=') === 0 && cookie.length > 25, cookie.slice(0, 20) + '...');
    const sc = c2.setCookies.join(' | ').toLowerCase();
    ok('C2c Cookie 带 HttpOnly', sc.indexOf('httponly') >= 0, sc);
    ok('C2d Cookie 带 SameSite=Lax', sc.indexOf('samesite=lax') >= 0, sc);
    ok('C2e 明文 HTTP 下不加 Secure（否则本地登录不了）', sc.indexOf('secure') < 0, sc);
    ok('C2f Cookie 不带 Domain（不跨子域）', sc.indexOf('domain=') < 0, sc);
    const c3 = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://127.0.0.1:' + GW_MAIN, 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '7.7.7.7', 'Content-Type': 'application/x-www-form-urlencoded' }, form({ password: PW }));
    ok('C3 经 Cloudflare(https) 时 Cookie 加 Secure', c3.setCookies.join(' ').toLowerCase().indexOf('secure') >= 0, c3.setCookies.join(' '));
    hits.length = 0;
    const c4 = await request(GW_MAIN, 'GET', '/app/page', { Accept: 'text/html', Cookie: cookie + '; app=1' });
    ok('C4 Cookie 认证后 200', c4.status === 200, c4.status);
    ok('C4b 请求确实到了上游', hits.length === 1 && hits[0].url === '/app/page', 'hits=' + hits.length);
    ok('C5 上游看不到网关会话 Cookie', hits.length === 1 && String(hits[0].headers.cookie || '') === 'app=1', hits.length ? String(hits[0].headers.cookie) : 'n/a');
    hits.length = 0;
    await request(GW_MAIN, 'GET', '/basic', { Authorization: 'Basic ' + Buffer.from('x:' + PW).toString('base64') });
    ok('C6b Basic 网关口令认证后 200', hits.length === 1, 'hits=' + hits.length);
    ok('C6 上游看不到网关 Basic 凭证', hits.length === 1 && hits[0].headers.authorization === undefined, hits.length ? String(hits[0].headers.authorization) : 'n/a');
    const forged = 'tunnel_session=' + Date.now() + 600000 + '.' + 'A'.repeat(43);
    const c7 = await request(GW_MAIN, 'GET', '/x', { Cookie: forged });
    ok('C7 伪造签名的 Cookie 401', c7.status === 401, c7.status);
    const parts = cookie.split('.');
    const exp = Number(parts[0].split('=')[1]);
    const c8 = await request(GW_MAIN, 'GET', '/x', { Cookie: 'tunnel_session=' + (exp - 3000000) + '.' + parts[1] });
    ok('C8 过期时间被篡改的 Cookie 401', c8.status === 401, c8.status);
    const c9 = await request(GW_MAIN, 'GET', '/x', { Cookie: 'tunnel_session=' + exp });
    ok('C9 无签名的 Cookie 401', c9.status === 401, c9.status);
    const c10 = await request(GW_MAIN, 'GET', '/x', { Authorization: 'Basic ' + Buffer.from('a:b').toString('base64') });
    ok('C10 错误 Basic 密码 401', c10.status === 401, c10.status);
    const c11 = await request(GW_MAIN, 'GET', '/x', { Authorization: 'Basic !!!not-base64!!!' });
    ok('C11 畸形 Basic 头 401（不 500）', c11.status === 401, c11.status);
    const c12 = await request(GW_MAIN, 'GET', '/__status', { Cookie: cookie });
    let st = {};
    try { st = JSON.parse(c12.body); } catch (e) {}
    ok('C12 认证后 /__status 200 且带端口', c12.status === 200 && st.port === UPSTREAM_PORT, c12.status + ' ' + c12.body.slice(0, 60));
    const c13 = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, form({ password: PW }));
    ok('C13 跨站 Origin 提交 /__auth 被拒 403', c13.status === 403, c13.status);
    const hdr = (r) => r.headers;
    ok('C14 登录页安全响应头齐全', ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'cache-control'].every((k) => hdr(c1)[k]), JSON.stringify(hdr(c1)));
    ok('C14b 401 JSON 也有安全响应头', hdr(c9)['x-content-type-options'] === 'nosniff' && !!hdr(c9)['content-security-policy'], JSON.stringify(hdr(c9)));
    revokedCookie = cookie;
    const c15 = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://127.0.0.1:' + GW_MAIN, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, form({ logout: '1' }));
    ok('C15 登出 302 并清 Cookie', c15.status === 302 && String(c15.setCookies.join(' ')).indexOf('Max-Age=0') >= 0, c15.status + ' ' + c15.setCookies.join(' '));
    const c16 = await request(GW_MAIN, 'GET', '/x', { Cookie: cookie });
    ok('C16 登出后旧 Cookie 立即失效 401（服务端吊销）', c16.status === 401, c16.status);
    const c17 = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://127.0.0.1:' + GW_MAIN, 'Content-Type': 'application/x-www-form-urlencoded' }, form({ password: PW }));
    cookie = cookieOf(c17);
    const c18 = await request(GW_MAIN, 'GET', '/again', { Cookie: cookie });
    ok('C17 重新登录后新 Cookie 可用', c18.status === 200, c18.status);
  }

  section('D. 头部伪造 / 注入');
  {
    const d0 = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://127.0.0.1:' + GW_MAIN, 'Content-Type': 'application/x-www-form-urlencoded' }, form({ password: PW }));
    cookie = cookieOf(d0);
    ok('D0 登出后重新登录下发全新会话 Cookie（不再所有会话同一把）', cookie !== revokedCookie && cookie.indexOf('tunnel_session=') === 0, cookie === revokedCookie ? '与已吊销的 Cookie 相同' : cookie.slice(0, 26));
    const d0b = await request(GW_MAIN, 'GET', '/d0', { Cookie: cookie });
    ok('D0b 新 Cookie 立即可用', d0b.status === 200, d0b.status);
    hits.length = 0;
    await request(GW_MAIN, 'GET', '/h', { Cookie: cookie, 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '1.2.3.4', 'CF-Connecting-IP': '5.6.7.8' });
    const h1 = hits.length ? hits[0].headers : {};
    ok('D1 上游 XFF 被改写为判定出的客户端 IP', String(h1['x-forwarded-for']) === '5.6.7.8', String(h1['x-forwarded-for']));
    ok('D1b 上游 XFF 不含客户端伪造值', String(h1['x-forwarded-for']).indexOf('1.2.3.4') < 0, String(h1['x-forwarded-for']));
    ok('D1c 上游 X-Real-IP 同样被改写', String(h1['x-real-ip']) === '5.6.7.8', String(h1['x-real-ip']));
    hits.length = 0;
    parseResp(await raw(GW_MAIN, 'GET /h2 HTTP/1.1\r\nHost: evil.example\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n'));
    ok('D2 非白名单 Host 被改写为回环', hits.length === 1 && String(hits[0].headers.host) === '127.0.0.1:' + UPSTREAM_PORT, hits.length ? String(hits[0].headers.host) : 'n/a');
    ok('D2b 原始 Host 通过 x-forwarded-host 传递', hits.length === 1 && String(hits[0].headers['x-forwarded-host']) === 'evil.example', hits.length ? String(hits[0].headers['x-forwarded-host']) : 'n/a');
    hits.length = 0;
    parseResp(await raw(GW_MAIN, 'GET /h3 HTTP/1.1\r\nHost: foo.trycloudflare.com\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n'));
    ok('D3 隧道域名 Host 原样透传', hits.length === 1 && String(hits[0].headers.host) === 'foo.trycloudflare.com', hits.length ? String(hits[0].headers.host) : 'n/a');
    hits.length = 0;
    parseResp(await raw(GW_MAIN, 'GET /h4 HTTP/1.0\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n'));
    ok('D4 无 Host 请求被改写为回环', hits.length === 1 && String(hits[0].headers.host) === '127.0.0.1:' + UPSTREAM_PORT, hits.length ? String(hits[0].headers.host) : 'n/a');
    const d5 = await request(GW_MAIN, 'GET', '/a%0d%0aX-Injected:%201', { Cookie: cookie });
    ok('D5 路径里的 CRLF 编码不产生响应头注入', d5.headers['x-injected'] === undefined && d5.status === 200, d5.status + ' ' + String(d5.headers['x-injected']));
    const d6 = parseResp(await raw(GW_MAIN, 'GET /a\r\nX-Injected: 1 HTTP/1.1\r\nHost: 127.0.0.1:' + GW_MAIN + '\r\nCookie: ' + cookie + '\r\nConnection: close\r\n\r\n'));
    ok('D6 请求行内真实 CRLF 不产生注入', d6.headers['x-injected'] === undefined && (d6.status === 401 || d6.status === 400 || d6.status === 200), d6.status + ' ' + String(d6.headers['x-injected']));
    const d7 = parseResp(await raw(GW_MAIN, 'POST /a HTTP/1.1\r\nHost: 127.0.0.1:' + GW_MAIN + '\r\nCookie: ' + cookie + '\r\nContent-Length: 1\r\nContent-Length: 5\r\nConnection: close\r\n\r\na'));
    ok('D7 冲突的 Content-Length 不导致 500', d7.status === 200 || d7.status === 400, d7.status);
    hits.length = 0;
    await request(GW_MAIN, 'GET', '/h5', { Cookie: cookie, 'X-Forwarded-Proto': 'https' });
    ok('D8 本地伪造 x-forwarded-proto=https 不被采信', hits.length === 1 && String(hits[0].headers['x-forwarded-proto']) === 'http', hits.length ? String(hits[0].headers['x-forwarded-proto']) : 'n/a');
  }

  section('E. 限流与防爆破');
  {
    let got429 = 0;
    for (let i = 0; i < 8; i++) {
      const r = await request(GW_RATE, 'GET', '/__login');
      if (r.status === 429) got429 += 1;
    }
    ok('E1 超过每分钟上限后返回 429', got429 >= 1, '429 次数=' + got429);
    let locked = 0;
    for (let i = 0; i < 8; i++) {
      const r = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://127.0.0.1:' + GW_MAIN, 'CF-Connecting-IP': '9.9.9.9', 'Content-Type': 'application/x-www-form-urlencoded' }, form({ password: 'bad' + i }));
      if (r.status === 401) locked += 1;
    }
    ok('E2 连续 8 次错误密码均为 401', locked === 8, '401 次数=' + locked);
    const e3 = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://127.0.0.1:' + GW_MAIN, 'CF-Connecting-IP': '9.9.9.9', 'Content-Type': 'application/x-www-form-urlencoded' }, form({ password: PW }));
    ok('E3 锁定后正确密码也被拒 429', e3.status === 429, e3.status);
    const e4 = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://127.0.0.1:' + GW_MAIN, 'CF-Connecting-IP': '8.8.8.8', 'Content-Type': 'application/x-www-form-urlencoded' }, form({ password: PW }));
    ok('E4 锁定只影响攻击者 IP（他人可正常登录）', e4.status === 302, e4.status);
    const e5 = await request(GW_MAIN, 'POST', '/__auth', { Origin: 'http://127.0.0.1:' + GW_MAIN, 'Content-Type': 'application/x-www-form-urlencoded' }, form({ password: PW }));
    ok('E5 本机回环未被误锁', e5.status === 302, e5.status);
  }

  section('F. 生命周期与残留');
  {
    const f1 = await runChild(['--port', String(UPSTREAM_PORT), '--gateway', String(GW_MAIN), '--password', PW, '--no-tunnel'], 8000);
    ok('F1 网关端口冲突时第二实例退出', f1.code !== 0 && !f1.timedOut, 'code=' + f1.code + ' timeout=' + f1.timedOut);
    const f2 = await request(GW_MAIN, 'GET', '/__login');
    ok('F2 冲突退出没有影响第一个实例', f2.status === 200, f2.status);
    const pidFiles = fs.readdirSync(TOOL_DIR).filter((f) => f.indexOf('.tunnel-') === 0);
    ok('F3 --no-tunnel 模式不写 pid 文件', pidFiles.every((f) => f.indexOf(String(GW_MAIN)) < 0 && f.indexOf(String(GW_RATE)) < 0), pidFiles.join(','));
    ok('F4 未创建 cloudflared 进程相关文件', !fs.existsSync(path.join(TOOL_DIR, '.tunnel-' + GW_MAIN + '.cloudflared.pid')));
    const t0 = Date.now();
    const ttl = await runChild(['--port', String(UPSTREAM_PORT), '--gateway', String(GW_TTL), '--password', PW, '--ttl', '3s', '--no-tunnel'], 15000);
    const elapsed = Date.now() - t0;
    ok('F5 TTL 到点自动退出(exit 0)', ttl.code === 0 && !ttl.timedOut, 'code=' + ttl.code + ' timeout=' + ttl.timedOut);
    ok('F5b TTL 在 3 秒附近生效', elapsed >= 2500 && elapsed < 12000, elapsed + 'ms');
    ok('F5c 退出后端口关闭', await portClosed(GW_TTL));
    const logs = fs.existsSync(path.join(TOOL_DIR, 'logs')) ? fs.readdirSync(path.join(TOOL_DIR, 'logs')) : [];
    let leaked = [];
    for (const f of logs) {
      const full = path.join(TOOL_DIR, 'logs', f);
      try {
        if (fs.statSync(full).mtimeMs < T0) continue;
        if (fs.readFileSync(full, 'utf8').indexOf(PW) >= 0) leaked.push(f);
      } catch (e) {}
    }
    ok('F6 日志文件不记录访问密码', leaked.length === 0, leaked.join(','));
  }
}

upstream.listen(UPSTREAM_PORT, '127.0.0.1', async () => {
  try {
    await main.start();
    await rate.start();
    await run();
  } catch (e) {
    failures.push('EXCEPTION: ' + (e && e.message ? e.message : e));
    console.log('\n!! 测试中断: ' + (e && e.stack ? e.stack : e));
  } finally {
    main.stop(); rate.stop();
    try { upstream.close(); } catch (e) {}
    await sleep(600);
    console.log('\n================ 结果 ================');
    console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(failures.length ? 1 : 0);
  }
});
