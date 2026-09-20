'use strict';
/**
 * 命令行前端：tunnel list / start / stop / enable / disable / add / rm / config / gui / mcp / tray / daemon
 * 起停通道统一走守护进程（GUI 后台），保证"配置页里看到的"和"实际在跑的"是同一份状态。
 */
const path = require('node:path');
const fs = require('node:fs');
const { Config } = require('./config.js');
const { TunnelManager } = require('./manager.js');
const DC = require('./daemonctl.js');
const U = require('./util.js');

const APP_DIR = U.appDir();

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--local') out.local = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--open') out.open = true;
    else if (a === '--no-open') out.open = false;
    else if (a === '--no-tray') out.noTray = true;
    else if (a === '--config') out.config = String(next());
    else if (a === '--name') out.name = String(next());
    else if (a === '--id') out.id = String(next());
    else if (a === '--port' || a === '-p') out.port = Number(next());
    else if (a === '--gateway' || a === '-g') out.gateway = Number(next());
    else if (a === '--ttl' || a === '-t') out.ttl = String(next());
    else if (a === '--password' || a === '-P') out.password = String(next());
    else if (a === '--random') out.passwordMode = 'random';
    else if (a === '--rate-limit') out.rateLimit = Number(next());
    else if (a === '--upstream-host' || a === '-U') out.upstreamHost = String(next());
    else if (a === '--allow-host') { (out.allowHosts = out.allowHosts || []).push(String(next())); }
    else if (a === '--auto-start') out.autoStart = true;
    else if (a === '--no-auto-start') out.autoStart = false;
    else if (a === '--enabled') out.enabled = true;
    else if (a === '--disabled') out.enabled = false;
    else if (a === '--no-tunnel') out.noTunnel = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function ctxOf(flags) {
  const configFile = flags.config || process.env.TUNNEL_CONFIG || path.join(APP_DIR, 'config.json');
  return { appDir: APP_DIR, configFile: configFile, baseDir: path.dirname(configFile) };
}

