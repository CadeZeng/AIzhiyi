// ============================================================
// AI智译 · 全局悬停取词翻译
//
// 平台冲突说明：
// 1) 「完全不触发原文任何事件」与「必须把鼠标事件继续传递」冲突。
//    鼠标仍在原应用中移动，WM_MOUSEMOVE / CSS :hover 无法避免。
//    本模块保证：不生成点击、不拖选、不 SetForegroundWindow/SetFocus、
//    不改原生选区、不用剪贴板、不阻断鼠标事件。
// 2) 未安装 WH_MOUSE_LL：Electron 主线程钩子回调会卡鼠标。
//    改为 screen.getCursorScreenPoint 轮询 + GetAsyncKeyState 观察按键，
//    这是纯观察，事件链不被进入、更不可能 CallNextHookEx 返回 1。
// 3) UIA RangeFromPoint 只读；永不调用 Select/SetFocus/Invoke。
// 4) Esc 用 GetAsyncKeyState 观察，不注册全局 Esc（避免抢走原应用 Esc）。
// ============================================================

const { screen } = require('electron');
const log = require('./logger');
const ai = require('./ai-call');
const resultWin = require('./result-window');
const winHost = require('./win-host');
const pipeline = require('./translate-pipeline');
const { classify } = require('./text-classify');
const capture = require('./screen-capture');
const ocr = require('./ocr/engine');

let pollTimer = null;
let lastPos = { x: 0, y: 0 };
let stableSince = 0;
let busy = false;
let enabled = false;
let masterEnabled = true;
let lastText = '';
let lastAbort = null;
let lastDown = { lbutton: false, escape: false };

function cfg() { return ai.getConfig(); }

function start() {
  if (pollTimer) return;
  enabled = true;
  winHost.ensure().catch(e => log.warn('[hover] win-host 启动失败，将仅 OCR:', e.message));
  pollTimer = setInterval(checkHover, 50);
  log.info('[hover] 已启动 observe-only poll=50ms delay=', cfg().hoverDelay,
    'modifier=', cfg().hoverModifier, '不阻断鼠标事件 clipboard_untouched=true');
}

function stop() {
  enabled = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  cancelWork();
  resultWin.hide('stop');
  log.info('[hover] 已停止');
}

function setMasterEnabled(v) {
  masterEnabled = !!v;
  if (!masterEnabled) {
    cancelWork();
    resultWin.hide('master-off');
  }
  log.info('[hover] masterEnabled=', masterEnabled);
}

function setDelay(ms) {
  ai.updateConfig({ hoverDelay: Math.max(100, Math.min(800, ms)) });
}

function cancelWork() {
  pipeline.cancelPending();
  if (lastAbort) { try { lastAbort.abort(); } catch (_) {} lastAbort = null; }
  busy = false;
}

function modifierHeld(keys) {
  const m = cfg().hoverModifier || 'alt';
  if (m === 'none') return true;
  if (m === 'alt') return !!keys.alt;
  if (m === 'ctrl') return !!keys.ctrl;
  if (m === 'shift') return !!keys.shift;
  return true;
}

function mapUnit(granularity, sampleText) {
  const g = granularity || 'auto';
  if (g === 'word' || g === 'phrase' || g === 'sentence' || g === 'paragraph') return g;
  if (sampleText && /[\u4e00-\u9fff]/.test(sampleText) && sampleText.trim().length <= 1) return 'phrase';
  return 'word';
}

async function pickText(pos) {
  const physical = screen.dipToScreenPoint(pos);
  const unit = mapUnit(cfg().hoverGranularity);
  log.info('[hover] 取词 DIP', JSON.stringify(pos), 'physical', JSON.stringify(physical), 'unit', unit,
    'SetForegroundWindow=not-called SetFocus=not-called clipboard=untouched');

  let uia = { text: '', source: 'uia-skip' };
  try {
    uia = await winHost.uiaText(physical.x, physical.y, unit) || uia;
    const t0 = String(uia.text || '').trim();
    if ((cfg().hoverGranularity || 'auto') === 'auto' && t0 && /[\u4e00-\u9fff]/.test(t0) && t0.length <= 1) {
      const more = await winHost.uiaText(physical.x, physical.y, 'phrase');
      if (more && more.text && more.text.trim().length > t0.length) uia = more;
    }
  } catch (e) {
    log.warn('[hover] UIA 失败，转 OCR:', e.message);
  }
  const uiaText = String(uia.text || '').trim();
  if (uiaText) {
    log.info('[hover] UIA 命中 source=', uia.source, 'len=', uiaText.length,
      'selection_unchanged=true (Select 未调用)', 'control=', uia.meta && uia.meta.controlType);
    return { text: uiaText, pickSource: uia.source || 'uia' };
  }

  const W = 260, H = 72;
  const region = await capture.captureRegion(Math.round(pos.x - W / 2), Math.round(pos.y - H / 2), W, H);
  if (!region || !region.image) return { text: '', pickSource: 'none' };
  const preferred = cfg().ocrEngine || 'windows';
  let result;
  try {
    result = await ocr.recognizeWithFallback(region.image, preferred === 'vision' ? 'vision' : 'windows');
  } catch (e) {
    log.warn('[hover] OCR 兜底失败:', e.message);
    return { text: '', pickSource: 'ocr-fail' };
  }
  const scaleX = region.scaleX || region.scale || 1;
  const scaleY = region.scaleY || region.scale || 1;
  const px = (W / 2) * scaleX;
  const py = (H / 2) * scaleY;
  const word = ocr.pickWordAt(result, px, py) || String(result.text || '').split(/\s+/)[0] || '';
  log.info('[hover] OCR 兜底 engine=', result.engine, 'word=', word.slice(0, 40));
  return { text: word, pickSource: 'ocr:' + (result.engine || 'unknown') };
}

