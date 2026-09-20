'use strict';
/**
 * 命名隧道 / 自有域名（Cloudflare Named Tunnel）
 *  - 快速隧道（quick）：地址随机、每次都不一样
 *  - 命名隧道（named）：在 Cloudflare 账号里建一个固定隧道，绑自己的域名（如 app.example.com），
 *    地址永久固定；本程序仍然在它前面挂密码门，所以公网访问依旧要密码
 * 需要：一个托管在 Cloudflare 的域名 + cloudflared 登录一次（浏览器授权）
 *
 * 这个模块只做"纯函数 + 文件布局"，真正的 cloudflared 调用由调用方 spawn，方便离线测试。
 */
const fs = require('node:fs');
const path = require('node:path');

const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

function validateHostname(h) {
  const s = String(h || '').trim().toLowerCase();
  if (!s) return { ok: false, error: '域名不能为空' };
  if (s.length > 253) return { ok: false, error: '域名过长' };
  if (s.includes('*')) return { ok: false, error: '不支持通配符域名（请在 Cloudflare 里单独加一条 CNAME）' };
  if (!HOSTNAME_RE.test(s)) return { ok: false, error: '域名格式不对（示例：app.example.com）' };
  if (/\.trycloudflare\.com$/.test(s)) return { ok: false, error: '这是快速隧道域名，请填你自己的域名' };
  return { ok: true, hostname: s };
}
function isNamed(profile) {
  return !!profile && String(profile.mode || '').toLowerCase() === 'named';
}
function stateDirOf(baseDir, stateDir) {
  return stateDir || path.join(baseDir, 'state');
}
function cfDir(baseDir, stateDir) {
  return path.join(stateDirOf(baseDir, stateDir), 'cloudflare');
}
function certPath(baseDir, stateDir) { return path.join(cfDir(baseDir, stateDir), 'cert.pem'); }
function credentialsPath(baseDir, stateDir, id) { return path.join(cfDir(baseDir, stateDir), String(id) + '.credentials.json'); }
function configPath(baseDir, stateDir, id) { return path.join(cfDir(baseDir, stateDir), String(id) + '.cloudflared.yml'); }
function userCloudflaredDir() {
  return path.join(process.env.USERPROFILE || process.env.HOME || '.', '.cloudflared');
}

