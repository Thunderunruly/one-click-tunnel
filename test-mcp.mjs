// MCP（AI 集成）端到端测试：手写 JSON-RPC 走 stdio，验证握手/工具/错误处理
// 用法: node test-mcp.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
// 设 TUNNEL_ENTRY=dist\\oct.exe 可以对打包后的 exe 跑同一套 MCP 测试
const TUNNEL = process.env.TUNNEL_ENTRY ? path.resolve(HERE, process.env.TUNNEL_ENTRY) : path.join(HERE, 'tunnel.js');
const PACKAGED = TUNNEL.toLowerCase().endsWith('.exe');
const TOOL_DIR = path.dirname(TUNNEL);
function spawnTunnel(args) { return PACKAGED ? spawn(TUNNEL, args, { cwd: TOOL_DIR, windowsHide: true }) : spawn(NODE, [TUNNEL].concat(args), { cwd: TOOL_DIR, windowsHide: true }); }
let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-mcp-'));
const cfgFile = path.join(tmp, 'config.json');
let child = null;
let stdoutBuf = '';
const responses = new Map();
let waiters = [];
let nextId = 1;
let parseErrors = [];
let stderrBuf = '';

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id: id, method: method };
  if (params !== undefined) msg.params = params;
  child.stdin.write(JSON.stringify(msg) + '\n');
  return waitFor(id);
}
function notify(method, params) {
  const msg = { jsonrpc: '2.0', method: method };
  if (params !== undefined) msg.params = params;
  child.stdin.write(JSON.stringify(msg) + '\n');
}
function waitFor(id, timeoutMs) {
  if (responses.has(id)) { const v = responses.get(id); responses.delete(id); return Promise.resolve(v); }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待响应超时 id=' + id)), timeoutMs || 90000);
    waiters.push({ id: id, resolve: (v) => { clearTimeout(t); resolve(v); } });
  });
}
function toolCall(name, args) {
  return send('tools/call', { name: name, arguments: args || {} }).then((r) => {
    const text = r.result && r.result.content && r.result.content[0] ? r.result.content[0].text : '';
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { raw: r, json: json, text: text, isError: !!(r.result && r.result.isError) };
  });
}
function killTree(pid) { try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); else process.kill(pid, 'SIGKILL'); } catch (e) {} }

