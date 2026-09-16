// ============================================================
// AI智译 · Windows 助手进程
// 长期运行的 STA PowerShell：UIA 只读取词、Windows OCR、按键观察、WS_EX_NOACTIVATE
// 不调用 Select / SetFocus / Invoke / 剪贴板
// ============================================================

const { spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');
const log = require('./logger');

let child = null;
let starting = null;
let reqId = 0;
const pending = new Map();
const eventListeners = new Set();
let buf = '';
let keysCache = { alt: false, ctrl: false, shift: false, lbutton: false, rbutton: false, escape: false };
let prevKeys = { ...keysCache };
let keysTimer = null;

function helperScript() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'helpers', 'win-host.ps1');
  }
  return path.join(__dirname, 'helpers', 'win-host.ps1');
}

function killChild() {
  if (!child) return;
  try { child.stdin.end(); } catch (_) {}
  try { child.kill(); } catch (_) {}
  child = null;
}

function handleLine(line) {
  const trim = String(line || '').trim();
  if (!trim) return;
  let msg;
  try { msg = JSON.parse(trim); } catch (e) {
    log.warn('[win-host] 非 JSON 输出:', trim.slice(0, 200));
    return;
  }
  if (msg.ready) {
    log.info('[win-host] 就绪 pid=', msg.pid);
    return;
  }
  if (msg.event) {
    for (const fn of eventListeners) {
      try { fn(msg); } catch (e) { log.warn('[win-host] event listener:', e.message); }
    }
    return;
  }
  if (msg.id == null) return;
  const job = pending.get(msg.id);
  if (!job) return;
  pending.delete(msg.id);
  clearTimeout(job.timer);
  if (msg.ok) job.resolve(msg.data);
  else job.reject(new Error(msg.error || 'win-host error'));
}

function attach(proc) {
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  });
  proc.stderr.on('data', (chunk) => {
    const t = String(chunk).trim();
    if (t) log.warn('[win-host:stderr]', t.slice(0, 400));
  });
  proc.on('exit', (code) => {
    log.warn('[win-host] 进程退出 code=', code);
    child = null;
    for (const [, job] of pending) {
      clearTimeout(job.timer);
      job.reject(new Error('win-host exited'));
    }
    pending.clear();
  });
}

async function ensure() {
  if (process.platform !== 'win32') {
    throw new Error('win-host 仅支持 Windows');
  }
  if (child && !child.killed) return child;
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    const script = helperScript();
    log.info('[win-host] 启动', script);
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', script
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child = proc;
    buf = '';
    attach(proc);
    const readyTimer = setTimeout(() => {
      // 即使没收到 ready 也继续，后续 ping 会失败并暴露问题
      resolve(proc);
    }, 2500);
    proc.once('error', (e) => {
      clearTimeout(readyTimer);
      child = null;
      reject(e);
    });
    proc.once('spawn', () => {
      clearTimeout(readyTimer);
      resolve(proc);
    });
  }).finally(() => { starting = null; });
  await starting;
  startKeysLoop();
  return child;
}

function request(cmd, extra = {}, timeoutMs = 2500) {
  return new Promise(async (resolve, reject) => {
    try { await ensure(); } catch (e) { reject(e); return; }
    if (!child || !child.stdin.writable) {
      reject(new Error('win-host stdin closed'));
      return;
    }
    const id = ++reqId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('win-host timeout: ' + cmd));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function startKeysLoop() {
  if (keysTimer) return;
  keysTimer = setInterval(async () => {
    if (!child || pending.size > 2) return;
    try {
      const k = await request('keys', {}, 400);
      if (k && typeof k === 'object') {
        prevKeys = keysCache;
        keysCache = {
          alt: !!k.alt, ctrl: !!k.ctrl, shift: !!k.shift,
          lbutton: !!k.lbutton, rbutton: !!k.rbutton, escape: !!k.escape
        };
      }
    } catch (_) {}
  }, 60);
}

function getKeys() { return { ...keysCache }; }
function keyWentDown(name) { return !!keysCache[name] && !prevKeys[name]; }

async function uiaText(physicalX, physicalY, unit = 'word') {
  const data = await request('uia', { x: physicalX, y: physicalY, unit }, 1800);
  return data || { text: '', source: 'uia-miss' };
}

async function uiaRect(physicalX, physicalY, physicalW, physicalH, unit = 'line') {
  const data = await request('uia-rect', {
    x: physicalX, y: physicalY, w: physicalW, h: physicalH, unit
  }, 2800);
  return data || { text: '', source: 'uia-rect-miss' };
}

async function uiaRange(x1, y1, x2, y2, unit = 'auto') {
  const data = await request('uia-range', { x1, y1, x2, y2, unit }, 2200);
  return data || { text: '', source: 'uia-range-miss', rects: [] };
}

function onEvent(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

function modifierToGuard(mod) {
  const m = String(mod || 'alt').toLowerCase();
  if (m === 'ctrl') return { modifier: 'ctrl', extraButton: 0 };
  if (m === 'shift') return { modifier: 'shift', extraButton: 0 };
  if (m === 'alt+xbutton1' || m === 'alt-xbutton1') return { modifier: 'alt', extraButton: 1 };
  if (m === 'alt+xbutton2' || m === 'alt-xbutton2') return { modifier: 'alt', extraButton: 2 };
  return { modifier: 'alt', extraButton: 0 };
}

async function startGuard(opts = {}) {
  const g = modifierToGuard(opts.modifier);
  return await request('guard-start', {
    modifier: g.modifier,
    extraButton: g.extraButton,
    debug: !!opts.debug
  }, 2500);
}

async function stopGuard() {
  try { return await request('guard-stop', {}, 1500); }
  catch (_) { return null; }
}

async function configGuard(opts = {}) {
  const g = modifierToGuard(opts.modifier);
  return await request('guard-config', {
    modifier: g.modifier,
    extraButton: g.extraButton,
    debug: !!opts.debug
  }, 1200);
}

async function ocrFile(absPath) {
  return await request('ocr', { path: absPath }, 20000);
}

async function applyNoActivate(win) {
  if (!win || win.isDestroyed()) return null;
  try {
    const buf = win.getNativeWindowHandle();
    const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
    const data = await request('exstyle', { hwnd }, 800);
    log.info('[win-host] WS_EX_NOACTIVATE 已应用', JSON.stringify(data));
    return data;
  } catch (e) {
    log.warn('[win-host] 应用 WS_EX_NOACTIVATE 失败（已用 Electron focusable:false 近似）:', e.message);
    return null;
  }
}

function stop() {
  if (keysTimer) { clearInterval(keysTimer); keysTimer = null; }
  try { if (child) child.stdin.write(JSON.stringify({ id: ++reqId, cmd: 'guard-stop' }) + '\n'); } catch (_) {}
  try { if (child) child.stdin.write(JSON.stringify({ id: ++reqId, cmd: 'quit' }) + '\n'); } catch (_) {}
  setTimeout(killChild, 300);
}

module.exports = {
  ensure, request, getKeys, keyWentDown, uiaText, uiaRect, uiaRange, ocrFile,
  startGuard, stopGuard, configGuard, onEvent,
  applyNoActivate, stop, isRunning: () => !!child
};
