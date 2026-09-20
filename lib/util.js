'use strict';
/**
 * 公共小工具：时长解析、随机密码、JSON 读写、端口探测等
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const TTL_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseTtl(v) {
  const m = String(v).trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!m) throw new Error('TTL 格式不对（示例: 30m / 2h / 1d）: ' + v);
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return Math.max(10_000, n * TTL_UNITS[unit]);
}
function ttlToText(ms) {
  if (!ms || ms < 0) return '0s';
  if (ms % TTL_UNITS.d === 0) return (ms / TTL_UNITS.d) + 'd';
  if (ms % TTL_UNITS.h === 0) return (ms / TTL_UNITS.h) + 'h';
  if (ms % TTL_UNITS.m === 0) return (ms / TTL_UNITS.m) + 'm';
  return Math.round(ms / 1000) + 's';
}
function randomPassword(len) {
  const n = len || 10;
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
function slugify(s, fallback) {
  const out = String(s || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '');
  return out || (fallback || 'tunnel');
}
function appDir() {
  // 打包成 exe（Node SEA / pkg）后用 exe 所在目录；否则用本文件所在目录的上一级
  try { if (require('node:sea').isSea()) return path.dirname(process.execPath); } catch (e) {}
  if (process.pkg) return path.dirname(process.execPath);
  return path.dirname(__dirname);
}
function isLoopbackHost(h) {
  return ['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1'].includes(String(h || '').toLowerCase());
}
function isLoopbackAddr(a) {
  const s = String(a || '');
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1' || s.startsWith('127.');
}
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try { srv.listen(port, host || '127.0.0.1'); } catch (e) { resolve(false); }
  });
}
function localIpList() {
  const out = [];
  try {
    const ifs = require('node:os').networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const it of ifs[name] || []) if (it.family === 'IPv4') out.push(it.address);
    }
  } catch (e) {}
  return out;
}
module.exports = { parseTtl, ttlToText, randomPassword, slugify, isLoopbackHost, isLoopbackAddr, readJsonSafe, writeJsonAtomic, portFree, localIpList, appDir, TTL_UNITS };