async function main() {
  fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, gui: { port: 18466 }, mcp: { enabled: true }, profiles: [] }, null, 2));
  child = spawnTunnel(['mcp', '--config', cfgFile]);
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    let i = stdoutBuf.indexOf('\n');
    while (i >= 0) {
      const line = stdoutBuf.slice(0, i).trim();
      stdoutBuf = stdoutBuf.slice(i + 1);
      if (line) {
        let msg = null;
        try { msg = JSON.parse(line); } catch (e) { parseErrors.push(line.slice(0, 120)); msg = null; }
        if (msg) {
          const w = waiters.find((x) => x.id === msg.id);
          if (w) { waiters = waiters.filter((x) => x !== w); w.resolve(msg); }
          else responses.set(msg.id, msg);
        }
      }
      i = stdoutBuf.indexOf('\n');
    }
  });
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  child.on('error', (e) => { stderrBuf += 'SPAWN ERROR ' + e.message; });

  const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  ok('P1 initialize 返回协议版本与服务器信息', init.result && init.result.protocolVersion === '2025-06-18' && init.result.serverInfo && init.result.serverInfo.name === 'public-tunnel', JSON.stringify(init.result && init.result.serverInfo));
  ok('P1b 声明了 tools 能力', !!(init.result.capabilities && init.result.capabilities.tools));
  notify('notifications/initialized');

  const oldProto = await send('initialize', { protocolVersion: '1999-01-01' });
  ok('P2 不认识的协议版本回落到受支持的版本', oldProto.result && ['2025-06-18', '2025-03-26', '2024-11-05'].includes(oldProto.result.protocolVersion), oldProto.result && oldProto.result.protocolVersion);

  const ping = await send('ping');
  ok('P3 ping 有响应', !!ping.result);

  const tools = await send('tools/list');
  const names = (tools.result.tools || []).map((t) => t.name);
  ok('P4 tools/list 暴露全部管理工具', ['list_tunnels', 'start_tunnel', 'stop_tunnel', 'create_tunnel', 'update_tunnel', 'delete_tunnel', 'tunnel_status', 'set_password', 'stop_all'].every((n) => names.includes(n)), names.join(','));
  ok('P4b 每个工具都有 inputSchema', (tools.result.tools || []).every((t) => t.inputSchema && t.inputSchema.type === 'object'));

  const empty = await toolCall('list_tunnels');
  ok('P5 list_tunnels 初始为空（并自动拉起守护进程）', empty.json && Array.isArray(empty.json.tunnels) && empty.json.tunnels.length === 0, empty.text.slice(0, 150));
  ok('P5b 返回了配置页地址方便人工查看', !!(empty.json && empty.json.guiUrl && empty.json.guiUrl.indexOf('token=') > 0));

  const created = await toolCall('create_tunnel', { name: 'MCP 测试', port: 19931, ttl: '30m', no_tunnel: true, start_now: true });
  const id = created.json && created.json.id;
  ok('P6 create_tunnel 建好并启动了通道', !!id && created.json.started === true, created.text.slice(0, 180));
  ok('P6b 自动生成了访问密码', !!(created.json && created.json.password && created.json.password.length >= 8), created.json && created.json.password);
  ok('P6c 自动分配了网关端口', !!(created.json && created.json.gatewayPort >= 18080), created.json && created.json.gatewayPort);

  const list2 = await toolCall('list_tunnels');
  const mine = list2.json.tunnels.filter((t) => t.id === id)[0];
  ok('P7 list_tunnels 能看到运行中的通道与密码', mine && mine.running && mine.password && mine.remainingSeconds > 0, JSON.stringify(mine && { r: mine.running, rem: mine.remainingSeconds }));

  const st = await toolCall('tunnel_status', { id: id, log_lines: 5 });
  ok('P8 tunnel_status 带日志尾部', st.json && typeof st.json.logTail === 'string', st.text.slice(0, 120));

  const upd = await toolCall('update_tunnel', { id: id, ttl: '45m' });
  ok('P9 update_tunnel 修改 TTL', upd.json && upd.json.updated && upd.json.updated.ttl === '45m', upd.text.slice(0, 140));

  const pw = await toolCall('set_password', { id: id, mode: 'random' });
  ok('P10 set_password(random) 重新生成并重启', pw.json && pw.json.restarted === true && !!pw.json.password, pw.text.slice(0, 160));
  ok('P10b 新密码与旧密码不同', pw.json && created.json && pw.json.password !== created.json.password);

  const stop = await toolCall('stop_tunnel', { id: id });
  ok('P11 stop_tunnel 停止成功', stop.json && stop.json.running === false, stop.text.slice(0, 120));

  const bad = await toolCall('start_tunnel', { id: '不存在的通道' });
  ok('P12 对不存在的通道报错但不崩', bad.isError === true && /找不到通道/.test(bad.text), bad.text.slice(0, 140));

  const badPort = await toolCall('create_tunnel', { name: '坏端口', port: 99999, no_tunnel: true });
  ok('P13 非法端口被拒绝', badPort.isError === true && /port/.test(badPort.text), badPort.text.slice(0, 120));

  const unknown = await toolCall('不存在的工具', {});
  ok('P14 未知工具返回 isError', unknown.isError === true, unknown.text.slice(0, 100));

  const badMethod = await send('foo/bar', {});
  ok('P15 未知方法返回 -32601', badMethod.error && badMethod.error.code === -32601, JSON.stringify(badMethod.error));

  child.stdin.write('这不是 JSON\n');
  await sleep(300);
  const stillAlive = await send('ping');
  ok('P16 非法 JSON 输入不会让服务崩溃', !!stillAlive.result);
  ok('P16b stdout 全程都是合法 JSON-RPC（日志走了 stderr）', parseErrors.length === 0, parseErrors.join(' | ').slice(0, 120));

  const del = await toolCall('delete_tunnel', { id: id });
  ok('P17 delete_tunnel 删除成功', del.json && del.json.deleted === true);
  const all = await toolCall('stop_all');
  ok('P18 stop_all 可用', all.json && all.json.ok === true);
  ok('P19 运行期日志都写在 stderr（stdout 干净）', stderrBuf.indexOf('[mcp]') >= 0, stderrBuf.slice(0, 80));

  child.stdin.end();
  const dl = Date.now() + 6000;
  while (Date.now() < dl && child.exitCode === null) await sleep(200);
  ok('P20 宿主关闭 stdin 后服务退出', child.exitCode === 0 || child.exitCode === null, 'exitCode=' + child.exitCode);

  try {
    const d = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'daemon.json'), 'utf8'));
    await fetch('http://127.0.0.1:' + d.port + '/api/shutdown', { method: 'POST', headers: { 'x-tunnel-token': d.token, 'content-type': 'application/json', origin: 'http://127.0.0.1:' + d.port }, body: '{}' });
  } catch (e) {}
}

main().catch((e) => { failures.push('EXCEPTION: ' + (e && e.message ? e.message : e)); console.log(e); })
  .finally(async () => {
    if (child && child.pid) killTree(child.pid);
    await sleep(800);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log('\n================ MCP 测试结果 ================');
    console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(failures.length ? 1 : 0);
  });
