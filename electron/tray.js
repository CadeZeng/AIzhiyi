// ============================================================
// AI智译 · 系统托盘
// 创建托盘图标 + 右键菜单，拦截关闭最小化到托盘
// ============================================================

const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let tray = null;
let isQuiting = false;

function create(win) {
  // 优先使用 16x16 小尺寸图标，避免托盘失真
  const icon16Path = path.join(__dirname, '..', 'build', 'icon-16.png');
  const iconIcoPath = path.join(__dirname, '..', 'build', 'icon.ico');
  let icon = null;

  try {
    // 优先尝试 PNG 16
    icon = nativeImage.createFromPath(icon16Path);
    if (icon.isEmpty()) {
      // 降级到 ICO 并缩放
      icon = nativeImage.createFromPath(iconIcoPath);
      if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
    }
  } catch (_) {
    icon = nativeImage.createEmpty();
  }

  if (icon.isEmpty()) icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('AI智译 · 翻译与提示词优化工具');

  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } },
    { type: 'separator' },
    { label: '退出 AI智译', click: () => { isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);

  // 单击/双击托盘图标恢复窗口
  tray.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
  tray.on('double-click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });

  // 拦截窗口关闭：最小化到托盘而非退出
  win.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });

  return tray;
}

function setIsQuiting(v) { isQuiting = v; }
function getIsQuiting() { return isQuiting; }
function destroy() { if (tray) { tray.destroy(); tray = null; } }

module.exports = { create, setIsQuiting, getIsQuiting, destroy };
