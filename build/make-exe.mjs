// 打包：把 tunnel.js + lib/*.js + public/* + lib/tray.ps1 打成一个单文件 bundle，再用官方 Node SEA 生成免安装 exe
// 用法: node build/make-exe.mjs        （只生成 exe，不压缩）
//       node build/make-zip.mjs        （把 dist/ 压成可以直接发给别人的 zip）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const OUT = path.join(DIST, IS_WIN ? 'oct.exe' : 'oct');
const BUNDLE = path.join(BUILD, 'bundle.cjs');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(cmd, args, opts) {
  console.log('> ' + cmd + ' ' + args.join(' '));
  const r = spawnSync(cmd, args, Object.assign({ cwd: ROOT, stdio: 'inherit', windowsHide: true }, opts || {}));
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(cmd + ' 退出码 ' + r.status);
}

function listModules() {
  const mods = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'lib')).sort()) {
    if (f.endsWith('.js')) mods.push('lib/' + f);
  }
  mods.push('tunnel.js');
  return mods;
}
function listAssets() {
  const out = [];
  for (const rel of ['public/index.html', 'lib/tray.ps1']) {
    if (fs.existsSync(path.join(ROOT, rel))) out.push(rel);
  }
  return out;
}

function buildBundle() {
  const mods = listModules();
  const assets = {};
  for (const rel of listAssets()) assets[rel] = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const parts = [];
  parts.push('/* 自动生成：tunnel.js + lib/*.js + 静态资源，由 build/make-exe.mjs 生成，不要手改 */');
  parts.push("'use strict';");
  parts.push('globalThis.__PT_ASSETS = ' + JSON.stringify(assets) + ';');
  let pkgVersion = '0.0.0';
  try { pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; } catch (e) {}
  parts.push('globalThis.__PT_VERSION = ' + JSON.stringify(pkgVersion) + ';');
  parts.push('var __ROOT = __dirname;');
  parts.push('var __mods = {};');
  parts.push('var __cache = {};');
  for (const rel of mods) {
    let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    src = src.replace(/^#![^\n]*/, '');
    parts.push('__mods[' + JSON.stringify(rel) + '] = ' + JSON.stringify(src) + ';');
  }
  parts.push("\nfunction __norm(from, req) {\n  if (req.charAt(0) !== '.') return req;\n  var base = from.split('/').slice(0, -1).join('/');\n  var parts = (base ? base.split('/') : []).concat(req.split('/'));\n  var out = [];\n  for (var i = 0; i < parts.length; i++) {\n    var s = parts[i];\n    if (s === '.' || s === '') continue;\n    if (s === '..') out.pop();\n    else out.push(s);\n  }\n  var p = out.join('/');\n  if (p.slice(-3) !== '.js') p += '.js';\n  return p;\n}\nfunction __require(from, req) {\n  if (req.charAt(0) !== '.') return require(req);\n  var key = __norm(from, req);\n  if (!__mods[key]) throw new Error('\u6a21\u5757\u6ca1\u6709\u6253\u5305\u8fdb\u6765: ' + key + ' (\u6765\u81ea ' + from + ')');\n  if (__cache[key]) return __cache[key].exports;\n  var m = { exports: {} };\n  __cache[key] = m;\n  var dir = path.dirname(path.join(__ROOT, key));\n  var fn = new Function('module', 'exports', 'require', '__dirname', '__filename', __mods[key]);\n  fn(m, m.exports, function (r) { return __require(key, r); }, dir, path.join(__ROOT, key));\n  return m.exports;\n}\nvar path = require('node:path');\n__require('entry.js', './tunnel.js');\n");
  fs.writeFileSync(BUNDLE, parts.join('\n'), 'utf8');
  console.log('已生成 bundle: ' + BUNDLE + '  (' + (fs.statSync(BUNDLE).size / 1024).toFixed(0) + ' KB, ' + mods.length + ' 个模块, ' + Object.keys(assets).length + ' 个静态资源)');
}

function smokeTestBundle() {
  console.log('> ' + process.execPath + ' build/bundle.cjs help  (冒烟)');
  const r = spawnSync(process.execPath, [BUNDLE, 'help'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 || out.indexOf('通道管理') < 0) throw new Error('bundle 冒烟失败（退出码 ' + r.status + '）:\n' + out.slice(0, 800));
  console.log('bundle 可用');
}

fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });
buildBundle();
smokeTestBundle();

