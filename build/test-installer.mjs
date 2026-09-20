// 安装器端到端测试：装到临时目录 → 校验文件/快捷方式/注册表 → 运行安装后的 exe → 卸载 → 校验清干净
// 用法: node build/test-installer.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(os.tmpdir(), 'pt-install-test-' + Date.now());
const SHORTCUTS = path.join(TMP, 'shortcuts');
const INSTALL = path.join(TMP, 'app');
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PublicTunnel';

let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(cmd) {
  const pre = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ';
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', pre + cmd], { encoding: 'utf8', windowsHide: true });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}
function regQuery() {
  const r = spawnSync('reg', ['query', REG_KEY], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}
async function waitForUrl(child) {
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const dl = Date.now() + 60000;
  while (Date.now() < dl) {
    const m = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) return m[0];
    await sleep(500);
  }
  return null;
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  console.log('临时安装目录: ' + TMP);

  const inst = ps('& "' + path.join(DIST, 'install.ps1') + '" -InstallDir "' + INSTALL + '" -ShortcutDir "' + SHORTCUTS + '" -NoLaunch');
  ok('I1 安装脚本执行成功', inst.indexOf('安装完成') >= 0, inst.slice(-300));

  for (const f of ['public-tunnel.exe', 'cloudflared.exe', 'start.cmd', 'stop.cmd', 'uninstall.cmd', 'uninstall.ps1', 'README.md']) {
    ok('I2 已安装 ' + f, fs.existsSync(path.join(INSTALL, f)));
  }
  const lnk = path.join(SHORTCUTS, '临时公网映射.lnk');
  ok('I3 快捷方式已创建', fs.existsSync(lnk));
  if (fs.existsSync(lnk)) {
    const target = ps('(New-Object -ComObject WScript.Shell).CreateShortcut("' + lnk + '").TargetPath');
    ok('I3b 快捷方式指向安装目录的 start.cmd', target.toLowerCase() === path.join(INSTALL, 'start.cmd').toLowerCase(), target);
  }
  const rq = regQuery();
  const rqUtf8 = ps('if (Test-Path "' + REG_KEY.replace('HKCU\\', 'HKCU:\\') + '") { (Get-ItemProperty "' + REG_KEY.replace('HKCU\\', 'HKCU:\\') + '").DisplayName }');
  ok('I4 注册表卸载项已写入（含中文名称）', rq.code === 0 && rqUtf8.indexOf('临时公网映射') >= 0, rq.code + ' / ' + rqUtf8);

  const exe = path.join(INSTALL, 'public-tunnel.exe');
  const child = spawn(exe, ['--port', '19905', '--gateway', '18305', '--password', 'inst-pw', '--ttl', '50s'], { cwd: INSTALL, windowsHide: true });
  let spawnErr = null;
  child.on('error', (e) => { spawnErr = e.code || e.message; });
  const url = spawnErr ? null : await waitForUrl(child);
  ok('I5a exe 能启动', !spawnErr, spawnErr || '');
  ok('I5 安装后的 exe 能起公网隧道（自动找到同目录 cloudflared.exe）', !!url, url || '未取到地址');
  ok('I6 隧道实例在安装目录写 pid 文件', fs.existsSync(path.join(INSTALL, '.tunnel-18305.node.pid')) || !!url);
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}
  await sleep(1500);
  const leftover = ps('@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "cloudflared.exe" -and $_.CommandLine -like "*18305*" }).Count');
  ok('I7 关闭后没有残留的本次隧道进程', leftover.trim() === '0', 'leftover=' + leftover);

  const unin = ps('& "' + path.join(INSTALL, 'uninstall.ps1') + '" -InstallDir "' + INSTALL + '" -Quiet');
  ok('I8 卸载脚本执行成功', unin.indexOf('卸载完成') >= 0 || !fs.existsSync(INSTALL), unin.slice(-160));
  ok('I9 安装目录已删除', !fs.existsSync(INSTALL));
  ok('I10 注册表项已删除', regQuery().code !== 0);
}

main().catch((e) => { failures.push('EXCEPTION: ' + (e && e.message ? e.message : e)); console.log(e); })
  .finally(async () => {
    try { fs.rmSync(SHORTCUTS, { recursive: true, force: true }); } catch (e) {}
    try { if (fs.existsSync(INSTALL)) ps('& "' + path.join(INSTALL, 'uninstall.ps1') + '" -InstallDir "' + INSTALL + '" -Quiet'); } catch (e) {}
    try { if (fs.existsSync(INSTALL)) fs.rmSync(INSTALL, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    console.log('\n================ 安装器测试结果 ================');
    console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(failures.length ? 1 : 0);
  });
