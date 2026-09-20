'use strict';
/**
 * 配置文件（config.json）：GUI / MCP / 托盘 / 多通道定义
 * 一个通道（profile）= 一个本机端口 + 一个网关端口 + 一个密码 + 一个 TTL
 */
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.js');

const CONFIG_VERSION = 1;
const DEFAULTS = {
  version: CONFIG_VERSION,
  gui: { port: 18400, token: '', openBrowser: true },
  mcp: { enabled: true, allowStart: true, allowStop: true },
  tray: { enabled: true },
  update: {
    enabled: true,
    repo: 'Thunderunruly/one-click-tunnel',
    apiBase: 'https://api.github.com',
    checkIntervalHours: 6,
    autoDownload: false,
    includePrerelease: false,
    downloadMirror: '',
    ignoredVersion: '',
  },
  defaults: {
    ttl: '1h',
    passwordMode: 'random',
    host: '127.0.0.1',
    gatewayStart: 18080,
    rateLimit: 3000,
  },
  profiles: [],
};

function deepMerge(base, over) {
  const out = JSON.parse(JSON.stringify(base));
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function profileErrors(p, all) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['profile 不是对象'];
  if (!p.name || !String(p.name).trim()) errs.push('name 不能为空');
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errs.push('port 必须是 1-65535');
  const gw = Number(p.gateway);
  if (!Number.isInteger(gw) || gw < 1024 || gw > 65535) errs.push('gateway 必须是 1024-65535');
  if (gw === port) errs.push('gateway 不能和 port 相同');
  try { U.parseTtl(p.ttl || '1h'); } catch (e) { errs.push(e.message); }
  if (p.passwordMode === 'fixed' && !String(p.password || '').trim()) errs.push('手动密码模式必须填写密码');
  if (p.passwordMode && !['random', 'fixed'].includes(p.passwordMode)) errs.push('passwordMode 只能是 random 或 fixed');
  if (!U.isLoopbackHost(p.host || '127.0.0.1') && !p.forcePublicGateway) errs.push('host 只能是回环地址（除非明确打开 forcePublicGateway）');
  const rl = Number(p.rateLimit);
  if (p.rateLimit !== undefined && (!Number.isInteger(rl) || rl < 10)) errs.push('rateLimit 至少 10');
  if (Array.isArray(all)) {
    const dup = all.filter((x) => x !== p && Number(x.gateway) === gw);
    if (dup.length) errs.push('网关端口 ' + gw + ' 已被通道「' + dup[0].name + '」占用');
  }
  return errs;
}

function normalizeProfile(input, index, cfg) {
  const p = Object.assign({}, input);
  p.id = U.slugify(p.id || p.name, 'tunnel-' + (index + 1));
  p.name = String(p.name || p.id).trim();
  p.enabled = p.enabled !== false;
  p.autoStart = !!p.autoStart;
  p.port = Number(p.port);
  p.gateway = Number(p.gateway);
  p.ttl = String(p.ttl || cfg.defaults.ttl || '1h');
  p.passwordMode = p.passwordMode === 'fixed' ? 'fixed' : 'random';
  p.password = String(p.password || '');
  p.host = String(p.host || cfg.defaults.host || '127.0.0.1');
  p.rateLimit = Number(p.rateLimit || cfg.defaults.rateLimit || 3000);
  p.upstreamHost = String(p.upstreamHost || '');
  p.allowHosts = Array.isArray(p.allowHosts) ? p.allowHosts.map(String) : [];
  p.openBrowser = !!p.openBrowser;
  p.forcePublicGateway = !!p.forcePublicGateway;
  p.noTunnel = !!p.noTunnel;
  p.lastUrl = String(p.lastUrl || '');
  return p;
}

class Config {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
  }
  static defaultFile(baseDir) {
    return process.env.TUNNEL_CONFIG || path.join(baseDir, 'config.json');
  }
  load() {
    const raw = U.readJsonSafe(this.file, null);
    this.data = deepMerge(DEFAULTS, raw || {});
    if (!this.data.gui.token) this.data.gui.token = require('node:crypto').randomBytes(16).toString('base64url');
    this.data.profiles = (this.data.profiles || []).map((p, i) => normalizeProfile(p, i, this.data));
    const seen = new Set();
    this.data.profiles.forEach((p, i) => {
      let id = p.id;
      while (seen.has(id)) id = p.id + '-' + (++i);
      seen.add(id);
      p.id = id;
    });
    if (!raw) this.save();
    return this;
  }
  save() {
    U.writeJsonAtomic(this.file, this.data);
    return this;
  }
  get profiles() { return this.data.profiles; }
  find(idOrName) {
    const key = String(idOrName || '').toLowerCase();
    return this.data.profiles.find((p) => p.id.toLowerCase() === key || p.name.toLowerCase() === key);
  }
  nextGateway(usedExtra) {
    const used = new Set(this.data.profiles.map((p) => Number(p.gateway)));
    if (usedExtra) for (const g of usedExtra) used.add(Number(g));
    let g = Number(this.data.defaults.gatewayStart) || 18080;
    while (used.has(g)) g += 1;
    return g;
  }
  nextFreeGateway() {
    return this.nextGateway();
  }
  addProfile(input) {
    const base = normalizeProfile(Object.assign({ gateway: this.nextGateway() }, input), this.data.profiles.length, this.data);
    const errs = profileErrors(base, this.data.profiles);
    if (errs.length) throw new Error('配置不合法: ' + errs.join('; '));
    let id = base.id;
    let n = 2;
    while (this.data.profiles.some((p) => p.id === id)) id = base.id + '-' + (n++);
    base.id = id;
    this.data.profiles.push(base);
    this.save();
    return base;
  }
  updateProfile(id, patch) {
    const p = this.find(id);
    if (!p) throw new Error('找不到通道: ' + id);
    const merged = normalizeProfile(Object.assign({}, p, patch), this.data.profiles.indexOf(p), this.data);
    // 校验时把自己排除掉，否则会把自己算成"网关端口冲突"
    const errs = profileErrors(merged, this.data.profiles.filter((x) => x !== p));
    if (errs.length) throw new Error('配置不合法: ' + errs.join('; '));
    Object.assign(p, merged);
    this.save();
    return p;
  }
  removeProfile(id) {
    const p = this.find(id);
    if (!p) throw new Error('找不到通道: ' + id);
    this.data.profiles = this.data.profiles.filter((x) => x !== p);
    this.save();
    return p;
  }
  updateGui(patch) {
    Object.assign(this.data.gui, patch || {});
    this.save();
    return this.data.gui;
  }
}
module.exports = { Config, DEFAULTS, CONFIG_VERSION, profileErrors, normalizeProfile };
