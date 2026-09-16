// ============================================================
// AI智译 · 全局拖动框选取词翻译
//
// 按住配置的修饰键（默认 Alt）进入取词模式：
// 1) WH_KEYBOARD_LL / WH_MOUSE_LL 吞掉修饰键、左键、滚轮等，不转发到底层
// 2) 全屏透明置顶遮罩（WS_EX_NOACTIVATE，不穿透）绘制选框
// 3) 松开修饰键后隐藏遮罩，UIA 只读框选文本，失败则 OCR
// 4) 不用剪贴板 / SendInput / 模拟点击，不改原生选区与焦点
// ============================================================

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const log = require('./logger');
const ai = require('./ai-call');
const resultWin = require('./result-window');
const winHost = require('./win-host');
const pipeline = require('./translate-pipeline');
const { classify } = require('./text-classify');
const capture = require('./screen-capture');
const ocr = require('./ocr/engine');

let overlayWin = null;
let overlayReady = false;
let overlayOrigin = { x: 0, y: 0 };
let enabled = false;
let masterEnabled = true;
let guardOn = false;
let fallbackTimer = null;
let drawTimer = null;
let busy = false;
let lastAbort = null;
let session = null;
let lastFallback = { alt: false, ctrl: false, shift: false, lbutton: false, escape: false };
let subscribed = false;

function cfg() { return ai.getConfig(); }

function dbg(...args) {
  if (cfg().pickDebugLog) log.info('[pick]', ...args);
}

function modifierSpec() {
  const m = String(cfg().hoverModifier || 'alt').toLowerCase();
  if (m === 'ctrl') return { id: 'ctrl', extra: false, label: 'Ctrl' };
  if (m === 'shift') return { id: 'shift', extra: false, label: 'Shift' };
  if (m === 'alt+xbutton1' || m === 'alt-xbutton1') {
    return { id: 'alt+xbutton1', extra: true, label: 'Alt+侧键' };
  }
  if (m === 'alt+xbutton2' || m === 'alt-xbutton2') {
    return { id: 'alt+xbutton2', extra: true, label: 'Alt+侧键' };
  }
  return { id: 'alt', extra: false, label: 'Alt' };
}

function minSize() {
  const n = Number(cfg().pickMinSize);
  return Number.isFinite(n) ? Math.max(8, Math.min(80, n)) : 12;
}

function borderColor() {
  return cfg().pickBorderColor || '#3B82F6';
}

function mapUnit(granularity) {
  const g = granularity || 'auto';
  if (g === 'word' || g === 'phrase' || g === 'sentence' || g === 'paragraph') return g;
  return 'line';
}

function dipRectToPhysical(rect) {
  const p1 = screen.dipToScreenPoint({ x: rect.x, y: rect.y });
  const p2 = screen.dipToScreenPoint({ x: rect.x + rect.width, y: rect.y + rect.height });
  return {
    x: Math.round(p1.x),
    y: Math.round(p1.y),
    width: Math.max(1, Math.round(p2.x - p1.x)),
    height: Math.max(1, Math.round(p2.y - p1.y))
  };
}

function physicalToDip(x, y) {
  try {
    return screen.screenToDipPoint({ x, y });
  } catch (_) {
    return { x, y };
  }
}

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  winHost.onEvent(onHostEvent);
  try {
    screen.on('display-metrics-changed', relayoutOverlay);
    screen.on('display-added', relayoutOverlay);
    screen.on('display-removed', relayoutOverlay);
  } catch (_) {}
}

function screenshotBusy() {
  try {
    const shot = require('./screenshot-translate');
    return typeof shot.isBusy === 'function' && shot.isBusy();
  } catch (_) {
    return false;
  }
}

function newSession() {
  return {
    active: true,
    dragging: false,
    start: null,
    rect: null,
    lastPos: screen.getCursorScreenPoint()
  };
}

function modifierHeldKeys(keys) {
  const id = modifierSpec().id;
  if (id === 'ctrl') return !!keys.ctrl;
  if (id === 'shift') return !!keys.shift;
  return !!keys.alt;
}

