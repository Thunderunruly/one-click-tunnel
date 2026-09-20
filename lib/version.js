'use strict';
/**
 * 当前版本：打包成 exe 时由 build/make-exe.mjs 注入 globalThis.__PT_VERSION，
 * 源码运行时读 package.json（单一来源，避免各处硬编码版本号）
 */
const fs = require('node:fs');
const path = require('node:path');

function currentVersion() {
  if (globalThis.__PT_VERSION) return String(globalThis.__PT_VERSION);
  try {
    const dir = require('./util.js').appDir();
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '0.0.0';
  } catch (e) { return '0.0.0'; }
}
module.exports = { currentVersion };
