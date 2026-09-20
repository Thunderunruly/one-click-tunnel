'use strict';
/**
 * 桌面外壳：把本地配置页装进一个"没有地址栏/标签页"的应用窗口
 *  - Windows 10/11 自带 Edge（Chromium），用 --app 就能得到真正的桌面窗口体验
 *  - 不引入 Electron/Tauri：安装包体积不变，也不需要额外的运行时
 *  - 用独立的 user-data-dir，避免影响用户自己的浏览器；关掉窗口不影响后台守护进程与托盘
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function firstExisting(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) {}
  }
  return '';
}
function findChromium() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return firstExisting(candidates);
}
function spawnDetached(file, args, opts) {
  const child = spawn(file, args, Object.assign({ detached: true, stdio: 'ignore', windowsHide: false }, opts || {}));
  child.unref();
  return child;
}
function openBrowserDefault(url) {
  if (process.platform === 'win32') return spawnDetached('cmd', ['/c', 'start', '', url], { windowsHide: true });
  if (process.platform === 'darwin') return spawnDetached('open', [url]);
  return spawnDetached('xdg-open', [url]);
}
/**
 * 打开"桌面应用窗口"。找不到 Chromium 系浏览器时退回默认浏览器。
 * @returns {{ok:boolean, browser:string, mode:'app'|'browser', reason?:string}}
 */
function openAppWindow(url, opts) {
  opts = opts || {};
  const size = String(opts.size || '1120,780');
  const profileDir = opts.profileDir || '';
  const browser = opts.browser || findChromium();
  if (!browser) {
    try { openBrowserDefault(url); } catch (e) {}
    return { ok: false, browser: '', mode: 'browser', reason: '没有找到 Edge/Chrome，已用默认浏览器打开' };
  }
  const args = ['--app=' + url, '--window-size=' + size, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,msEdgeTranslate'];
  if (profileDir) {
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) {}
    args.push('--user-data-dir=' + profileDir);
  }
  try {
    spawnDetached(browser, args);
    return { ok: true, browser: browser, mode: 'app' };
  } catch (e) {
    try { openBrowserDefault(url); } catch (e2) {}
    return { ok: false, browser: browser, mode: 'browser', reason: '启动应用窗口失败: ' + (e && e.message ? e.message : e) };
  }
}
module.exports = { findChromium, openAppWindow, openBrowserDefault };