/** cloudflared 的配置：把公网域名指向"本地密码门"，而不是直接指向业务端口 */
function buildConfigYaml(opts) {
  const v = validateHostname(opts.hostname);
  if (!v.ok) throw new Error(v.error);
  const gatewayPort = Number(opts.gatewayPort);
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) throw new Error('网关端口不合法: ' + opts.gatewayPort);
  const lines = [];
  lines.push('# 由 one-click-tunnel 自动生成，请勿手改（改配置请在配置页里改）');
  lines.push('tunnel: ' + String(opts.tunnelId || opts.tunnelName || '').trim());
  lines.push("credentials-file: '" + String(opts.credentialsFile).replace(/'/g, "''") + "'");
  lines.push('no-autoupdate: true');
  lines.push('ingress:');
  lines.push('  - hostname: ' + v.hostname);
  lines.push('    service: http://127.0.0.1:' + gatewayPort);
  lines.push('    originRequest:');
  lines.push('      connectTimeout: 30s');
  lines.push('      disableChunkedEncoding: false');
  lines.push('  - service: http_status:404');
  lines.push('');
  return lines.join('\n');
}

/** 运行命名隧道的 cloudflared 参数 */
function runArgs(opts) {
  return ['tunnel', '--no-autoupdate', '--config', opts.configFile, 'run', String(opts.tunnelId || opts.tunnelName)];
}
/** 登录（浏览器授权，拿到账号级 cert.pem） */
function loginArgs(opts) {
  return ['tunnel', '--no-autoupdate', '--origincert', opts.certFile, 'login'];
}
/** 创建命名隧道：cloudflared tunnel create <name> */
function createArgs(opts) {
  return ['tunnel', '--no-autoupdate', '--origincert', opts.certFile, 'create', String(opts.tunnelName)];
}
/** 把域名 CNAME 指到隧道：cloudflared tunnel route dns <tunnel> <hostname> */
function routeArgs(opts) {
  return ['tunnel', '--no-autoupdate', '--origincert', opts.certFile, 'route', 'dns', String(opts.tunnelRef), String(opts.hostname)];
}
/** 列出隧道：cloudflared tunnel list --output json */
function listArgs(opts) {
  return ['tunnel', '--no-autoupdate', '--origincert', opts.certFile, 'list', '--output', 'json'];
}
/** 删除隧道：cloudflared tunnel delete <tunnel> */
function deleteArgs(opts) {
  return ['tunnel', '--no-autoupdate', '--origincert', opts.certFile, 'delete', String(opts.tunnelRef)];
}

function cloudflaredPathIn(baseDir) { return path.join(baseDir, 'cloudflared.exe'); }

function certInfo(baseDir, stateDir) {
  const f = certPath(baseDir, stateDir);
  try {
    const s = fs.readFileSync(f, 'utf8');
    const ok = s.includes('BEGIN CERTIFICATE') && s.includes('BEGIN PRIVATE KEY');
    return { ok: ok, path: f, bytes: Buffer.byteLength(s), exists: true };
  } catch (e) {
    return { ok: false, path: f, bytes: 0, exists: false, error: '还没有登录 Cloudflare（' + f + '）' };
  }
}
function readCredentials(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ok: !!(j && (j.TunnelID || j.tunnelId)),
      tunnelId: j.TunnelID || j.tunnelId || '',
      accountTag: j.AccountTag || j.accountTag || '',
      hasSecret: !!j.TunnelSecret,
      path: file,
    };
  } catch (e) {
    return { ok: false, tunnelId: '', path: file, error: e && e.message ? e.message : String(e) };
  }
}
/** 从 "Created tunnel xxx with id <uuid>" 里取隧道 ID */
function parseCreatedTunnelId(output) {
  const s = String(output || '');
  const m = s.match(/with id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    || s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : '';
}
/** 检查 cloudflared 是否可用 */
function cloudflaredStatus(baseDir, overridePath) {
  const p = overridePath || cloudflaredPathIn(baseDir);
  try {
    const st = fs.statSync(p);
    return { ok: st.size > 1024 * 1024, path: p, size: st.size };
  } catch (e) {
    return { ok: false, path: p, size: 0, error: '找不到 cloudflared: ' + p };
  }
}
/** 命名隧道需要的东西齐不齐（给 GUI/CLI 做前置检查） */
function namedReadiness(baseDir, stateDir, profile, cloudflaredOverride) {
  const v = validateHostname(profile && profile.hostname);
  const cert = certInfo(baseDir, stateDir);
  const credFile = credentialsPath(baseDir, stateDir, (profile && profile.id) || '');
  const cred = fs.existsSync(credFile) ? readCredentials(credFile) : { ok: false, tunnelId: '', path: credFile, error: '还没有创建命名隧道' };
  const cf = cloudflaredStatus(baseDir, cloudflaredOverride);
  const steps = [];
  if (!cf.ok) steps.push('下载 cloudflared（首次运行本程序会自动下载，或把 cloudflared.exe 放到程序目录）');
  if (!cert.ok) steps.push('登录 Cloudflare：cloudflared tunnel login（浏览器里选择你的域名）');
  if (!cred.ok) steps.push('创建命名隧道：cloudflared tunnel create ' + ((profile && (profile.tunnelName || profile.id)) || '<名字>'));
  if (!v.ok) steps.push('填写要用的域名（示例 app.example.com）');
  return {
    ready: cf.ok && cert.ok && cred.ok && v.ok,
    cloudflared: cf, cert: cert, credentials: cred, hostname: v.ok ? v.hostname : '',
    hostnameError: v.ok ? '' : v.error, steps: steps,
    tunnelId: cred.tunnelId || (profile && profile.tunnelId) || '',
    configFile: configPath(baseDir, stateDir, (profile && profile.id) || ''),
    credentialsFile: credFile,
    publicUrl: v.ok ? 'https://' + v.hostname : '',
  };
}
module.exports = {
  validateHostname, isNamed, cfDir, certPath, credentialsPath, configPath, userCloudflaredDir,
  buildConfigYaml, runArgs, loginArgs, createArgs, routeArgs, listArgs, deleteArgs,
  certInfo, readCredentials, parseCreatedTunnelId, cloudflaredStatus, namedReadiness, cloudflaredPathIn,
};
