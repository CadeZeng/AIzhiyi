// ============================================================
// AI智译 · 截图 OCR 原位替换翻译
// Alt+Q → 冻结全屏 → 框选 → OCR(bbox) → 按行翻译 → 覆盖层固定在截图位置
// 覆盖层不修改原应用内容，不抢焦点
// ============================================================

const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const log = require('./logger');
const ai = require('./ai-call');
const resultWin = require('./result-window');
const winHost = require('./win-host');
const captureUtil = require('./screen-capture');
const ocr = require('./ocr/engine');
const pipeline = require('./translate-pipeline');

const TOOLBAR_H = 32;
let overlayWin = null;
let inplaceWin = null;
let busy = false;
let freezeFrames = null;
let overlayOrigin = { x: 0, y: 0 };
let lastSession = null;
let inplacePassTimer = null;
let lastDown = { lbutton: false, escape: false };

function cfg() { return ai.getConfig(); }

function toDipBoxes(items, image, scaleX, scaleY) {
  return items.map(line => {
    const colors = captureUtil.sampleColors(image, line.bbox);
    return {
      original: line.text,
      translation: line.translation || line.text,
      skipped: !!line.skipped,
      bbox: {
        x: line.bbox.x / scaleX,
        y: line.bbox.y / scaleY,
        width: line.bbox.width / scaleX,
        height: line.bbox.height / scaleY
      },
      background: colors.background,
      color: colors.color
    };
  });
}

function init() {
  ipcMain.handle('screenshot:select', (_e, rect) => onSelection(rect));
  ipcMain.on('screenshot:cancel', () => {
    closeOverlay();
    busy = false;
    log.info('[screenshot] 用户取消框选');
  });
  ipcMain.on('inplace:close', () => closeInplace('ipc'));
  ipcMain.on('inplace:copy', () => copyTranslations());
  ipcMain.on('inplace:toggle', () => {});
  ipcMain.on('inplace:retry', () => retryLast());
}