function fmtRemain(ms) {
  if (!ms) return '-';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? h + 'h' : '') + m + 'm' + (h ? '' : (s % 60) + 's');
}
function printStatus(list, asJson) {
  if (asJson) return console.log(JSON.stringify(list, null, 2));
  if (!list.length) return console.log('（还没有配置任何通道，用 tunnel add --name 前端 --port 5777 添加）');
  const rows = list.map((s) => [s.id, s.name, (s.enabled ? '启用' : '停用'), (s.running ? '运行中' : '已停止'), s.port + ' -> ' + s.gateway, s.ttl,
    (s.passwordMode === 'fixed' ? '手动' : '随机'), (s.running ? fmtRemain(s.remainingMs) : '-'), (s.url || '-')]);
  const head = ['ID', '名称', '启用', '状态', '端口->网关', 'TTL', '密码', '剩余', '公网地址'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
}

async function run(cmd, argv) {
  const flags = parseFlags(argv);
  const ctx = ctxOf(flags);
  const localCfg = () => new Config(ctx.configFile).load();

  if (cmd === 'help' || flags.help) { printHelp(); return 0; }

  if (cmd === 'gui') {
    const { runGui } = require('./gui.js');
    if (flags.port) { const c = localCfg(); c.updateGui({ port: Number(flags.port) }); }
    if (flags.open !== undefined) { const c = localCfg(); c.updateGui({ openBrowser: !!flags.open }); }
    await runGui({ configFile: ctx.configFile, appDir: APP_DIR, open: flags.open, quiet: flags.quiet, port: flags.port, noTray: !!flags.noTray, tray: flags.noTray ? false : undefined });
    return 0;
  }
  if (cmd === 'tray') { const { runTray } = require('./tray.js'); return runTray(ctx, flags); }
  if (cmd === 'mcp') { const { runMcp } = require('./mcp.js'); return runMcp(ctx, flags); }

  if (cmd === 'daemon') {
    const sub = flags._[0] || 'status';
    if (sub === 'status') {
      const d = await DC.findDaemon(ctx.baseDir);
      console.log(d ? ('守护进程运行中: pid=' + d.pid + ' 端口=' + d.port) : '守护进程未运行');
      return 0;
    }
    if (sub === 'start') { const d = await DC.ensureDaemon(ctx); console.log('守护进程已启动: pid=' + d.pid + ' 端口=' + d.port + '（配置页 /?token=' + d.token + '）'); return 0; }
    if (sub === 'stop') { const ok = await DC.stopDaemon(ctx.baseDir); console.log(ok ? '守护进程已关闭' : '守护进程本来就没在运行'); return 0; }
    console.log('用法: tunnel daemon status|start|stop');
    return 2;
  }

  if (cmd === 'list' || cmd === 'status') {
    const d = await DC.findDaemon(ctx.baseDir);
    if (d) {
      const st = await DC.httpJson(d.port, 'GET', '/api/state', undefined, d.token);
      const one = flags._[0];
      const list = one ? st.profiles.filter((p) => p.id === one || p.name === one) : st.profiles;
      printStatus(list, flags.json);
      if (!flags.quiet) console.log('\n（守护进程运行中，配置页: http://127.0.0.1:' + d.port + '/?token=' + d.token + '）');
      return 0;
    }
    const cfg = localCfg();
    const mgr = new TunnelManager(cfg, { baseDir: ctx.baseDir, appDir: APP_DIR });
    const one = flags._[0];
    const list = one ? (mgr.status(one) ? [mgr.status(one)] : []) : mgr.status();
    printStatus(list, flags.json);
    if (!flags.quiet) console.log('\n（守护进程未运行，以上是各通道状态文件里的最后状态）');
    return 0;
  }

  if (cmd === 'add') {
    const profile = {
      id: flags.id, name: flags.name, port: flags.port, gateway: flags.gateway, ttl: flags.ttl,
      passwordMode: flags.password ? 'fixed' : (flags.passwordMode || 'random'), password: flags.password,
      autoStart: !!flags.autoStart, enabled: flags.enabled !== false, noTunnel: !!flags.noTunnel,
      rateLimit: flags.rateLimit, upstreamHost: flags.upstreamHost, allowHosts: flags.allowHosts,
    };
    Object.keys(profile).forEach((k) => { if (profile[k] === undefined) delete profile[k]; });
    if (!profile.name || !profile.port) { console.log('用法: tunnel add --name 前端 --port 5777 [--ttl 1h] [--password xxx|--random] [--auto-start]'); return 2; }
    const d = await DC.findDaemon(ctx.baseDir);
    if (d) {
      const r = await DC.httpJson(d.port, 'POST', '/api/profile', { profile: profile }, d.token);
      console.log('已添加通道: ' + r.profile.id + '（网关端口 ' + r.profile.gateway + '）');
      printStatus(r.profiles, false);
      return 0;
    }
    const cfg = localCfg();
    const p = cfg.addProfile(profile);
    console.log('已添加通道: ' + p.id + '（网关端口 ' + p.gateway + '，TTL ' + p.ttl + '，密码模式 ' + p.passwordMode + '）');
    return 0;
  }

  if (cmd === 'rm' || cmd === 'remove' || cmd === 'delete') {
    const ids = flags.all ? localCfg().profiles.map((p) => p.id) : flags._;
    if (!ids.length) { console.log('用法: tunnel rm <id...>|--all'); return 2; }
    const d = await DC.findDaemon(ctx.baseDir);
    for (const id of ids) {
      if (d) { await DC.httpJson(d.port, 'POST', '/api/delete', { id: id }, d.token); }
      else { const cfg = localCfg(); const p = cfg.find(id); if (p) { cfg.removeProfile(p.id); try { fs.rmSync(path.join(ctx.baseDir, 'state', 'tunnel-' + p.id + '.json'), { force: true }); } catch (e) {} } }
      console.log('已删除通道: ' + id);
    }
    return 0;
  }

  if (cmd === 'start' || cmd === 'stop') {
    const d = await DC.ensureDaemon(ctx);
    const ids = flags.all ? (await DC.httpJson(d.port, 'GET', '/api/state', undefined, d.token)).profiles.map((p) => p.id) : flags._;
    if (cmd === 'start' && flags.all) {
      const r = await DC.httpJson(d.port, 'POST', '/api/action', { action: 'startAll' }, d.token);
      console.log('已启动: ' + (r.started.length ? r.started.join(', ') : '（没有可启动的启用通道）'));
      printStatus(r.profiles, flags.json);
      return 0;
    }
    if (cmd === 'stop' && flags.all) {
      const r = await DC.httpJson(d.port, 'POST', '/api/action', { action: 'stopAll' }, d.token);
      console.log('已全部停止');
      printStatus(r.profiles, flags.json);
      return 0;
    }
    if (!ids.length) { console.log('用法: tunnel ' + cmd + ' <id...>|--all'); return 2; }
    for (const id of ids) {
      try {
        const r = await DC.httpJson(d.port, 'POST', '/api/action', { action: cmd, id: id }, d.token, 120000);
        const s = r.status || (r.profiles || []).find((p) => p.id === id);
        console.log((cmd === 'start' ? '已启动' : '已停止') + ': ' + id + (s && s.url ? '  ' + s.url : '') + (s && s.password ? '  密码: ' + s.password : ''));
      } catch (e) { console.log('失败: ' + id + ' -> ' + e.message); }
    }
    return 0;
  }

  if (cmd === 'enable' || cmd === 'disable' || cmd === 'autostart-on' || cmd === 'autostart-off') {
    const ids = flags.all ? localCfg().profiles.map((p) => p.id) : flags._;
    if (!ids.length) { console.log('用法: tunnel ' + cmd + ' <id...>|--all'); return 2; }
    const action = cmd === 'enable' ? 'enable' : cmd === 'disable' ? 'disable' : cmd === 'autostart-on' ? 'autoStartOn' : 'autoStartOff';
    const d = await DC.findDaemon(ctx.baseDir);
    for (const id of ids) {
      if (d) await DC.httpJson(d.port, 'POST', '/api/action', { action: action, id: id }, d.token);
      else {
        const cfg = localCfg();
        if (cmd === 'enable' || cmd === 'disable') cfg.updateProfile(id, { enabled: cmd === 'enable' });
        else cfg.updateProfile(id, { autoStart: cmd === 'autostart-on' });
      }
      console.log(cmd + ': ' + id);
    }
    return 0;
  }

  if (cmd === 'regen') {
    const d = await DC.ensureDaemon(ctx);
    const r = await DC.httpJson(d.port, 'POST', '/api/action', { action: 'regenPassword', id: flags._[0] }, d.token, 120000);
    console.log('已重新生成密码: ' + r.profile.id + (r.status && r.status.password ? '  新密码: ' + r.status.password : ''));
    return 0;
  }

  if (cmd === 'config') {
    const sub = flags._[0];
    const d = await DC.findDaemon(ctx.baseDir);
    const cfg = localCfg();
    if (!sub || sub === 'show') {
      const view = d ? await DC.httpJson(d.port, 'GET', '/api/state', undefined, d.token) : { gui: cfg.data.gui, mcp: cfg.data.mcp, tray: cfg.data.tray, defaults: cfg.data.defaults, profiles: [] };
      if (flags.json) return console.log(JSON.stringify({ gui: d ? { port: view.guiPort } : view.gui, mcp: view.mcp, tray: view.tray, defaults: view.defaults, configFile: ctx.configFile }, null, 2)), 0;
      console.log('配置文件: ' + ctx.configFile);
      console.log('  GUI 端口: ' + (view.guiPort || view.gui.port) + '   MCP: ' + (view.mcp.enabled ? '开' : '关') + '   托盘: ' + (view.tray.enabled ? '开' : '关'));
      console.log('  默认 TTL: ' + view.defaults.ttl + '   默认密码模式: ' + view.defaults.passwordMode + '   网关起始端口: ' + view.defaults.gatewayStart);
      return 0;
    }
    if (sub === 'set') {
      const key = flags._[1];
      const val = flags._[2];
      const patch = { defaults: {}, gui: {}, mcp: {}, tray: {} };
      const bool = (v) => String(v) === 'true' || String(v) === '1' || String(v) === 'on';
      if (key === 'defaults.ttl') patch.defaults.ttl = val;
      else if (key === 'defaults.passwordMode') patch.defaults.passwordMode = val;
      else if (key === 'defaults.gatewayStart') patch.defaults.gatewayStart = Number(val);
      else if (key === 'defaults.rateLimit') patch.defaults.rateLimit = Number(val);
      else if (key === 'gui.port') patch.gui.port = Number(val);
      else if (key === 'gui.openBrowser') patch.gui.openBrowser = bool(val);
      else if (key === 'mcp.enabled') patch.mcp.enabled = bool(val);
      else if (key === 'mcp.allowStart') patch.mcp.allowStart = bool(val);
      else if (key === 'tray.enabled') patch.tray.enabled = bool(val);
      else { console.log('支持的键: defaults.ttl|defaults.passwordMode|defaults.gatewayStart|defaults.rateLimit|gui.port|gui.openBrowser|mcp.enabled|mcp.allowStart|tray.enabled'); return 2; }
      if (d) { await DC.httpJson(d.port, 'POST', '/api/settings', patch, d.token); console.log('已更新（守护进程）: ' + key + ' = ' + val); return 0; }
      Object.assign(cfg.data.defaults, patch.defaults);
      Object.assign(cfg.data.gui, patch.gui);
      Object.assign(cfg.data.mcp, patch.mcp);
      Object.assign(cfg.data.tray, patch.tray);
      cfg.save();
      console.log('已更新: ' + key + ' = ' + val + '（GUI 端口改动需重启守护进程生效）');
      return 0;
    }
    console.log('用法: tunnel config [show] [--json] | tunnel config set <key> <value>');
    return 2;
  }

  if (cmd === 'api') {
    const d = await DC.findDaemon(ctx.baseDir);
    if (!d) { console.log('守护进程未运行（tunnel gui 或 tunnel daemon start）'); return 1; }
    const sub = flags._[0] || 'state';
    if (sub === 'state') return console.log(JSON.stringify(await DC.httpJson(d.port, 'GET', '/api/state', undefined, d.token), null, 2)), 0;
    console.log('用法: tunnel api state');
    return 2;
  }

  printHelp();
  return 2;
}

function printHelp() {
  console.log('临时公网映射 - 命令行');
  console.log('');
  console.log('  通道管理（由后台守护进程执行，配置页里能看到同一份状态）');
  console.log('    tunnel list [--json]                    列出所有通道与状态');
  console.log('    tunnel add --name 前端 --port 5777 [--ttl 1h] [--password xxx|--random] [--auto-start]');
  console.log('    tunnel start <id...> | --all            启动通道（可同时开多个）');
  console.log('    tunnel stop  <id...> | --all            关闭通道');
  console.log('    tunnel enable|disable <id...>           启用/停用通道');
  console.log('    tunnel autostart-on|autostart-off <id>  设置"随守护进程自动启动"');
  console.log('    tunnel regen <id>                       重新随机生成该通道密码');
  console.log('    tunnel rm <id...>|--all                 删除通道');
  console.log('    tunnel config [show] | config set gui.port 18400');
  console.log('');
  console.log('  前台程序');
  console.log('    tunnel gui [--port 18400] [--open]      图形化配置页（可最小化到托盘）');
  console.log('    tunnel tray                             只起托盘（自动拉起后台守护进程）');
  console.log('    tunnel mcp                              MCP 服务（给 AI 用，stdio）');
  console.log('    tunnel daemon status|start|stop         后台守护进程');
  console.log('');
  console.log('  经典用法（前台单通道，参数与以前完全一致）');
  console.log('    tunnel --port 5777 --ttl 1h --password xxx');
  console.log('    tunnel --help                           查看全部经典参数');
}

module.exports = { run, parseFlags, printHelp };
