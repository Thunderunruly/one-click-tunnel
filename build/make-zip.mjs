// 打便携 zip：只收白名单文件（避免把 config.json/日志/state/browser-profile 之类的运行期文件也打进去）
// 用法: node build/make-zip.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const OUTDIR = path.join(ROOT, 'release');
const STAGE = path.join(ROOT, 'build', '_zipstage');

const REQUIRED = ['oct.exe', 'one-click-tunnel.exe', 'install.cmd', 'install.ps1'];
const OPTIONAL = ['cloudflared.exe', 'uninstall.cmd', 'uninstall.ps1', 'start.cmd', 'tray.cmd', 'stop-all.cmd', 'stop.cmd', 'README.md'];

const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) { return {}; }
})();
const version = pkg.version || '1.0.0';
const name = pkg.name || 'one-click-tunnel';
const zip = path.join(OUTDIR, name + '-' + version + '-win-x64.zip');

for (const f of REQUIRED) {
  if (!fs.existsSync(path.join(DIST, f))) {
    console.error('dist/' + f + ' 不存在（先运行 node build/make-exe.mjs）');
    process.exit(1);
  }
}
fs.mkdirSync(OUTDIR, { recursive: true });
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

const included = [];
for (const f of REQUIRED.concat(OPTIONAL)) {
  const src = path.join(DIST, f);
  if (!fs.existsSync(src)) continue;
  fs.copyFileSync(src, path.join(STAGE, f));
  included.push(f);
}
console.log('打包白名单（' + included.length + ' 个文件）: ' + included.join(', '));

if (fs.existsSync(zip)) fs.rmSync(zip);
const ps = 'Compress-Archive -Path "' + path.join(STAGE, '*') + '" -DestinationPath "' + zip + '" -Force';
const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'inherit', windowsHide: true });
fs.rmSync(STAGE, { recursive: true, force: true });
if (r.status !== 0) { console.error('压缩失败，退出码 ' + r.status); process.exit(1); }
console.log('已生成: ' + zip + '  (' + (fs.statSync(zip).size / 1024 / 1024).toFixed(1) + ' MB)');
console.log('对方解压后双击 install.cmd 即可安装。');
