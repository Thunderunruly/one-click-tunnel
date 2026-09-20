// 把 dist/ 打包成一个可以直接发给别人的 zip（解压后双击 install.cmd 即可）
// 用法: node build/make-zip.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const OUTDIR = path.join(ROOT, 'release');
const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) { return {}; }
})();
const version = pkg.version || '1.0.0';
const name = pkg.name || 'one-click-tunnel';
const zip = path.join(OUTDIR, name + '-' + version + '-win-x64.zip');

if (!fs.existsSync(path.join(DIST, 'public-tunnel.exe'))) {
  console.error('dist/public-tunnel.exe 不存在，请先运行 node build/make-exe.mjs');
  process.exit(1);
}
fs.mkdirSync(OUTDIR, { recursive: true });
if (fs.existsSync(zip)) fs.rmSync(zip);
const ps = 'Compress-Archive -Path "' + path.join(DIST, '*') + '" -DestinationPath "' + zip + '" -Force';
const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'inherit', windowsHide: true });
if (r.status !== 0) { console.error('压缩失败，退出码 ' + r.status); process.exit(1); }
console.log('已生成: ' + zip + '  (' + (fs.statSync(zip).size / 1024 / 1024).toFixed(1) + ' MB)');
console.log('对方解压后双击 install.cmd 即可安装。');
