#!/usr/bin/env node
/**
 * 临时公网映射小工具（Cloudflare Quick Tunnel + 密码门 + 定时自动关闭）
 *
 * 用法：
 *   node tunnel.js                       # 默认把 3000 映射出去，1 小时后自动关闭，自动生成密码
 *   node tunnel.js --port 8090 --ttl 30m --password 我的密码
 *   start.cmd --port 8091 --ttl 1h       # Windows 双击/命令行
 *
 * 参数：
 *   --port <n>        要映射的本机端口（默认 3000）
 *   --ttl <dur>       有效期，如 60m / 1h / 90s / 3600（默认 1h），到点自动杀掉隧道并退出
 *   --password <pwd>  访问密码（不给则自动生成，命令行与日志里会打印）
 *   --gateway <n>     本地网关端口（默认 18080）
 *   --host <ip>       网关监听地址（默认 127.0.0.1，只允许本机；不要改成 0.0.0.0）
 *   --upstream-host <h> 强制改写转发给上游的 Host（默认：白名单透传，其它改写为 127.0.0.1:<port>）
 *
 * 行为：
 *   1) 本机起一个带密码门的反向代理（只监听 127.0.0.1）
 *   2) 用 cloudflared 快速隧道把该网关暴露到 https://<随机>.trycloudflare.com
 *   3) 外部必须先输入正确密码（或 curl 用 Basic Auth / Cookie）才能访问真正端口
 *   4) 到 TTL 自动关闭隧道 + 网关并退出；Ctrl+C 也会清理
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 打包成 exe（Node SEA / pkg）后 __dirname 指向虚拟快照或不可写位置，
// 必须改用 exe 自身所在目录来定位 cloudflared.exe / logs / pid 文件
const HERE = (function () {
  try { if (require('node:sea').isSea()) return path.dirname(process.execPath); } catch (e) {}
  if (process.pkg) return path.dirname(process.execPath);
  return __dirname;
})();
const LOG_DIR = path.join(HERE, 'logs');

// 兜底：任何未捕获的 socket/子进程错误都不允许杀死隧道进程。
// 2026-09-20 曾因客户端连接被重置（read ECONNRESET）未捕获 → 隧道进程静默退出 → 域名失效。
process.on('uncaughtException', (err) => {
  try { console.error('[tunnel] uncaughtException:', (err && (err.code || err.message)) || err); } catch {}
});
process.on('unhandledRejection', (reason) => {
  try { console.error('[tunnel] unhandledRejection:', (reason && (reason.code || reason.message)) || reason); } catch {}
});

// ---------------- 参数 ----------------
function parseArgs(argv) {
  const out = { port: 3000, ttl: '1h', password: '', gateway: 18080, host: '127.0.0.1',
    upstreamHost: '', cloudflared: '', noDownload: false, noTunnel: false, open: false, forcePublicGateway: false, rateLimit: 3000, allowHosts: [],
    runProfile: '', config: '', stateFile: '', name: '',
    tunnelMode: '', hostname: '', tunnelName: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') out.port = Number(next());
    else if (a === '--ttl' || a === '-t') out.ttl = String(next());
    else if (a === '--password' || a === '-P') out.password = String(next());
    else if (a === '--gateway' || a === '-g') out.gateway = Number(next());
    else if (a === '--host') out.host = String(next());
    else if (a === '--cloudflared') out.cloudflared = String(next());
    else if (a === '--no-download') out.noDownload = true;
    else if (a === '--no-tunnel') out.noTunnel = true;
    else if (a === '--open') out.open = true;
    else if (a === '--run-profile') out.runProfile = String(next());
    else if (a === '--config') out.config = String(next());
    else if (a === '--state-file') out.stateFile = String(next());
    else if (a === '--name') out.name = String(next());
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force-public-gateway') out.forcePublicGateway = true;
    else if (a === '--rate-limit') out.rateLimit = Number(next());
    else if (a === '--allow-host') { (out.allowHosts = out.allowHosts || []).push(String(next())); }
    else if (a === '--upstream-host' || a === '-U') out.upstreamHost = String(next());
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}
function printHelp() {
  console.log('用法: tunnel [选项]');
  console.log('');
  console.log('  --port, -p <端口>        要暴露的本机服务端口（默认 3000）');
  console.log('  --ttl, -t <时长>         存活时长，如 30m / 2h / 1d（默认 1h，从公网地址就绪起算）');
  console.log('  --password, -P <密码>    访问密码（默认随机生成，也可用环境变量 TUNNEL_PASSWORD）');
  console.log('  --gateway, -g <端口>     本地密码门端口（默认 18080，只监听 127.0.0.1）');
  console.log('  --host <地址>            密码门监听地址（仅允许回环，默认 127.0.0.1）');
  console.log('  --app / --browser        启动时用桌面窗口（默认）还是普通浏览器打开配置页');
  console.log('  --dry-run                只生成配置并打印 cloudflared 命令，不真的起隧道（排障用）');
  console.log('  --cloudflared <路径>     指定 cloudflared.exe（默认用同目录下的）');
  console.log('  --no-download            缺 cloudflared.exe 时不自动下载');
  console.log('  --rate-limit <次数>      每客户端 IP 每分钟请求上限（默认 3000）');
  console.log('  --allow-host <域名>      Host 透传白名单（可重复，非白名单 Host 会被改写为回环地址）');
  console.log('  --upstream-host, -U <值> 强制改写转发给上游的 Host 头');
  console.log('  --open                   就绪后自动用默认浏览器打开公网地址');
  console.log('  --no-tunnel              只启动本地密码门，不建隧道（自测/排障用）');
  console.log('  --force-public-gateway   允许 --host 绑定非回环地址（危险，密码门会暴露到局域网）');
  console.log('  --help, -h               显示本帮助');
  console.log('');
  console.log('  多通道 / 图形化配置页 / MCP: 运行 tunnel help 查看子命令');
}
// 时长解析 / 随机密码统一放在 lib/util.js（GUI、CLI、MCP 共用同一个实现）
const U = require('./lib/util.js');
const { parseTtl, randomPassword } = U;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 日志 ----------------
let logStream = null;
function log(...args) {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + args.join(' ');
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

// ---------------- cloudflared ----------------
const EXE = path.join(HERE, 'cloudflared.exe');
const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向过多'));
    https.get(url, { headers: { 'User-Agent': 'public-tunnel-helper' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      let lastPct = -1;
      res.setTimeout(60_000, () => res.destroy(new Error('下载停滞超过 60 秒')));
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total > 0) {
          const pct = Math.floor((got * 100) / total);
          if (pct >= lastPct + 20) { lastPct = pct; log('  ...下载中 ' + pct + '%  (' + (got / 1048576).toFixed(1) + '/' + (total / 1048576).toFixed(1) + ' MB)'); }
        }
      });
      const tmp = dest + '.part';
      const ws = fs.createWriteStream(tmp);
      res.pipe(ws);
      ws.on('finish', () => { fs.renameSync(tmp, dest); resolve(dest); });
      ws.on('error', reject);
    }).on('error', reject);
  });
}

function isPeFile(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    return b[0] === 0x4d && b[1] === 0x5a; // 'MZ'
  } catch { return false; }
}
function logSha256(p) {
  try { log('cloudflared SHA-256: ' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')); } catch {}
}
async function ensureCloudflared(cfg) {
  if (cfg.cloudflared) {
    if (!fs.existsSync(cfg.cloudflared) || !isPeFile(cfg.cloudflared)) throw new Error('--cloudflared 指定的文件不是有效的 Windows 程序: ' + cfg.cloudflared);
    log('使用指定的 cloudflared: ' + cfg.cloudflared);
    logSha256(cfg.cloudflared);
    return cfg.cloudflared;
  }
  if (fs.existsSync(EXE) && fs.statSync(EXE).size > 5 * 1024 * 1024 && isPeFile(EXE)) { logSha256(EXE); return EXE; }
  if (cfg.noDownload) throw new Error('本目录没有可用的 cloudflared.exe，且指定了 --no-download');
  log('未找到 cloudflared.exe，正在从 GitHub 下载（约 55MB，仅首次；日志里有进度）...');
  await download(DOWNLOAD_URL, EXE);
  const size = fs.statSync(EXE).size;
  if (size < 5 * 1024 * 1024 || !isPeFile(EXE)) throw new Error('cloudflared 下载不完整或不是有效程序: ' + size + ' 字节');
  log('cloudflared 就绪: ' + (size / 1024 / 1024).toFixed(1) + ' MB');
  logSha256(EXE);
  return EXE;
}

// ---------------- 反向代理 ----------------
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function proxyHttp(req, res, targetPort, extraHeaders) {
  const headers = { ...req.headers, ...extraHeaders };
  for (const h of Object.keys(headers)) if (HOP_BY_HOP.has(h.toLowerCase())) delete headers[h];
  const upstream = http.request(
    { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers },
    (up) => {
      const outHeaders = { ...up.headers };
      for (const h of Object.keys(outHeaders)) if (HOP_BY_HOP.has(h.toLowerCase())) delete outHeaders[h];
      res.writeHead(up.statusCode || 502, outHeaders);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    log('代理到 ' + targetPort + ' 失败: ' + err.message);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('无法连接本机端口 ' + targetPort + '：' + err.message);
  });
  req.pipe(upstream);
}

// ---------------- 主流程 ----------------
function makeStateWriter(file) {
  return function writeState(patch) {
    if (!file) return;
    try {
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prev = {}; }
      fs.writeFileSync(file, JSON.stringify(Object.assign(prev, patch, { updatedAt: Date.now() }), null, 2));
    } catch (e) {}
  };
}
/** GUI/托盘/MCP 通过 --run-profile 让子进程按 config.json 里的通道定义启动 */
function applyProfile(args) {
  const { Config } = require('./lib/config.js');
  const cfg = new Config(args.config || Config.defaultFile(HERE)).load();
  const p = cfg.find(args.runProfile);
  if (!p) throw new Error('配置里找不到通道: ' + args.runProfile);
  if (!p.enabled) throw new Error('通道已禁用: ' + p.name);
  args.port = Number(p.port);
  args.gateway = Number(p.gateway);
  args.ttl = String(p.ttl);
  args.host = String(p.host || '127.0.0.1');
  args.rateLimit = Number(p.rateLimit || args.rateLimit);
  args.upstreamHost = String(p.upstreamHost || '');
  args.allowHosts = Array.isArray(p.allowHosts) ? p.allowHosts.slice() : [];
  args.forcePublicGateway = !!p.forcePublicGateway;
  if (p.passwordMode === 'fixed' && p.password) args.password = String(p.password);
  if (p.openBrowser) args.open = true;
  if (p.noTunnel) args.noTunnel = true;
  args.tunnelMode = String(p.mode || 'quick');
  args.hostname = String(p.hostname || '');
  args.tunnelName = String(p.tunnelName || p.id || '');
  args.name = p.name;
  return p;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.runProfile) applyProfile(args);
  const writeState = makeStateWriter(args.stateFile);
  if (!args.port || args.port < 1 || args.port > 65535) { console.error('端口不合法'); process.exit(2); }
  const LOOPBACK = ['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1'];
  if (!LOOPBACK.includes(args.host) && !args.forcePublicGateway) {
    console.error('拒绝启动：--host ' + args.host + ' 会让同网段的人绕过隧道直连网关（不走密码门）。确实需要请加 --force-public-gateway');
    process.exit(2);
  }
  const NAMED = require('./lib/named.js');
  const ttlRaw = String(args.ttl || '').trim().toLowerCase();
  const forever = (ttlRaw === 'forever' || ttlRaw === '0' || ttlRaw === 'inf' || ttlRaw === 'never');
  const ttlMs = forever ? 0 : parseTtl(args.ttl);
  const isNamedMode = String(args.tunnelMode || '') === 'named';
  const password = args.password || process.env.TUNNEL_PASSWORD || randomPassword();
  const generated = !args.password && !process.env.TUNNEL_PASSWORD;
  const SECRET = crypto.randomBytes(32);
  let expiresAt = 0; // 等隧道就绪后再开始计时
  const startedAt = new Date();

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'tunnel-' + startedAt.toISOString().replace(/[:.]/g, '-') + '.log');
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  writeState({ id: args.runProfile || '', name: args.name || '', pid: process.pid, port: args.port,
    gateway: args.gateway, ttl: args.ttl, host: args.host, password: password, running: true,
    phase: 'starting', startedAt: Date.now(), logFile: logFile, exitReason: '', error: '',
    mode: isNamedMode ? 'named' : 'quick', hostname: args.hostname || '', forever: forever });

  // 密码校验：恒定时间比较
  const pwdDigest = crypto.createHash('sha256').update(password).digest();
  function passwordOk(input) {
    if (typeof input !== 'string' || !input) return false;
    const d = crypto.createHash('sha256').update(input).digest();
    return crypto.timingSafeEqual(d, pwdDigest);
  }
  const okNonce = crypto.randomBytes(16).toString('base64url');
  // 已登出的会话签名黑名单（登出后旧 Cookie 立即失效，而不是等过期）
  const revoked = new Map();
  // 每把会话 Cookie 带独立随机 sid：泄露一把不影响其它会话，登出按 sid 精确吊销
  function makeCookie(ttl) {
    const exp = Date.now() + ttl;
    const sid = crypto.randomBytes(12).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(exp + '.' + sid + '.' + okNonce).digest('base64url');
    return { value: 'tunnel_session=' + exp + '.' + sid + '.' + sig, exp: exp, sid: sid };
  }
  function parseCookie(req) {
    const raw = req.headers.cookie || '';
    const m = raw.match(/tunnel_session=(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const exp = Number(m[1]);
    if (!Number.isFinite(exp) || exp < Date.now()) return null;
    const expect = crypto.createHmac('sha256', SECRET).update(exp + '.' + m[2] + '.' + okNonce).digest('base64url');
    const a = Buffer.from(m[3]); const b = Buffer.from(expect);
    if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return null;
    if (revoked.has(m[2])) return null;
    return { exp: exp, sid: m[2] };
  }
  function cookieOk(req) { return !!parseCookie(req); }
  function basicOk(req) {
    const h = req.headers.authorization || '';
    if (!h.toLowerCase().startsWith('basic ')) return false;
    try {
      const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      return passwordOk(idx >= 0 ? decoded.slice(idx + 1) : decoded);
    } catch { return false; }
  }

  // 简单防爆破：同 IP 连续失败 8 次锁 5 分钟
  const fails = new Map();
  function tooManyFails(ip) {
    const rec = fails.get(ip);
    return rec && rec.count >= 8 && Date.now() - rec.last < 5 * 60 * 1000;
  }
  function noteFail(ip) {
    const rec = fails.get(ip) || { count: 0, last: 0 };
    rec.count += 1; rec.last = Date.now(); fails.set(ip, rec);
  }

  const loginPage = (msg) => {
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>需要密码</title>' +
      '<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e5e7eb;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}' +
      '.box{width:min(92vw,420px);background:#171a21;border:1px solid #262b36;border-radius:14px;padding:26px 24px;box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
      'h1{margin:0 0 6px;font-size:18px}label{display:block;margin:16px 0 6px;color:#9aa4b2;font-size:13px}' +
      'input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #303645;background:#0f1115;color:#e5e7eb;font-size:15px}' +
      'button{width:100%;margin-top:16px;padding:11px;border:0;border-radius:9px;background:#2563eb;color:#fff;font-size:15px;cursor:pointer}' +
      'button:hover{background:#1d4ed8}.err{margin-top:12px;color:#f87171;font-size:13px}.tip{margin-top:14px;color:#6b7280;font-size:12px}' +
      '</style></head><body><form class="box" method="POST" action="/__auth">' +
      '<h1>临时公网访问</h1><div class="tip">此地址受密码保护，到点会自动关闭</div>' +
      '<label>访问密码</label><input name="password" type="password" autofocus autocomplete="current-password" placeholder="请输入访问密码">' +
      '<button type="submit">进入</button>' + (msg ? '<div class="err">' + msg + '</div>' : '') +
      '</form></body></html>';
  };

  // ---------------- 安全辅助 ----------------
  const SEC_HEADERS = {
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
  function sendHtml(res, code, html, extra) {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS, ...(extra || {}) });
    res.end(html);
  }
  /**
   * 真实客户端 IP：
   *  - Cloudflare 边缘写死的 CF-Connecting-IP（客户端伪造会被边缘覆盖）
   *  - 否则取 X-Forwarded-For 的最后一跳（边缘追加的那一跳）
   *  - 直连本机时退回 socket 地址
   * 用 remoteAddress 做限流键是错的：经隧道时所有请求的 remoteAddress 都是 127.0.0.1，
   * 一个攻击者错 8 次就会把所有人（包括主人）一起锁掉。
   */
  function clientIp(req) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const parts = xff.split(',').map((x) => x.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return req.socket.remoteAddress || '?';
  }
  /** 只对隧道域名/本机透传原始 Host，其它一律改写，避免 Host 头注入上游服务 */
  function hostAllowed(hostHeader) {
    const host = String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();
    if (!host) return false;
    if (['localhost', '127.0.0.1', '::1'].includes(host)) return true;
    if (host.endsWith('.trycloudflare.com')) return true;
    return (args.allowHosts || []).some((h) => {
      const a = String(h).toLowerCase();
      return host === a || host.endsWith('.' + a);
    });
  }
  /** 转发前清洗：不给上游看到我的会话 Cookie / Basic 网关口令；Host 不在白名单则改写 */
  function sanitizeIncoming(req) {
    const rawCookie = req.headers.cookie;
    if (rawCookie) {
      const kept = String(rawCookie).split(';').map((x) => x.trim())
        .filter((x) => x && !x.startsWith('tunnel_session=')).join('; ');
      if (kept) req.headers.cookie = kept; else delete req.headers.cookie;
    }
    const auth = req.headers.authorization;
    if (auth && String(auth).toLowerCase().startsWith('basic ')) {
      try {
        const decoded = Buffer.from(String(auth).slice(6), 'base64').toString('utf8');
        const i = decoded.indexOf(':');
        if (passwordOk(i >= 0 ? decoded.slice(i + 1) : decoded)) delete req.headers.authorization;
      } catch {}
    }
    if (!hostAllowed(req.headers.host)) req.headers.host = '127.0.0.1:' + args.port;
    // 可选：强制改写转发给上游的 Host（如让 dsh-pocket 按 loopback 处理、跳过它的第二道 PIN）
    if (args.upstreamHost) req.headers.host = args.upstreamHost;
  }
  // 每客户端 IP 每分钟限流（默认 3000，防隧道被刷；正常浏览 Vite 模块加载不会碰到）
  const rateHits = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const rec = rateHits.get(ip);
    if (!rec || now - rec.window > 60_000) { rateHits.set(ip, { window: now, count: 1 }); return false; }
    rec.count += 1;
    if (rec.count === args.rateLimit + 1) log('限流触发 ip=' + ip + '（每分钟上限 ' + args.rateLimit + '）');
    return rec.count > args.rateLimit;
  }
  // 定时清理限流/失败计数表：长期运行下 Map 会无限增长（内存耗尽/DoS）
  function pruneMaps() {
    const now = Date.now();
    for (const entry of fails) { if (now - entry[1].last > 30 * 60 * 1000) fails.delete(entry[0]); }
    for (const entry of rateHits) { if (now - entry[1].window > 5 * 60 * 1000) rateHits.delete(entry[0]); }
    for (const entry of revoked) { if (!(entry[1] > now)) revoked.delete(entry[0]); }
  }
  const pruneTimer = setInterval(pruneMaps, 5 * 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  const server = http.createServer((req, res) => {
    const ip = clientIp(req);
    const url = req.url || '/';
    // 只接受 origin-form（以 / 开头）的请求行，绝对形式一律拒绝，防止请求走私/混淆上游
    if (!url.startsWith('/')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', ...SEC_HEADERS });
      return res.end('bad request target');
    }
    if (req.method === 'TRACE' || req.method === 'TRACK') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS', ...SEC_HEADERS });
      return res.end('method not allowed');
    }
    if (rateLimited(ip)) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', ...SEC_HEADERS });
      return res.end('too many requests');
    }
    // 只有确实来自 Cloudflare 边缘的请求才采信 x-forwarded-proto（防本地伪造 https 语义）
    const fromCf = !!req.headers['cf-connecting-ip'] || /\.trycloudflare\.com$/.test(String(req.headers.host || '').toLowerCase());
    const extra = {
      'x-forwarded-for': ip,
      'x-real-ip': ip,
      'x-forwarded-proto': (fromCf ? req.headers['x-forwarded-proto'] : '') || 'http',
      'x-forwarded-host': req.headers.host || '',
    };
    const authorized = cookieOk(req) || basicOk(req);

    if (url.startsWith('/__auth')) {
      // 跨站表单提交防护：带 Origin 时必须与 Host 同源，否则拒绝（防第三方站点钓鱼/CSRF 登录）
      const originHdr = req.headers.origin;
      if (originHdr && String(originHdr) !== 'null') {
        let originHost = '';
        try { originHost = new URL(String(originHdr)).host.toLowerCase(); } catch { originHost = ''; }
        if (!originHost || originHost !== String(req.headers.host || '').toLowerCase()) {
          log('拒绝跨站 /__auth origin=' + originHdr + ' host=' + req.headers.host);
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', ...SEC_HEADERS });
          return res.end('forbidden origin');
        }
      }
      if (tooManyFails(ip)) return sendHtml(res, 429, loginPage('尝试次数过多，请 5 分钟后再试'));
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const pwd = params.get('password') || '';
        if (params.get('logout') === '1' || url.includes('logout=1')) {
          const cm = String(req.headers.cookie || '').match(/tunnel_session=(\d+)\.([A-Za-z0-9_-]+)\./);
          if (cm) revoked.set(cm[2], Number(cm[1]) || Date.now());
          res.writeHead(302, { 'set-cookie': 'tunnel_session=; Path=/; Max-Age=0' });
          return res.end();
        }
        if (!passwordOk(pwd)) {
          noteFail(ip);
          log('密码错误 ip=' + ip);
          return sendHtml(res, 401, loginPage('密码不对'));
        }
        fails.delete(ip);
        const isHttps = String(req.headers['x-forwarded-proto'] || '').includes('https')
          || String(req.headers.host || '').endsWith('.trycloudflare.com');
        const secure = isHttps ? '; Secure' : '';
        const ttl = Math.max(60_000, Math.min((expiresAt || Date.now() + 3_600_000) - Date.now(), 12 * 3600 * 1000));
        log('密码正确，放行 ip=' + ip);
        res.writeHead(302, { 'set-cookie': makeCookie(ttl).value + '; Path=/; HttpOnly; SameSite=Lax' + secure, location: '/' });
        res.end();
      });
      return;
    }

    if (url === '/__login' || url.startsWith('/__login?')) {
      return sendHtml(res, 200, loginPage(''));
    }
    if (url === '/__status') {
      if (!authorized) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS });
        return res.end(JSON.stringify({ error: 'forbidden' }));
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS });
      return res.end(JSON.stringify({ ok: true, port: args.port, expiresAt, remainingMs: Math.max(0, expiresAt - Date.now()) }));
    }

    if (!authorized) {
      const wantsHtml = String(req.headers.accept || '').includes('text/html');
      if (wantsHtml) { res.writeHead(302, { location: '/__login' }); return res.end(); }
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Basic realm="temporary tunnel"', ...SEC_HEADERS });
      return res.end(JSON.stringify({ error: 'unauthorized', hint: '请先访问 /__login 输入密码，或用 Basic Auth / Cookie tunnel_session' }));
    }

    sanitizeIncoming(req);
    proxyHttp(req, res, args.port, extra);
  });

  // CONNECT（把本机当正向代理跳板）一律拒绝
  server.on('connect', (req, socket) => {
    socket.write('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  // WebSocket（Vite HMR 等）也走同一套鉴权
  server.on('upgrade', (req, socket, head) => {
    if (!(cookieOk(req) || basicOk(req))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    sanitizeIncoming(req);
    const headers = { ...req.headers };
    for (const h of Object.keys(headers)) if (HOP_BY_HOP.has(h.toLowerCase())) delete headers[h];
    // HOP_BY_HOP 里含 connection/upgrade —— 普通请求要删，但 WebSocket 升级必须带回去，
    // 否则上游收到的是普通 GET，永远等不到 101（表现为前端一直"重连中"）。
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';
    const upstream = http.request({ host: '127.0.0.1', port: args.port, method: req.method, path: req.url, headers });
    upstream.on('upgrade', (up, upSocket, upHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(up.headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      upSocket.pipe(socket); socket.pipe(upSocket);
    });
    upstream.on('error', () => socket.destroy());
    if (head && head.length) upstream.write(head);
    upstream.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.gateway, args.host, resolve);
  });
  log('密码门已就绪: http://' + args.host + ':' + args.gateway + '  ->  127.0.0.1:' + args.port);

  // 上次被硬杀（taskkill /F 掉 node）时 cloudflared 会变孤儿，pid 文件还在；
  // 启动时先按 pid 文件回收，避免公网隧道悄悄继续开着
  function imageOfPid(pid) {
    try {
      const out = require('node:child_process').execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      const m = out.match(/^"([^"]+)"/m);
      return m ? m[1].toLowerCase() : '';
    } catch { return ''; }
  }
  function reapStale() {
    if (process.platform !== 'win32') return;
    for (const f of [CF_PID_FILE, NODE_PID_FILE]) {
      let pid = 0;
      try { pid = Number(String(fs.readFileSync(f, 'utf8')).trim()); } catch { continue; }
      if (!pid || pid === process.pid) continue;
      const img = imageOfPid(pid);
      if (img === 'cloudflared.exe' || img === 'node.exe') {
        log('回收上次残留进程 ' + img + ' pid=' + pid + '（' + path.basename(f) + '）');
        try { require('node:child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
      }
    }
  }
  let child = null;
  const exe = args.noTunnel ? null : await ensureCloudflared(args);
  // 命名隧道：把 cloudflared 配置写好，指向本地密码门（这样自有域名也必须先过密码）
  let namedCtx = null;
  if (!args.noTunnel && isNamedMode) {
    const stateDir = args.stateFile ? path.dirname(args.stateFile) : path.join(HERE, 'state');
    const profile = { id: args.runProfile || 'manual', mode: 'named', hostname: args.hostname, tunnelName: args.tunnelName || args.runProfile || 'manual' };
    const rd = NAMED.namedReadiness(HERE, stateDir, profile, args.cloudflared);
    if (!rd.ready) throw new Error('命名隧道还没准备好 —— ' + rd.steps.join('；'));
    const yaml = NAMED.buildConfigYaml({ hostname: rd.hostname, gatewayPort: args.gateway, tunnelId: rd.tunnelId, credentialsFile: rd.credentialsFile });
    fs.mkdirSync(path.dirname(rd.configFile), { recursive: true });
    fs.writeFileSync(rd.configFile, yaml, 'utf8');
    namedCtx = {
      url: rd.publicUrl, configFile: rd.configFile, tunnelId: rd.tunnelId, hostname: rd.hostname,
      args: NAMED.runArgs({ configFile: rd.configFile, tunnelId: rd.tunnelId }),
    };
    log('命名隧道已就绪: ' + namedCtx.url + '  ->  http://127.0.0.1:' + args.gateway);
  }
  // --dry-run：只生成配置并打印命令，不真的起隧道（排障 + 自动化测试用）
  if (args.dryRun) {
    const cmdLine = namedCtx
      ? (exe + ' ' + namedCtx.args.join(' '))
      : (exe + ' tunnel --no-autoupdate --url http://127.0.0.1:' + args.gateway);
    console.log('cloudflared : ' + (exe || '(未使用)'));
    console.log('命令        : ' + cmdLine);
    if (namedCtx) console.log('配置文件    : ' + namedCtx.configFile);
    writeState({ running: false, phase: 'dry-run', mode: isNamedMode ? 'named' : 'quick',
      hostname: args.hostname || '', url: namedCtx ? namedCtx.url : '', expiresAt: 0,
      cloudflaredCommand: cmdLine, configFile: namedCtx ? namedCtx.configFile : '' });
    args.dryRunKeepState = true;
    try { server.close(); } catch (e) {}
    process.exit(0);
  }
  if (!args.noTunnel) log('启动 Cloudflare 快速隧道...');
  // 每个实例按网关端口写各自的两个 pid 文件（node 与 cloudflared），
  // 这样 stop.cmd 能精确关闭某一个实例，不会误杀别人的隧道
  const NODE_PID_FILE = path.join(HERE, '.tunnel-' + args.gateway + '.node.pid');
  const CF_PID_FILE = path.join(HERE, '.tunnel-' + args.gateway + '.cloudflared.pid');
  if (!args.noTunnel) {
    reapStale();
    child = spawn(exe, namedCtx ? namedCtx.args : ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + args.gateway], {
      cwd: HERE, windowsHide: true,
    });
    try {
      fs.writeFileSync(NODE_PID_FILE, String(process.pid));
      fs.writeFileSync(CF_PID_FILE, String(child.pid || ''));
    } catch {}
  }
  server.requestTimeout = 300_000;
  server.headersTimeout = 65_000;
  let childBuf = '';
  let publicUrl = null;
  const urlSeen = args.noTunnel ? Promise.resolve(null) : new Promise((resolve) => {
    const onChunk = (buf) => {
      childBuf += buf.toString();
      const m = childBuf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !publicUrl) { publicUrl = m[0]; resolve(publicUrl); }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', (code) => { log('cloudflared 退出，code=' + code); resolve(null); });
    setTimeout(() => resolve(null), 60_000);
  });

  // 命名隧道的地址是固定的自有域名，不用等 cloudflared 打印
  let url = namedCtx ? namedCtx.url : await urlSeen;
  if (args.noTunnel) url = 'http://' + (args.host === '0.0.0.0' ? '127.0.0.1' : args.host) + ':' + args.gateway;
  if (!url) {
    log('未能取得公网地址，请检查网络/cloudflared 输出；日志: ' + logFile);
    writeState({ running: false, phase: 'stopped', url: '', error: '未能取得公网地址', exitReason: '隧道创建失败' });
    try { child.kill(); } catch {}
    server.close();
    process.exit(1);
  }

  expiresAt = forever ? 0 : Date.now() + ttlMs;
  const hhmm = forever ? '不自动关闭' : new Date(expiresAt).toLocaleString('zh-CN', { hour12: false });
  const bar = '='.repeat(64);
  console.log('\n' + bar);
  console.log((args.noTunnel ? '  本地地址     : ' : '  临时公网地址 : ') + url);
  console.log('  访问密码     : ' + password + (generated ? '   （自动生成）' : ''));
  console.log('  映射到本机   : 127.0.0.1:' + args.port + '   （网关 ' + args.host + ':' + args.gateway + '）');
  console.log('  自动关闭时间 : ' + hhmm + (forever
    ? '   （TTL=forever：地址长期有效，关掉程序才停止）'
    : '   （TTL ' + Math.round(ttlMs / 60000) + ' 分钟，从地址就绪起算）'));
  if (isNamedMode) console.log('  隧道类型     : 命名隧道（自有域名，地址永久固定）');
  console.log('  日志文件     : ' + logFile);
  console.log('  关闭方式     : 到点自动关闭 / 本窗口 Ctrl+C / 双击 stop.cmd');
  console.log(bar + '\n');
  log('公网地址已就绪: ' + url);
  writeState({ running: true, phase: 'running', url: url, cloudflaredPid: (child && child.pid) ? child.pid : 0,
    expiresAt: expiresAt, startedAt: Date.now(), password: password, port: args.port, gateway: args.gateway,
    mode: isNamedMode ? 'named' : 'quick', hostname: args.hostname || '',
    tunnelId: namedCtx ? namedCtx.tunnelId : '', configFile: namedCtx ? namedCtx.configFile : '' });

  let closed = false;
  // Windows 下直接 kill 只杀到 cmd/node 这一层，cloudflared 可能变成孤儿把隧道继续开着；
  // 所以统一用 taskkill /T /F 杀整棵进程树（其它平台退回 child.kill）
  function killTunnelTree() {
    try {
      if (process.platform === 'win32' && child && child.pid) {
        const r = require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        if (r.status !== 0) log('taskkill 返回 ' + r.status + '（cloudflared 可能已退出或权限不足）');
      } else if (child) {
        child.kill('SIGTERM');
      }
    } catch (e) { log('杀隧道进程失败: ' + e.message); }
    // 杀完再删 pid 文件：万一清理失败，pid 文件会留到下次启动被回收，避免隧道变孤儿
    for (const f of [NODE_PID_FILE, CF_PID_FILE, path.join(HERE, '.cloudflared.pid')]) {
      try { fs.rmSync(f, { force: true }); } catch {}
    }
  }
  function shutdown(reason) {
    if (closed) return;
    closed = true;
    log('关闭中（' + reason + '）...');
    if (!args.dryRunKeepState) writeState({ running: false, phase: 'stopped', url: '', exitReason: String(reason || ''), stoppedAt: Date.now() });
    killTunnelTree();
    try { server.close(); } catch {}
    if (logStream) logStream.end();
    setTimeout(() => process.exit(0), 400);
  }
  const timer = forever ? null : setTimeout(() => shutdown('到达 TTL ' + Math.round(ttlMs / 60000) + ' 分钟'), ttlMs);
  const hb = setInterval(() => {
    const left = expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 60000)) : 0;
    log('剩余约 ' + left + ' 分钟');
  }, 5 * 60 * 1000);
  process.on('exit', () => {
    if (!args.dryRunKeepState) writeState({ running: false, url: '', exitReason: '进程退出' });
    killTunnelTree();
  });
  process.on('SIGINT', () => { if (timer) clearTimeout(timer); clearInterval(hb); shutdown('Ctrl+C'); });
  process.on('SIGTERM', () => { if (timer) clearTimeout(timer); clearInterval(hb); shutdown('SIGTERM'); });
  if (child) child.on('exit', () => { if (!closed) shutdown('cloudflared 退出'); });
  if (args.open && url) {
    try { require('node:child_process').spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
  }
}

// 子命令走 lib/cli.js（GUI / 托盘 / MCP / 多通道管理）；以 - 开头的老参数仍然是"前台单通道"模式
const SUBCOMMANDS = ['gui', 'tray', 'mcp', 'list', 'status', 'start', 'stop', 'enable', 'disable',
  'autostart-on', 'autostart-off', 'regen', 'add', 'rm', 'remove', 'delete', 'config', 'api', 'daemon', 'help',
  'update', 'version', 'app', 'login', 'domain', 'info'];
const ARGV = process.argv.slice(2);
if (ARGV.length && !ARGV[0].startsWith('-') && SUBCOMMANDS.includes(ARGV[0])) {
  require('./lib/cli.js').run(ARGV[0], ARGV.slice(1))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error('失败: ' + (err && err.message ? err.message : err)); process.exit(1); });
} else {
  main().catch((err) => {
    console.error('启动失败: ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
}
