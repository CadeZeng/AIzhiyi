// ============================================================
// AI智译 · 全局快捷键
// Ctrl+Shift+T 唤起/隐藏窗口（常驻）
// Alt+Q 截图 OCR 翻译      ┐
// Ctrl+Shift+J 光标处取词   ├ 翻译类快捷键（受 LOGO 小球开关控制）
// Alt+T 剪贴板取词翻译     ┘
// 全局拖动取词默认 Alt，由低级钩子处理，不走 globalShortcut
// ============================================================

const { globalShortcut } = require('electron');
const log = require('./logger');

const ACCELERATOR = 'Ctrl+Shift+T';
const SCREENSHOT_ACCELERATOR = 'Alt+Q';
const HOVER_OCR_ACCELERATOR = 'Ctrl+Shift+J';  // 外部应用 OCR 取词
const CLIPBOARD_ACCELERATOR = 'Alt+T';         // 外部应用剪贴板翻译
let mainWindowRef = null;
let enabled = true;                    // 总开关（设置页"启用全局快捷键"）
let translateShortcutsEnabled = true;  // 翻译类快捷键开关（LOGO 小球控制）
let screenshotHandler = null;
let hoverOcrHandler = null;
let clipboardHandler = null;

function register(win) {
  mainWindowRef = win;
  if (!enabled) return false;

  // 唤起窗口（常驻，不受小球控制）
  try { globalShortcut.unregister(ACCELERATOR); } catch (_) {}
  const ret = globalShortcut.register(ACCELERATOR, () => {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible() && win.isFocused()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
  log.info('[shortcuts] 唤起快捷键 ' + ACCELERATOR + ' 注册: ' + (ret ? '成功' : '失败'));

  // 翻译类快捷键
  registerTranslateShortcuts();
  return ret;
}

// 注册翻译类快捷键（截图 OCR / 光标 OCR / 剪贴板翻译）
function registerTranslateShortcuts() {
  if (!translateShortcutsEnabled) return;
  try { globalShortcut.unregister(SCREENSHOT_ACCELERATOR); } catch (_) {}
  try { globalShortcut.unregister(HOVER_OCR_ACCELERATOR); } catch (_) {}
  try { globalShortcut.unregister(CLIPBOARD_ACCELERATOR); } catch (_) {}

  // 截图翻译
  const ret2 = globalShortcut.register(SCREENSHOT_ACCELERATOR, () => {
    if (screenshotHandler) screenshotHandler();
  });
  // 外部应用 OCR 取词（单次触发）
  const ret3 = globalShortcut.register(HOVER_OCR_ACCELERATOR, () => {
    if (hoverOcrHandler) hoverOcrHandler();
  });
  // 外部应用剪贴板翻译
  const ret4 = globalShortcut.register(CLIPBOARD_ACCELERATOR, () => {
    if (clipboardHandler) clipboardHandler();
  });

  log.info('[shortcuts] 截图快捷键 ' + SCREENSHOT_ACCELERATOR + ' 注册: ' + (ret2 ? '成功' : '失败'));
  log.info('[shortcuts] OCR取词快捷键 ' + HOVER_OCR_ACCELERATOR + ' 注册: ' + (ret3 ? '成功' : '失败'));
  log.info('[shortcuts] 剪贴板翻译快捷键 ' + CLIPBOARD_ACCELERATOR + ' 注册: ' + (ret4 ? '成功' : '失败'));
  return ret2 && ret3 && ret4;
}

// 注销翻译类快捷键（小球关闭时调用）
function unregisterTranslateShortcuts() {
  try { globalShortcut.unregister(SCREENSHOT_ACCELERATOR); } catch (_) {}
  try { globalShortcut.unregister(HOVER_OCR_ACCELERATOR); } catch (_) {}
  try { globalShortcut.unregister(CLIPBOARD_ACCELERATOR); } catch (_) {}
  log.info('[shortcuts] 翻译类快捷键已全部注销');
}

// LOGO 小球开关 → 控制翻译类快捷键
function setTranslateShortcutsEnabled(v) {
  translateShortcutsEnabled = !!v;
  if (v) registerTranslateShortcuts();
  else unregisterTranslateShortcuts();
}

function setScreenshotHandler(fn) {
  screenshotHandler = fn;
}

function setHoverOcrHandler(fn) {
  hoverOcrHandler = fn;
}

function setClipboardHandler(fn) {
  clipboardHandler = fn;
}

function setEnabled(v) {
  enabled = v;
  if (!v) {
    try { globalShortcut.unregister(ACCELERATOR); } catch (_) {}
    unregisterTranslateShortcuts();
  } else if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    register(mainWindowRef);
  }
}

function isEnabled() { return enabled; }
function isTranslateShortcutsEnabled() { return translateShortcutsEnabled; }

function unregisterAll() {
  try { globalShortcut.unregister(ACCELERATOR); } catch (_) {}
  try { globalShortcut.unregister(SCREENSHOT_ACCELERATOR); } catch (_) {}
  try { globalShortcut.unregister(HOVER_OCR_ACCELERATOR); } catch (_) {}
  try { globalShortcut.unregister(CLIPBOARD_ACCELERATOR); } catch (_) {}
}

module.exports = {
  register, setEnabled, isEnabled, unregisterAll,
  ACCELERATOR, SCREENSHOT_ACCELERATOR, HOVER_OCR_ACCELERATOR, CLIPBOARD_ACCELERATOR,
  setScreenshotHandler, setHoverOcrHandler, setClipboardHandler,
  setTranslateShortcutsEnabled, isTranslateShortcutsEnabled
};
