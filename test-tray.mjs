// 托盘冒烟测试：验证 tray 命令能把 PowerShell 托盘图标拉起来、守护进程也活着、退出后不残留
// 用法: node test-tray.mjs   （会在你屏幕上短暂出现一个托盘图标，测试结束自动清掉）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const TUNNEL = process.env.TUNNEL_ENTRY ? path.resolve(HERE, process.env.TUNNEL_ENTRY) : path.join(HERE, 'tunnel.js');
const PACKAGED = TUNNEL.toLowerCase().endsWith('.exe');
function spawnTunnel(args) { return PACKAGED ? spawn(TUNNEL, args, { cwd: path.dirname(TUNNEL), windowsHide: true }) : spawn(NODE, [TUNNEL].concat(args), { cwd: HERE, windowsHide: true }); }
let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PS_HELPER = path.join(HERE, 'build', 'ps-tray-count.ps1');
function psHelper(match, kill) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_HELPER, '-Match', match];
  if (kill) args.push('-Kill');
  const r = spawnSync('powershell', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const m = ((r.stdout || '') + (r.stderr || '')).match(/COUNT=(\d+)/);
  return m ? Number(m[1]) : -1;
}
function ps(cmd) {
  const pre = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ';
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', pre + cmd], { encoding: 'utf8', windowsHide: true });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}
// 统计所有托盘进程（每次测试前先把历史残留清掉，保证基线是 0）
function trayCount() { return psHelper('tray.ps1', false); }
function trayCountFor() { return trayCount(); }
function killTree(pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) {} }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-tray-'));
const cfgFile = path.join(tmp, 'config.json');
let trayChild = null;
let guiChild = null;

async function main() {
  if (process.platform !== 'win32') { console.log('非 Windows，跳过托盘测试'); process.exit(0); }
  const cleaned = psHelper('tray.ps1', true);
  await sleep(1200);
  console.log('  （测试前清理历史托盘进程 ' + cleaned + ' 个，当前 ' + trayCount() + ' 个）');
  fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, gui: { port: 18488 }, tray: { enabled: true }, profiles: [] }, null, 2));
  const before = trayCountFor();

  trayChild = spawnTunnel(['tray', '--config', cfgFile, '--quiet']);
  let err = '';
  trayChild.stderr.on('data', (d) => { err += d.toString(); });
  await sleep(9000);
  ok('T1 tunnel tray 进程没有异常退出', trayChild.exitCode === null, 'code=' + trayChild.exitCode + ' err=' + err.slice(0, 300));
  ok('T2 守护进程被自动拉起', fs.existsSync(path.join(tmp, 'state', 'daemon.json')));
  ok('T3 出现了托盘进程（tray.ps1）', trayCountFor() > before, 'before=' + before + ' after=' + trayCountFor());
  ok('T4 PowerShell 没有报语法/运行错误', !/Exception|ParserError|错误/.test(err), err.slice(0, 300));

  killTree(trayChild.pid);
  await sleep(7000);
  trayChild = null;
  ok('T3b 关掉 tray 进程后托盘图标也消失', trayCountFor() === 0, 'tray=' + trayCountFor());

  // gui 命令也应该顺手把托盘拉起来（最小化到托盘的体验）
  const before2 = trayCountFor();
  guiChild = spawnTunnel(['gui', '--quiet', '--no-open', '--config', cfgFile]);
  let okDaemon = false;
  const dl = Date.now() + 20000;
  while (Date.now() < dl) { if (fs.existsSync(path.join(tmp, 'state', 'daemon.json'))) { okDaemon = true; break; } await sleep(300); }
  ok('T5 gui 守护进程起来了', okDaemon);
  await sleep(4000);
  ok('T6 gui 会自动带上托盘图标', trayCountFor() > before2, 'before=' + before2 + ' after=' + trayCountFor());

  const d = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'daemon.json'), 'utf8'));
  spawnSync('powershell', ['-NoProfile', '-Command', 'Invoke-RestMethod -Uri "http://127.0.0.1:' + d.port + '/api/shutdown" -Method Post -Headers @{ "x-tunnel-token" = "' + d.token + '" } -ContentType "application/json" -Body "{}" | Out-Null'], { windowsHide: true, timeout: 20000 });
  await sleep(3000);
  ok('T7 关闭守护进程后托盘图标一起收掉', trayCountFor() <= before2, 'tray=' + trayCountFor());
  ok('T8 daemon.json 已清理', !fs.existsSync(path.join(tmp, 'state', 'daemon.json')));
}

main().catch((e) => { failures.push('EXCEPTION: ' + (e && e.message ? e.message : e)); console.log(e); })
  .finally(async () => {
    if (trayChild && trayChild.pid) killTree(trayChild.pid);
    if (guiChild && guiChild.pid) killTree(guiChild.pid);
    await sleep(800);
    psHelper('tray.ps1', true);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log('\n================ 托盘测试结果 ================');
    console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(failures.length ? 1 : 0);
  });
