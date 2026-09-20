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
    else if (a === '--download') out.download = true;
    else if (a === '--install') out.install = true;
    else if (a === '--notes') out.notes = true;
    else if (a === '--force') out.force = true;
    else if (a === '--ignore') out.ignore = true;
    else if (a === '--app') out.app = true;
    else if (a === '--hostname') out.hostname = String(next());
    else if (a === '--mode') out.mode = String(next());
    else if (a === '--tunnel-name') out.tunnelName = String(next());
    else if (a === '--start') out.start = true;
    else if (a === '--startup-dir') out.startupDir = String(next());
    else if (a === '--target') out.target = String(next());
    else if (a === '--allow-public-target') out.allowPublicTarget = true;
    else if (a === '--browser') out.app = false;
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
  if (!list.length) return console.log('（还没有配置任何通道，用 tunnel add --name 前端 --port 3000 添加）');
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
    await runGui({ configFile: ctx.configFile, appDir: APP_DIR, open: flags.open, app: flags.app, quiet: flags.quiet, port: flags.port, noTray: !!flags.noTray, tray: flags.noTray ? false : undefined });
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
      mode: flags.mode, hostname: flags.hostname, hostnames: flags.hostnames, tunnelName: flags.tunnelName,
      target: flags.target, allowPublicTarget: !!flags.allowPublicTarget,
      rateLimit: flags.rateLimit, upstreamHost: flags.upstreamHost, allowHosts: flags.allowHosts,
    };
    Object.keys(profile).forEach((k) => { if (profile[k] === undefined) delete profile[k]; });
    if (!profile.name || !profile.port) { console.log('用法: tunnel add --name 前端 --port 3000 [--ttl 1h] [--password xxx|--random] [--auto-start]'); return 2; }
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

  if (cmd === 'autostart') {
    const A = require('./autostart.js');
    const sub = flags._[0] || 'status';
    if (sub === 'install') {
      const r = A.install(APP_DIR, flags.startupDir);
      if (!r.ok) { console.log('安装失败: ' + r.error); return 1; }
      console.log('已设置开机自启: ' + r.path);
      console.log('  启动方式: ' + r.kind + ' -> ' + r.target + ' ' + (r.args || ''));
      return 0;
    }
    if (sub === 'uninstall') {
      const r = A.uninstall(flags.startupDir);
      console.log(r.removed ? ('已取消开机自启: ' + r.path) : '本来就没有设置开机自启');
      return r.ok ? 0 : 1;
    }
    const st = A.status(APP_DIR, flags.startupDir);
    console.log('开机自启: ' + (st.installed ? '已开启' : '未开启'));
    console.log('  快捷方式: ' + st.path + (st.installed ? (' -> ' + st.target) : ''));
    console.log('  启动方式: ' + st.plan.kind + ' -> ' + st.plan.target + ' ' + (st.plan.args || ''));
    return 0;
  }

  if (cmd === 'undomain') {
    const S = require('./named-setup.js');
    const NAMED2 = require('./named.js');
    const cfg = localCfg();
    const p = cfg.find(flags._[0]);
    if (!p) { console.log('找不到通道: ' + flags._[0]); return 1; }
    if (!p.tunnelId) { console.log('这个通道没有命名隧道（当前类型: ' + (p.mode || 'quick') + '）'); return 1; }
    if (!flags.force) { console.log('这会删除 Cloudflare 上的隧道 ' + p.tunnelId + '（DNS 记录请在 Cloudflare 后台自行删除）。确认请加 --force'); return 1; }
    const r = S.deleteTunnel({ appDir: APP_DIR, stateDir: ctx.baseDir, tunnelId: p.tunnelId });
    console.log(r.ok ? ('已删除 Cloudflare 隧道 ' + p.tunnelId) : ('删除失败: ' + r.error));
    if (r.ok) {
      cfg.updateProfile(p.id, { mode: 'quick', hostname: '', hostnames: [], tunnelId: '', tunnelName: '' });
      try { fs.rmSync(NAMED2.credentialsPath(APP_DIR, ctx.baseDir, p.id), { force: true }); } catch (e) {}
      console.log('已把通道 ' + p.id + ' 改回快速隧道（本地凭据也删了）');
    }
    return r.ok ? 0 : 1;
  }

  if (cmd === 'login') {
    const S = require('./named-setup.js');
    console.log('即将运行 cloudflared tunnel login：浏览器里请选择你要用的域名（授权信息保存到程序目录）');
    const r = S.loginCloudflare({ appDir: APP_DIR, stateDir: ctx.baseDir, inherit: true });
    if (!r.ok) { console.log(r.error || '登录失败'); return 1; }
    console.log('登录成功，证书: ' + r.certFile);
    console.log('接下来: tunnel domain <通道id> <你的域名>   例如 tunnel domain web app.example.com');
    return 0;
  }

  if (cmd === 'domain') {
    const S = require('./named-setup.js');
    const cfg = localCfg();
    const p = cfg.find(flags._[0]);
    if (!p) { console.log('找不到通道: ' + flags._[0]); return 1; }
    const hostnames = flags._.slice(1).concat(flags.hostnames || []).filter(Boolean);
    const hostname = hostnames[0] || flags.hostname || '';
    console.log('通道 ' + p.id + ' 绑定域名 ' + (hostnames.length ? hostnames.join(', ') : '(未填)') + ' ...');
    const r = S.setupDomain({ appDir: APP_DIR, stateDir: ctx.baseDir, profile: p, hostname: hostname, hostnames: hostnames, tunnelName: flags.tunnelName });
    if (!r.ok) {
      console.log('失败: ' + r.error);
      if (r.needLogin) console.log('先运行: tunnel login');
      return 1;
    }
    cfg.updateProfile(p.id, { mode: 'named', hostname: r.hostname, hostnames: r.hostnames, tunnelId: r.tunnelId, tunnelName: r.tunnelName, ttl: flags.ttl || 'forever' });
    console.log('已绑定: ' + (r.publicUrls || [r.publicUrl]).join(' , ') + '（隧道 ID ' + r.tunnelId + '，凭据 ' + r.credentialsFile + '）');
    console.log('本机仍然要过密码门；TTL=' + (flags.ttl || 'forever') + ' 表示不自动关闭。');
    if (flags.start) {
      const d = await DC.ensureDaemon(ctx);
      const rr = await DC.httpJson(d.port, 'POST', '/api/action', { action: 'start', id: p.id }, d.token, 120000);
      console.log('已启动: ' + ((rr.status && rr.status.url) || r.publicUrl));
    } else {
      console.log('启动它: tunnel start ' + p.id);
    }
    return 0;
  }

  if (cmd === 'info') {
    const NAMED = require('./named.js');
    const cfg = localCfg();
    const list = flags._.length ? [cfg.find(flags._[0])].filter(Boolean) : cfg.profiles;
    if (!list.length) { console.log('没有这个通道'); return 1; }
    const rows = list.map((p) => {
      const rd = NAMED.namedReadiness(APP_DIR, ctx.baseDir, p);
      return {
        id: p.id, name: p.name, mode: p.mode || 'quick', hostname: p.hostname || '',
        tunnelName: p.tunnelName || '', tunnelId: p.tunnelId || rd.tunnelId || '',
        ttl: p.ttl, target: p.target || ('127.0.0.1:' + p.port), publicUrl: (p.mode === 'named') ? (rd.publicUrl || '') : '',
        cloudflared: rd.cloudflared.ok, loggedIn: rd.cert.ok, credentials: rd.credentials.ok,
        configFile: rd.configFile, credentialsFile: rd.credentialsFile, certFile: rd.cert.path,
        ready: rd.ready, steps: rd.steps, localPort: p.port, gatewayPort: p.gateway,
        certValidTo: rd.certValidTo, certDaysLeft: rd.certDaysLeft,
      };
    });
    if (flags.json) { console.log(JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2)); return 0; }
    for (const r of rows) {
      console.log('通道 ' + r.id + '  (' + r.name + ')');
      console.log('  类型      : ' + (r.mode === 'named' ? '命名隧道（自有域名，固定地址）' : '快速隧道（地址随机）'));
      if (r.mode === 'named') {
        console.log('  域名      : ' + (r.hostname || '(未填)'));
        console.log('  固定地址  : ' + (r.publicUrl || '(未就绪)'));
        console.log('  隧道 ID   : ' + (r.tunnelId || '(还没创建)') + '   名字: ' + (r.tunnelName || '-'));
        console.log('  cloudflared: ' + (r.cloudflared ? '有' : '没有') + '   已登录: ' + (r.loggedIn ? '是' : '否') + '   凭据: ' + (r.credentials ? '有' : '没有'));
        if (r.certValidTo) console.log('  证书有效期: ' + r.certValidTo + (r.certDaysLeft === null ? '' : '（还剩 ' + r.certDaysLeft + ' 天' + (r.certDaysLeft < 30 ? '，建议重新 tunnel login' : '') + '）'));
        console.log('  开机自启  : ' + (require('./autostart.js').status(APP_DIR).installed ? '已开启' : '未开启'));
        console.log('  配置文件  : ' + r.configFile);
        if (r.steps.length) console.log('  还差      : ' + r.steps.join('；'));
      }
      console.log('  目标地址  : ' + (r.target ? r.target : ('127.0.0.1:' + r.localPort)) + '   网关: 127.0.0.1:' + r.gatewayPort + '   TTL: ' + r.ttl);
    }
    return 0;
  }

  if (cmd === 'app') {
    const d = await DC.ensureDaemon(ctx);
    const url = 'http://127.0.0.1:' + d.port + '/?token=' + d.token;
    const c = localCfg();
    const D = require('./desktop.js');
    const r = D.openAppWindow(url, {
      size: (c.data.gui && c.data.gui.appWindowSize) || '1120,780',
      profileDir: path.join(ctx.baseDir, 'state', 'browser-profile'),
    });
    if (flags.json) return console.log(JSON.stringify(Object.assign({ url: url, daemonPort: d.port }, r), null, 2)), 0;
    if (r.mode === 'app') console.log('已打开桌面窗口: ' + r.browser);
    else console.log('已用默认浏览器打开' + (r.reason ? '（' + r.reason + '）' : ''));
    return 0;
  }

  if (cmd === 'version') {
    const v = require('./version.js').currentVersion();
    if (flags.json) return console.log(JSON.stringify({ version: v, appDir: APP_DIR, configFile: ctx.configFile }, null, 2)), 0;
    console.log('one-click-tunnel ' + v);
    console.log('程序目录: ' + APP_DIR);
    console.log('配置文件: ' + ctx.configFile);
    return 0;
  }

  if (cmd === 'update') {
    const UP = require('./updater.js');
    const cfg = localCfg();
    const p = await UP.checkForUpdate(cfg, ctx.baseDir, { force: true });
    if (flags.json) console.log(JSON.stringify(p, null, 2));
    else {
      console.log('当前版本: ' + p.currentVersion);
      if (!p.ok) {
        console.log('检查更新失败: ' + p.error + (p.hint ? '\n提示: ' + p.hint : ''));
      } else {
        console.log('最新版本: ' + (p.latestVersion || '(未知)') + (p.publishedAt ? '   发布于 ' + p.publishedAt : ''));
        console.log(p.hasUpdate ? ('有更新可用' + (p.ignored ? '（该版本已被忽略）' : '')) : '已经是最新版本');
        if (p.installer) console.log('安装包: ' + p.installer.name + '  (' + (p.installer.size / 1024 / 1024).toFixed(1) + ' MB)');
        console.log('发布页: ' + p.htmlUrl);
        if (flags.notes && p.notes) { console.log('--- 更新说明 ---'); console.log(p.notes); }
      }
    }
    if (flags.ignore) {
      const v = p.latestVersion || '';
      if (v) { UP.setIgnored(cfg, v); console.log('已忽略版本: ' + v); }
      else console.log('没有可忽略的版本');
    }
    if (flags.download) {
      const r = await UP.downloadUpdate(cfg, ctx.baseDir, { payload: p.ok ? p : undefined });
      if (r.ok) console.log('已下载: ' + r.path + '  (' + (r.bytes / 1024 / 1024).toFixed(1) + ' MB, ' + (r.verified ? 'SHA-256 校验通过' : 'release 未提供校验和') + ')');
      else console.log('下载失败: ' + r.error);
      if (!r.ok) return 1;
    }
    if (flags.install) {
      const r = await UP.installUpdate(cfg, ctx.baseDir, {});
      if (r.ok) console.log('已静默安装完成（版本 ' + r.version + '），请重新打开程序');
      else console.log('安装失败: ' + r.error);
      if (!r.ok) return 1;
    }
    return p.ok ? 0 : 1;
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
  console.log('    tunnel add --name 前端 --port 3000 [--ttl 1h] [--password xxx|--random] [--auto-start]');
  console.log('    tunnel start <id...> | --all            启动通道（可同时开多个）');
  console.log('    tunnel stop  <id...> | --all            关闭通道');
  console.log('    tunnel enable|disable <id...>           启用/停用通道');
  console.log('    tunnel autostart-on|autostart-off <id>  设置"随守护进程自动启动"');
  console.log('    tunnel regen <id>                       重新随机生成该通道密码');
  console.log('    tunnel rm <id...>|--all                 删除通道');
  console.log('    tunnel config [show] | config set gui.port 18400');
  console.log('    tunnel version                          显示当前版本');
  console.log('    tunnel update [--notes] [--download] [--install] [--ignore] [--json]   检查/下载/安装新版本');
  console.log('');
  console.log('  自有域名（命名隧道，地址永久固定；域名需托管在 Cloudflare）');
  console.log('    tunnel login                            浏览器授权一次');
  console.log('    tunnel domain <id> app.example.com      建隧道 + 绑定域名（自动写回配置）');
  console.log('    tunnel info [id] [--json]               查看隧道类型/域名/隧道ID/还差什么');
  console.log('    tunnel add --mode named --name web --port 3000 --hostname app.example.com');
  console.log('    tunnel add --name nas --port 5000 --target 192.168.1.50:5000   把局域网设备映射出去');
  console.log('    tunnel domain <id> a.example.com b.example.com   一个隧道绑多个域名');
  console.log('    tunnel undomain <id> --force                     删除 Cloudflare 隧道并改回快速隧道');
  console.log('    tunnel autostart install|uninstall|status        开机自启（autoStart 的命名隧道随之常驻）');
  console.log('');
  console.log('  前台程序');
  console.log('    tunnel gui [--port 18400] [--open] [--app|--browser]   图形化配置页（默认桌面窗口，可最小化到托盘）');
  console.log('    tunnel app                              打开桌面窗口（守护进程没跑就自动拉起）');
  console.log('    tunnel tray                             只起托盘（自动拉起后台守护进程）');
  console.log('    tunnel mcp                              MCP 服务（给 AI 用，stdio）');
  console.log('    tunnel daemon status|start|stop         后台守护进程');
  console.log('');
  console.log('  经典用法（前台单通道，参数与以前完全一致）');
  console.log('    tunnel --port 3000 --ttl 1h --password xxx');
  console.log('    tunnel --help                           查看全部经典参数');
}

module.exports = { run, parseFlags, printHelp };
