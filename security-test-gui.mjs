// GUI 配置页 / 守护进程 API 安全测试（离线，点本地回环）
// 用法: node security-test-gui.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const TUNNEL = path.join(HERE, 'tunnel.js');
let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(port, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const body = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
    const headers = Object.assign({}, opts.headers || {});
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = body.length; }
    const r = http.request({ host: '127.0.0.1', port: port, path: p, method: method, headers: headers, timeout: 15000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c.toString(); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: b, json: json });
      });
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: '', json: null, err: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, headers: {}, body: '', json: null, err: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-gui-'));
const cfgFile = path.join(tmp, 'config.json');
let child = null;
let token = '';
let port = 0;

function killTree(pid) { try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); else process.kill(pid, 'SIGKILL'); } catch (e) {} }

async function main() {
  fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, gui: { port: 18455 }, profiles: [] }, null, 2));
  child = spawn(NODE, [TUNNEL, 'gui', '--quiet', '--no-open', '--config', cfgFile], { cwd: HERE, windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const daemonFile = path.join(tmp, 'state', 'daemon.json');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fs.existsSync(daemonFile)) { const j = JSON.parse(fs.readFileSync(daemonFile, 'utf8')); token = j.token; port = j.port; if (token && port) break; }
    await sleep(300);
  }
  ok('G0 守护进程启动并写入 daemon.json', !!token && !!port, out.trim().slice(-200));

  const h = await req(port, 'GET', '/api/health');
  ok('G1 /api/health 免鉴权可用', h.status === 200 && h.json && h.json.ok === true, h.status);
  ok('G1b /api/health 不泄露 token', h.body.indexOf(token) < 0);

  const noTok = await req(port, 'GET', '/api/state');
  ok('G2 无 token 读状态 401', noTok.status === 401, noTok.status);
  const badTok = await req(port, 'GET', '/api/state', { headers: { 'x-tunnel-token': 'wrong-token-xxxx' } });
  ok('G3 错误 token 读状态 401', badTok.status === 401, badTok.status);
  const goodTok = await req(port, 'GET', '/api/state', { headers: { 'x-tunnel-token': token } });
  ok('G4 正确 token 读状态 200 且含通道数组', goodTok.status === 200 && Array.isArray(goodTok.json.profiles), goodTok.status);

  const page401 = await req(port, 'GET', '/');
  ok('G5 无 token 打开配置页 401', page401.status === 401, page401.status);
  const page = await req(port, 'GET', '/?token=' + token);
  ok('G6 带 token 打开配置页 200', page.status === 200 && page.body.indexOf('临时公网映射') >= 0, page.status);
  ok('G6b 配置页下发 HttpOnly + SameSite=Strict Cookie', /pt_token=[A-Za-z0-9_-]+/.test(String(page.headers['set-cookie'] || '')) && String(page.headers['set-cookie']).toLowerCase().indexOf('httponly') >= 0 && String(page.headers['set-cookie']).toLowerCase().indexOf('samesite=strict') >= 0, String(page.headers['set-cookie']).slice(0, 90));
  ok('G6c 配置页有 CSP 且禁止 frame/外链脚本', String(page.headers['content-security-policy'] || '').indexOf("default-src 'none'") >= 0 && String(page.headers['x-frame-options']) === 'DENY', String(page.headers['content-security-policy']).slice(0, 60));
  ok('G6d 配置页不引用任何外部资源', !/src="https?:|href="https?:/.test(page.body));
  const cookie = String(page.headers['set-cookie'] || '').split(';')[0];
  const withCookie = await req(port, 'GET', '/api/state', { headers: { cookie: cookie } });
  ok('G7 Cookie 也能通过鉴权', withCookie.status === 200, withCookie.status);

  const csrf1 = await req(port, 'POST', '/api/action', { headers: { 'x-tunnel-token': token, origin: 'https://evil.example' }, body: { action: 'stopAll' } });
  ok('G8 跨站 Origin 的写操作 403', csrf1.status === 403, csrf1.status);
  const csrf2 = await req(port, 'POST', '/api/action', { headers: { 'x-tunnel-token': token, 'sec-fetch-site': 'cross-site' }, body: { action: 'stopAll' } });
  ok('G9 Sec-Fetch-Site: cross-site 被拒 403', csrf2.status === 403, csrf2.status);
  const csrf3 = await req(port, 'POST', '/api/action', { headers: { origin: 'http://127.0.0.1:' + port }, body: { action: 'stopAll' } });
  ok('G10 同源但无 token 的写操作 401', csrf3.status === 401, csrf3.status);
  const getAction = await req(port, 'GET', '/api/action', { headers: { 'x-tunnel-token': token } });
  ok('G11 GET 不能触发写操作（404）', getAction.status === 404, getAction.status);

  const add = await req(port, 'POST', '/api/profile', { headers: { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, body: { profile: { name: 'GUI 通道', port: 19921, ttl: '30m', noTunnel: true } } });
  ok('G12 通过 API 新增通道', add.status === 200 && add.json.profile && add.json.profile.id, add.status + ' ' + add.body.slice(0, 120));
  const id = add.json && add.json.profile ? add.json.profile.id : '';
  ok('G12b 自动分配了网关端口', add.json.profile.gateway >= 18080, JSON.stringify(add.json.profile && add.json.profile.gateway));

  const start = await req(port, 'POST', '/api/action', { headers: { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, body: { action: 'start', id: id } });
  ok('G13 通过 API 启动通道', start.status === 200 && start.json.status.running && /^\d+$/.test(String(start.json.status.gateway)), start.status + ' ' + JSON.stringify(start.json.status && { r: start.json.status.running, e: start.json.status.error }));
  const st = await req(port, 'GET', '/api/state', { headers: { 'x-tunnel-token': token } });
  const mine = st.json.profiles.filter((p) => p.id === id)[0];
  ok('G14 状态里能看到运行中的通道与密码', mine && mine.running && mine.password && mine.remainingMs > 0, JSON.stringify(mine && { r: mine.running, p: mine.password, rem: mine.remainingMs }));

  const dis = await req(port, 'POST', '/api/action', { headers: { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, body: { action: 'disable', id: id } });
  ok('G15 停用通道会顺带把它停掉', dis.status === 200 && dis.json.profile.enabled === false && !dis.json.profiles.filter((p) => p.id === id)[0].running, dis.status);

  // 模拟"1.0.0 时代留下的缓存说 1.4.0 是新版"，当前已经是 1.5.x => 不能再提示有更新
  const cacheFile = path.join(tmp, 'state', 'update.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ ok: true, checkedAt: Date.now(), currentVersion: '1.0.0',
    latestVersion: '1.4.0', hasUpdate: true, ignored: false, htmlUrl: 'https://example.invalid' }, null, 2));
  const staleState = await req(port, 'GET', '/api/state', { headers: { 'x-tunnel-token': token } });
  const su = (staleState.json && staleState.json.update) || {};
  // 关键性质：不管后台有没有来得及重查，都绝不能再出现"最新版本比当前版本还旧却提示有更新"
  const consistent = su.hasUpdate === false && (su.latestVersion === '1.4.0' ? su.staleCache === true : true);
  ok('G16e 升级后不再拿旧缓存提示"有新版"（且状态自洽）', consistent,
    JSON.stringify({ has: su.hasUpdate, latest: su.latestVersion, stale: su.staleCache, cur: su.currentVersion }));

  const updNoTok = await req(port, 'GET', '/api/update');
  ok('G16a /api/update 无 token 401', updNoTok.status === 401, updNoTok.status);
  const updPost = await req(port, 'POST', '/api/update', { headers: { 'x-tunnel-token': token, origin: 'https://evil.example' }, body: { action: 'check' } });
  ok('G16b 跨站 Origin 触发更新检查 403', updPost.status === 403, updPost.status);
  const updGet = await req(port, 'GET', '/api/update', { headers: { 'x-tunnel-token': token } });
  ok('G16c 认证后可读更新状态（离线也返回结构）', updGet.status === 200 && !!updGet.json.update && typeof updGet.json.update.currentVersion === 'string', updGet.status + ' ' + JSON.stringify(updGet.json && updGet.json.update && updGet.json.update.currentVersion));
  const updBad = await req(port, 'POST', '/api/update', { headers: { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, body: { action: 'nope' } });
  ok('G16d 未知更新动作 400', updBad.status === 400, updBad.status);

  const log = await req(port, 'GET', '/api/log?id=' + encodeURIComponent(id), { headers: { 'x-tunnel-token': token } });
  ok('G16 能读取通道日志', log.status === 200 && typeof log.json.log === 'string', log.status);

  const set = await req(port, 'POST', '/api/settings', { headers: { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, body: { defaults: { ttl: '2h' }, mcp: { enabled: false } } });
  ok('G17 能保存全局设置', set.status === 200 && set.json.defaults.ttl === '2h' && set.json.mcp.enabled === false, set.status);
  ok('G17b 设置已持久化到 config.json', JSON.parse(fs.readFileSync(cfgFile, 'utf8')).defaults.ttl === '2h');

  const badProfile = await req(port, 'POST', '/api/profile', { headers: { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, body: { profile: { name: '坏的', port: 70000 } } });
  ok('G18 非法配置被拒绝且不 500', badProfile.status === 400 && /port/.test(badProfile.json.error || ''), badProfile.status + ' ' + badProfile.body.slice(0, 90));

  const del = await req(port, 'POST', '/api/delete', { headers: { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, body: { id: id } });
  ok('G19 删除通道', del.status === 200 && !del.json.profiles.some((p) => p.id === id), del.status);

  const sd = await req(port, 'POST', '/api/shutdown', { headers: { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, body: {} });
  ok('G20 shutdown 接口返回成功', sd.status === 200, sd.status);
  const dl2 = Date.now() + 8000;
  let gone = false;
  while (Date.now() < dl2) { if (!fs.existsSync(daemonFile)) { gone = true; break; } await sleep(250); }
  ok('G21 关闭后 daemon.json 被清理', gone);
  const ping2 = await req(port, 'GET', '/api/health');
  ok('G22 关闭后端口不再响应', ping2.status === 0, ping2.status);
}

main().catch((e) => { failures.push('EXCEPTION: ' + (e && e.message ? e.message : e)); console.log(e); })
  .finally(async () => {
    if (child && child.pid) killTree(child.pid);
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log('\n================ GUI/API 安全测试结果 ================');
    console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(failures.length ? 1 : 0);
  });
