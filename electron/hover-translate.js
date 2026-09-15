// ============================================================
// AI智译 · 悬停取词翻译
// 轮询光标位置，停留 300ms 后截图 OCR + 翻译，浮动窗展示
// 基于 VibeLens 方案：取词优先、OCR 兜底
// ============================================================

const { screen, desktopCapturer } = require('electron');
const log = require('./logger');
const ai = require('./ai-call');
const resultWin = require('./result-window');

let pollTimer = null;
let lastPos = { x: 0, y: 0 };
let stableSince = 0;
let busy = false;
let enabled = false;
let hoverDelay = 300;
let lastTranslatedText = '';

function start() {
  if (pollTimer) return;
  enabled = true;
  pollTimer = setInterval(checkHover, 60);
  log.info('[hover-translate] 已启动，延迟', hoverDelay, 'ms');
}

function stop() {
  enabled = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  resultWin.hide();
  log.info('[hover-translate] 已停止');
}

function setDelay(ms) {
  hoverDelay = Math.max(100, Math.min(800, ms));
}

function checkHover() {
  if (!enabled || busy) return;
  const pos = screen.getCursorScreenPoint();
  const dx = pos.x - lastPos.x;
  const dy = pos.y - lastPos.y;
  if (Math.abs(dx) < 4 && Math.abs(dy) < 4) {
    // 鼠标稳定
    if (Date.now() - stableSince > hoverDelay) {
      // 触发取词，设置 stableSince 为未来时间避免重复触发
      stableSince = Number.MAX_SAFE_INTEGER;
      doHoverTranslate(pos);
    }
  } else {
    stableSince = Date.now();
    lastPos = pos;
    resultWin.hide();
  }
}

async function doHoverTranslate(pos) {
  busy = true;
  try {
    resultWin.showLoading(pos.x, pos.y, '识别翻译中...');
    // 截取光标周围区域 (200x64)
    const W = 200, H = 64;
    const imgBase64 = await captureRegion(
      Math.round(pos.x - W / 2),
      Math.round(pos.y - H / 2),
      W, H
    );
    if (!imgBase64) {
      resultWin.hide();
      return;
    }
    // 调用视觉模型 OCR + 翻译，目标语言为简体中文
    const result = await ai.ocrAndTranslate(imgBase64, { translate: true, targetLang: '简体中文' });
    log.info('[hover] AI 返回:', JSON.stringify(result).slice(0, 300));
    if (!result || result.includes('未识别到文字')) {
      resultWin.hide();
      return;
    }
    // 解析 "原文 | 译文" 格式
    const parsed = parseOcrResult(result);
    if (!parsed) {
      resultWin.hide();
      return;
    }
    const { original, translation } = parsed;
    // 检测：如果译文和原文完全相同，说明翻译失败
    if (translation === original) {
      log.warn('[hover] 译文与原文相同，翻译可能失败');
      resultWin.showAt(pos.x, pos.y, {
        original,
        translation: '翻译失败：译文与原文相同',
        source: 'hover',
        error: true
      });
      return;
    }
    if (translation && translation !== lastTranslatedText) {
      lastTranslatedText = translation;
      resultWin.showAt(pos.x, pos.y, { original, translation, source: 'hover' });
    } else if (translation) {
      // 相同内容，保持显示
    } else {
      resultWin.hide();
    }
  } catch (e) {
    log.error('[hover-translate] 失败:', e.message);
    resultWin.showAt(pos.x, pos.y, { error: true, msg: e.message });
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
    // 没有分隔符或分隔符在开头，去除可能的开头分隔符
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

// 截取指定屏幕区域，返回 base64（无前缀）
async function captureRegion(x, y, w, h) {
  try {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const display = screen.getDisplayNearestPoint({ x, y });
    const scale = display.scaleFactor;
    const px = Math.round((x - display.bounds.x) * scale);
    const py = Math.round((y - display.bounds.y) * scale);
    const pw = Math.round(w * scale);
    const ph = Math.round(h * scale);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
    });
    const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (!src) return null;

    const thumbSize = src.thumbnail.getSize();

    let cropped;
    try {
      cropped = src.thumbnail.crop({ x: px, y: py, width: pw, height: ph });
    } catch (e1) {
      log.warn('[hover] crop 失败（scale 坐标）:', e1.message);
      try {
        // 降级：逻辑坐标
        const lx = Math.round(x - display.bounds.x);
        const ly = Math.round(y - display.bounds.y);
        cropped = src.thumbnail.crop({ x: lx, y: ly, width: w, height: h });
      } catch (e2) {
        log.error('[hover] crop 降级也失败:', e2.message);
        // 最终降级：返回整个 thumbnail
        log.warn('[hover] 返回整个 thumbnail');
        return src.thumbnail.toPNG().toString('base64');
      }
    }
    return cropped.toPNG().toString('base64');
  } catch (e) {
    log.error('[hover-translate] 截图失败:', e.message);
    return null;
  }
}

// 单次 OCR 取词（由全局快捷键 Ctrl+Shift+J 触发，用于外部应用取词）
async function translateAtCursor() {
  if (busy) return;
  busy = true;
  try {
    const pos = screen.getCursorScreenPoint();
    resultWin.showLoading(pos.x, pos.y, 'OCR 识别翻译中...');
    const W = 200, H = 64;
    const imgBase64 = await captureRegion(
      Math.round(pos.x - W / 2),
      Math.round(pos.y - H / 2),
      W, H
    );
    if (!imgBase64) {
      resultWin.hide();
      return;
    }
    const result = await ai.ocrAndTranslate(imgBase64, { translate: true, targetLang: '简体中文' });
    log.info('[hover] OCR AI 返回:', JSON.stringify(result).slice(0, 300));
    if (!result || result.includes('未识别到文字')) {
      resultWin.showAt(pos.x, pos.y, { error: true, msg: '未识别到文字' });
      return;
    }
    const parsed = parseOcrResult(result);
    if (!parsed) {
      resultWin.hide();
      return;
    }
    const { original, translation } = parsed;
    if (translation === original) {
      resultWin.showAt(pos.x, pos.y, {
        original,
        translation: '翻译失败：译文与原文相同',
        source: 'hover',
        error: true
      });
      return;
    }
    if (translation) {
      resultWin.showAt(pos.x, pos.y, { original, translation, source: 'hover' });
    } else {
      resultWin.hide();
    }
  } catch (e) {
    log.error('[hover-translate] 单次取词失败:', e.message);
    resultWin.showAt(pos.x, pos.y, { error: true, msg: e.message });
  } finally {
    busy = false;
  }
}

module.exports = { start, stop, setDelay, isRunning: () => !!pollTimer, translateAtCursor };
