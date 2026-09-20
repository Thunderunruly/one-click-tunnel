// 打包产物（exe）端到端测试：三种前端（CLI 子命令 / GUI 守护进程 / 子进程自启动）都能用
// 用法: node test-exe.mjs            （默认测 dist/public-tunnel.exe）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = process.env.TUNNEL_ENTRY ? path.resolve(HERE, process.env.TUNNEL_ENTRY) : path.join(HERE, 'dist', 'public-tunnel.exe');
let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function runExe(args, timeoutMs) {
  return new Promise((resolve) => {
    const c = spawn(EXE, args, { cwd: path.dirname(EXE), windowsHide: true });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.stderr.on('data', (d) => { err += d.toString(); });
    let done = false;
    const fin = (code) => { if (done) return; done = true; resolve({ code: code, out: out, err: err }); };
    c.on('exit', (code) => fin(code));
    c.on('error', (e) => { err += ' ' + e.message; fin(-1); });
    setTimeout(() => { try { c.kill(); } catch (e) {} fin(null); }, timeoutMs || 60000);
  });
}
function req(port, method, p, headers, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({}, headers || {});
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port: port, path: p, method: method, headers: h, timeout: 120000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c.toString(); });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j, body: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, json: null, body: '', err: e.code }));
    if (data) r.write(data);
    r.end();
  });
}
function killTree(pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) {} }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-exe-'));
const cfgFile = path.join(tmp, 'config.json');
let daemon = null;

async function main() {
  ok('E0 打包产物存在', fs.existsSync(EXE), EXE);
  const help = await runExe(['help'], 30000);
  ok('E1 exe help 子命令可用', help.code === 0 && help.out.indexOf('通道管理') >= 0, JSON.stringify(help.out.slice(0, 80)));
  const classic = await runExe(['--help'], 30000);
  ok('E2 经典参数帮助仍可用', classic.code === 0 && classic.out.indexOf('--token') < 0 && classic.out.indexOf('--port') >= 0, JSON.stringify(classic.out.slice(0, 60)));

  fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, gui: { port: 18477 }, profiles: [] }, null, 2));
  const empty = await runExe(['list', '--config', cfgFile, '--quiet'], 30000);
  ok('E3 exe list 能读配置（空）', empty.code === 0 && empty.out.indexOf('还没有配置任何通道') >= 0, JSON.stringify(empty.out.slice(0, 100)));

  const added = await runExe(['add', '--config', cfgFile, '--name', 'exe 通道', '--port', '19941', '--ttl', '30m', '--no-tunnel'], 30000);
  ok('E4 exe add 写入配置', added.code === 0 && added.out.indexOf('已添加通道') >= 0, JSON.stringify(added.out.slice(0, 120)));
  ok('E4b 配置文件真的写进去了', JSON.parse(fs.readFileSync(cfgFile, 'utf8')).profiles.length === 1);

  daemon = spawn(EXE, ['gui', '--quiet', '--no-open', '--config', cfgFile], { cwd: path.dirname(EXE), windowsHide: true, detached: true, stdio: 'ignore' });
  let token = '', port = 0;
  const daemonFile = path.join(tmp, 'state', 'daemon.json');
  const dl = Date.now() + 25000;
  while (Date.now() < dl) {
    if (fs.existsSync(daemonFile)) { const j = JSON.parse(fs.readFileSync(daemonFile, 'utf8')); token = j.token; port = j.port; if (token && port) break; }
    await sleep(300);
  }
  ok('E5 exe gui 起守护进程并写 daemon.json', !!token && !!port, 'port=' + port);

  const st = await req(port, 'GET', '/api/state', { 'x-tunnel-token': token });
  ok('E6 exe 守护进程 API 可用', st.status === 200 && st.json.profiles.length === 1, st.status + ' ' + JSON.stringify(st.json && st.json.profiles.length));

  const id = st.json.profiles[0].id;
  const started = await req(port, 'POST', '/api/action', { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, { action: 'start', id: id });
  ok('E7 exe 能启动通道子进程', started.status === 200 && started.json.status.running, started.status + ' ' + JSON.stringify(started.json && started.json.status && { r: started.json.status.running, e: started.json.status.error, u: started.json.status.url }));
  const childPid = started.json.status.pid;
  let img = '';
  try {
    const r = spawnSync('tasklist', ['/FI', 'PID eq ' + childPid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    img = ((r.stdout || '').match(/^"([^"]+)"/m) || [])[1] || '';
  } catch (e) {}
  ok('E8 子进程就是打包后的 exe 自己（自举成功）', img.toLowerCase().indexOf('public-tunnel') >= 0 || process.platform !== 'win32', 'pid=' + childPid + ' img=' + img);

  const stopped = await req(port, 'POST', '/api/action', { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, { action: 'stop', id: id });
  ok('E9 exe 能停通道', stopped.status === 200 && !stopped.json.status.running, stopped.status);

  const sd = await req(port, 'POST', '/api/shutdown', { 'x-tunnel-token': token, origin: 'http://127.0.0.1:' + port }, {});
  ok('E10 exe 守护进程能被关闭', sd.status === 200, sd.status);
  const dl2 = Date.now() + 8000;
  while (Date.now() < dl2 && fs.existsSync(daemonFile)) await sleep(250);
  ok('E11 关闭后 daemon.json 清理', !fs.existsSync(daemonFile));
}

main().catch((e) => { failures.push('EXCEPTION: ' + (e && e.message ? e.message : e)); console.log(e); })
  .finally(async () => {
    if (daemon && daemon.pid) killTree(daemon.pid);
    await sleep(600);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log('\n================ 打包产物测试结果 ================');
    console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(failures.length ? 1 : 0);
  });
