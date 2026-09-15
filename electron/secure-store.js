// ============================================================
// AI智译 · 安全存储（safeStorage 加密）
// 使用 Windows DPAPI 加密 API Key 等敏感信息
// ============================================================

const { safeStorage, app } = require('electron');
const fs = require('fs');
const path = require('path');

const KEY_PREFIX = 'aizhiyi-secure-';
const storeFile = path.join(app.getPath('userData'), 'secure-store.json');

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

function storeSet(k, v) {
  let data = {};
  try {
    const raw = fs.readFileSync(storeFile, 'utf8');
    if (raw) data = JSON.parse(raw);
  } catch (_) {}
  data[k] = v;
  try {
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

function storeGet(k) {
  try {
    const raw = fs.readFileSync(storeFile, 'utf8');
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data[k] || null;
  } catch (_) {
    return null;
  }
}

function set(key, value) {
  if (!isAvailable()) return false;
  if (!value) {
    // 空值时清除
    try {
      let data = {};
      try {
        const raw = fs.readFileSync(storeFile, 'utf8');
        if (raw) data = JSON.parse(raw);
      } catch (_) {}
      delete data[KEY_PREFIX + key];
      fs.writeFileSync(storeFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) {}
    return true;
  }
  try {
    const buf = safeStorage.encryptString(value);
    storeSet(KEY_PREFIX + key, buf.toString('base64'));
    return true;
  } catch (e) {
    console.error('[secure-store] 加密失败:', e);
    return false;
  }
}

function get(key) {
  if (!isAvailable()) return null;
  const b64 = storeGet(KEY_PREFIX + key);
  if (!b64) return null;
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch (e) {
    console.error('[secure-store] 解密失败:', e);
    return null;
  }
}

function remove(key) {
  try {
    let data = {};
    try {
      const raw = fs.readFileSync(storeFile, 'utf8');
      if (raw) data = JSON.parse(raw);
    } catch (_) {}
    delete data[KEY_PREFIX + key];
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

module.exports = { set, get, remove, isAvailable };
