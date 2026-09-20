// 命名隧道 / 自有域名 测试（离线：纯函数 + --dry-run 集成；不联网、不碰 Cloudflare）
// 用法: node test-named.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const N = require(path.join(HERE, 'lib', 'named.js'));
const S = require(path.join(HERE, 'lib', 'named-setup.js'));
const { Config } = require(path.join(HERE, 'lib', 'config.js'));

let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passCount += 1; console.log('  PASS  ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail === undefined ? '' : '   [' + String(detail) + ']')); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-named-'));
const stateDir = path.join(tmp, 'state');
const cfDir = N.cloudflaredDir ? N.cloudflaredDir(tmp, stateDir) : path.join(stateDir, 'cloudflare');
fs.mkdirSync(cfDir, { recursive: true });
const realCloudflared = path.join(HERE, 'dist', 'cloudflared.exe');
const HAS_CF = fs.existsSync(realCloudflared);
const TUNNEL_ID = '8f2e1c34-5b6a-47d8-9e01-2a3b4c5d6e7f';

// ---------- 纯函数 ----------
console.log('== 域名校验 ==');
ok('N1 合法域名（自动小写）', N.validateHostname('App.Example.COM').ok && N.validateHostname('App.Example.COM').hostname === 'app.example.com');
ok('N2 非法：下划线/空格/空', ['bad_domain.com', 'a b.com', ''].every((h) => !N.validateHostname(h).ok));
ok('N3 非法：通配符（提示要单独加 CNAME）', !N.validateHostname('*.example.com').ok && /通配符/.test(N.validateHostname('*.example.com').error));
ok('N4 非法：快速隧道域名', !N.validateHostname('x.trycloudflare.com').ok);
ok('N5 合法：多级子域名', N.validateHostname('a.b.example.co.uk').ok);

console.log('== cloudflared 配置生成 ==');
const yaml = N.buildConfigYaml({ hostname: 'app.example.com', gatewayPort: 18080, tunnelId: TUNNEL_ID, credentialsFile: 'C:\\state\\cf\\web.credentials.json' });
ok('N6 配置含 tunnel / credentials-file / hostname', yaml.includes('tunnel: ' + TUNNEL_ID) && yaml.includes('credentials-file:') && yaml.includes('hostname: app.example.com'));
ok('N7 指向本地密码门（不是业务端口）', yaml.includes('service: http://127.0.0.1:18080'));
ok('N8 有 404 兜底（不会把没匹配的流量放出去）', yaml.includes('service: http_status:404'));
ok('N9 非法域名/端口直接抛错', (() => { try { N.buildConfigYaml({ hostname: 'bad domain', gatewayPort: 18080, credentialsFile: 'x' }); return false; } catch (e) { return true; } })()
  && (() => { try { N.buildConfigYaml({ hostname: 'a.example.com', gatewayPort: 0, credentialsFile: 'x' }); return false; } catch (e) { return true; } })());

console.log('== 命令拼装 ==');
ok('N10 运行参数带 --config run <id>', JSON.stringify(N.runArgs({ configFile: 'C:\\x.yml', tunnelId: TUNNEL_ID })) === JSON.stringify(['tunnel', '--no-autoupdate', '--config', 'C:\\x.yml', 'run', TUNNEL_ID]));
ok('N11 登录/创建/绑域名参数正确', JSON.stringify(N.loginArgs({ certFile: 'c.pem' })) === JSON.stringify(['tunnel', '--no-autoupdate', '--origincert', 'c.pem', 'login'])
  && JSON.stringify(N.createArgs({ certFile: 'c.pem', tunnelName: 'web' })) === JSON.stringify(['tunnel', '--no-autoupdate', '--origincert', 'c.pem', 'create', 'web'])
  && JSON.stringify(N.routeArgs({ certFile: 'c.pem', tunnelRef: TUNNEL_ID, hostname: 'app.example.com' })) === JSON.stringify(['tunnel', '--no-autoupdate', '--origincert', 'c.pem', 'route', 'dns', TUNNEL_ID, 'app.example.com']));

console.log('== 解析与文件 ==');
ok('N12 从 create 输出里解析隧道 ID', N.parseCreatedTunnelId('Created tunnel web with id ' + TUNNEL_ID) === TUNNEL_ID);
const credFile = N.credentialsPath(tmp, stateDir, 'web');
fs.writeFileSync(credFile, JSON.stringify({ AccountTag: 'acc', TunnelID: TUNNEL_ID, TunnelSecret: 'c2VjcmV0' }));
const cred = N.readCredentials(credFile);
ok('N13 解析凭据文件', cred.ok && cred.tunnelId === TUNNEL_ID && cred.accountTag === 'acc' && cred.hasSecret);
fs.writeFileSync(path.join(tmp, 'bad.json'), 'not json');
ok('N14 坏凭据文件不崩', N.readCredentials(path.join(tmp, 'bad.json')).ok === false);
ok('N15 未登录时 certInfo 给出提示', N.certInfo(tmp, stateDir).ok === false && /登录/.test(N.certInfo(tmp, stateDir).error || ''));
fs.writeFileSync(N.certPath(tmp, stateDir), '-----BEGIN CERTIFICATE-----\nxx\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nyy\n-----END PRIVATE KEY-----\n');
ok('N16 有 cert.pem 时认为已登录', N.certInfo(tmp, stateDir).ok === true);
const rd = N.namedReadiness(tmp, stateDir, { id: 'web', hostname: 'app.example.com' }, HAS_CF ? realCloudflared : undefined);
ok('N17 namedReadiness 汇总（已登录+有凭据）', rd.cert.ok && rd.credentials.ok && rd.hostname === 'app.example.com' && rd.publicUrl === 'https://app.example.com', JSON.stringify({ cert: rd.cert.ok, cred: rd.credentials.ok, steps: rd.steps }));
ok('N18 未填域名时给出可读步骤', (() => { const r = N.namedReadiness(tmp, stateDir, { id: 'web' }, HAS_CF ? realCloudflared : undefined); return r.ready === false && r.steps.some((s) => /域名/.test(s)); })());

