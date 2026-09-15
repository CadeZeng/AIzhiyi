// ============================================================
// AI智译 · 浮动结果窗
// 悬停取词与截图翻译共用的轻量置顶窗口
// ============================================================

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const log = require('./logger');

let win = null;

function ensure() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 380,
    height: 220,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'result-preload.js')
    }
  });
  win.loadFile(path.join(__dirname, '..', 'result.html'));
  win.on('blur', () => hide());
  return win;
}

function showAt(x, y, data) {
  const w = ensure();
  const display = screen.getDisplayNearestPoint({ x, y });
  const bounds = display.workArea;
  // 预估尺寸，避免超出屏幕边缘
  const W = 380, H = 220;
  let px = x + 16;
  let py = y + 16;
  if (px + W > bounds.x + bounds.width) px = x - W - 16;
  if (py + H > bounds.y + bounds.height) py = y - H - 16;
  w.setBounds({ x: Math.max(bounds.x, px), y: Math.max(bounds.y, py), width: W, height: H });
  w.webContents.send('result:show', data);
  w.showInactive();
  log.info('[result-window] 显示结果:', data.source || 'unknown');
}

function showLoading(x, y, msg) {
  showAt(x, y, { loading: true, msg: msg || '识别翻译中...' });
}

function hide() {
  if (win && !win.isDestroyed()) {
    win.hide();
  }
}

function destroy() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = { ensure, showAt, showLoading, hide, destroy };