function onHostEvent(msg) {
  if (!enabled || !masterEnabled) return;
  const ev = msg && msg.event;
  if (!ev) return;
  if (ev === 'guard-error') {
    log.warn('[pick] 钩子错误:', msg.error || 'unknown');
    return;
  }
  if (ev === 'guard-ready') {
    log.info('[pick] 低级钩子就绪');
    return;
  }
  if (ev === 'pick-start') {
    enterCapture(msg.reason || 'hook');
    return;
  }
  if (ev === 'pick-end') {
    finishCapture('modifier-up');
    return;
  }
  if (ev === 'pick-cancel') {
    cancelCapture(msg.reason || 'cancel');
    return;
  }
  if (ev === 'pick-mouse') {
    onHookMouse(msg);
  }
}

function onHookMouse(msg) {
  if (!session || !session.active) return;
  const dip = physicalToDip(Number(msg.x) || 0, Number(msg.y) || 0);
  session.lastPos = dip;
  if (msg.type === 'down') {
    session.dragging = true;
    session.start = { x: dip.x, y: dip.y };
    session.rect = { x: dip.x, y: dip.y, width: 0, height: 0 };
    pushOverlay();
  } else if (msg.type === 'up') {
    session.dragging = false;
    if (session.start) {
      session.rect = makeRect(session.start, dip);
      pushOverlay();
    }
  }
}

function makeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

function toClientRect(screenRect) {
  if (!screenRect) return null;
  return {
    x: screenRect.x - overlayOrigin.x,
    y: screenRect.y - overlayOrigin.y,
    width: screenRect.width,
    height: screenRect.height
  };
}

function relayoutOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const virt = capture.virtualBounds();
  overlayOrigin = { x: virt.x, y: virt.y };
  overlayWin.setBounds({ x: virt.x, y: virt.y, width: virt.width, height: virt.height });
}

function tipHtml() {
  const label = modifierSpec().label;
  return `<span class="accent">拖动</span>框选要翻译的区域 · 松开 <span class="accent">${label}</span> 翻译 · <span class="accent">Esc</span> 取消`;
}

function pushOverlay() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayReady) return;
  overlayWin.webContents.send('pick:state', {
    color: borderColor(),
    tip: tipHtml(),
    rect: toClientRect(session && session.rect)
  });
}

function ensureOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const virt = capture.virtualBounds();
  overlayOrigin = { x: virt.x, y: virt.y };
  overlayWin = new BrowserWindow({
    x: virt.x,
    y: virt.y,
    width: virt.width,
    height: virt.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    fullscreen: false,
    type: 'toolbar',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'pick-overlay-preload.js')
    }
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(false);
  overlayWin.setMenuBarVisibility(false);
  try { overlayWin.setContentProtection(true); } catch (_) {}
  overlayWin.loadFile(path.join(__dirname, '..', 'pick-overlay.html'));
  overlayWin.webContents.on('did-finish-load', () => {
    overlayReady = true;
    winHost.applyNoActivate(overlayWin);
    pushOverlay();
    log.info('[pick] 遮罩窗口已预创建 showInactive focusable=false 不穿透');
  });
  overlayWin.on('closed', () => {
    overlayWin = null;
    overlayReady = false;
  });
  return overlayWin;
}

function showOverlay() {
  ensureOverlay();
  relayoutOverlay();
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(false);
  overlayWin.showInactive();
  try { overlayWin.moveTop(); } catch (_) {}
  pushOverlay();
}

function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
}

function startDrawLoop() {
  if (drawTimer) return;
  drawTimer = setInterval(() => {
    if (!session || !session.active || !session.dragging || !session.start) return;
    const pos = screen.getCursorScreenPoint();
    session.lastPos = pos;
    session.rect = makeRect(session.start, pos);
    pushOverlay();
  }, 16);
}

function stopDrawLoop() {
  if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
}

function enterCapture(reason) {
  if (!enabled || !masterEnabled) return;
  if (screenshotBusy()) {
    dbg('截图模式占用，忽略取词', reason);
    return;
  }
  if (session && session.active) return;
  session = newSession();
  if (resultWin.isVisible() && !resultWin.isPinned()) resultWin.hide('pick-start');
  showOverlay();
  startDrawLoop();
  log.info('[pick] 进入取词模式 reason=', reason,
    'hook_swallow=true SendInput=not-used clipboard=untouched noactivate=true');
}

function isValidRect(rect) {
  if (!rect) return false;
  const min = minSize();
  return rect.width >= min && rect.height >= min;
}

function cancelCapture(reason) {
  stopDrawLoop();
  hideOverlay();
  session = null;
  log.info('[pick] 已取消 reason=', reason);
}

