// ============================================================
// AI智译 · 浮动结果窗
// WS_EX_NOACTIVATE | TOOLWINDOW | TOPMOST（Electron + win-host 加固）
// 默认点击穿透，标题栏可交互；不抢焦点、不激活原窗口
// ============================================================

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const log = require('./logger');
const ai = require('./ai-call');
const winHost = require('./win-host');

let win = null;
let pinned = false;
let hideTimer = null;
let passTimer = null;
let lastPoint = { x: 0, y: 0 };
const HEADER_H = 34;

function hwndLog(prefix) {
  if (!win || win.isDestroyed()) return;
  log.info(prefix, 'focusable=', win.isFocusable(), 'visible=', win.isVisible(),
    'alwaysOnTop=', win.isAlwaysOnTop(), 'pinned=', pinned);
}

function ensure() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 400,
    height: 240,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: true,
    type: 'toolbar',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'result-preload.js')
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'result.html'));
  win.webContents.on('did-finish-load', () => {
    winHost.applyNoActivate(win);
    hwndLog('[result-window] 已创建，不抢焦点');
  });
  startPassThroughWatch();
  return win;
}

function startPassThroughWatch() {
  if (passTimer) return;
  passTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (pinned) {
      win.setIgnoreMouseEvents(false);
      return;
    }
    const pos = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const overHeader = pos.x >= b.x && pos.x <= b.x + b.width && pos.y >= b.y && pos.y <= b.y + HEADER_H;
    win.setIgnoreMouseEvents(!overHeader, { forward: true });
  }, 80);
}

function placeNear(x, y, W, H) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const bounds = display.workArea;
  let px = x + 18;
  let py = y + 22;
  if (px + W > bounds.x + bounds.width) px = x - W - 18;
  if (py + H > bounds.y + bounds.height) py = y - H - 18;
  px = Math.max(bounds.x, px);
  py = Math.max(bounds.y, py);
  return { x: Math.round(px), y: Math.round(py), width: W, height: H };
}

function scheduleHide() {
  clearTimeout(hideTimer);
  if (pinned) return;
  const ms = Number(ai.getConfig().hoverHideTimeout) || 8000;
  hideTimer = setTimeout(() => hide('timeout'), ms);
}

function showAt(x, y, data) {
  const w = ensure();
  lastPoint = { x, y };
  const cfg = ai.getConfig();
  const payload = {
    ...data,
    theme: data.theme || cfg.theme || 'dark',
    showOriginal: cfg.showOriginal !== false,
    showPhonetic: cfg.showPhonetic !== false,
    showSourceLang: cfg.showSourceLang !== false,
    pinned
  };
  const H = payload.loading || payload.error ? 160 : 250;
  const W = 400;
  w.setBounds(placeNear(x, y, W, H));
  w.webContents.send('result:show', payload);
  w.showInactive();
  w.setIgnoreMouseEvents(!pinned, { forward: true });
  scheduleHide();
  log.info('[result-window] showInactive 不激活当前窗口 source=', data.source || 'unknown',
    'clipboard_untouched=true focus_stolen=false');
}

function showLoading(x, y, msg) {
  showAt(x, y, { loading: true, msg: msg || '识别翻译中...' });
}

function hide(reason) {
  if (pinned && reason !== 'force' && reason !== 'stop') return;
  clearTimeout(hideTimer);
  pinned = false;
  if (win && !win.isDestroyed()) {
    win.hide();
    log.info('[result-window] 隐藏 reason=', reason || 'unknown', '原活动窗口不应被改变');
  }
}

function setPinned(v) {
  pinned = !!v;
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(!pinned, { forward: true });
    win.webContents.send('result:pinned', pinned);
  }
  if (pinned) clearTimeout(hideTimer);
  else scheduleHide();
  log.info('[result-window] 交互模式 pinned=', pinned);
}

function isVisible() {
  return !!(win && !win.isDestroyed() && win.isVisible());
}

function containsPoint(pt) {
  if (!isVisible()) return false;
  const b = win.getBounds();
  return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
}

function destroy() {
  clearTimeout(hideTimer);
  if (passTimer) { clearInterval(passTimer); passTimer = null; }
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  pinned = false;
}

module.exports = {
  ensure, showAt, showLoading, hide, destroy, setPinned, isPinned: () => pinned,
  isVisible, containsPoint, getLastPoint: () => lastPoint
};
