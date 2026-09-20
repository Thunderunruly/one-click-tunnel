'use strict';
/**
 * 把 Cloudflare 的登录/建隧道做成"可观察的后台任务"：
 * 配置页 POST 一下立刻返回 taskId，然后轮询日志，把 cloudflared 的实时输出显示出来。
 */
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const NAMED = require('./named.js');

const tasks = new Map();
const MAX_TASKS = 20;

function newTask(label) {
  const id = crypto.randomBytes(6).toString('base64url');
  const t = { id: id, label: label, running: true, ok: null, error: '', result: null, log: '', startedAt: Date.now(), endedAt: 0, child: null };
  tasks.set(id, t);
  while (tasks.size > MAX_TASKS) {
    const first = tasks.keys().next().value;
    const old = tasks.get(first);
    if (old && old.running) break;
    tasks.delete(first);
  }
  return t;
}
function append(t, text) {
  t.log = (t.log + String(text)).slice(-20000);
}
function spawnStep(t, cmd, args, opts) {
  return new Promise((resolve) => {
    append(t, '\n$ ' + cmd + ' ' + args.join(' ') + '\n');
    let child = null;
    try {
      child = spawn(cmd, args, Object.assign({ cwd: opts.cwd, windowsHide: true }, opts.spawn || {}));
    } catch (e) {
      append(t, '启动失败: ' + e.message + '\n');
      return resolve({ status: -1, output: e.message });
    }
    t.child = child;
    let out = '';
    const onData = (buf) => { const s = buf.toString(); out += s; append(t, s); };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', (e) => { append(t, '进程错误: ' + e.message + '\n'); resolve({ status: -1, output: out + ' ' + e.message }); });
    child.on('exit', (code) => { append(t, '\n(退出码 ' + code + ')\n'); resolve({ status: code, output: out }); });
  });
}
function get(id) {
  const t = tasks.get(id);
  if (!t) return null;
  return { id: t.id, label: t.label, running: t.running, ok: t.ok, error: t.error, result: t.result, log: t.log,
    startedAt: t.startedAt, endedAt: t.endedAt };
}
function list() { return Array.from(tasks.values()).map((t) => get(t.id)); }

/** 登录任务：cloudflared tunnel login（浏览器授权），输出实时可看 */
function startLogin(opts) {
  const t = newTask('login');
  (async () => {
    const cf = NAMED.cloudflaredStatus(opts.appDir, opts.cloudflared);
    if (!cf.ok) { t.running = false; t.ok = false; t.error = '找不到 cloudflared: ' + cf.path; t.endedAt = Date.now(); return; }
    const certFile = NAMED.certPath(opts.appDir, opts.stateDir);
    require('node:fs').mkdirSync(require('node:path').dirname(certFile), { recursive: true });
    append(t, '浏览器会被打开，请在页面里选择你的域名（最长 5 分钟）\n');
    await spawnStep(t, cf.path, NAMED.loginArgs({ certFile: certFile }), { cwd: opts.appDir });
    const info = NAMED.certInfo(opts.appDir, opts.stateDir);
    t.running = false; t.endedAt = Date.now(); t.ok = info.ok;
    t.result = { certFile: certFile, validTo: info.validTo, daysLeft: info.daysLeft };
    if (!info.ok) t.error = '登录没有完成（浏览器里没有确认？）';
  })().catch((e) => { t.running = false; t.ok = false; t.error = e && e.message ? e.message : String(e); t.endedAt = Date.now(); });
  return t;
}

/** 建隧道 + 绑域名任务（支持多个域名） */
function startSetup(opts) {
  const t = newTask('setup');
  const fs = require('node:fs');
  const path = require('node:path');
  (async () => {
    const hv = NAMED.checkHostnames({ hostnames: opts.hostnames, hostname: opts.hostname });
    if (!hv.ok) { t.running = false; t.ok = false; t.error = hv.error; t.endedAt = Date.now(); return; }
    const cf = NAMED.cloudflaredStatus(opts.appDir, opts.cloudflared);
    if (!cf.ok) { t.running = false; t.ok = false; t.error = '找不到 cloudflared: ' + cf.path; t.endedAt = Date.now(); return; }
    const certFile = NAMED.certPath(opts.appDir, opts.stateDir);
    if (!NAMED.certInfo(opts.appDir, opts.stateDir).ok) { t.running = false; t.ok = false; t.error = '还没有登录 Cloudflare，先点「登录 Cloudflare」'; t.endedAt = Date.now(); return; }
    const tunnelName = String(opts.tunnelName || (opts.profile && (opts.profile.tunnelName || opts.profile.id)) || 'one-click-tunnel');
    const credFile = NAMED.credentialsPath(opts.appDir, opts.stateDir, (opts.profile && opts.profile.id) || tunnelName);
    let tunnelId = String(opts.tunnelId || '').trim();
    if (!tunnelId && fs.existsSync(credFile)) { const c = NAMED.readCredentials(credFile); if (c.ok) tunnelId = c.tunnelId; }
    if (!tunnelId) {
      const created = await spawnStep(t, cf.path, NAMED.createArgs({ certFile: certFile, tunnelName: tunnelName }), { cwd: opts.appDir });
      tunnelId = NAMED.parseCreatedTunnelId(created.output);
      if (!tunnelId) {
        const listed = await spawnStep(t, cf.path, NAMED.listArgs({ certFile: certFile }), { cwd: opts.appDir });
        try {
          const arr = JSON.parse(String(listed.output).replace(/^\s*[^\[]*/, '') || '[]');
          const hit = (Array.isArray(arr) ? arr : []).find((x) => x && x.name === tunnelName && (x.id || x.ID));
          if (hit) tunnelId = hit.id || hit.ID;
        } catch (e) {}
        if (!tunnelId) { t.running = false; t.ok = false; t.error = '创建命名隧道失败，请看上面的输出'; t.endedAt = Date.now(); return; }
        append(t, '复用已存在的隧道: ' + tunnelId + '\n');
      }
      const src = path.join(NAMED.userCloudflaredDir(), tunnelId + '.json');
      if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(credFile), { recursive: true }); fs.copyFileSync(src, credFile); append(t, '凭据已复制: ' + credFile + '\n'); }
    }
    const routed = [];
    for (const hostname of hv.hostnames) {
      const r = await spawnStep(t, cf.path, NAMED.routeArgs({ certFile: certFile, tunnelRef: tunnelId, hostname: hostname }), { cwd: opts.appDir });
      if (r.status === 0 || /already|exists/i.test(String(r.output))) { routed.push(hostname); continue; }
      t.running = false; t.ok = false; t.error = '绑定域名 ' + hostname + ' 失败'; t.endedAt = Date.now(); return;
    }
    t.running = false; t.ok = true; t.endedAt = Date.now();
    t.result = { tunnelId: tunnelId, tunnelName: tunnelName, hostnames: routed, publicUrls: routed.map((h) => 'https://' + h), credentialsFile: credFile, certFile: certFile };
  })().catch((e) => { t.running = false; t.ok = false; t.error = e && e.message ? e.message : String(e); t.endedAt = Date.now(); });
  return t;
}
module.exports = { startLogin, startSetup, get, list };