async function finishCapture(reason) {
  if (!session || !session.active) return;
  const rect = session.rect;
  session.active = false;
  stopDrawLoop();
  hideOverlay();
  session = null;
  if (!isValidRect(rect)) {
    log.info('[pick] 选区无效，不翻译', JSON.stringify(rect), 'reason=', reason);
    return;
  }
  log.info('[pick] 取词结束 reason=', reason, 'DIP', JSON.stringify(rect));
  setTimeout(() => {
    doPickTranslate(rect).catch((e) => log.error('[pick] 翻译异常:', e.message));
  }, 60);
}

async function pickText(rect) {
  const physical = dipRectToPhysical(rect);
  const unit = mapUnit(cfg().hoverGranularity);
  const preferUia = cfg().pickPreferUia !== false;
  dbg('取词 DIP', JSON.stringify(rect), 'physical', JSON.stringify(physical), 'unit', unit);

  if (preferUia) {
    try {
      const uia = await winHost.uiaRect(physical.x, physical.y, physical.width, physical.height, unit);
      const text = String(uia && uia.text || '').trim();
      if (text) {
        log.info('[pick] UIA 命中 source=', uia.source, 'len=', text.length,
          'selection_unchanged=true (Select 未调用)');
        return { text, pickSource: uia.source || 'uia-rect' };
      }
      dbg('UIA 无文本 source=', uia && uia.source);
    } catch (e) {
      log.warn('[pick] UIA 框选失败，转 OCR:', e.message);
    }
  }

  const region = await capture.captureRegion(
    Math.round(rect.x), Math.round(rect.y),
    Math.round(rect.width), Math.round(rect.height)
  );
  if (!region || !region.image) return { text: '', pickSource: 'none' };
  const preferred = cfg().ocrEngine || 'windows';
  let result;
  try {
    result = await ocr.recognizeWithFallback(region.image, preferred === 'vision' ? 'vision' : 'windows');
  } catch (e) {
    log.warn('[pick] OCR 失败:', e.message);
    return { text: '', pickSource: 'ocr-fail', error: e.message };
  }
  const text = String(result.text || '').trim();
  log.info('[pick] OCR engine=', result.engine, 'len=', text.length);
  return { text, pickSource: 'ocr:' + (result.engine || 'unknown') };
}

