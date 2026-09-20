// 用系统自带 csc.exe 编译无控制台启动器 -> dist/one-click-tunnel.exe（GUI 子系统，不弹 cmd）
// 用法: node build/make-launcher.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'build', 'launcher', 'Launcher.cs');
const OUT = path.join(ROOT, 'dist', 'one-click-tunnel.exe');

function findCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  const probe = spawnSync('where', ['csc.exe'], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0) {
    const first = String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return '';
}
/** 读 PE 头里的 Subsystem：2=GUI（无控制台），3=Console */
export function peSubsystem(file) {
  const b = fs.readFileSync(file);
  if (b[0] !== 0x4d || b[1] !== 0x5a) return { ok: false, error: '不是 PE 文件' };
  const peOff = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(peOff) !== 0x00004550) return { ok: false, error: 'PE 签名不对' };
  const opt = peOff + 24;
  const magic = b.readUInt16LE(opt);
  const subsystemOff = opt + 0x44;
  const subsystem = b.readUInt16LE(subsystemOff);
  return { ok: true, magic: magic === 0x20b ? 'PE32+' : 'PE32', subsystem: subsystem, gui: subsystem === 2, console: subsystem === 3 };
}

if (process.argv[1] && process.argv[1].endsWith('make-launcher.mjs')) {
  if (!fs.existsSync(SRC)) { console.error('缺少 ' + SRC); process.exit(1); }
  const csc = findCsc();
  if (!csc) { console.error('找不到 csc.exe（.NET Framework 编译器的位置不对）'); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const args = ['/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
    '/r:System.Windows.Forms.dll', '/out:' + OUT, SRC];
  console.log('> ' + csc + ' ' + args.join(' '));
  const r = spawnSync(csc, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) { console.error('csc 编译失败，退出码 ' + r.status); process.exit(1); }
  const info = peSubsystem(OUT);
  console.log('已生成: ' + OUT + '  (' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB, ' + info.magic + ', Subsystem=' + info.subsystem + (info.gui ? ' GUI（不弹控制台）' : ' 非 GUI！') + ')');
  if (!info.gui) { console.error('生成的程序不是 GUI 子系统，会弹控制台窗口'); process.exit(1); }
}
