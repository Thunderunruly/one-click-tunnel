'use strict';
/**
 * 命名隧道 / 自有域名的一次性设置（登录、建隧道、绑域名）
 * CLI、配置页、MCP 共用这一份实现，避免三处逻辑各写一遍。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const NAMED = require('./named.js');

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', windowsHide: true, timeout: 300000 }, opts || {}));
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', output: ((r.stdout || '') + (r.stderr || '')).trim(), error: r.error ? r.error.message : '' };
}

/** 登录 Cloudflare（会打开浏览器，让用户选择要用的域名） */
function loginCloudflare(opts) {
  const cf = NAMED.cloudflaredStatus(opts.appDir, opts.cloudflared);
  if (!cf.ok) return { ok: false, error: '找不到 cloudflared: ' + cf.path };
  const certFile = NAMED.certPath(opts.appDir, opts.stateDir);
  fs.mkdirSync(path.dirname(certFile), { recursive: true });
  const r = run(cf.path, NAMED.loginArgs({ certFile: certFile }), { cwd: opts.appDir, stdio: opts.inherit ? 'inherit' : 'pipe' });
  const info = NAMED.certInfo(opts.appDir, opts.stateDir);
  if (info.ok) return { ok: true, certFile: certFile, output: r.output };
  return { ok: false, error: '登录没有完成（退出码 ' + r.status + '）：' + (r.output || r.error || '浏览器里没有完成授权？'), certFile: certFile };
}

/** 建隧道 + 绑域名 + 保存到配置；返回 { ok, tunnelId, hostname, publicUrl } */
function setupDomain(opts) {
  const cf = NAMED.cloudflaredStatus(opts.appDir, opts.cloudflared);
  if (!cf.ok) return { ok: false, error: '找不到 cloudflared: ' + cf.path };
  const hv = NAMED.validateHostname(opts.hostname);
  if (!hv.ok) return { ok: false, error: hv.error };
  if (!NAMED.certInfo(opts.appDir, opts.stateDir).ok) {
    return { ok: false, error: '还没有登录 Cloudflare，先执行登录（浏览器里选你的域名）', needLogin: true };
  }
  const certFile = NAMED.certPath(opts.appDir, opts.stateDir);
  const profile = opts.profile || {};
  const tunnelName = String(opts.tunnelName || profile.tunnelName || profile.id || 'one-click-tunnel').trim();
  const credFile = NAMED.credentialsPath(opts.appDir, opts.stateDir, profile.id || tunnelName);
  let tunnelId = String(opts.tunnelId || '').trim();

  if (!tunnelId && fs.existsSync(credFile)) {
    const c = NAMED.readCredentials(credFile);
    if (c.ok) tunnelId = c.tunnelId;
  }
  if (!tunnelId) {
    const created = run(cf.path, NAMED.createArgs({ certFile: certFile, tunnelName: tunnelName }), { cwd: opts.appDir });
    tunnelId = NAMED.parseCreatedTunnelId(created.output);
    if (!tunnelId) {
      // 隧道可能已存在：从 list 里找同名隧道
      const listed = run(cf.path, NAMED.listArgs({ certFile: certFile }), { cwd: opts.appDir });
      try {
        const arr = JSON.parse(listed.output.replace(/^\s*[^\[]*/, '') || '[]');
        const hit = (Array.isArray(arr) ? arr : []).find((t) => t && (t.name === tunnelName) && (t.id || t.ID));
        if (hit) tunnelId = hit.id || hit.ID;
      } catch (e) {}
      if (!tunnelId) return { ok: false, error: '创建命名隧道失败：' + (created.output || created.error || '（退出码 ' + created.status + '）') };
    }
    const src = path.join(NAMED.userCloudflaredDir(), tunnelId + '.json');
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(credFile), { recursive: true });
      fs.copyFileSync(src, credFile);
    } else if (!fs.existsSync(credFile)) {
      return { ok: false, error: '没有找到 cloudflared 生成的凭据文件 ' + src + '（隧道已建好，ID=' + tunnelId + '，可手动把该 json 复制到 ' + credFile + '）' };
    }
  }
  const routed = run(cf.path, NAMED.routeArgs({ certFile: certFile, tunnelRef: tunnelId, hostname: hv.hostname }), { cwd: opts.appDir });
  const routeOut = routed.output || '';
  const routeFailed = routed.status !== 0 && !/already|exists/i.test(routeOut);
  if (routeFailed) {
    return { ok: false, error: '绑定域名失败：' + (routeOut || '（退出码 ' + routed.status + '）'), tunnelId: tunnelId, hostname: hv.hostname };
  }
  return {
    ok: true, tunnelId: tunnelId, hostname: hv.hostname, tunnelName: tunnelName,
    publicUrl: 'https://' + hv.hostname, credentialsFile: credFile, certFile: certFile,
    routeOutput: routeOut, created: !!opts.tunnelId ? false : true,
  };
}
/** 删除命名隧道（Cloudflare 侧） */
function deleteTunnel(opts) {
  const cf = NAMED.cloudflaredStatus(opts.appDir, opts.cloudflared);
  if (!cf.ok) return { ok: false, error: '找不到 cloudflared: ' + cf.path };
  const certFile = NAMED.certPath(opts.appDir, opts.stateDir);
  if (!NAMED.certInfo(opts.appDir, opts.stateDir).ok) return { ok: false, error: '还没有登录 Cloudflare' };
  const r = run(cf.path, NAMED.deleteArgs({ certFile: certFile, tunnelRef: opts.tunnelId }), { cwd: opts.appDir });
  return { ok: r.status === 0, output: r.output, error: r.status === 0 ? '' : (r.output || '退出码 ' + r.status) };
}
module.exports = { loginCloudflare, setupDomain, deleteTunnel, run };
