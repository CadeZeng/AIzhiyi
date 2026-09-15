// ============================================================
// AI智译 · Electron 预加载脚本
// 在渲染进程和主进程之间安全暴露 API
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ====== 窗口控制 ======
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('window-maximize-toggle'),
  closeWindow: () => ipcRenderer.send('window-close'),
  quitApp: () => ipcRenderer.send('app-quit'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  onMaximizeChanged: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on('window-maximize-changed', handler);
    return () => ipcRenderer.removeListener('window-maximize-changed', handler);
  },

  // ====== 全局快捷键 ======
  setShortcutEnabled: (enabled) => ipcRenderer.invoke('shortcut:set-enabled', enabled),
  getShortcutAccelerator: () => ipcRenderer.invoke('shortcut:get-accelerator'),
  isShortcutEnabled: () => ipcRenderer.invoke('shortcut:is-enabled'),

  // ====== 安全存储（safeStorage 加密 API Key） ======
  secureStore: {
    set: (key, value) => ipcRenderer.invoke('secure-store:set', key, value),
    get: (key) => ipcRenderer.invoke('secure-store:get', key),
    available: () => ipcRenderer.invoke('secure-store:available')
  },

  // ====== 自动更新 ======
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    on: (channel, callback) => {
      const handler = (_e, ...args) => callback(...args);
      ipcRenderer.on('updater:' + channel, handler);
      return () => ipcRenderer.removeListener('updater:' + channel, handler);
    }
  },

  // ====== 日志 ======
  openLogsPath: () => ipcRenderer.invoke('logs:open-folder'),
  writeLog: (level, msg) => ipcRenderer.invoke('logs:write', level, msg),

  // ====== 应用信息 ======
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },

  // ====== 悬停取词 / 截图翻译 / 配置同步 ======
  configSync: (config) => ipcRenderer.invoke('config:sync', config),
  hover: {
    setEnabled: (enabled) => ipcRenderer.invoke('hover:set-enabled', enabled),
    setDelay: (ms) => ipcRenderer.invoke('hover:set-delay', ms)
  },
  screenshot: {
    trigger: () => ipcRenderer.invoke('screenshot:trigger')
  },
  screenshotAccelerator: 'Alt+Q',
  hoverOcrAccelerator: 'Ctrl+Shift+J',
  clipboardAccelerator: 'Alt+T',

  // ====== LOGO 小球（翻译总开关） ======
  ball: {
    getState: () => ipcRenderer.invoke('ball:get-state'),
    onStateChanged: (callback) => {
      const handler = (_e, v) => callback(v);
      ipcRenderer.on('ball:state-changed', handler);
      return () => ipcRenderer.removeListener('ball:state-changed', handler);
    }
  }
});
