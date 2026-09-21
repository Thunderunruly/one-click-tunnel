'use strict';
/**
 * 托盘：Node 这边只负责"确保守护进程在跑 + 拉起 PowerShell 托盘图标"，
 * 托盘图标本身用 Windows 自带 WinForms 实现（零第三方依赖）。
 * 关掉托盘图标时，守护进程和各个通道可以继续跑（菜单里也可以选择一起退出）。
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { Config } = require('./config.js');
const DC = require('./daemonctl.js');
const U = require('./util.js');

function trayScriptPath(ctx) {
  const appDir = ctx.appDir || U.appDir();
  const onDisk = path.join(appDir, 'lib', 'tray.ps1');
  if (fs.existsSync(onDisk)) return onDisk;
  // 打包成单文件 exe 时磁盘上没有 .ps1，从内联资源里写一份出来（UTF-8 BOM 已包含在资源里）
  const A = require('./assets.js');
  const target = path.join(ctx.baseDir || appDir, 'state', 'tray.ps1');
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) {}
  fs.writeFileSync(target, A.readAsset('lib/tray.ps1', appDir), 'utf8');
  return target;
}
function trayArgs(ctx, guiPort, token) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', trayScriptPath(ctx),
    '-GuiPort', String(guiPort), '-Token', String(token), '-ConfigFile', String(ctx.configFile),
    '-ParentPid', String(process.pid)];
}

async function runTray(ctx, flags) {
  flags = flags || {};
  const cfg = new Config(ctx.configFile).load();
  const existing = await DC.findDaemon(ctx.baseDir);
  if (existing) {
    const trayPid = Number((U.readJsonSafe(DC.daemonFile(ctx.baseDir), {}) || {}).trayPid || 0);
    let alive = false;
    try { process.kill(trayPid, 0); alive = trayPid > 0; } catch (e) { alive = false; }
    if (alive) {
      if (!flags.quiet) console.log('托盘已经在运行（由守护进程管理），无需重复启动。配置页: http://127.0.0.1:' + existing.port + '/?token=' + existing.token);
      await new Promise(() => {});
      return 0;
    }
  }
  const d = existing || await DC.ensureDaemon(ctx, { noTray: true });
  const args = trayArgs(ctx, d.port, d.token);
  if (flags.open) {
    try { require('node:child_process').spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:' + d.port + '/?token=' + d.token], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) {}
  }
  const ps = spawn('powershell', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const cur = U.readJsonSafe(DC.daemonFile(ctx.baseDir), {}) || {};
    cur.trayPid = ps.pid;
    U.writeJsonAtomic(DC.daemonFile(ctx.baseDir), cur);
  } catch (e) {}
  ps.stdout.on('data', (b) => { if (!flags.quiet) process.stdout.write(b); });
  ps.stderr.on('data', (b) => { process.stderr.write('[tray] ' + b.toString()); });
  ps.on('error', (e) => { process.stderr.write('托盘启动失败: ' + e.message + '\n'); process.exit(1); });
  ps.on('exit', (code) => { if (!flags.quiet) console.log('托盘已退出（守护进程仍在后台运行，tunnel daemon stop 可彻底关闭）'); process.exit(code || 0); });
  if (!flags.quiet) console.log('托盘已启动（右键图标可操作通道 / 打开配置页）');
  await new Promise(() => {});
  return 0;
}
function trayStatus(ctx) {
  const supported = process.platform === 'win32';
  const d = U.readJsonSafe(DC.daemonFile(ctx.baseDir), {}) || {};
  const pid = Number(d.trayPid || 0);
  let running = false;
  if (pid > 0) { try { process.kill(pid, 0); running = true; } catch (e) { running = false; } }
  return { running: running, pid: running ? pid : 0, supported: supported };
}
module.exports = { runTray, trayArgs, trayScriptPath, trayStatus };
