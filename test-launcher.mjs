// 启动器测试：GUI 子系统（无控制台）+ 能找到并驱动 public-tunnel.exe + 缺文件时有可读提示
// 用法: node test-launcher.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(HERE, 'dist', 'one-click-tunnel.exe');
const TUNNEL = path.join(HERE, 'dist', 'public-tunnel.exe');
let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-launcher-'));

if (!fs.existsSync(LAUNCHER) || !fs.existsSync(TUNNEL)) {
  console.log('dist/one-click-tunnel.exe 或 dist/public-tunnel.exe 不存在，先运行 node build/make-exe.mjs');
  process.exit(1);
}
// 这里不需要 make-launcher 的顶层入口，直接内联同样的 PE 解析
function peSubsystem(file) {
  const b = fs.readFileSync(file);
  if (b[0] !== 0x4d || b[1] !== 0x5a) return null;
  const peOff = b.readUInt32LE(0x3c);
  const opt = peOff + 24;
  const magic = b.readUInt16LE(opt);
  return b.readUInt16LE(opt + 0x44);
}

console.log('== 启动器（无控制台）==');
ok('L1 启动器已生成', fs.existsSync(LAUNCHER), LAUNCHER);
ok('L2 体积很小（不是打包的 Node）', fs.statSync(LAUNCHER).size < 100 * 1024, (fs.statSync(LAUNCHER).size / 1024).toFixed(0) + ' KB');
ok('L3 PE Subsystem = 2 (GUI，不会弹 cmd 窗口)', peSubsystem(LAUNCHER) === 2, 'subsystem=' + peSubsystem(LAUNCHER));
ok('L4 对比：public-tunnel.exe 是控制台程序 (3)', peSubsystem(TUNNEL) === 3, 'subsystem=' + peSubsystem(TUNNEL));

const out1 = path.join(tmp, 'a.txt');
spawnSync(LAUNCHER, ['--selfcheck', out1], { windowsHide: true, timeout: 60000 });
const t1 = fs.existsSync(out1) ? fs.readFileSync(out1, 'utf8') : '';
ok('L5 自检能定位到同目录的 public-tunnel.exe', /EXISTS=1/.test(t1) && t1.indexOf(path.join(HERE, 'dist')) >= 0, t1.split('\n').slice(0, 3).join(' | '));

const out2 = path.join(tmp, 'b.txt');
spawnSync(LAUNCHER, ['--selfcheck', out2, '--spawn-args', 'version'], { windowsHide: true, timeout: 60000 });
const t2 = fs.existsSync(out2) ? fs.readFileSync(out2, 'utf8') : '';
ok('L6 能真的驱动 public-tunnel.exe（拿到 version 输出）', /one-click-tunnel \d+\.\d+\.\d+/.test(t2), t2.split('\n').filter((l) => /one-click-tunnel/.test(l)).join(' | '));

const out3 = path.join(tmp, 'c.txt');
spawnSync(LAUNCHER, ['--selfcheck', out3, '--spawn-args', 'help'], { windowsHide: true, timeout: 60000 });
const t3 = fs.existsSync(out3) ? fs.readFileSync(out3, 'utf8') : '';
ok('L7 子进程参数透传正常（help 输出）', /通道管理/.test(t3), t3.slice(0, 60));

// 缺 public-tunnel.exe 时
const lonely = path.join(tmp, 'lonely');
fs.mkdirSync(lonely, { recursive: true });
fs.copyFileSync(LAUNCHER, path.join(lonely, 'one-click-tunnel.exe'));
const out4 = path.join(tmp, 'd.txt');
const r4 = spawnSync(path.join(lonely, 'one-click-tunnel.exe'), ['--selfcheck', out4], { windowsHide: true, timeout: 60000 });
const t4 = fs.existsSync(out4) ? fs.readFileSync(out4, 'utf8') : '';
ok('L8 缺 exe 时返回退出码 2 并给出 EXISTS=0', r4.status === 2 && /EXISTS=0/.test(t4), 'rc=' + r4.status + ' ' + t4.replace(/\n/g, ' ').slice(0, 80));

console.log('\n================ 启动器测试结果 ================');
console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
for (const f of failures) console.log('  FAILED: ' + f);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(failures.length ? 1 : 0);
