'use strict';
/**
 * 多通道管理器：一个通道(profile) = 一个子进程(密码门 + cloudflared)
 * 子进程仍是 tunnel.js 自己（--run-profile），因此每个通道的安全实现完全一致、互不影响。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const U = require('./util.js');

function isPackaged() {
  try { if (require('node:sea').isSea()) return true; } catch (e) {}
  return !!process.pkg;
}

class TunnelManager {
  constructor(cfg, opts) {
    opts = opts || {};
    this.cfg = cfg;
    // appDir = 程序本体目录（tunnel.js / lib 所在），baseDir = 运行状态目录（state/logs）
    this.appDir = opts.appDir || U.appDir();
    this.baseDir = opts.baseDir || path.dirname(cfg.file);
    this.stateDir = path.join(this.baseDir, 'state');
    this.logDir = path.join(this.baseDir, 'logs');
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });
    this.procs = new Map();
    this.logTails = new Map();
    this.packaged = isPackaged();
  }
  entry() {
    const exe = process.execPath;
    if (this.packaged) return { cmd: exe, args: [] };
    return { cmd: exe, args: [path.join(this.appDir, 'tunnel.js')] };
  }
  stateFile(id) { return path.join(this.stateDir, 'tunnel-' + id + '.json'); }
  logFile(id) { return path.join(this.logDir, 'tunnel-' + id + '.log'); }
  readState(id) { return U.readJsonSafe(this.stateFile(id), null); }
  writeState(id, obj) { try { U.writeJsonAtomic(this.stateFile(id), obj); } catch (e) {} }
  isAlive(pid) {
    const n = Number(pid);
    if (!n) return false;
    try { process.kill(n, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
  running(id) {
    const rec = this.procs.get(id);
    return !!(rec && rec.child && rec.child.exitCode === null && !rec.child.killed);
  }
  /** 子进程真实 pid（避免 pid 复用误判：进程不在表里就只看状态文件） */
  pidsOf(profile) {
    const st = this.readState(profile.id);
    const out = [];
    if (st && st.pid) out.push(Number(st.pid));
    if (st && st.cloudflaredPid) out.push(Number(st.cloudflaredPid));
    return out;
  }
  statusOne(profile) {
    const st = this.readState(profile.id) || {};
    const live = this.running(profile.id);
    const adopted = !live && st.running && this.isAlive(st.pid) && Date.now() - Number(st.startedAt || 0) < 24 * 3600 * 1000;
    const expiresAt = Number(st.expiresAt || 0);
    return {
      id: profile.id,
      name: profile.name,
      enabled: !!profile.enabled,
      autoStart: !!profile.autoStart,
      port: profile.port,
      gateway: profile.gateway,
      ttl: profile.ttl,
      passwordMode: profile.passwordMode,
      mode: profile.mode || 'quick',
      hostname: profile.hostname || '',
      tunnelName: profile.tunnelName || '',
      tunnelId: profile.tunnelId || '',
      host: profile.host,
      rateLimit: profile.rateLimit,
      upstreamHost: profile.upstreamHost,
      allowHosts: profile.allowHosts,
      running: !!(live || adopted),
      adopting: adopted,
      phase: live || adopted ? (st.url ? 'running' : 'starting') : 'stopped',
      url: st.url || profile.lastUrl || '',
      password: st.password || (profile.passwordMode === 'fixed' ? profile.password : ''),
      startedAt: Number(st.startedAt || 0),
      expiresAt: expiresAt,
      remainingMs: expiresAt ? Math.max(0, expiresAt - Date.now()) : 0,
      pid: Number(st.pid || 0),
      cloudflaredPid: Number(st.cloudflaredPid || 0),
      exitCode: st.exitCode === undefined ? null : st.exitCode,
      exitReason: st.exitReason || '',
      error: st.error || '',
      logFile: this.logFile(profile.id),
      logTail: this.logTails.get(profile.id) || '',
    };
  }
  status(id) {
    if (id) {
      const p = this.cfg.find(id);
      return p ? this.statusOne(p) : null;
    }
    return this.cfg.profiles.map((p) => this.statusOne(p));
  }
  appendLog(id, text) {
    const prev = this.logTails.get(id) || '';
    const next = (prev + text).slice(-4000);
    this.logTails.set(id, next);
    try { fs.appendFileSync(this.logFile(id), text); } catch (e) {}
  }
  async start(id, opts) {
    opts = opts || {};
    const p = this.cfg.find(id);
    if (!p) throw new Error('找不到通道: ' + id);
    if (!p.enabled && !opts.force) {
      const e0 = new Error('通道已禁用: ' + p.name + '（先在配置页里启用）');
      e0.status = this.statusOne(p);
      throw e0;
    }
    if (this.running(p.id)) return this.statusOne(p);
    const e = this.entry();
    const args = e.args.concat(['--run-profile', p.id, '--config', this.cfg.file, '--state-file', this.stateFile(p.id)]);
    const child = spawn(e.cmd, args, { cwd: this.baseDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.procs.set(p.id, { child: child, startedAt: Date.now() });
    this.logTails.set(p.id, '');
    const onData = (buf) => this.appendLog(p.id, buf.toString());
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      this.appendLog(p.id, '\n---- 进程退出 code=' + code + ' ----\n');
      const st = this.readState(p.id) || {};
      st.running = false;
      st.exitCode = code;
      st.exitReason = st.exitReason || '进程退出';
      st.url = '';
      this.writeState(p.id, st);
    });
    child.on('error', (err) => {
      this.appendLog(p.id, '\n进程启动失败: ' + err.message + '\n');
      this.writeState(p.id, { id: p.id, name: p.name, running: false, error: err.message });
    });
    if (opts.waitForUrl === false) return this.statusOne(p);
    const deadline = Date.now() + (opts.timeoutMs || 90000);
    while (Date.now() < deadline) {
      const st = this.readState(p.id);
      if (st && st.url && st.running) return this.statusOne(p);
      if (child.exitCode !== null) {
        const st2 = this.readState(p.id) || {};
        const tail = String(this.logTails.get(p.id) || '').trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(-240);
        const err = new Error('通道启动失败: ' + (st2.error || st2.exitReason || ('退出码 ' + child.exitCode)) + (tail ? ' —— ' + tail : ''));
        err.status = this.statusOne(p);
        throw err;
      }
      if (opts.noWait) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    return this.statusOne(p);
  }
  killTree(pid) {
    const n = Number(pid);
    if (!n) return;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true });
      else process.kill(n, 'SIGTERM');
    } catch (e) {}
  }
  async stop(id, opts) {
    opts = opts || {};
    const p = this.cfg.find(id);
    if (!p) throw new Error('找不到通道: ' + id);
    const rec = this.procs.get(p.id);
    const st = this.readState(p.id) || {};
    const pids = [];
    if (rec && rec.child && rec.child.pid) pids.push(rec.child.pid);
    else if (st.pid && this.isAlive(st.pid)) pids.push(st.pid);
    for (const pid of pids) this.killTree(pid);
    if (rec && rec.child) { try { rec.child.kill(); } catch (e) {} }
    this.procs.delete(p.id);
    // 等它真的退出
    const deadline = Date.now() + (opts.timeoutMs || 6000);
    while (Date.now() < deadline) {
      if (!this.isAlive((rec && rec.child && rec.child.pid) || st.pid)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (st.cloudflaredPid && this.isAlive(st.cloudflaredPid)) this.killTree(st.cloudflaredPid);
    const cur = this.readState(p.id) || {};
    cur.running = false;
    cur.url = '';
    cur.exitReason = cur.exitReason || '手动关闭';
    cur.stoppedAt = Date.now();
    this.writeState(p.id, cur);
    for (const f of [this.stateFile(p.id)]) { /* 保留状态，方便 GUI 显示上次地址 */ }
    return this.statusOne(p);
  }
  ownedPids(id) {
    const rec = this.procs.get(id);
    const st = this.readState(id) || {};
    const out = [];
    if (rec && rec.child && rec.child.pid) out.push(rec.child.pid);
    if (st.pid) out.push(Number(st.pid));
    if (st.cloudflaredPid) out.push(Number(st.cloudflaredPid));
    return out.filter(Boolean);
  }
  async stopAll() {
    const out = [];
    for (const p of this.cfg.profiles) out.push(await this.stop(p.id));
    return out;
  }
  async startEnabled() {
    const started = [];
    for (const p of this.cfg.profiles) {
      if (!p.enabled || !p.autoStart) continue;
      try { started.push((await this.start(p.id, { noWait: true })).id); }
      catch (e) { this.appendLog(p.id, '\n自动启动失败: ' + e.message + '\n'); }
    }
    return started;
  }
  async startAll() {
    const out = [];
    for (const p of this.cfg.profiles) {
      if (!p.enabled) continue;
      try { await this.start(p.id, { noWait: true }); out.push(p.id); } catch (e) {}
    }
    return out;
  }
  dispose() {
    for (const [id, rec] of this.procs) {
      if (rec.child && rec.child.pid) this.killTree(rec.child.pid);
    }
    this.procs.clear();
  }
}
module.exports = { TunnelManager, isPackaged };
