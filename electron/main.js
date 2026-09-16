// ============================================================
// AI智译 · Electron 主进程
// 创建无边框窗口，加载 index.html
// 集成系统托盘 + 全局快捷键 + 自动更新 + 安全存储 + 日志
// ============================================================

const { app, BrowserWindow, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const tray = require('./tray');
const shortcuts = require('./shortcuts');
const updater = require('./updater');
const secure = require('./secure-store');
const log = require('./logger');
const ai = require('./ai-call');
const hoverTranslate = require('./hover-translate');
const screenshotTranslate = require('./screenshot-translate');
const resultWindow = require('./result-window');
const clipboardTranslate = require('./clipboard-translate');
const ball = require('./ball-window');
const winHost = require('./win-host');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.aizhiyi.translator');
}

let mainWindow = null;

function resolveIconImage(fileName) {
  const candidates = [
    path.join(__dirname, '..', 'build', fileName),
    path.join(process.resourcesPath || '', fileName)
  ];
  for (const iconPath of candidates) {
    try {
      const image = nativeImage.createFromPath(iconPath);
      if (image && !image.isEmpty()) return image;
    } catch (_) {}
  }
  return null;
}

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  const icon = resolveIconImage('icon.ico') || resolveIconImage('icon.png');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'AI智译',
    frame: false,
    backgroundColor: '#0B0F14',
    show: false,
    icon: icon || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      zoomFactor: 1.0
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // ====== IPC 处理 ======
  // 窗口控制
  ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.on('window-maximize-toggle', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.on('app-quit', () => {
    tray.setIsQuiting(true);
    app.quit();
  });
  ipcMain.handle('window-is-maximized', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return mainWindow.isMaximized();
  });

  // 全局快捷键
  ipcMain.handle('shortcut:set-enabled', (_, v) => {
    shortcuts.setEnabled(v);
    return true;
  });
  ipcMain.handle('shortcut:get-accelerator', () => shortcuts.ACCELERATOR);
  ipcMain.handle('shortcut:is-enabled', () => shortcuts.isEnabled());

  // 安全存储（safeStorage 加密）
  ipcMain.handle('secure-store:set', (_, key, value) => secure.set(key, value));
  ipcMain.handle('secure-store:get', (_, key) => secure.get(key));
  ipcMain.handle('secure-store:available', () => secure.isAvailable());

  // 自动更新
  ipcMain.handle('updater:check', () => updater.checkNow());
  ipcMain.handle('updater:download', () => updater.downloadNow());
  ipcMain.handle('updater:install', () => updater.quitAndInstall());
  ipcMain.handle('updater:get-state', () => updater.getState());

  // 日志
  ipcMain.handle('logs:open-folder', () => {
    shell.openPath(path.join(app.getPath('userData'), 'logs'));
  });
  ipcMain.handle('logs:write', (_, level, msg) => {
    if (typeof log[level] === 'function') log[level](msg);
  });

  // 应用信息
  ipcMain.handle('app:get-version', () => app.getVersion());

  // ====== 悬停取词 / 截图翻译 / AI 配置同步 ======
  // 渲染进程启动后同步配置到主进程
  ipcMain.handle('config:sync', (_, config) => {
    ai.updateConfig(config);
    return true;
  });

  // 悬停取词开关
  ipcMain.handle('hover:set-enabled', (_, enabled) => {
    if (enabled && ball.getEnabled()) hoverTranslate.start();
    else hoverTranslate.stop();
    return true;
  });
  ipcMain.handle('hover:set-delay', (_, ms) => {
    hoverTranslate.setDelay(ms);
    return true;
  });

  // 截图翻译触发
  ipcMain.handle('screenshot:trigger', () => {
    log.info('[main] screenshot:trigger IPC 被调用');
    screenshotTranslate.trigger();
    return true;
  });

  // 截图翻译初始化（注册 IPC）
  screenshotTranslate.init();

  // 结果窗控制
  ipcMain.on('result:copy', (_, text) => {
    if (process.platform === 'win32') {
      // 用 Electron clipboard
      const { clipboard } = require('electron');
      clipboard.writeText(text);
    }
  });
  ipcMain.on('result:close', () => {
    resultWindow.hide('force');
  });
  ipcMain.on('result:pin-toggle', () => {
    resultWindow.setPinned(!resultWindow.isPinned());
  });

  // 监听最大化状态变化
  mainWindow.on('maximize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('window-maximize-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('window-maximize-changed', false);
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 创建系统托盘
  tray.create(mainWindow);

  // 注册全局快捷键
  shortcuts.register(mainWindow);
  shortcuts.setScreenshotHandler(() => screenshotTranslate.trigger());
  shortcuts.setHoverOcrHandler(() => hoverTranslate.translateAtCursor());
  shortcuts.setClipboardHandler(() => clipboardTranslate.trigger());

  // ====== LOGO 浮窗小球（翻译总开关） ======
  // 点击小球 → 切换所有翻译触发（应用内取词 + 应用外快捷键）
  ball.create(mainWindow, (ballEnabled) => {
    shortcuts.setTranslateShortcutsEnabled(ballEnabled);
    hoverTranslate.setMasterEnabled(ballEnabled);
    if (!ballEnabled) hoverTranslate.stop();
  });
  ipcMain.handle('ball:get-state', () => ball.getEnabled());
  // 启动时若小球为关闭状态，立即注销翻译类快捷键
  if (!ball.getEnabled()) {
    shortcuts.setTranslateShortcutsEnabled(false);
    hoverTranslate.setMasterEnabled(false);
  }

  // 预热 Windows UIA / OCR 助手（失败不影响主窗口）
  winHost.ensure().catch((e) => log.warn('[main] win-host 预热失败:', e.message));

  // 从 secureStore 加载 API Key 到 ai-call 缓存
  ai.loadKeysAsync();

  // 初始化自动更新
  updater.init(mainWindow);
  // 启动后 5 秒静默检查（失败只写日志，不在关于页刷 HTML 错误）
  setTimeout(() => {
    updater.checkNow({ silent: true }).catch((e) => log.error('检查更新失败:', e));
  }, 5000);

  return mainWindow;
}

// ====== 应用生命周期 ======
app.whenReady().then(() => {
  log.info('AI智译 应用启动，版本：', app.getVersion());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 关闭所有窗口时不立即退出（托盘常驻）
  if (process.platform !== 'darwin') {
    // 不调用 app.quit()，让托盘 hold 住进程
  }
});

app.on('will-quit', () => {
  shortcuts.unregisterAll();
  tray.destroy();
  resultWindow.destroy();
  screenshotTranslate.destroy();
  hoverTranslate.stop();
  winHost.stop();
  ball.destroy();
});

// 安全：拒绝意外的网页权限请求
app.on('web-contents-created', (_, contents) => {
  contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['clipboard', 'clipboard-read', 'clipboard-write', 'media', 'display-capture'];
    callback(allowed.includes(permission));
  });
});
