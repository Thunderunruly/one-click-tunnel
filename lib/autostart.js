'use strict';
/**
 * 开机自启：往"启动"文件夹放一个快捷方式（免管理员、可随时删）
 *  - 快目标：wscript.exe //nologo "<程序目录>\launch.vbs"（无窗口启动器）
 *  - 开发目录里没有 launch.vbs 时退回 start.cmd / node tunnel.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LNK_NAME = 'one-click-tunnel.lnk';

function startupDir(override) {
  if (override) return override;
  return path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function linkPath(override) { return path.join(startupDir(override), LNK_NAME); }
/** 自启时到底执行什么 */
function plan(appDir) {
  const native = path.join(appDir, 'one-click-tunnel.exe');
  if (fs.existsSync(native)) return { target: native, args: '', kind: 'one-click-tunnel.exe（无控制台启动器）' };
  const vbs = path.join(appDir, 'launch.vbs');
  if (fs.existsSync(vbs)) return { target: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'), args: '//nologo "' + vbs + '"', kind: 'launch.vbs' };
  const cmd = path.join(appDir, 'start.cmd');
  if (fs.existsSync(cmd)) return { target: cmd, args: '', kind: 'start.cmd' };
  return { target: process.execPath, args: '"' + path.join(appDir, 'tunnel.js') + '" gui --quiet', kind: 'node tunnel.js' };
}
function status(appDir, dir) {
  const p = linkPath(dir);
  const planInfo = plan(appDir);
  const exists = fs.existsSync(p);
  let target = '';
  if (exists) {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      '(New-Object -ComObject WScript.Shell).CreateShortcut("' + p + '").TargetPath'], { encoding: 'utf8', windowsHide: true });
    target = (r.stdout || '').trim();
  }
  return { installed: exists, path: p, target: target, startupDir: startupDir(dir), plan: planInfo };
}
function install(appDir, dir) {
  const p = linkPath(dir);
  const planInfo = plan(appDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const ps = 'try { $ws = New-Object -ComObject WScript.Shell } catch { $ws = $null }; ' +
    'if (-not $ws) { Write-Output "COM-UNAVAILABLE"; exit 3 }; ' +
    '$l = $ws.CreateShortcut("' + p + '"); ' +
    '$l.TargetPath = "' + planInfo.target + '"; ' +
    '$l.Arguments = "' + String(planInfo.args).replace(/"/g, '""') + '"; ' +
    '$l.WorkingDirectory = "' + appDir + '"; ' +
    '$l.Description = "one-click-tunnel 开机自启"; ' +
    'if (Test-Path (Join-Path "' + appDir + '" "public-tunnel.exe")) { $l.IconLocation = (Join-Path "' + appDir + '" "public-tunnel.exe") + ",0" }; ' +
    '$l.Save(); Write-Output "OK"';
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out.indexOf('COM-UNAVAILABLE') >= 0) return { ok: false, error: '当前环境不支持创建快捷方式（没有桌面会话/COM 不可用）', path: p };
  if (out.indexOf('OK') < 0) return { ok: false, error: out || ('退出码 ' + r.status), path: p };
  return { ok: true, path: p, target: planInfo.target, args: planInfo.args, kind: planInfo.kind };
}
function uninstall(dir) {
  const p = linkPath(dir);
  if (!fs.existsSync(p)) return { ok: true, removed: false, path: p };
  try { fs.rmSync(p, { force: true }); return { ok: true, removed: true, path: p }; }
  catch (e) { return { ok: false, removed: false, path: p, error: e && e.message ? e.message : String(e) }; }
}
module.exports = { startupDir, linkPath, plan, status, install, uninstall, LNK_NAME };
