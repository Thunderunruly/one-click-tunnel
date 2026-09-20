'use strict';
/**
 * 守护进程（GUI 后台）客户端：CLI / MCP / 托盘都通过它来启停通道，
 * 这样"谁开的通道"在配置页里都能看到，只有一个地方持有真实状态。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const U = require('./util.js');
const { isPackaged } = require('./manager.js');

function daemonFile(baseDir) { return path.join(baseDir, 'state', 'daemon.json'); }
function readDaemon(baseDir) { return U.readJsonSafe(daemonFile(baseDir), null); }

function httpJson(port, method, p, body, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: port, path: p, method: method, timeout: timeoutMs || 30000,
      headers: Object.assign({ 'x-tunnel-token': token || '', 'content-type': 'application/json' },
        data ? { 'content-length': data.length } : {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c.toString(); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (e) { json = null; }
        if (res.statusCode >= 400) {
          const err = new Error((json && json.error) || ('HTTP ' + res.statusCode));
          err.statusCode = res.statusCode;
          err.body = json;
          return reject(err);
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('守护进程响应超时')); });
    if (data) req.write(data);
    req.end();
  });
}

function ping(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: port, path: '/api/health', method: 'GET', timeout: timeoutMs || 1500 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c.toString(); });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** 找到正在运行的守护进程（pid 存活 + health 通过） */
async function findDaemon(baseDir) {
  const info = readDaemon(baseDir);
  if (!info || !info.port || !info.token) return null;
  let alive = false;
  try { process.kill(Number(info.pid), 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  if (!alive) return null;
  const h = await ping(info.port);
  if (!h || !h.ok) return null;
  return info;
}

function entryOf(appDir) {
  const packaged = isPackaged();
  const exe = process.execPath;
  if (packaged) return { cmd: exe, args: [] };
  return { cmd: exe, args: [path.join(appDir, 'tunnel.js')] };
}

/** 确保守护进程在跑：没有就后台拉起一个（GUI 页面 + 通道管理都在里面） */
async function ensureDaemon(ctx, opts) {
  opts = opts || {};
  const found = await findDaemon(ctx.baseDir);
  if (found) return found;
  const e = entryOf(ctx.appDir);
  const extra = [];
  if (opts.noTray) extra.push('--no-tray');
  const args = e.args.concat(['gui', '--quiet', '--no-open', '--config', ctx.configFile]).concat(extra);
  const child = spawn(e.cmd, args, { cwd: ctx.appDir, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const deadline = Date.now() + (opts.timeoutMs || 20000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const info = await findDaemon(ctx.baseDir);
    if (info) return info;
  }
  throw new Error('守护进程启动超时（可手动运行: tunnel gui）');
}

async function stopDaemon(baseDir) {
  const info = await findDaemon(baseDir);
  if (!info) return false;
  try { await httpJson(info.port, 'POST', '/api/shutdown', {}, info.token, 5000); } catch (e) {}
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await findDaemon(baseDir))) return true;
  }
  try { if (process.platform === 'win32') require('node:child_process').spawnSync('taskkill', ['/PID', String(info.pid), '/T', '/F'], { windowsHide: true }); else process.kill(info.pid, 'SIGTERM'); } catch (e) {}
  return true;
}

module.exports = { findDaemon, ensureDaemon, stopDaemon, httpJson, ping, daemonFile, readDaemon };
