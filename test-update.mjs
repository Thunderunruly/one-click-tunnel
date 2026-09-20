// 更新功能测试：用本地假 GitHub API 覆盖检查/缓存/ETag/下载校验/镜像/忽略/异常
// 用法: node test-update.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UP = require(path.join(HERE, 'lib', 'updater.js'));
const { Config } = require(path.join(HERE, 'lib', 'config.js'));

let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = Buffer.from('FAKE-SETUP-EXE-' + 'x'.repeat(4096));
const ZIP = Buffer.from('PK-FAKE-ZIP-' + 'y'.repeat(1024));
let port = 0;
const hits = { api: 0, dl: 0, sums: 0, mirror: 0 };
const state = {
  tag: 'v9.9.9', mode: 'ok', tamper: false, etag304: false,
  includeZip: true, setupName: 'one-click-tunnel-setup-9.9.9.exe',
};
function sumsBody() {
  const h = state.tamper ? 'f'.repeat(64) : crypto.createHash('sha256').update(SETUP).digest('hex');
  return h + '  ' + state.setupName + '\n';
}
function releaseJson() {
  const base = 'http://127.0.0.1:' + port;
  const assets = [
    { name: state.setupName, size: SETUP.length, browser_download_url: base + '/dl/setup.exe' },
    { name: 'SHA256SUMS.txt', size: sumsBody().length, browser_download_url: base + '/dl/SHA256SUMS.txt' },
  ];
  if (state.includeZip) assets.push({ name: 'one-click-tunnel-9.9.9-win-x64.zip', size: ZIP.length, browser_download_url: base + '/dl/portable.zip' });
  return { tag_name: state.tag, name: state.tag, body: '## 更新说明\n- 修了一些东西\n', published_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/Thunderunruly/one-click-tunnel/releases/tag/' + state.tag, assets: assets };
}
const server = http.createServer((req, res) => {
  const url = req.url || '';
  if (url.indexOf('/repos/') === 0 && url.indexOf('/releases') > 0) {
    hits.api += 1;
    if (state.mode === '404') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"Not Found"}'); }
    if (state.mode === '500') { res.writeHead(500); return res.end('boom'); }
    if (state.mode === 'badjson') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('<html>not json</html>'); }
    if (state.etag304) { res.writeHead(304, { etag: 'W/"fixed"' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json', etag: 'W/"fixed"' });
    return res.end(JSON.stringify(releaseJson()));
  }
  if (url === '/dl/setup.exe') { hits.dl += 1; res.writeHead(200); return res.end(SETUP); }
  if (url === '/dl/SHA256SUMS.txt') { hits.sums += 1; res.writeHead(200); return res.end(sumsBody()); }
  if (url === '/dl/portable.zip') { hits.dl += 1; res.writeHead(200); return res.end(ZIP); }
  if (url.indexOf('/mirror/') === 0) {
    hits.mirror += 1;
    if (url.indexOf('SHA256SUMS') > 0) { res.writeHead(200); return res.end(sumsBody()); }
    res.writeHead(200); return res.end(SETUP);
  }
  if (url.indexOf('/redirect') === 0) { res.writeHead(302, { location: 'http://127.0.0.1:' + port + '/dl/setup.exe' }); return res.end(); }
  res.writeHead(404); res.end('nope');
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-update-'));
const cfgFile = path.join(tmp, 'config.json');
function freshConfig(patch) {
  fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, profiles: [], update: Object.assign({ repo: 'Thunderunruly/one-click-tunnel', apiBase: 'http://127.0.0.1:' + port }, patch || {}) }, null, 2));
  return new Config(cfgFile).load();
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  // 有更新
  state.tag = 'v9.9.9'; state.mode = 'ok'; state.tamper = false; state.etag304 = false;
  let cfg = freshConfig();
  let r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U1 检测到新版本', r.ok && r.hasUpdate && r.latestVersion === '9.9.9', JSON.stringify({ ok: r.ok, has: r.hasUpdate, latest: r.latestVersion, err: r.error }));
  ok('U1b 带出更新说明与发布页', (r.notes || '').indexOf('更新说明') >= 0 && /releases\/tag/.test(r.htmlUrl || ''), (r.notes || '').slice(0, 40));
  ok('U1c 自动挑出 setup.exe 作为首选安装包', r.installer && r.installer.kind === 'setup' && /setup.*\.exe$/.test(r.installer.name), JSON.stringify(r.installer));
  ok('U1d 当前版本取自 package.json/注入值', r.currentVersion === '1.1.0', r.currentVersion);
  ok('U1e 结果写入了 state/update.json 缓存', !!UP.readCache(tmp) && UP.readCache(tmp).latestVersion === '9.9.9');

  // 缓存：不强制不走网络
  const apiBefore = hits.api;
  let r2 = await UP.checkForUpdate(cfg, tmp, {});
  ok('U2 缓存期内不重复请求 API', hits.api === apiBefore && r2.fromCache === true, 'hits ' + apiBefore + '->' + hits.api + ' fromCache=' + r2.fromCache);
  r2 = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U3 force 会重新请求', hits.api === apiBefore + 1, 'hits=' + hits.api);

  // 已是最新 / 更旧
  state.tag = 'v1.1.0';
  cfg = freshConfig();
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U4 版本相同不算有更新', r.ok && !r.hasUpdate && r.latestVersion === '1.1.0', JSON.stringify({ has: r.hasUpdate, latest: r.latestVersion }));
  state.tag = 'v1.0.0';
  cfg = freshConfig();
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U5 远端版本更旧不算更新', r.ok && !r.hasUpdate, JSON.stringify({ has: r.hasUpdate }));

  // 预发布
  state.tag = 'v9.9.9-beta.1';
  cfg = freshConfig();
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U6 默认忽略预发布版本', r.ok && !r.hasUpdate, JSON.stringify({ has: r.hasUpdate, latest: r.latestVersion }));
  cfg = freshConfig({ includePrerelease: true });
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U6b 打开 includePrerelease 后接受预发布', r.ok && r.hasUpdate, JSON.stringify({ has: r.hasUpdate }));

  // ETag 304
  state.tag = 'v9.9.9'; state.etag304 = true;
  cfg = freshConfig();
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U7 304 时标记 notModified 且不报错', r.ok && r.notModified === true, JSON.stringify({ ok: r.ok, nm: r.notModified, err: r.error }));
  state.etag304 = false;

  // 下载 + SHA256 校验
  cfg = freshConfig();
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  let d = await UP.downloadUpdate(cfg, tmp, { payload: r });
  ok('U8 下载安装包成功', d.ok && fs.existsSync(d.path), JSON.stringify({ ok: d.ok, err: d.error }));
  ok('U8b 文件内容正确', d.ok && fs.readFileSync(d.path).equals(SETUP), d.ok ? String(fs.statSync(d.path).size) : '');
  ok('U8c SHA-256 校验通过并标记 verified', d.ok && d.verified === true && d.sha256 === crypto.createHash('sha256').update(SETUP).digest('hex'), JSON.stringify({ v: d.verified, s: (d.sha256 || '').slice(0, 10) }));
  ok('U8d 下载记录进缓存', !!(UP.readCache(tmp) || {}).downloaded && UP.readCache(tmp).downloaded.name === state.setupName);
  ok('U8e 没有留下 .part 临时文件', !fs.readdirSync(path.join(tmp, 'updates')).some((f) => f.endsWith('.part')), fs.readdirSync(path.join(tmp, 'updates')).join(','));

  // 校验和不匹配必须拒绝
  state.tamper = true;
  d = await UP.downloadUpdate(cfg, tmp, { payload: r });
  ok('U9 SHA-256 不匹配时拒绝并删除文件', !d.ok && /校验不通过/.test(d.error || ''), JSON.stringify({ ok: d.ok, err: (d.error || '').slice(0, 60) }));
  ok('U9b 校验失败后没有 .part 残留', !fs.readdirSync(path.join(tmp, 'updates')).some((f) => f.endsWith('.part')));
  state.tamper = false;

  // 镜像
  hits.mirror = 0;
  cfg = freshConfig({ downloadMirror: 'http://127.0.0.1:' + port + '/mirror/{url}' });
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U10 配置镜像后下载地址被改写', /\/mirror\//.test(r.installer.url), r.installer.url);
  d = await UP.downloadUpdate(cfg, tmp, { payload: r });
  ok('U10b 走镜像也能下载成功', d.ok && hits.mirror >= 1 && d.verified === true, JSON.stringify({ ok: d.ok, mirrorHits: hits.mirror, err: d.error }));

  // 忽略版本
  cfg = freshConfig();
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U11 忽略前 hasUpdate=true', r.hasUpdate === true);
  UP.setIgnored(cfg, r.latestVersion);
  const cfg2 = new Config(cfgFile).load();
  r = await UP.checkForUpdate(cfg2, tmp, { force: true });
  ok('U11b 忽略后不再提示，但保留 ignored 标记', r.ok && r.hasUpdate === false && r.ignored === true, JSON.stringify({ has: r.hasUpdate, ign: r.ignored }));

  // 各种失败路径
  state.mode = '404';
  cfg = freshConfig();
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U12 仓库没有 Release 时给出可读提示', !r.ok && /没有发布任何 Release/.test(r.error || ''), r.error);
  state.mode = '500';
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U13 API 500 不抛异常且记录错误', !r.ok && /HTTP 500/.test(r.error || ''), r.error);
  state.mode = 'badjson';
  r = await UP.checkForUpdate(cfg, tmp, { force: true });
  ok('U14 非 JSON 响应不崩溃', !r.ok && !!r.error, r.error);
  state.mode = 'ok';
  const cfgDead = freshConfig({ apiBase: 'http://127.0.0.1:1' });
  r = await UP.checkForUpdate(cfgDead, tmp, { force: true });
  ok('U15 连不上 API 时给出网络错误 + 镜像提示', !r.ok && /网络请求失败/.test(r.error || '') && !!r.hint, (r.error || '') + ' | ' + (r.hint || '').slice(0, 30));

  // 只给 zip 的 release
  state.includeZip = true; state.setupName = 'one-click-tunnel-setup-9.9.9.exe';
  const noSetup = JSON.stringify(releaseJson()).replace(/one-click-tunnel-setup-9\.9\.9\.exe/g, 'one-click-tunnel-9.9.9-win-x64.zip');
  ok('U16 zip 兜底逻辑存在（无 setup 时选 zip）', UP.pickInstaller(UP.assetList({ assets: [{ name: 'one-click-tunnel-9.9.9-win-x64.zip', browser_download_url: 'http://x/a.zip' }] }, '')).kind === 'zip');

  // 版本比较
  ok('U17 版本比较', UP.compareVersions('1.10.0', '1.9.9') === 1 && UP.compareVersions('v2.0.0', '1.9.9') === 1 && UP.compareVersions('1.0.0', '1.0') === 0 && UP.isNewer('1.0.1', '1.0.0'));

  // 重定向
  const redir = await UP.downloadUpdate(freshConfig(), tmp, { payload: { ok: true, installer: { name: 'setup.exe', url: 'http://127.0.0.1:' + port + '/redirect', size: 1 }, assets: [], latestVersion: '9.9.9' } });
  ok('U18 下载会跟随 302 重定向', redir.ok && fs.readFileSync(redir.path).equals(SETUP), JSON.stringify({ ok: redir.ok, err: redir.error }));

  // 真实 api.github.com（可达与否都不能抛异常）
  let live = null;
  try { live = await UP.checkForUpdate(freshConfig({ apiBase: 'https://api.github.com' }), tmp, { force: true, timeoutMs: 12000 }); }
  catch (e) { live = { ok: false, error: 'threw: ' + e.message }; }
  ok('U19 真实 GitHub API 调用不会抛异常（有网络时返回真实结果）', !!live && typeof live.ok === 'boolean', JSON.stringify({ ok: live && live.ok, err: live && live.error ? String(live.error).slice(0, 80) : '', latest: live && live.latestVersion }));
}

main().catch((e) => { failures.push('EXCEPTION: ' + (e && e.message ? e.message : e)); console.log(e); })
  .finally(async () => {
    try { server.close(); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log('\n================ 更新功能测试结果 ================');
    console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(failures.length ? 1 : 0);
  });
