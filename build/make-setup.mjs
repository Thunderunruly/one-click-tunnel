// 用 Inno Setup 打一个真正的安装包（one-click-tunnel-setup-<版本>.exe）
// 用法: node build/make-setup.mjs [--strict]
//   本机没装 Inno Setup 时默认"跳过并成功退出"（CI 的 windows runner 自带 ISCC，会真的编译）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ISS = path.join(ROOT, 'installer', 'one-click-tunnel.iss');
const RELEASE = path.join(ROOT, 'release');
const strict = process.argv.includes('--strict');

function versionOf() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '1.1.0'; } catch (e) { return '1.1.0'; }
}
function findIscc() {
  const candidates = [
    process.env.ISCC,
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  const probe = spawnSync('where', ['ISCC.exe'], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0) {
    const first = String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return '';
}

if (!fs.existsSync(ISS)) { console.error('缺少 ' + ISS); process.exit(strict ? 1 : 0); }
if (!fs.existsSync(path.join(ROOT, 'dist', 'public-tunnel.exe'))) {
  console.error('dist/public-tunnel.exe 不存在，先运行 node build/make-exe.mjs');
  process.exit(1);
}
const version = versionOf();
const iscc = findIscc();
if (!iscc) {
  console.log('未找到 Inno Setup (ISCC.exe)：跳过安装包生成。');
  console.log('想本地生成安装包的话装一个 Inno Setup 6（https://jrsoftware.org/isdl.php），CI 的 windows runner 已自带。');
  process.exit(strict ? 1 : 0);
}
fs.mkdirSync(RELEASE, { recursive: true });
console.log('ISCC: ' + iscc);
console.log('版本: ' + version);
const r = spawnSync(iscc, ['/DMyAppVersion=' + version, '/Qp', ISS], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (r.status !== 0) { console.error('ISCC 编译失败，退出码 ' + r.status); process.exit(1); }
const out = fs.readdirSync(RELEASE).filter((f) => /^one-click-tunnel-setup-.*\.exe$/.test(f));
if (!out.length) { console.error('没有生成安装包，请检查 ISCC 输出'); process.exit(1); }
for (const f of out) console.log('已生成: release/' + f + '  (' + (fs.statSync(path.join(RELEASE, f)).size / 1024 / 1024).toFixed(1) + ' MB)');
