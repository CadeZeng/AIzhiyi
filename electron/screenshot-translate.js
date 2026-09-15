// ============================================================
// AI智译 · 截图 OCR 翻译
// Alt+Q 触发 → 全屏遮罩框选 → OCR+翻译 → 浮动结果
// ============================================================

const { BrowserWindow, screen, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const log = require('./logger');
const ai = require('./ai-call');
const resultWin = require('./result-window');

let overlayWin = null;
let busy = false;

function init() {
  ipcMain.handle('screenshot:select', (_e, rect) => onSelection(rect));
  ipcMain.on('screenshot:cancel', () => closeOverlay());
}

async function trigger() {
  log.info('[screenshot] trigger 被调用，busy=' + busy + ', overlayWin=' + !!overlayWin);
  if (busy || overlayWin) return;
  busy = true;
  try {
    // 获取主显示器
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;

    overlayWin = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width,
      height,
      fullscreen: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: true,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'overlay-preload.js')
      }
    });
    overlayWin.loadFile(path.join(__dirname, '..', 'overlay.html'));
    overlayWin.setAlwaysOnTop(true, 'pop-up-menu');
    // 捕获 overlay 渲染进程的 console 日志
    overlayWin.webContents.on('console-message', (_e, level, message) => {
      log.info('[overlay-console]', message);
    });
    overlayWin.webContents.on('did-finish-load', () => {
      overlayWin.show();
      overlayWin.focus();
      log.info('[screenshot] 进入框选模式');
    });
    overlayWin.webContents.on('render-process-gone', (_e, details) => {
      log.error('[screenshot] overlay 渲染进程崩溃:', details.reason);
    });
  } catch (e) {
    log.error('[screenshot] 启动失败:', e.message);
    busy = false;
  }
}

async function onSelection(rect) {
  // rect: {x, y, width, height} 屏幕逻辑坐标
  closeOverlay();
  if (!rect || rect.width < 4 || rect.height < 4) {
    busy = false;
    return;
  }
  log.info('[screenshot] 选区:', JSON.stringify(rect));
  try {
    resultWin.showLoading(rect.x + rect.width / 2, rect.y + rect.height + 10, 'OCR 识别翻译中...');
    // 截取选区
    const imgBase64 = await captureSelection(rect);
    if (!imgBase64) {
      resultWin.showAt(rect.x, rect.y, { error: true, msg: '截图失败' });
      return;
    }
    log.info('[screenshot] 图片 base64 长度:', imgBase64.length);
    // OCR + 翻译，目标语言为简体中文
    const result = await ai.ocrAndTranslate(imgBase64, { translate: true, targetLang: '简体中文' });
    log.info('[screenshot] AI 返回:', JSON.stringify(result).slice(0, 300));
    if (!result || result.includes('未识别到文字')) {
      resultWin.showAt(rect.x, rect.y + rect.height + 10, { error: true, msg: '未识别到文字' });
      return;
    }
    // 解析 "原文 | 译文" 格式
    const parsed = parseOcrResult(result);
    if (!parsed || !parsed.original) {
      resultWin.showAt(rect.x, rect.y + rect.height + 10, { error: true, msg: '解析结果失败' });
      return;
    }
    const { original, translation } = parsed;
    // 检测：如果译文和原文完全相同，说明翻译失败
    if (translation === original) {
      log.warn('[screenshot] 译文与原文相同，翻译可能失败');
      resultWin.showAt(rect.x, rect.y + rect.height + 10, {
        original,
        translation: '翻译失败：译文与原文相同',
        source: 'screenshot',
        error: true
      });
      return;
    }
    if (!translation) {
      resultWin.showAt(rect.x, rect.y + rect.height + 10, { error: true, msg: '翻译结果为空' });
      return;
    }
    resultWin.showAt(rect.x, rect.y + rect.height + 10, { original, translation, source: 'screenshot' });
  } catch (e) {
    log.error('[screenshot] 翻译失败:', e.message);
    resultWin.showAt(rect.x, rect.y + rect.height + 10, { error: true, msg: e.message });
  } finally {
    busy = false;
  }
}

// 解析 OCR 翻译结果 "原文 | 译文" 格式
function parseOcrResult(result) {
  const lines = result.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  let original = '', translation = '';
  const first = lines[0];
  const sep = first.indexOf(' | ');
  if (sep > 0) {
    original = first.slice(0, sep).trim();
    translation = first.slice(sep + 3).trim();
  } else {
    original = first.replace(/^\s*\|\s*/, '').trim();
    translation = '';
  }
  // 多行合并
  if (lines.length > 1) {
    const origs = [], trans = [];
    for (const l of lines) {
      const s = l.indexOf(' | ');
      if (s > 0) {
        origs.push(l.slice(0, s).trim());
        trans.push(l.slice(s + 3).trim());
      } else {
        origs.push(l.trim());
        trans.push(l.trim());
      }
    }
    original = origs.join('\n');
    translation = trans.join('\n');
  }
  if (!original) return null;
  return { original, translation };
}

async function captureSelection(rect) {
  const display = screen.getDisplayNearestPoint({ x: rect.x, y: rect.y });
  const scale = display.scaleFactor;
  log.info('[screenshot] display:', display.id, 'scale:', scale, 'bounds:', JSON.stringify(display.bounds));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
  });
  const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
  if (!src) {
    log.error('[screenshot] 未找到截图源');
    return null;
  }
  log.info('[screenshot] thumbnail size:', src.thumbnail.getSize());

  const px = Math.round((rect.x - display.bounds.x) * scale);
  const py = Math.round((rect.y - display.bounds.y) * scale);
  const pw = Math.round(rect.width * scale);
  const ph = Math.round(rect.height * scale);
  const cropRect = { x: px, y: py, width: pw, height: ph };
  log.info('[screenshot] crop 参数:', JSON.stringify(cropRect));

  let cropped;
  try {
    cropped = src.thumbnail.crop(cropRect);
  } catch (e) {
    log.error('[screenshot] crop 失败:', e.message, '尝试不缩放的坐标');
    // 降级：不使用 scale，直接用逻辑坐标
    cropped = src.thumbnail.crop({ x: rect.x - display.bounds.x, y: rect.y - display.bounds.y, width: rect.width, height: rect.height });
  }
  return cropped.toPNG().toString('base64');
}

function closeOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy();
  }
  overlayWin = null;
}

module.exports = { init, trigger, closeOverlay };