async function doHoverTranslate(pos, once) {
  if (busy) return;
  busy = true;
  const token = pipeline.nextToken();
  lastAbort = new AbortController();
  try {
    resultWin.showLoading(pos.x, pos.y, once ? '取词翻译中...' : '识别翻译中...');
    const picked = await pickText(pos);
    if (!pipeline.isCurrent(token)) return;
    const nowPos = screen.getCursorScreenPoint();
    const threshold = Number(cfg().hoverMoveThreshold) || 6;
    if (Math.abs(nowPos.x - pos.x) >= threshold || Math.abs(nowPos.y - pos.y) >= threshold) {
      resultWin.hide('moved-during-pick');
      return;
    }
    const text = String(picked.text || '').trim();
    if (!text) {
      resultWin.hide('empty');
      return;
    }
    if (text === lastText && resultWin.isVisible()) return;

    const info = classify(text);
    log.info('[hover] 原文类型', info.kind, 'text=', text.slice(0, 80));
    const result = await pipeline.translateSmart(text, {
      token,
      signal: lastAbort.signal,
      targetLang: cfg().targetLang
    });
    if (!pipeline.isCurrent(token) || result.cancelled) return;
    lastText = text;

    if (result.skipped) {
      resultWin.showAt(pos.x, pos.y, {
        original: result.original || text,
        translation: '',
        hint: result.hint || '已跳过翻译',
        detected: result.detected,
        targetLang: result.targetLang,
        kind: result.kind,
        kindLabel: result.kindLabel,
        pickSource: picked.pickSource,
        source: 'hover'
      });
      return;
    }
    resultWin.showAt(pos.x, pos.y, {
      original: result.original,
      translation: result.translation,
      phonetic: result.phonetic,
      definitions: result.definitions,
      detected: result.detected,
      targetLang: result.targetLang,
      kind: result.kind,
      kindLabel: result.kindLabel,
      pickSource: picked.pickSource,
      error: !!result.error,
      hint: result.hint,
      source: 'hover'
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    log.error('[hover] 失败:', e.message);
    resultWin.showAt(pos.x, pos.y, { error: true, msg: e.message, source: 'hover' });
  } finally {
    busy = false;
  }
}

function checkHover() {
  if (!enabled || !masterEnabled) return;
  const pos = screen.getCursorScreenPoint();
  const keys = winHost.getKeys();
  const threshold = Number(cfg().hoverMoveThreshold) || 6;

  if (keys.escape && !lastDown.escape && resultWin.isVisible()) {
    resultWin.setPinned(false);
    resultWin.hide('esc-observed');
    log.info('[hover] 观察到 Esc（未拦截，原应用仍会收到）');
  }
  if (keys.lbutton && !lastDown.lbutton) {
    if (resultWin.isVisible() && !resultWin.isPinned() && !resultWin.containsPoint(pos)) {
      resultWin.hide('outside-click-observed');
      log.info('[hover] 观察到外点击（未消费鼠标事件）');
    }
  }
  lastDown = { lbutton: !!keys.lbutton, escape: !!keys.escape };

  if (!modifierHeld(keys)) {
    if (resultWin.isVisible() && !resultWin.isPinned()) resultWin.hide('modifier-up');
    stableSince = Date.now();
    lastPos = pos;
    return;
  }

  const dx = pos.x - lastPos.x;
  const dy = pos.y - lastPos.y;
  if (Math.abs(dx) >= threshold || Math.abs(dy) >= threshold) {
    if (busy) cancelWork();
    if (resultWin.isVisible() && !resultWin.isPinned() && !resultWin.containsPoint(pos)) {
      resultWin.hide('move');
    }
    stableSince = Date.now();
    lastPos = pos;
    lastText = '';
    return;
  }

  if (resultWin.containsPoint(pos) || resultWin.isPinned()) return;
  if (busy) return;
  const delay = Number(cfg().hoverDelay) || 350;
  if (Date.now() - stableSince > delay) {
    stableSince = Number.MAX_SAFE_INTEGER;
    doHoverTranslate(pos, false);
  }
}

async function translateAtCursor() {
  const pos = screen.getCursorScreenPoint();
  lastPos = pos;
  stableSince = Number.MAX_SAFE_INTEGER;
  await doHoverTranslate(pos, true);
}

module.exports = {
  start, stop, setDelay, setMasterEnabled, translateAtCursor,
  isRunning: () => !!pollTimer
};