async function trigger() {
  log.info('[screenshot] trigger busy=', busy, 'overlay=', !!overlayWin);
  if (busy || overlayWin) return;
  busy = true;
  closeInplace('new-shot');
  try {
    freezeFrames = await captureUtil.captureAllDisplays();
    const virt = captureUtil.virtualBounds();
    overlayOrigin = { x: virt.x, y: virt.y };
    log.info('[screenshot] 已冻结屏幕 displays=', freezeFrames.length, 'virtual=', JSON.stringify(virt));

    overlayWin = new BrowserWindow({
      x: virt.x,
      y: virt.y,
      width: virt.width,
      height: virt.height,
      fullscreen: false,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
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
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.loadFile(path.join(__dirname, '..', 'overlay.html'));
    overlayWin.webContents.on('console-message', (_e, _level, message) => {
      log.info('[overlay-console]', message);
    });
    overlayWin.webContents.on('did-finish-load', () => {
      overlayWin.webContents.send('overlay:init', {
        origin: overlayOrigin,
        screens: freezeFrames.map(f => ({
          bounds: f.bounds,
          dataUrl: f.dataUrl
        }))
      });
      overlayWin.show();
      overlayWin.focus();
      log.info('[screenshot] 进入框选模式（此阶段会暂时捕获鼠标，属用户主动操作）');
    });
    overlayWin.webContents.on('render-process-gone', (_e, details) => {
      log.error('[screenshot] overlay 渲染进程崩溃:', details.reason);
      busy = false;
    });
    overlayWin.on('closed', () => { overlayWin = null; });
  } catch (e) {
    log.error('[screenshot] 启动失败:', e.message);
    busy = false;
  }
}

function toScreenRect(clientRect) {
  const ob = overlayWin && !overlayWin.isDestroyed() ? overlayWin.getBounds() : overlayOrigin;
  return {
    x: Math.round((ob.x || overlayOrigin.x) + clientRect.x),
    y: Math.round((ob.y || overlayOrigin.y) + clientRect.y),
    width: Math.round(clientRect.width),
    height: Math.round(clientRect.height)
  };
}

async function onSelection(clientRect) {
  const screenRect = toScreenRect(clientRect || {});
  closeOverlay();
  if (!screenRect || screenRect.width < 4 || screenRect.height < 4) {
    busy = false;
    freezeFrames = null;
    return;
  }
  log.info('[screenshot] 选区 DIP', JSON.stringify(screenRect));
  try {
    await runOcrTranslate(screenRect);
  } finally {
    busy = false;
  }
}

async function runOcrTranslate(screenRect) {
  resultWin.showLoading(screenRect.x + screenRect.width / 2, screenRect.y + screenRect.height + 8, 'OCR 识别翻译中...');
  const cropped = freezeFrames
    ? captureUtil.cropFromFrames(freezeFrames, screenRect)
    : null;
  freezeFrames = null;
  if (!cropped || !cropped.image) {
    resultWin.showAt(screenRect.x, screenRect.y, { error: true, msg: '截图失败' });
    return;
  }

  const preferred = cfg().ocrEngine || 'windows';
  let ocrResult;
  try {
    ocrResult = await ocr.recognizeWithFallback(cropped.image, preferred);
  } catch (e) {
    resultWin.showAt(screenRect.x, screenRect.y, { error: true, msg: e.message });
    return;
  }
  if (!ocrResult.lines || !ocrResult.lines.length) {
    resultWin.showAt(screenRect.x, screenRect.y, { error: true, msg: '未识别到文字' });
    return;
  }

  if (ocrResult.hasGeometry === false) {
    const text = ocrResult.text;
    const result = await pipeline.translateSmart(text, { targetLang: cfg().targetLang });
    resultWin.showAt(screenRect.x, screenRect.y + screenRect.height + 8, {
      original: result.original || text,
      translation: result.translation || '',
      hint: result.hint,
      detected: result.detected,
      targetLang: result.targetLang,
      kindLabel: result.kindLabel,
      error: !!result.error,
      msg: result.cancelled ? '已取消' : (result.hint || ''),
      source: 'screenshot'
    });
    return;
  }

  const scaleX = cropped.scaleX || cropped.scale || 1;
  const scaleY = cropped.scaleY || cropped.scale || 1;
  const token = pipeline.nextToken();
  const translated = await pipeline.translateLines(ocrResult.lines, {
    token,
    targetLang: cfg().targetLang
  });
  if (translated.cancelled) {
    resultWin.hide('cancelled');
    return;
  }
  const lines = toDipBoxes(translated.items || [], cropped.image, scaleX, scaleY);

  lastSession = {
    screenRect,
    ocrLines: ocrResult.lines,
    scaleX,
    scaleY,
    image: cropped.image,
    lines,
    targetLang: cfg().targetLang,
    detected: translated.detected
  };
  resultWin.hide('inplace');
  showInplace(screenRect, lines);
  resultWin.notifyHistory({
    source: 'screenshot',
    original: (ocrResult.lines || []).map((l) => l.text).join('\n'),
    translation: (lines || []).map((l) => l.translation || '').filter(Boolean).join('\n')
  });
}

function showInplace(screenRect, lines) {
  closeInplace('replace');
  const x = Math.round(screenRect.x);
  const y = Math.round(screenRect.y - TOOLBAR_H);
  const width = Math.max(120, Math.round(screenRect.width));
  const height = Math.round(screenRect.height) + TOOLBAR_H;

  inplaceWin = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    type: 'toolbar',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'inplace-preload.js')
    }
  });
  inplaceWin.setAlwaysOnTop(true, 'screen-saver');
  inplaceWin.setIgnoreMouseEvents(true, { forward: true });
  inplaceWin.loadFile(path.join(__dirname, '..', 'inplace.html'));
  inplaceWin.webContents.on('did-finish-load', () => {
    winHost.applyNoActivate(inplaceWin);
    inplaceWin.webContents.send('inplace:show', { lines, targetLang: cfg().targetLang });
    inplaceWin.showInactive();
    log.info('[screenshot] 原位覆盖层已显示 showInactive focusable=false 固定于截图位置',
      JSON.stringify({ x, y, width, height }), 'lines=', lines.length);
  });
  startInplaceWatch();
}

