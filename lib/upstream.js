'use strict';
/**
 * 上游（被映射的目标）解析与安全校验
 *  - 默认 127.0.0.1:<port>
 *  - 支持局域网设备：--target 192.168.1.50:8080（也支持 10.x / 172.16-31.x / 主机名解析到私有地址）
 *  - 默认拒绝公网地址 / 0.0.0.0 / 组播 / 链路本地（169.254.x，含云元数据 169.254.169.254），
 *    否则这个隧道就变成了"把任意公网地址转发出去"的开放代理
 *  - 需要显式 --allow-public-target 才允许公网目标
 */
const net = require('node:net');
const dns = require('node:dns');

function isIPv4Literal(h) { return net.isIPv4(h); }
function isPrivateIPv4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 127) return true;                        // 回环
  if (p[0] === 10) return true;                         // 10/8
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12
  if (p[0] === 192 && p[1] === 168) return true;        // 192.168/16
  if (p[0] === 169 && p[1] === 254) return false;       // 链路本地（明确拒绝）
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false; // CGNAT，按公网处理
  return false;
}
function isLoopbackName(h) { return ['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1'].includes(String(h).toLowerCase()); }
function isPrivateIPv6(ip) {
  const s = String(ip).toLowerCase();
  if (s === '::1' || s === '0:0:0:0:0:0:0:1') return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true;  // 唯一本地地址 fc00::/7
  if (s.startsWith('fe80')) return false;                     // 链路本地
  return false;
}
/** 解析 "host[:port]"，返回 { host, port|null }；支持 [::1]:8080 */
function parseTarget(input, defaultPort) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return { host: '127.0.0.1', port: defaultPort == null ? null : Number(defaultPort), raw: '' };
  if (s.startsWith('[')) {
    const i = s.indexOf(']');
    if (i < 0) throw new Error('IPv6 地址缺少 ]: ' + s);
    const host = s.slice(1, i);
    const rest = s.slice(i + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : (defaultPort == null ? null : Number(defaultPort));
    return { host: host, port: port, raw: s };
  }
  const idx = s.lastIndexOf(':');
  if (idx > 0 && s.indexOf(':') === idx) {
    const host = s.slice(0, idx);
    const port = Number(s.slice(idx + 1));
    return { host: host, port: port, raw: s };
  }
  return { host: s, port: defaultPort == null ? null : Number(defaultPort), raw: s };
}
function looksLikeUrl(s) { return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(s || '')); }

/** 校验目标是否允许；hostname 会做一次 DNS 解析并按解析结果判断 */
async function resolveTarget(opts) {
  opts = opts || {};
  let t;
  try { t = parseTarget(opts.target, opts.port); }
  catch (e) { throw new Error(e.message); }
  if (looksLikeUrl(t.host)) throw new Error('目标只填 host:port，不要带 http:// 前缀');
  let host = String(t.host || '').trim();
  if (!host) host = '127.0.0.1';
  let port = t.port == null ? Number(opts.port) : Number(t.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('目标端口不合法: ' + t.port);

  const isLocal = isLoopbackName(host) || host === '0.0.0.0';
  let kind = 'loopback';
  let ip = isIPv4Literal(host) || net.isIPv6(host) ? host : '';

  if (host === '0.0.0.0' || host === '::' || host === '0:0:0:0:0:0:0:0') throw new Error('目标不能是 0.0.0.0 / ::（要填具体设备地址，例如 192.168.1.50:8080）');
  if (isIPv4Literal(host)) {
    const p = host.split('.').map(Number);
    if (p[0] === 224 || p[0] >= 240) throw new Error('目标是组播/保留地址，不允许: ' + host);
    if (p[0] === 0) throw new Error('目标地址不合法: ' + host);
    kind = isPrivateIPv4(host) ? (p[0] === 127 ? 'loopback' : 'lan') : 'public';
  } else if (net.isIPv6(host) || host.indexOf(':') >= 0) {
    kind = isPrivateIPv6(host) ? (host === '::1' ? 'loopback' : 'lan') : 'public';
  } else {
    // 主机名：解析后按第一个地址判断
    try {
      const r = await dns.promises.lookup(host, { all: true });
      const addrs = (r || []).map((x) => x.address);
      if (!addrs.length) throw new Error('解析不到地址');
      ip = addrs[0];
      const anyPrivate = addrs.some((a) => (net.isIPv4(a) ? isPrivateIPv4(a) : isPrivateIPv6(a)));
      const anyLoop = addrs.some((a) => (net.isIPv4(a) ? a.startsWith('127.') : a === '::1'));
      kind = anyLoop ? 'loopback' : (anyPrivate ? 'lan' : 'public');
      if (kind === 'public' && !opts.allowPublic) throw new Error('主机名 ' + host + ' 解析到公网地址 ' + ip + '：默认不允许（要允许请加 --allow-public-target）');
    } catch (e) {
      if (/默认不允许/.test(e.message || '')) throw e;
      throw new Error('解析不了主机名 ' + host + '：' + (e && e.message ? e.message : e));
    }
  }
  if (kind === 'public' && !opts.allowPublic) {
    throw new Error('目标是公网地址 ' + host + '：默认不允许（本工具是给内网/本机做临时映射的，避免变成开放代理）。确实需要请加 --allow-public-target');
  }
  if (net.isIPv4(host)) {
    const p = host.split('.').map(Number);
    if (p[0] === 169 && p[1] === 254) throw new Error('目标是链路本地地址（169.254.x.x），不允许: ' + host);
  }
  return {
    host: host, port: port, kind: kind, ip: ip,
    secure: !!opts.secure,
    insecureTLS: !!opts.insecureTLS,
    label: (kind === 'loopback' ? '本机' : kind === 'lan' ? '局域网设备' : '公网地址') + ' ' + host + ':' + port,
    hostHeader: host + ':' + port,
  };
}
module.exports = { parseTarget, resolveTarget, isPrivateIPv4, isPrivateIPv6, isLoopbackName, looksLikeUrl };
