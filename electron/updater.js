// ============================================================
// AI智译 · 自动更新（electron-updater）
// 自动检查 GitHub Release，下载并安装新版本
// ============================================================

const { autoUpdater } = require("electron-updater");
const log = require("./logger");

let mainWindow = null;

function init(win) {
  mainWindow = win;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => send("checking"));
  autoUpdater.on("update-available", (info) => send("update-available", info));
  autoUpdater.on("update-not-available", () => send("up-to-date"));
  autoUpdater.on("download-progress", (p) => send("progress", { percent: p.percent, transferred: p.transferred, total: p.total }));
  autoUpdater.on("update-downloaded", (info) => send("downloaded", info));
  autoUpdater.on("error", (e) => send("error", { message: e.message }));
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("updater:" + channel, data);
  }
}

function checkNow() {
  autoUpdater.checkForUpdatesAndNotify().catch(e => {
    log.error("[updater] 检查更新失败:", e.message);
    send("error", { message: e.message });
  });
}

function quitAndInstall() {
  try {
    autoUpdater.quitAndInstall();
  } catch (e) {
    log.error("[updater] 安装更新失败:", e);
  }
}

module.exports = { init, checkNow, quitAndInstall };
