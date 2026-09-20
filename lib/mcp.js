'use strict';
/**
 * MCP 服务（stdio JSON-RPC 2.0）：让 AI 直接管理这些通道
 *  - stdout 只走协议，日志一律走 stderr
 *  - 真正的启停还是交给守护进程，所以 AI 开的通道在配置页里一样能看到、能手动关
 *  - 受 config.json 里 mcp.enabled / mcp.allowStart / mcp.allowStop 控制
 */
const path = require('node:path');
const { Config } = require('./config.js');
const DC = require('./daemonctl.js');
const U = require('./util.js');

const SERVER_NAME = 'public-tunnel';
const SERVER_VERSION = '1.1.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function log() {
  try { process.stderr.write('[mcp] ' + Array.prototype.slice.call(arguments).join(' ') + '\n'); } catch (e) {}
}

const TOOLS = [
  {
    name: 'list_tunnels',
    description: '列出所有通道（配置 + 运行状态：公网地址、访问密码、剩余时间）。AI 先调用它了解现状。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'start_tunnel',
    description: '按 id 启动一个已配置的通道（可同时启动多个）。返回公网地址与访问密码。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '通道 id 或名称' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'stop_tunnel',
    description: '按 id 停止一个通道（公网地址随即失效）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'create_tunnel',
    description: '新建一个通道（把本机某个端口临时发布到公网）。可选立即启动。密码默认随机生成。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '通道名称，如 "前端 5777"' },
        port: { type: 'number', description: '本机端口 1-65535' },
        ttl: { type: 'string', description: '有效期，如 30m / 2h / 1d，默认用全局默认值' },
        password: { type: 'string', description: '手动指定访问密码；不填=每次随机生成' },
        gateway: { type: 'number', description: '本地密码门端口（一般不用填，自动分配）' },
        auto_start: { type: 'boolean', description: '是否随守护进程自动启动' },
        start_now: { type: 'boolean', description: '创建后是否立即启动（默认 true）' },
        no_tunnel: { type: 'boolean', description: '只起本地密码门、不建公网隧道（排障/自测用）' },
      },
      required: ['name', 'port'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_tunnel',
    description: '修改通道：有效期、密码模式（random/fixed）、手动密码、是否启用、是否自动启动。改动在下次启动时生效。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ttl: { type: 'string' },
        password_mode: { type: 'string', enum: ['random', 'fixed'] },
        password: { type: 'string' },
        enabled: { type: 'boolean' },
        auto_start: { type: 'boolean' },
        restart: { type: 'boolean', description: '正在运行的话是否立刻重启以生效（默认 false）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_tunnel',
    description: '删除一个通道（会先停止它）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'tunnel_status',
    description: '查看某个通道（或全部）的详细状态，包含进程号、日志尾部。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, log_lines: { type: 'number' } }, additionalProperties: false },
  },
  {
    name: 'set_password',
    description: '设置访问密码：mode=random 重新随机生成；mode=fixed 用指定密码。运行中的通道会自动重启生效。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['random', 'fixed'] }, password: { type: 'string' } },
      required: ['id', 'mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_all',
    description: '停止所有正在运行的通道（一键全部关闭）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function toolList() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

function okText(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: 'text', text: text }], isError: false };
}
function errText(msg) {
  return { content: [{ type: 'text', text: '错误: ' + msg }], isError: true };
}

async function callTool(ctx, cfg, name, args) {
  const m = cfg.data.mcp || {};
  if (m.enabled === false) {
    throw new Error('MCP 已关闭（config.json 里 mcp.enabled=false），可在配置页的「全局设置」里打开');
  }
  args = args || {};
  const needDaemon = async () => DC.ensureDaemon(ctx);
  const stateOf = async (d) => DC.httpJson(d.port, 'GET', '/api/state', undefined, d.token);
  const findOne = (st, id) => st.profiles.filter((p) => p.id === id || p.name === id)[0];

  if (name === 'list_tunnels') {
    const d = await needDaemon();
    const st = await stateOf(d);
    return okText({
      guiUrl: 'http://127.0.0.1:' + d.port + '/?token=' + d.token,
      configFile: ctx.configFile,
      tunnels: st.profiles.map((p) => ({
        id: p.id, name: p.name, running: p.running, enabled: p.enabled, autoStart: p.autoStart,
        localPort: p.port, gatewayPort: p.gateway, ttl: p.ttl, passwordMode: p.passwordMode,
        url: p.url || '', password: p.running ? p.password : '', remainingSeconds: p.running ? Math.round(p.remainingMs / 1000) : 0,
      })),
    });
  }
  if (name === 'start_tunnel') {
    if (m.allowStart === false) throw new Error('MCP 不允许启动通道（mcp.allowStart=false）');
    const d = await needDaemon();
    const r = await DC.httpJson(d.port, 'POST', '/api/action', { action: 'start', id: String(args.id) }, d.token, 120000);
    const s = r.status || {};
    return okText({ id: s.id, name: s.name, url: s.url, password: s.password, localPort: s.port, gatewayPort: s.gateway,
      expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : '', remainingSeconds: Math.round((s.remainingMs || 0) / 1000) });
  }
  if (name === 'stop_tunnel') {
    if (m.allowStop === false) throw new Error('MCP 不允许停止通道（mcp.allowStop=false）');
    const d = await needDaemon();
    const r = await DC.httpJson(d.port, 'POST', '/api/action', { action: 'stop', id: String(args.id) }, d.token, 60000);
    return okText({ id: r.status.id, running: r.status.running, message: '已停止，公网地址立即失效' });
  }
  if (name === 'stop_all') {
    const d = await needDaemon();
    await DC.httpJson(d.port, 'POST', '/api/action', { action: 'stopAll' }, d.token, 120000);
    return okText({ ok: true, message: '所有通道已停止' });
  }
  if (name === 'create_tunnel') {
    if (m.allowStart === false && args.start_now !== false) throw new Error('MCP 不允许启动通道（mcp.allowStart=false）');
    const port = Number(args.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port 必须是 1-65535 的整数');
    if (args.ttl) U.parseTtl(String(args.ttl));
    const d = await needDaemon();
    const profile = { name: String(args.name), port: port, ttl: args.ttl, gateway: args.gateway,
      passwordMode: args.password ? 'fixed' : 'random', password: args.password || '',
      autoStart: !!args.auto_start, noTunnel: !!args.no_tunnel };
    Object.keys(profile).forEach((k) => { if (profile[k] === undefined) delete profile[k]; });
    const added = await DC.httpJson(d.port, 'POST', '/api/profile', { profile: profile }, d.token);
    const id = added.profile.id;
    if (args.start_now === false) return okText({ id: id, created: true, started: false, gatewayPort: added.profile.gateway });
    const r = await DC.httpJson(d.port, 'POST', '/api/action', { action: 'start', id: id }, d.token, 120000);
    const s = r.status || {};
    return okText({ id: id, created: true, started: true, url: s.url, password: s.password,
      localPort: s.port, gatewayPort: s.gateway, expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : '' });
  }
  if (name === 'update_tunnel') {
    const patch = {};
    if (args.ttl !== undefined) patch.ttl = String(args.ttl);
    if (args.password_mode !== undefined) patch.passwordMode = String(args.password_mode);
    if (args.password !== undefined) patch.password = String(args.password);
    if (args.enabled !== undefined) patch.enabled = !!args.enabled;
    if (args.auto_start !== undefined) patch.autoStart = !!args.auto_start;
    if (!Object.keys(patch).length) throw new Error('至少要指定一个要改的字段');
    const d = await needDaemon();
    const st0 = await stateOf(d);
    const before = findOne(st0, String(args.id));
    const r = await DC.httpJson(d.port, 'POST', '/api/profile', { id: String(args.id), patch: patch }, d.token);
    let restarted = false;
    if (args.restart && before && before.running) {
      await DC.httpJson(d.port, 'POST', '/api/action', { action: 'stop', id: r.profile.id }, d.token, 60000);
      const rr = await DC.httpJson(d.port, 'POST', '/api/action', { action: 'start', id: r.profile.id }, d.token, 120000);
      restarted = true;
      return okText({ id: r.profile.id, updated: patch, restarted: restarted, url: rr.status.url, password: rr.status.password });
    }
    return okText({ id: r.profile.id, updated: patch, restarted: restarted, note: '改动会在下次启动该通道时生效' });
  }
  if (name === 'delete_tunnel') {
    const d = await needDaemon();
    await DC.httpJson(d.port, 'POST', '/api/delete', { id: String(args.id) }, d.token, 60000);
    return okText({ id: String(args.id), deleted: true });
  }
  if (name === 'tunnel_status') {
    const d = await needDaemon();
    const st = await stateOf(d);
    const list = args.id ? [findOne(st, String(args.id))].filter(Boolean) : st.profiles;
    if (args.id && !list.length) throw new Error('找不到通道: ' + args.id);
    const wantLog = args.id || args.log_lines;
    const out = [];
    for (const p of list) {
      const item = Object.assign({}, p);
      if (wantLog) {
        try {
          const lg = await DC.httpJson(d.port, 'GET', '/api/log?id=' + encodeURIComponent(p.id), undefined, d.token);
          const lines = String(lg.log || '').split('\n');
          item.logTail = lines.slice(-(Number(args.log_lines) || 20)).join('\n');
        } catch (e) { item.logTail = '(读取日志失败: ' + e.message + ')'; }
      }
      out.push(item);
    }
    return okText(args.id ? out[0] : { tunnels: out });
  }
  if (name === 'set_password') {
    const mode = String(args.mode);
    if (mode !== 'random' && mode !== 'fixed') throw new Error('mode 只能是 random 或 fixed');
    if (mode === 'fixed' && !String(args.password || '').trim()) throw new Error('mode=fixed 时必须提供 password');
    const d = await needDaemon();
    const st0 = await stateOf(d);
    const before = findOne(st0, String(args.id));
    if (!before) throw new Error('找不到通道: ' + args.id);
    const patch = mode === 'fixed' ? { passwordMode: 'fixed', password: String(args.password) } : { passwordMode: 'random', password: '' };
    await DC.httpJson(d.port, 'POST', '/api/profile', { id: before.id, patch: patch }, d.token);
    if (before.running) {
      await DC.httpJson(d.port, 'POST', '/api/action', { action: 'stop', id: before.id }, d.token, 60000);
      const rr = await DC.httpJson(d.port, 'POST', '/api/action', { action: 'start', id: before.id }, d.token, 120000);
      return okText({ id: before.id, mode: mode, restarted: true, url: rr.status.url, password: rr.status.password });
    }
    return okText({ id: before.id, mode: mode, restarted: false, note: '通道当前没在运行，新密码会在下次启动时生效' });
  }
  throw new Error('未知工具: ' + name);
}

async function runMcp(ctx, flags) {
  const cfg = new Config(ctx.configFile).load();
  if ((cfg.data.mcp || {}).enabled === false) log('注意: config.json 里 mcp.enabled=false，工具调用会被拒绝');
  let buf = '';
  let shuttingDown = false;

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
  function sendResult(id, result) { send({ jsonrpc: '2.0', id: id, result: result }); }
  function sendError(id, code, message) { send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    const id = msg.id;
    const method = String(msg.method || '');
    if (id === undefined || id === null) return; // 通知，不需要回
    try {
      if (method === 'initialize') {
        const want = msg.params && msg.params.protocolVersion;
        const version = SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1];
        return sendResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: '临时公网映射 (public-tunnel)' },
          instructions: '用 list_tunnels 看现状；create_tunnel/start_tunnel 会把本机端口临时发布到公网（带随机密码），stop_tunnel 立即收回。所有操作在本地配置页里也能看到。',
        });
      }
      if (method === 'ping') return sendResult(id, {});
      if (method === 'tools/list') return sendResult(id, { tools: toolList() });
      if (method === 'tools/call') {
        const params = msg.params || {};
        const name = String(params.name || '');
        const args = params.arguments || {};
        try {
          const r = await callTool(ctx, cfg, name, args);
          return sendResult(id, r);
        } catch (e) {
          return sendResult(id, errText(e && e.message ? e.message : String(e)));
        }
      }
      if (method === 'resources/list') return sendResult(id, { resources: [] });
      if (method === 'prompts/list') return sendResult(id, { prompts: [] });
      if (method === 'logging/setLevel') return sendResult(id, {});
      return sendError(id, -32601, 'Method not found: ' + method);
    } catch (e) {
      return sendError(id, -32603, 'Internal error: ' + (e && e.message ? e.message : String(e)));
    }
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx = buf.indexOf('\n');
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        let msg = null;
        try { msg = JSON.parse(line); } catch (e) { log('收到的不是合法 JSON，已忽略'); msg = null; }
        if (msg) handle(msg).catch((e) => log('处理失败: ' + e.message));
      }
      idx = buf.indexOf('\n');
    }
  });
  process.stdin.on('end', () => { if (!shuttingDown) { shuttingDown = true; process.exit(0); } });
  log('MCP 服务就绪（stdio），工具: ' + TOOLS.map((t) => t.name).join(', '));
  // 一直活着，等宿主关闭 stdin
  await new Promise(() => {});
  return 0;
}

module.exports = { runMcp, TOOLS, toolList };
