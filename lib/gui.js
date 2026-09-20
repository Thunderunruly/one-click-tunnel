'use strict';
/**
 * 本地配置页（GUI）：127.0.0.1 上的小服务 + 通道管理 API
 * 安全：
 *  - 只监听回环地址，且每个请求再检查一次来源 socket 是否回环
 *  - 所有 /api/*（除 /api/health）都要 token（Cookie 或头），恒定时间比较
 *  - 写操作要求同源（Origin/Referer 与 Host 一致，Sec-Fetch-Site 必须是 same-origin/none）
 *  - 响应带 CSP/nosniff/no-store，页面不引用任何外部资源
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Config } = require('./config.js');
const { TunnelManager } = require('./manager.js');
const A = require('./assets.js');
const U = require('./util.js');

const VERSION = require('./version.js').currentVersion();
const UP = require('./updater.js');

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function cookieToken(req) {
  const raw = String(req.headers.cookie || '');
  const m = raw.match(/(?:^|;\s*)pt_token=([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}
function json(res, code, obj, extra) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }, extra || {}));
  res.end(body);
}
function text(res, code, s, type, extra) {
  const body = Buffer.from(String(s));
  res.writeHead(code, Object.assign({
    'content-type': type || 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  }, extra || {}));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > (limit || 262144)) { reject(new Error('请求体过大')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const DESKTOP = require('./desktop.js');
function openUi(url, opts) {
  opts = opts || {};
  const useApp = opts.app !== undefined ? !!opts.app : (cfgOfGuiAppWindow(opts.cfg) && process.platform === 'win32');
  if (useApp) {
    const r = DESKTOP.openAppWindow(url, {
      size: (opts.cfg && opts.cfg.data && opts.cfg.data.gui && opts.cfg.data.gui.appWindowSize) || '1120,780',
      profileDir: path.join(opts.baseDir || path.dirname(url), 'state', 'browser-profile'),
    });
    return r;
  }
  try { DESKTOP.openBrowserDefault(url); } catch (e) {}
  return { ok: true, browser: '', mode: 'browser' };
}
function cfgOfGuiAppWindow(cfg) {
  return !!(cfg && cfg.data && cfg.data.gui && cfg.data.gui.appWindow !== false);
}

async function runGui(opts) {
  opts = opts || {};
  const cfg = new Config(opts.configFile).load();
  const baseDir = path.dirname(cfg.file);
  const appDir = opts.appDir || U.appDir();
  const mgr = new TunnelManager(cfg, { baseDir: baseDir, appDir: appDir });
  const token = cfg.data.gui.token;
  const port = Number(opts.port || cfg.data.gui.port || 18400);
  const daemonFile = path.join(baseDir, 'state', 'daemon.json');
  const quiet = !!opts.quiet;
  const say = (m) => { if (!quiet) console.log(m); };

  const server = http.createServer(async (req, res) => {
    try {
      if (!U.isLoopbackAddr(req.socket.remoteAddress)) return text(res, 403, 'forbidden: loopback only');
      const url = String(req.url || '/');
      if (!url.startsWith('/')) return text(res, 400, 'bad request target');
      const parsed = new URL('http://127.0.0.1' + url);
      const pathname = parsed.pathname;
      const q = parsed.searchParams;

      if (pathname === '/api/health') return json(res, 200, { ok: true, name: 'public-tunnel-gui', version: VERSION, pid: process.pid });

      // 首次带 token 打开页面时写 Cookie，方便后续 XHR（只作用于 127.0.0.1）
      if (pathname === '/' || pathname === '/index.html') {
        const qt = q.get('token') || '';
        if (!safeEqual(qt, token) && !safeEqual(cookieToken(req), token)) {
          return text(res, 401, '需要 token：请在控制台用带 ?token=... 的地址打开配置页（tunnel gui --open 会自动带上）', 'text/plain; charset=utf-8');
        }
        const setCookie = safeEqual(qt, token) ? { 'set-cookie': 'pt_token=' + token + '; Path=/; HttpOnly; SameSite=Strict' } : {};
        const html = A.readAsset('public/index.html', appDir);
        return text(res, 200, html, 'text/html; charset=utf-8', setCookie);
      }
      if (pathname === '/app.js' || pathname === '/style.css') {
        if (!safeEqual(cookieToken(req), token) && !safeEqual(req.headers['x-tunnel-token'], token)) return text(res, 401, 'unauthorized');
        const rel = pathname === '/app.js' ? 'public/app.js' : 'public/style.css';
        if (!A.existsAsset(rel, appDir)) return text(res, 404, 'not found');
        return text(res, 200, A.readAsset(rel, appDir), pathname === '/app.js' ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      }

      if (pathname.startsWith('/api/')) {
        if (!safeEqual(cookieToken(req), token) && !safeEqual(req.headers['x-tunnel-token'], token)) return json(res, 401, { error: 'unauthorized: 缺少或错误的 token' });
        if (req.method === 'POST') {
          const origin = String(req.headers.origin || '');
          const referer = String(req.headers.referer || '');
          const host = String(req.headers.host || '');
          const site = String(req.headers['sec-fetch-site'] || '');
          if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: 'forbidden: 跨站请求被拒（Sec-Fetch-Site=' + site + '）' });
          for (const o of [origin, referer]) {
            if (!o) continue;
            let oh = '';
            try { oh = new URL(o).host; } catch (e) { oh = '?'; }
            if (oh !== host) return json(res, 403, { error: 'forbidden: Origin/Referer 与 Host 不一致' });
          }
        }

        if (pathname === '/api/state' && req.method === 'GET') {
          return json(res, 200, {
            version: VERSION, pid: process.pid, guiPort: port,
            configFile: cfg.file,
            gui: { port: port, openBrowser: !!cfg.data.gui.openBrowser },
            mcp: cfg.data.mcp,
            defaults: cfg.data.defaults,
            tray: cfg.data.tray,
            profiles: mgr.status(),
            update: updateView(),
          });
        }
        if (pathname === '/api/update' && req.method === 'GET') {
          const force = q.get('force') === '1';
          const payload = await UP.checkForUpdate(cfg, baseDir, { force: force });
          return json(res, 200, { ok: !!payload.ok, error: payload.error || '', update: updateView(), payload: payload });
        }
        if (pathname === '/api/update' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const action = String(body.action || 'check');
          if (action === 'check') {
            const p = await UP.checkForUpdate(cfg, baseDir, { force: true });
            return json(res, 200, { ok: !!p.ok, error: p.error || '', update: updateView() });
          }
          if (action === 'ignore') {
            const v = String(body.version || '');
            UP.setIgnored(cfg, v);
            return json(res, 200, { ok: true, ignored: v, update: updateView() });
          }
          if (action === 'download') {
            const r = await UP.downloadUpdate(cfg, baseDir, {});
            return json(res, r.ok ? 200 : 400, { ok: r.ok, error: r.error || '', result: r, update: updateView() });
          }
          if (action === 'install') {
            const r = await UP.installUpdate(cfg, baseDir, {});
            return json(res, r.ok ? 200 : 400, { ok: r.ok, error: r.error || '', result: r });
          }
          return json(res, 400, { error: '未知操作: ' + action });
        }
        if (pathname === '/api/log' && req.method === 'GET') {
          const id = String(q.get('id') || '');
          const p = cfg.find(id);
          if (!p) return json(res, 404, { error: '找不到通道: ' + id });
          let tail = '';
          try { tail = fs.readFileSync(mgr.logFile(p.id), 'utf8').slice(-8000); } catch (e) { tail = ''; }
          return json(res, 200, { id: p.id, logFile: mgr.logFile(p.id), log: tail });
        }
        if (pathname === '/api/profile' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const p = body.id ? cfg.updateProfile(body.id, body.patch || body.profile || body) : cfg.addProfile(body.profile || body);
          return json(res, 200, { ok: true, profile: p, profiles: mgr.status() });
        }
        if (pathname === '/api/delete' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const p = cfg.find(body.id);
          if (!p) return json(res, 404, { error: '找不到通道: ' + body.id });
          if (mgr.running(p.id) || mgr.statusOne(p).running) await mgr.stop(p.id);
          mgr.writeState(p.id, { id: p.id, name: p.name, running: false, exitReason: '通道已删除' });
          cfg.removeProfile(p.id);
          try { fs.rmSync(mgr.stateFile(p.id), { force: true }); } catch (e) {}
          return json(res, 200, { ok: true, profiles: mgr.status() });
        }
        if (pathname === '/api/action' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const action = String(body.action || '');
          const id = body.id ? String(body.id) : '';
          if (action === 'start') return json(res, 200, { ok: true, status: await mgr.start(id) });
          if (action === 'stop') return json(res, 200, { ok: true, status: await mgr.stop(id) });
          if (action === 'startAll') { const r = await mgr.startAll(); return json(res, 200, { ok: true, started: r, profiles: mgr.status() }); }
          if (action === 'stopAll') { await mgr.stopAll(); return json(res, 200, { ok: true, profiles: mgr.status() }); }
          if (action === 'enable' || action === 'disable') {
            const p = cfg.updateProfile(id, { enabled: action === 'enable' });
            if (!p.enabled && (mgr.running(p.id) || mgr.statusOne(p).running)) await mgr.stop(p.id);
            return json(res, 200, { ok: true, profile: p, profiles: mgr.status() });
          }
          if (action === 'autoStartOn' || action === 'autoStartOff') {
            const p = cfg.updateProfile(id, { autoStart: action === 'autoStartOn' });
            return json(res, 200, { ok: true, profile: p, profiles: mgr.status() });
          }
          if (action === 'regenPassword') {
            const p = cfg.updateProfile(id, { passwordMode: 'random', password: '' });
            if (mgr.running(p.id) || mgr.statusOne(p).running) { await mgr.stop(p.id); await mgr.start(p.id); }
            return json(res, 200, { ok: true, profile: cfg.find(id), profiles: mgr.status() });
          }
          if (action === 'openLog') {
            const p = cfg.find(id);
            if (!p) return json(res, 404, { error: '找不到通道: ' + id });
            try { spawn('cmd', ['/c', 'start', '', mgr.logFile(p.id)], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) {}
            return json(res, 200, { ok: true });
          }
          return json(res, 400, { error: '未知操作: ' + action });
        }
        if (pathname === '/api/settings' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          if (body.gui) cfg.updateGui(body.gui);
          if (body.mcp) { Object.assign(cfg.data.mcp, body.mcp); cfg.save(); }
          if (body.tray) { Object.assign(cfg.data.tray, body.tray); cfg.save(); }
          if (body.defaults) { Object.assign(cfg.data.defaults, body.defaults); cfg.save(); }
          if (body.update) { Object.assign(cfg.data.update, body.update); cfg.save(); }
          return json(res, 200, { ok: true, gui: cfg.data.gui, mcp: cfg.data.mcp, tray: cfg.data.tray, defaults: cfg.data.defaults, update: cfg.data.update });
        }
        if (pathname === '/api/shutdown' && req.method === 'POST') {
          json(res, 200, { ok: true, message: '正在关闭守护进程' });
          setTimeout(() => shutdown('API 请求关闭'), 200);
          return;
        }
        return json(res, 404, { error: 'not found: ' + pathname });
      }
      return text(res, 404, 'not found');
    } catch (e) {
      try { json(res, 400, { error: e && e.message ? e.message : String(e) }); } catch (e2) {}
    }
  });

  function updateView() {
    const cache = UP.readCache(baseDir) || {};
    const c = cfg.data.update || {};
    return {
      enabled: c.enabled !== false, repo: c.repo || UP.DEFAULT_REPO, apiBase: c.apiBase || UP.DEFAULT_API,
      autoDownload: !!c.autoDownload, includePrerelease: !!c.includePrerelease, checkIntervalHours: Number(c.checkIntervalHours || 6),
      downloadMirror: c.downloadMirror || '', ignoredVersion: c.ignoredVersion || '',
      currentVersion: VERSION, checkedAt: cache.checkedAt || 0, latestVersion: cache.latestVersion || '',
      hasUpdate: !!cache.hasUpdate, ignored: !!cache.ignored, error: cache.error || '', hint: cache.hint || '',
      notes: cache.notes || '', htmlUrl: cache.htmlUrl || '', publishedAt: cache.publishedAt || '',
      installer: cache.installer || null, downloaded: cache.downloaded || null, assets: cache.assets || [],
    };
  }
  // 启动后后台自动检查一次（到间隔才查；开了 autoDownload 就顺手把安装包拉下来）
  function backgroundUpdateCheck() {
    const c = cfg.data.update || {};
    if (c.enabled === false) return;
    const cache = UP.readCache(baseDir) || {};
    const intervalMs = Math.max(1, Number(c.checkIntervalHours || 6)) * 3600 * 1000;
    if (cache.checkedAt && (Date.now() - cache.checkedAt) < intervalMs) return;
    UP.checkForUpdate(cfg, baseDir, {}).then(async (p) => {
      if (p && p.ok && p.hasUpdate) {
        say('发现新版本 ' + p.latestVersion + '（当前 ' + p.currentVersion + '）：' + p.htmlUrl);
        if (c.autoDownload) {
          const r = await UP.downloadUpdate(cfg, baseDir, { payload: p });
          say(r.ok ? ('已自动下载更新包: ' + r.path) : ('自动下载更新包失败: ' + r.error));
        }
      } else if (p && !p.ok && p.error) {
        say('更新检查未成功: ' + p.error);
      }
    }).catch((e) => say('更新检查失败: ' + (e && e.message ? e.message : e)));
  }
  let closed = false;
  let onShutdown = null;
  let trayProc = null;
  function startTrayIfEnabled() {
    if (opts.tray === false || opts.noTray) return;
    if (!(cfg.data.tray && cfg.data.tray.enabled !== false)) return;
    if (process.platform !== 'win32') return;
    try {
      const T = require('./tray.js');
      trayProc = spawn('powershell', T.trayArgs({ appDir: appDir, baseDir: baseDir, configFile: cfg.file }, port, token), { detached: true, stdio: 'ignore', windowsHide: true });
      trayProc.unref();
      try {
        const cur = U.readJsonSafe(daemonFile, {}) || {};
        cur.trayPid = trayProc.pid;
        U.writeJsonAtomic(daemonFile, cur);
      } catch (e) {}
      say('托盘图标已启动（右键图标可操作通道 / 关掉配置页也不影响隧道）');
    } catch (e) { say('托盘启动失败: ' + (e && e.message ? e.message : e)); }
  }
  function stopTray() {
    // 托盘可能是本进程起的，也可能是 tunnel tray 起的（pid 记在 daemon.json 里），都要收掉
    let pid = trayProc && trayProc.pid ? trayProc.pid : 0;
    if (!pid) { try { pid = Number((U.readJsonSafe(daemonFile, {}) || {}).trayPid || 0); } catch (e) { pid = 0; } }
    if (pid) {
      try {
        if (process.platform === 'win32') require('node:child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        else process.kill(pid, 'SIGTERM');
      } catch (e) {}
    }
    trayProc = null;
  }
  function shutdown(reason) {
    if (closed) return;
    closed = true;
    say('守护进程关闭中（' + reason + '）...');
    try { stopTray(); } catch (e) {}
    try { mgr.dispose(); } catch (e) {}
    try { fs.rmSync(daemonFile, { force: true }); } catch (e) {}
    try { server.close(); } catch (e) {}
    if (onShutdown) onShutdown();
    else setTimeout(() => process.exit(0), 300);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  U.writeJsonAtomic(daemonFile, { pid: process.pid, port: port, token: token, startedAt: Date.now(), version: VERSION, configFile: cfg.file });
  const guiUrl = 'http://127.0.0.1:' + port + '/?token=' + token;
  say('配置页: ' + guiUrl);
  say('（token 存在 config.json 的 gui.token 里，每次访问都要带）');
  if (opts.open !== false && cfg.data.gui.openBrowser !== false) {
    const r = openUi(guiUrl, { app: opts.app, cfg: cfg, baseDir: baseDir });
    say(r.mode === 'app' ? '已打开桌面窗口（无地址栏，关闭窗口不影响后台隧道；退出用托盘菜单）' : ('已用浏览器打开配置页' + (r.reason ? '（' + r.reason + '）' : '')));
  }
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => { try { mgr.dispose(); } catch (e) {} try { fs.rmSync(daemonFile, { force: true }); } catch (e) {} });
  startTrayIfEnabled();
  backgroundUpdateCheck();
  const started = await mgr.startEnabled();
  if (started.length) say('已按配置自动启动: ' + started.join(', '));
  const info = { server: server, mgr: mgr, cfg: cfg, url: guiUrl, port: port, token: token, shutdown: shutdown };
  // 守护进程要一直活到被要求关闭（Ctrl+C / API / 托盘退出），不能返回后就让 CLI 退出
  await new Promise((resolve) => { onShutdown = resolve; });
  setTimeout(() => process.exit(0), 200);
  return info;
}

module.exports = { runGui, VERSION, safeEqual };