function startInplaceWatch() {
  if (inplacePassTimer) clearInterval(inplacePassTimer);
  inplacePassTimer = setInterval(() => {
    if (!inplaceWin || inplaceWin.isDestroyed() || !inplaceWin.isVisible()) return;
    const pos = screen.getCursorScreenPoint();
    const b = inplaceWin.getBounds();
    const overHeader = pos.x >= b.x && pos.x <= b.x + b.width && pos.y >= b.y && pos.y <= b.y + TOOLBAR_H;
    inplaceWin.setIgnoreMouseEvents(!overHeader, { forward: true });

    const keys = winHost.getKeys();
    if (keys.escape && !lastDown.escape) {
      closeInplace('esc-observed');
      log.info('[screenshot] 观察到 Esc，关闭覆盖层（未拦截键盘）');
    }
    if (keys.lbutton && !lastDown.lbutton) {
      const inside = pos.x >= b.x && pos.x <= b.x + b.width && pos.y >= b.y && pos.y <= b.y + b.height;
      if (!inside) {
        closeInplace('outside-click-observed');
        log.info('[screenshot] 观察到外部点击，关闭覆盖层（未消费鼠标事件）');
      }
    }
    lastDown = { lbutton: !!keys.lbutton, escape: !!keys.escape };
  }, 70);
}

function copyTranslations() {
  if (!lastSession) return;
  const { clipboard } = require('electron');
  const text = lastSession.lines.map(l => l.translation).join('\n');
  clipboard.writeText(text);
  log.info('[screenshot] 已复制译文，未改变原应用焦点');
}

async function retryLast() {
  if (!lastSession || !lastSession.ocrLines || !lastSession.image) {
    if (lastSession && lastSession.screenRect) {
      resultWin.showAt(lastSession.screenRect.x, lastSession.screenRect.y, { error: true, msg: '请重新 Alt+Q 截图后再试' });
    }
    return;
  }
  const { screenRect, ocrLines, scaleX, scaleY, image } = lastSession;
  const token = pipeline.nextToken();
  try {
    const translated = await pipeline.translateLines(ocrLines, { token, targetLang: cfg().targetLang });
    if (translated.cancelled) return;
    const lines = toDipBoxes(translated.items || [], image, scaleX || 1, scaleY || 1);
    lastSession.lines = lines;
    if (inplaceWin && !inplaceWin.isDestroyed()) {
      inplaceWin.webContents.send('inplace:show', { lines, targetLang: cfg().targetLang });
    } else {
      showInplace(screenRect, lines);
    }
  } catch (e) {
    resultWin.showAt(screenRect.x, screenRect.y, { error: true, msg: e.message });
  }
}

function closeOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  overlayWin = null;
}

function closeInplace(reason) {
  if (inplacePassTimer) { clearInterval(inplacePassTimer); inplacePassTimer = null; }
  if (inplaceWin && !inplaceWin.isDestroyed()) inplaceWin.destroy();
  inplaceWin = null;
  if (reason) log.info('[screenshot] 原位覆盖层关闭 reason=', reason, '原界面恢复（仅移除覆盖，未改原应用）');
}

function destroy() {
  closeOverlay();
  closeInplace('destroy');
  freezeFrames = null;
  lastSession = null;
  busy = false;
}

function isBusy() {
  return busy || !!(overlayWin && !overlayWin.isDestroyed());
}

module.exports = { init, trigger, closeOverlay, closeInplace, destroy, isBusy };
