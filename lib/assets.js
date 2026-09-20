'use strict';
/**
 * 静态资源读取：开发时读磁盘，打包成单文件 exe 时读打包时内联进来的资源表。
 */
const fs = require('node:fs');
const path = require('node:path');

function assetMap() {
  return globalThis.__PT_ASSETS || null;
}
function hasAsset(rel) {
  const a = assetMap();
  return !!(a && Object.prototype.hasOwnProperty.call(a, rel));
}
function readAsset(rel, baseDir) {
  if (hasAsset(rel)) return assetMap()[rel];
  return fs.readFileSync(path.join(baseDir || process.cwd(), rel), 'utf8');
}
function existsAsset(rel, baseDir) {
  if (hasAsset(rel)) return true;
  try { return fs.existsSync(path.join(baseDir || process.cwd(), rel)); } catch (e) { return false; }
}
module.exports = { readAsset, hasAsset, existsAsset };