const cfg = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(cfg, JSON.stringify({ main: 'build/bundle.cjs', output: 'build/sea-prep.blob', disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2));
run(process.execPath, ['--experimental-sea-config', cfg]);
const blob = path.join(BUILD, 'sea-prep.blob');
if (!fs.existsSync(blob)) throw new Error('未生成 ' + blob);
fs.copyFileSync(process.execPath, OUT);
console.log('已复制 node 运行时: ' + process.execPath + ' -> ' + OUT);
if (IS_MAC) {
  // macOS 上 node 自带签名，postject 改完二进制签名就失效了，必须先摘掉再注入，注入完再重新 ad-hoc 签名
  try { run('codesign', ['--remove-signature', OUT]); } catch (e) { console.log('（codesign 摘签名失败，继续尝试：' + (e && e.message ? e.message : e) + '）'); }
}
const npxCmd = IS_WIN ? 'npx.cmd' : 'npx';
const pjArgs = ['--yes', 'postject', OUT, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SENTINEL];
if (IS_MAC) pjArgs.push('--macho-segment-name', 'NODE_SEA');
run(npxCmd, pjArgs, { shell: true });
if (IS_MAC) run('codesign', ['--sign', '-', OUT]);
if (!IS_WIN) fs.chmodSync(OUT, 0o755);

const cfName = IS_WIN ? 'cloudflared.exe' : 'cloudflared';
const cfSrc = path.join(ROOT, cfName);
if (fs.existsSync(cfSrc)) {
  fs.copyFileSync(cfSrc, path.join(DIST, cfName));
  if (!IS_WIN) fs.chmodSync(path.join(DIST, cfName), 0o755);
  console.log('已复制 ' + cfName);
} else console.log('注意: 没找到 ' + cfName + '，首次运行会自动下载');
if (IS_WIN) {
  // Windows 专有的启动脚本与 GUI 子系统启动器（unix 上双击就是外壳/终端，不需要这些）
  for (const f of ['install.cmd', 'install.ps1', 'uninstall.cmd', 'uninstall.ps1', 'start.cmd', 'tray.cmd', 'stop-all.cmd', 'stop.cmd', 'README.md']) {
    const s = path.join(ROOT, 'installer', f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(DIST, f));
  }
  run(process.execPath, [path.join(ROOT, 'build', 'make-launcher.mjs')]);
} else {
  const s = path.join(ROOT, 'installer', 'README-unix.md');
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(DIST, 'README.md'));
  else {
    fs.writeFileSync(path.join(DIST, 'README.md'),
      'OCT（一键隧道）核心\n\n' +
      '  ./oct app            打开配置页（后台自动起守护进程）\n' +
      '  ./oct daemon start   只起守护进程\n' +
      '  ./oct list           看通道状态\n' +
      '  ./oct help           全部命令\n\n' +
      'cloudflared 已经在同目录里，不需要另外下载。\n', 'utf8');
  }
}

// 清掉旧名字的引擎（1.5.x 叫 public-tunnel.exe），避免发布包里同时躺着两个
for (const f of fs.readdirSync(DIST)) {
  if (/^public-tunnel.*\.exe$/i.test(f)) { try { fs.rmSync(path.join(DIST, f), { force: true }); console.log('已清理旧文件: dist/' + f); } catch (e) {} }
}

// RUNTIME_JUNK：清掉 dist 里的运行期文件（配置/日志/状态/pid），它们不该进发布包
for (const junk of ['config.json', 'logs', 'state', 'updates']) {
  try { fs.rmSync(path.join(DIST, junk), { recursive: true, force: true }); } catch (e) {}
}
for (const f of fs.readdirSync(DIST)) { if (f.endsWith('.pid')) { try { fs.rmSync(path.join(DIST, f), { force: true }); } catch (e) {} } }

// 清掉历史遗留的 dist/*.vbs（1.5.1 之前用 VBScript 启动器）
for (const f of fs.readdirSync(DIST)) { if (f.endsWith('.vbs')) { fs.rmSync(path.join(DIST, f), { force: true }); console.log('已清理遗留文件: dist/' + f); } }

const size = (p) => (fs.existsSync(p) ? (fs.statSync(p).size / 1024 / 1024).toFixed(1) + ' MB' : '-');
console.log('\n产物:');
for (const f of fs.readdirSync(DIST)) console.log('  dist/' + f + '   ' + size(path.join(DIST, f)));
