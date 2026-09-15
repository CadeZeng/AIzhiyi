// ============================================================
// AI智译 · 日志记录（electron-log）
// 记录主进程日志到文件，捕获未处理异常
// ============================================================

const log = require("electron-log");
const path = require("path");
const { app } = require("electron");

// 日志文件路径：userData/logs/main.log
log.transports.file.level = "info";
log.transports.file.resolvePathFn = () => path.join(app.getPath("userData"), "logs", "main.log");
log.transports.file.maxSize = 5 * 1024 * 1024;  // 5MB

// 控制台输出：仅开发模式启用，避免打包后 EPIPE 错误刷屏
const isDev = !app.isPackaged;
log.transports.console.level = isDev ? "debug" : false;

// 捕获未处理异常（忽略 EPIPE 以避免循环写入）
log.errorHandler.startCatching({ showDialog: false });

const EPIPE_FILTER = /EPIPE|broken pipe/i;
process.on("uncaughtException", (err) => {
  if (err && EPIPE_FILTER.test(err.message || "")) return;
  log.error("uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  if (reason && typeof reason === "object" && EPIPE_FILTER.test(reason.message || "")) return;
  log.error("unhandledRejection:", reason);
});

module.exports = log;