async function doPickTranslate(rect) {
  if (busy) return;
  busy = true;
  const token = pipeline.nextToken();
  lastAbort = new AbortController();
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height + 8;
  try {
    resultWin.showLoading(cx, cy, '识别翻译中...');
    const picked = await pickText(rect);
    if (!pipeline.isCurrent(token)) return;
    const text = String(picked.text || '').trim();
    if (!text) {
      const msg = picked.error ? picked.error : (picked.pickSource === 'ocr-fail' ? 'OCR 识别失败' : '选区内未识别到文字');
      resultWin.showAt(cx, cy, { error: true, msg, source: 'pick', pickSource: picked.pickSource });
      return;
    }

    const info = classify(text);
    const targetLang = cfg().targetLang || '简体中文';
    log.info('[pick] 原文类型', info.kind, '目标=', targetLang, 'text=', text.slice(0, 80));
    const result = await pipeline.translateSmart(text, {
      token,
      signal: lastAbort.signal,
      targetLang
    });
    if (!pipeline.isCurrent(token) || result.cancelled) return;

    if (result.skipped) {
      resultWin.showAt(cx, cy, {
        original: result.original || text,
        translation: '',
        hint: result.hint || '已跳过翻译',
        detected: result.detected,
        targetLang: result.targetLang || targetLang,
        kind: result.kind,
        kindLabel: result.kindLabel,
        pickSource: picked.pickSource,
        source: 'pick'
      });
      return;
    }
    resultWin.showAt(cx, cy, {
      original: result.original,
      translation: result.translation,
      phonetic: result.phonetic,
      definitions: result.definitions,
      detected: result.detected,
      targetLang: result.targetLang || targetLang,
      kind: result.kind,
      kindLabel: result.kindLabel,
      pickSource: picked.pickSource,
      error: !!result.error,
      hint: result.hint,
      source: 'pick'
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    log.error('[pick] 失败:', e.message);
    resultWin.showAt(cx, cy, { error: true, msg: e.message, source: 'pick' });
  } finally {
    busy = false;
  }
}

function cancelWork() {
  pipeline.cancelPending();
  if (lastAbort) { try { lastAbort.abort(); } catch (_) {} lastAbort = null; }
  busy = false;
}

function startFallbackPoll() {
  if (fallbackTimer) return;
  log.warn('[pick] 低级钩子不可用，回退为按键观察；底层窗口可能仍会收到 Alt');
  fallbackTimer = setInterval(() => {
    if (!enabled || !masterEnabled) return;
    if (screenshotBusy()) return;
    const keys = winHost.getKeys();
    const held = modifierHeldKeys(keys);
    const wasHeld = modifierHeldKeys(lastFallback);

    if (keys.escape && !lastFallback.escape && session && session.active) {
      cancelCapture('esc-fallback');
    }
    if (held && !wasHeld) {
      enterCapture('fallback-modifier');
    }
    if (session && session.active) {
      const pos = screen.getCursorScreenPoint();
      if (keys.lbutton && !lastFallback.lbutton) {
        session.dragging = true;
        session.start = { x: pos.x, y: pos.y };
        session.rect = { x: pos.x, y: pos.y, width: 0, height: 0 };
        pushOverlay();
      }
      if (!keys.lbutton && lastFallback.lbutton && session.dragging) {
        session.dragging = false;
        if (session.start) session.rect = makeRect(session.start, pos);
        pushOverlay();
      }
      if (session.dragging && session.start) {
        session.rect = makeRect(session.start, pos);
        pushOverlay();
      }
    }
    if (!held && wasHeld && session && session.active) {
      finishCapture('fallback-modifier-up');
    }
    lastFallback = {
      alt: !!keys.alt, ctrl: !!keys.ctrl, shift: !!keys.shift,
      lbutton: !!keys.lbutton, escape: !!keys.escape
    };
  }, 30);
}

function stopFallbackPoll() {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}

async function startGuardSafe() {
  try {
    await winHost.ensure();
    await winHost.startGuard({
      modifier: cfg().hoverModifier || 'alt',
      debug: !!cfg().pickDebugLog
    });
    guardOn = true;
    stopFallbackPoll();
    log.info('[pick] 全局钩子已启动 modifier=', cfg().hoverModifier || 'alt');
  } catch (e) {
    guardOn = false;
    log.warn('[pick] 启动钩子失败，使用回退观察:', e.message);
    startFallbackPoll();
  }
}

async function start() {
  ensureSubscribed();
  if (enabled) {
    await startGuardSafe();
    return;
  }
  enabled = true;
  ensureOverlay();
  await startGuardSafe();
  log.info('[pick] 已启用全局拖动取词 modifier=', cfg().hoverModifier || 'alt',
    'preferUia=', cfg().pickPreferUia !== false, 'clipboard_untouched=true');
}

function stop() {
  enabled = false;
  cancelCapture('stop');
  cancelWork();
  stopDrawLoop();
  stopFallbackPoll();
  resultWin.hide('stop');
  if (guardOn) {
    winHost.stopGuard().catch(() => {});
    guardOn = false;
  }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy();
    overlayWin = null;
    overlayReady = false;
  }
  log.info('[pick] 已停止');
}

function setMasterEnabled(v) {
  masterEnabled = !!v;
  if (!masterEnabled) {
    cancelCapture('master-off');
    cancelWork();
    resultWin.hide('master-off');
  }
  log.info('[pick] masterEnabled=', masterEnabled);
}

function setDelay(ms) {
  ai.updateConfig({ hoverDelay: Math.max(100, Math.min(800, ms)) });
}

function applyConfig() {
  if (!enabled) return;
  if (guardOn) {
    winHost.configGuard({
      modifier: cfg().hoverModifier || 'alt',
      debug: !!cfg().pickDebugLog
    }).catch((e) => log.warn('[pick] 更新钩子配置失败:', e.message));
  }
  if (session && session.active) pushOverlay();
}

async function translateAtCursor() {
  const pos = screen.getCursorScreenPoint();
  const W = 260, H = 72;
  const rect = {
    x: Math.round(pos.x - W / 2),
    y: Math.round(pos.y - H / 2),
    width: W,
    height: H
  };
  await doPickTranslate(rect);
}

module.exports = {
  start, stop, setDelay, setMasterEnabled, translateAtCursor, applyConfig,
  isRunning: () => enabled
};