console.log('== 配置校验 ==');
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, profiles: [] }));
const cfg = new Config(cfgFile).load();
ok('N19 命名隧道缺域名会被拒绝', (() => { try { cfg.addProfile({ name: 'web', port: 3000, mode: 'named' }); return false; } catch (e) { return /自有域名/.test(e.message); } })());
const namedProfile = cfg.addProfile({ name: 'web', port: 3000, mode: 'named', hostname: 'app.example.com', tunnelName: 'web' });
ok('N20 命名隧道默认 TTL=forever', namedProfile.ttl === 'forever', namedProfile.ttl);
ok('N21 配置页保存后 hostname 归一化', cfg.find('web').hostname === 'app.example.com' && cfg.find('web').mode === 'named');

// ---------- dry-run 集成 ----------
console.log('== --dry-run 集成（生成配置但不启动）==');
if (!HAS_CF) {
  console.log('  （dist/cloudflared.exe 不存在，跳过 dry-run 集成部分）');
} else {
  const stateFile = path.join(stateDir, 'tunnel-web.json');
  const r = spawnSync(process.execPath, [path.join(HERE, 'tunnel.js'), '--run-profile', 'web', '--config', cfgFile,
    '--state-file', stateFile, '--dry-run', '--cloudflared', realCloudflared, '--gateway', '18477', '--port', '3000'], { cwd: HERE, encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  ok('N22 dry-run 退出码 0', r.status === 0, 'code=' + r.status + ' ' + out.slice(-200));
  ok('N23 打印了 cloudflared 命令（含 --config … run）', /cloudflared/.test(out) && /--config/.test(out) && /run/.test(out), out.slice(0, 160));
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  ok('N24 状态：mode=named + 固定地址', st.mode === 'named' && st.url === 'https://app.example.com' && st.hostname === 'app.example.com', JSON.stringify({ m: st.mode, u: st.url }));
  ok('N25 状态：forever 时 expiresAt=0（不会自动关）', st.expiresAt === 0 && st.forever === true, JSON.stringify({ e: st.expiresAt, f: st.forever }));
  const genYml = N.configPath(HERE, stateDir, 'web');
  const exists = fs.existsSync(genYml);
  ok('N26 生成了 cloudflared 配置文件', exists, genYml);
  if (exists) {
    const y = fs.readFileSync(genYml, 'utf8');
    const gw = cfg.find('web').gateway;
    ok('N27 生成的配置指向本地密码门 + 自有域名', y.includes('hostname: app.example.com') && y.includes('http://127.0.0.1:' + gw), 'gateway=' + gw + ' | ' + y.split('\n').slice(4, 7).join(' | '));
    fs.rmSync(genYml, { force: true });
  }
  // 未登录场景
  fs.rmSync(N.certPath(tmp, stateDir), { force: true });
  const r2 = spawnSync(process.execPath, [path.join(HERE, 'tunnel.js'), '--run-profile', 'web', '--config', cfgFile,
    '--state-file', stateFile, '--dry-run', '--cloudflared', realCloudflared], { cwd: HERE, encoding: 'utf8', timeout: 60000 });
  const out2 = (r2.stdout || '') + (r2.stderr || '');
  ok('N28 没登录时给出"先登录 Cloudflare"的可读错误', r2.status !== 0 && /登录 Cloudflare/.test(out2), out2.slice(-160));
}

// ---------- setup 前置检查 ----------
console.log('== setup 前置检查 ==');
const lr = S.loginCloudflare({ appDir: tmp, stateDir: stateDir, cloudflared: path.join(tmp, '不存在的.exe') });
ok('N29 没有 cloudflared 时登录给出可读错误', lr.ok === false && /cloudflared/.test(lr.error || ''));
const sd = S.setupDomain({ appDir: tmp, stateDir: stateDir, profile: { id: 'web' }, hostname: 'bad host', cloudflared: HAS_CF ? realCloudflared : undefined });
ok('N30 非法域名在 setup 阶段就被拦下', sd.ok === false && /域名/.test(sd.error || ''), sd.error);

console.log('\n================ 命名隧道测试结果 ================');
console.log('通过 ' + passCount + ' 项，失败 ' + failures.length + ' 项');
for (const f of failures) console.log('  FAILED: ' + f);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(failures.length ? 1 : 0);
