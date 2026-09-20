'use strict';
/**
 * 更新检查 / 下载
 *  - 从 GitHub Release 拉取最新版本信息（默认走 api.github.com，可用 update.apiBase 换镜像）
 *  - 版本比较用语义化版本（支持 v 前缀、预发布）
 *  - 结果缓存到 state/update.json（默认 6 小时检查一次；GUI 里可以手动"检查更新"）
 *  - 下载安装包时会用 release 里的 SHA256SUMS.txt 校验，校验不过直接删除并报错
 *  - 支持 update.downloadMirror（形如 https://mirror.example/{url}）给 github 被墙的网络用
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const U = require('./util.js');
const { currentVersion } = require('./version.js');

const DEFAULT_REPO = 'Thunderunruly/one-click-tunnel';
const DEFAULT_API = 'https://api.github.com';

function cfgOf(cfg) {
  const c = (cfg && cfg.data && cfg.data.update) || {};
  return {
    enabled: c.enabled !== false,
    repo: c.repo || DEFAULT_REPO,
    apiBase: (c.apiBase || DEFAULT_API).replace(/\/+$/, ''),
    checkIntervalHours: Number(c.checkIntervalHours || 6),
    autoDownload: !!c.autoDownload,
    includePrerelease: !!c.includePrerelease,
    downloadMirror: String(c.downloadMirror || ''),
    ignoredVersion: String(c.ignoredVersion || ''),
  };
}

function parseVersion(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] || 0), patch: Number(m[3] || 0), pre: m[4] || '' };
}
function compareVersions(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}
function isNewer(latest, current) { return compareVersions(latest, current) > 0; }

function httpRequest(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u = null;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL 不合法: ' + url)); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: (u.pathname || '/') + (u.search || ''), method: opts.method || 'GET',
      headers: Object.assign({ 'user-agent': 'one-click-tunnel-updater', accept: '*/*' }, opts.headers || {}),
      timeout: opts.timeoutMs || 15000,
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && (opts.redirects || 0) < 5) {
        res.resume();
        resolve(httpRequest(new URL(res.headers.location, url).toString(), Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 })));
        return;
      }
      resolve({ status: code, headers: res.headers, stream: res });
    });
    req.on('error', (e) => reject(new Error('网络请求失败: ' + (e.code || e.message))));
    req.on('timeout', () => req.destroy(new Error('网络请求超时')));
    req.end();
  });
}
function readAll(stream, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    stream.on('data', (c) => {
      n += c.length;
      if (limitBytes && n > limitBytes) { stream.destroy(); return reject(new Error('响应体过大')); }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
async function getJson(url, opts) {
  const res = await httpRequest(url, Object.assign({ headers: { accept: 'application/vnd.github+json' } }, opts || {}));
  if (res.status === 304) return { status: 304, notModified: true, json: null };
  const buf = await readAll(res.stream, 2 * 1024 * 1024);
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { json = null; }
  return { status: res.status, headers: res.headers, json: json, text: buf.toString('utf8').slice(0, 400) };
}

function withMirror(url, mirror) {
  const m = String(mirror || '').trim();
  if (!m || !/^https?:\/\//.test(url)) return url;
  if (m.includes('{url}')) return m.replace('{url}', url);
  if (m.includes('{raw}')) return m.replace('{raw}', url.replace(/^https?:\/\//, ''));
  return m.replace(/\/+$/, '') + '/' + url;
}
function assetList(release, mirror) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  return assets.map((a) => ({
    name: String(a.name || ''),
    size: Number(a.size || 0),
    url: withMirror(String(a.browser_download_url || ''), mirror),
    rawUrl: String(a.browser_download_url || ''),
  }));
}
function pickInstaller(assets) {
  const setup = assets.find((a) => /setup-.*\.exe$/i.test(a.name));
  if (setup) return { kind: 'setup', asset: setup };
  const zip = assets.find((a) => /\.zip$/i.test(a.name));
  if (zip) return { kind: 'zip', asset: zip };
  return null;
}
async function fetchSums(assets, opts) {
  const sums = assets.find((a) => /sha256sums/i.test(a.name));
  if (!sums) return null;
  try {
    const res = await httpRequest(sums.url, { timeoutMs: (opts && opts.timeoutMs) || 15000 });
    if (res.status !== 200) return null;
    const buf = await readAll(res.stream, 256 * 1024);
    const map = {};
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
      if (m) map[m[2].trim()] = m[1].toLowerCase();
    }
    return map;
  } catch (e) { return null; }
}

function cacheFile(baseDir) { return path.join(baseDir, 'state', 'update.json'); }
function readCache(baseDir) { return U.readJsonSafe(cacheFile(baseDir), null); }
function writeCache(baseDir, obj) { try { U.writeJsonAtomic(cacheFile(baseDir), obj); } catch (e) {} }

function payloadFrom(cfg, release, extra) {
  const c = cfgOf(cfg);
  const current = currentVersion();
  const latest = String((release && (release.tag_name || release.name)) || '').replace(/^v/i, '');
  const latestOk = !!parseVersion(latest);
  const assets = assetList(release, c.downloadMirror);
  const pick = pickInstaller(assets);
  let hasUpdate = false;
  if (latestOk) hasUpdate = isNewer(latest, current);
  if (latestOk && !c.includePrerelease && parseVersion(latest) && parseVersion(latest).pre) hasUpdate = false;
  const ignored = !!c.ignoredVersion && latest === c.ignoredVersion;
  return Object.assign({
    ok: true, checkedAt: Date.now(), currentVersion: current, repo: c.repo,
    latestVersion: latest || '', hasUpdate: hasUpdate && !ignored, ignored: ignored,
    publishedAt: (release && release.published_at) || '',
    htmlUrl: (release && release.html_url) || ('https://github.com/' + c.repo + '/releases'),
    notes: String((release && (release.body || '')) || '').slice(0, 4000),
    name: (release && release.name) || '',
    assets: assets.map((a) => ({ name: a.name, size: a.size, url: a.url })),
    installer: pick ? { kind: pick.kind, name: pick.asset.name, size: pick.asset.size, url: pick.asset.url } : null,
    mirror: c.downloadMirror,
  }, extra || {});
}

/** 检查更新；force=true 时忽略缓存立刻请求；返回统一结构的 payload */
async function checkForUpdate(cfg, baseDir, opts) {
  opts = opts || {};
  const c = cfgOf(cfg);
  const current = currentVersion();
  const cached = readCache(baseDir);
  const intervalMs = Math.max(1, c.checkIntervalHours) * 3600 * 1000;
  if (!opts.force && cached && cached.checkedAt && (Date.now() - cached.checkedAt) < intervalMs && !opts.ignoreCache) {
    return Object.assign({}, cached, { fromCache: true, currentVersion: current });
  }
  if (!c.enabled && !opts.force) {
    return { ok: false, error: '更新检查已关闭（config.json 里 update.enabled=false）', currentVersion: current, fromCache: false };
  }
  const url = c.apiBase + '/repos/' + c.repo + '/releases/' + (c.includePrerelease ? '?per_page=1' : 'latest');
  const headers = {};
  if (!c.includePrerelease && cached && cached.etag) headers['if-none-match'] = cached.etag;
  let result = null;
  try {
    const res = c.includePrerelease
      ? await getJson(c.apiBase + '/repos/' + c.repo + '/releases?per_page=1', { headers: headers, timeoutMs: opts.timeoutMs })
      : await getJson(url, { headers: headers, timeoutMs: opts.timeoutMs });
    if (res.notModified && cached) {
      result = Object.assign({}, cached, { checkedAt: Date.now(), fromCache: false, notModified: true, currentVersion: current });
    } else if (res.status === 404) {
      result = { ok: false, error: '仓库还没有发布任何 Release（或仓库地址/镜像不对）', currentVersion: current, latestVersion: '', hasUpdate: false, checkedAt: Date.now() };
    } else if (res.status === 403) {
      result = { ok: false, error: 'GitHub API 限流（403），稍后再试或改用 update.apiBase 镜像', currentVersion: current, hasUpdate: false, checkedAt: Date.now() };
    } else if (res.status !== 200 || !res.json) {
      result = { ok: false, error: '更新检查失败：HTTP ' + res.status + ' ' + String(res.text || '').slice(0, 120), currentVersion: current, hasUpdate: false, checkedAt: Date.now() };
    } else {
      const rel = Array.isArray(res.json) ? res.json[0] : res.json;
      if (!rel) result = { ok: false, error: '没有找到 Release', currentVersion: current, hasUpdate: false, checkedAt: Date.now() };
      else result = payloadFrom(cfg, rel, { etag: res.headers && res.headers.etag ? res.headers.etag : '' });
    }
  } catch (e) {
    result = { ok: false, error: '更新检查失败: ' + (e && e.message ? e.message : String(e)), currentVersion: current, hasUpdate: false, checkedAt: Date.now(), hint: '如果你的网络访问不了 api.github.com，可以在配置里把 update.apiBase 换成镜像地址' };
  }
  writeCache(baseDir, result);
  return Object.assign({ fromCache: false }, result);
}

/** 下载首选安装包（setup.exe 优先，其次 zip），并用 SHA256SUMS.txt 校验 */
async function downloadUpdate(cfg, baseDir, opts) {
  opts = opts || {};
  const c = cfgOf(cfg);
  const current = currentVersion();
  let info = opts.payload;
  if (!info) info = await checkForUpdate(cfg, baseDir, { force: true });
  if (!info || !info.ok) return { ok: false, error: (info && info.error) || '先做一次成功的更新检查' };
  if (!info.installer) return { ok: false, error: '这个 Release 里没有可下载的安装包（setup.exe / zip）' };
  const dir = path.join(baseDir, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, info.installer.name);
  const releases = assetList(opts.release || { assets: info.assets.map((a) => ({ name: a.name, size: a.size, browser_download_url: a.url })) }, c.downloadMirror);
  const sums = await fetchSums(releases, { timeoutMs: opts.timeoutMs });
  const expect = sums ? sums[info.installer.name] : '';
  const res = await httpRequest(info.installer.url, { timeoutMs: opts.timeoutMs || 600000 });
  if (res.status !== 200) {
    await readAll(res.stream, 1024).catch(() => {});
    return { ok: false, error: '下载失败：HTTP ' + res.status + '（github.com 被墙时可以配置 update.downloadMirror）' };
  }
  const tmp = dest + '.part';
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    res.stream.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
    res.stream.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    res.stream.pipe(ws);
  }).catch((e) => { try { fs.rmSync(tmp, { force: true }); } catch (e2) {} throw e; });
  const sha = hash.digest('hex');
  if (expect && expect !== sha) {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    return { ok: false, error: 'SHA-256 校验不通过，已删除下载文件（期望 ' + expect.slice(0, 12) + '… 实际 ' + sha.slice(0, 12) + '…）' };
  }
  fs.renameSync(tmp, dest);
  const out = { ok: true, path: dest, name: info.installer.name, kind: info.installer.kind, bytes: bytes, sha256: sha, verified: !!expect, version: info.latestVersion, currentVersion: current };
  writeCache(baseDir, Object.assign({}, readCache(baseDir) || {}, { downloaded: { name: out.name, path: out.path, sha256: sha, at: Date.now(), version: info.latestVersion } }));
  return out;
}

/** 静默安装已下载的 setup.exe（zip 只能提示用户手动解压） */
async function installUpdate(cfg, baseDir, opts) {
  opts = opts || {};
  const c = cfgOf(cfg);
  const cache = readCache(baseDir) || {};
  const info = cache.downloaded || null;
  if (!info || !info.path || !fs.existsSync(info.path)) return { ok: false, error: '还没有下载过安装包（先执行 tunnel update --download）' };
  if (!/setup-.*\.exe$/i.test(info.name)) return { ok: false, error: '下载的是便携 zip，需要手动解压；自动安装只支持 setup.exe：' + info.path };
  const { spawnSync } = require('node:child_process');
  const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
  if (opts.dir) args.push('/DIR=' + opts.dir);
  const r = spawnSync(info.path, args, { windowsHide: true, timeout: 600000 });
  return { ok: r.status === 0, exitCode: r.status, path: info.path, version: info.version };
}

function setIgnored(cfg, version) {
  cfg.data.update = Object.assign({}, cfg.data.update, { ignoredVersion: version || '' });
  cfg.save();
  return cfg.data.update.ignoredVersion;
}

module.exports = {
  checkForUpdate, downloadUpdate, installUpdate, setIgnored, cfgOf, cacheFile, readCache, writeCache,
  compareVersions, isNewer, parseVersion, withMirror, fetchSums, assetList, pickInstaller, DEFAULT_REPO, DEFAULT_API,
};
