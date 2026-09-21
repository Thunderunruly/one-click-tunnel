// 命令行行为测试（离线）：裸跑给提示、help / version 可用
// 用法: node test-cli.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const TUNNEL = path.join(HERE, 'tunnel.js');
let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}

const bare = spawnSync(NODE, [TUNNEL], { cwd: HERE, encoding: 'utf8', timeout: 20000 });
ok('C1 裸跑 oct 不会启动任何隧道', bare.status === 0 && bare.stdout.indexOf('上游目标') < 0 && bare.stdout.indexOf('Tunnel ready') < 0,
  'exit=' + bare.status + ' ' + JSON.stringify((bare.stdout || '').slice(0, 60)));
ok('C2 裸跑会打印指引用法', bare.stdout.indexOf('你只敲了 oct') >= 0 && bare.stdout.indexOf('oct daemon start') >= 0,
  JSON.stringify((bare.stdout || '').slice(0, 80)));
ok('C3 裸跑不会偷偷用默认端口 3000 起网关', bare.stdout.indexOf('127.0.0.1:3000') < 0 && bare.stdout.indexOf('剩余约') < 0, '');
const legacy = spawnSync(NODE, [TUNNEL, '--help'], { cwd: HERE, encoding: 'utf8', timeout: 20000 });
ok('C4 老参数入口仍然可用（oct --help）', legacy.status === 0 && /--port/.test(legacy.stdout || ''), 'exit=' + legacy.status);

const help = spawnSync(NODE, [TUNNEL, 'help'], { cwd: HERE, encoding: 'utf8', timeout: 20000 });
ok('C5 oct help 可用并列出主要命令', help.status === 0 && /start/.test(help.stdout) && /add/.test(help.stdout),
  'exit=' + help.status + ' ' + JSON.stringify((help.stdout || '').slice(0, 60)));

const ver = spawnSync(NODE, [TUNNEL, 'version'], { cwd: HERE, encoding: 'utf8', timeout: 20000 });
ok('C6 oct version 可用且形如 one-click-tunnel x.y.z', ver.status === 0 && /one-click-tunnel \d+\.\d+\.\d+/.test(ver.stdout || ''),
  'exit=' + ver.status + ' ' + JSON.stringify((ver.stdout || '').slice(0, 60)));

console.log('\n================ CLI 行为测试结果 ================');
console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
for (const f of failures) console.log('  FAILED: ' + f);
process.exit(failures.length ? 1 : 0);
