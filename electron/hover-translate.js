// ============================================================
// AI智译 · 全局划词取词翻译
//
// 按住配置的修饰键（默认 Alt）进入取词模式：
// 1) WH_KEYBOARD_LL / WH_MOUSE_LL 吞掉修饰键、左键、滚轮等，不转发到底层
// 2) 全屏透明置顶遮罩（WS_EX_NOACTIVATE，不穿透）绘制划词高亮
// 3) 松开修饰键后隐藏遮罩，UIA 按起止点拉取字句，失败则 OCR
// 4) 不用剪贴板 / SendInput / 模拟点击，不改原生选区与焦点
// ============================================================

const { BrowserWindow, screen, ipcMain } = require('electron');
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
let lastPollLbutton = false;

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
  ipcMain.on('pick:drag', onOverlayDrag);
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
    highlights: [],
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
  applyPointer(msg.type, dip);
}

function onOverlayDrag(_e, payload) {
  if (!session || !session.active || !payload) return;
  const toScreen = (pt) => {
    if (!pt) return null;
    return {
      x: overlayOrigin.x + Number(pt.x || 0),
      y: overlayOrigin.y + Number(pt.y || 0)
    };
  };
  if (payload.type === 'down') {
    applyPointer('down', toScreen(payload.start || { x: payload.x, y: payload.y }));
    return;
  }
  const end = toScreen(payload.end);
  if (end) {
    session.lastPos = end;
    if (payload.type === 'up') session.dragging = false;
  }
  if (Array.isArray(payload.highlights) && payload.highlights.length) {
    session.highlights = payload.highlights.map((r) => ({
      x: overlayOrigin.x + Number(r.x || 0),
      y: overlayOrigin.y + Number(r.y || 0),
      width: Number(r.width || 0),
      height: Number(r.height || 0)
    }));
  } else if (session.start && session.lastPos) {
    session.highlights = selectionLikeRects(session.start, session.lastPos);
  }
}

function applyPointer(type, dip) {
  if (!session || !session.active || !dip) return;
  session.lastPos = dip;
  if (type === 'down') {
    session.dragging = true;
    session.start = { x: dip.x, y: dip.y };
    session.highlights = [];
  } else if (type === 'up') {
    session.dragging = false;
  }
  if (session.start && session.lastPos) {
    session.highlights = selectionLikeRects(session.start, session.lastPos);
  }
}

function selectionLikeRects(a, b) {
  const H = 22;
  let x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
  if (y2 < y1 - 2) {
    const tx = x1; x1 = x2; x2 = tx;
    const ty = y1; y1 = y2; y2 = ty;
  }
  if (Math.abs(y2 - y1) < H * 0.65) {
    const x = Math.min(x1, x2);
    return [{ x, y: y1 - H / 2, width: Math.max(8, Math.abs(x2 - x1)), height: H }];
  }
  const virt = capture.virtualBounds();
  const left = virt.x + 24;
  const right = virt.x + virt.width - 24;
  const rects = [];
  rects.push({ x: x1, y: y1 - H / 2, width: Math.max(8, right - x1), height: H });
  let y = y1 + H;
  while (y + H / 2 < y2 - H * 0.4) {
    rects.push({ x: left, y: y - H / 2, width: Math.max(8, right - left), height: H });
    y += H;
  }
  rects.push({ x: left, y: y2 - H / 2, width: Math.max(8, x2 - left), height: H });
  return rects;
}

function unionRect(rects) {
  if (!rects || !rects.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  if (!Number.isFinite(x1)) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function toClientHighlights(rects) {
  return (rects || []).map((r) => ({
    x: r.x - overlayOrigin.x,
    y: r.y - overlayOrigin.y,
    width: r.width,
    height: r.height
  }));
}

function relayoutOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const virt = capture.virtualBounds();
  overlayOrigin = { x: virt.x, y: virt.y };
  overlayWin.setBounds({ x: virt.x, y: virt.y, width: virt.width, height: virt.height });
}

function tipHtml() {
  const label = modifierSpec().label;
  return `<span class="accent">拖动</span>拉取要翻译的字句 · 松开 <span class="accent">${label}</span> 翻译 · <span class="accent">Esc</span> 取消`;
}

function pushOverlay() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayReady) return;
  overlayWin.webContents.send('pick:state', {
    color: borderColor(),
    tip: tipHtml(),
    highlights: toClientHighlights(session && session.highlights)
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
    focusable: true,
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
    log.info('[pick] 遮罩窗口已预创建 showInactive 可命中鼠标 不穿透');
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
  lastPollLbutton = false;
  drawTimer = setInterval(() => {
    if (!session || !session.active) return;
    const pos = screen.getCursorScreenPoint();
    const keys = winHost.getKeys();
    const lbutton = !!keys.lbutton;

    if (lbutton && !lastPollLbutton && !session.dragging) {
      session.dragging = true;
      session.start = { x: pos.x, y: pos.y };
      session.highlights = [];
    }
    if (session.dragging && session.start) {
      session.lastPos = pos;
      session.highlights = selectionLikeRects(session.start, pos);
      pushOverlay();
    }
    if (!lbutton && lastPollLbutton && session.dragging) {
      session.dragging = false;
      if (session.start) session.highlights = selectionLikeRects(session.start, pos);
      pushOverlay();
    }
    lastPollLbutton = lbutton;
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
    'hook_move_pass=true swipe_text=true SendInput=not-used clipboard=untouched noactivate=true');
}

function isValidSwipe(start, end, highlights) {
  if (!start || !end) return false;
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  if (dist >= minSize()) return true;
  return !!(highlights && highlights.some((r) => r && r.width >= minSize()));
}

function dipPointToPhysical(pt) {
  const p = screen.dipToScreenPoint({ x: pt.x, y: pt.y });
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function cancelCapture(reason) {
  stopDrawLoop();
  hideOverlay();
  session = null;
  log.info('[pick] 已取消 reason=', reason);
}

async function finishCapture(reason) {
  if (!session || !session.active) return;
  const start = session.start;
  const end = session.lastPos || session.start;
  const highlights = (session.highlights || []).slice();
  session.active = false;
  stopDrawLoop();
  hideOverlay();
  session = null;
  if (!isValidSwipe(start, end, highlights)) {
    log.info('[pick] 划词无效，不翻译', JSON.stringify({ start, end }), 'reason=', reason);
    return;
  }
  log.info('[pick] 划词结束 reason=', reason, 'start', JSON.stringify(start), 'end', JSON.stringify(end));
  setTimeout(() => {
    doPickTranslate(start, end, highlights).catch((e) => log.error('[pick] 翻译异常:', e.message));
  }, 60);
}

async function pickText(start, end, highlights) {
  const p1 = dipPointToPhysical(start);
  const p2 = dipPointToPhysical(end);
  const unit = mapUnit(cfg().hoverGranularity);
  const preferUia = cfg().pickPreferUia !== false;
  dbg('划词 DIP', JSON.stringify({ start, end }), 'physical', JSON.stringify({ p1, p2 }), 'unit', unit);

  if (preferUia) {
    try {
      const uia = await winHost.uiaRange(p1.x, p1.y, p2.x, p2.y, unit);
      const text = String(uia && uia.text || '').trim();
      if (text) {
        log.info('[pick] UIA 划词命中 source=', uia.source, 'len=', text.length,
          'selection_unchanged=true (Select 未调用)');
        return { text, pickSource: uia.source || 'uia-range', bounds: uia.rects || highlights };
      }
      dbg('UIA 无文本 source=', uia && uia.source);
    } catch (e) {
      log.warn('[pick] UIA 划词失败，转 OCR:', e.message);
    }
  }

  const rect = unionRect(highlights) || {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y) - 12,
    width: Math.max(8, Math.abs(end.x - start.x)),
    height: Math.max(minSize(), Math.abs(end.y - start.y) + 24)
  };
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

async function doPickTranslate(start, end, highlights) {
  if (busy) return;
  busy = true;
  const token = pipeline.nextToken();
  lastAbort = new AbortController();
  const union = unionRect(highlights);
  const cx = end ? end.x : (union ? union.x + union.width / 2 : start.x);
  const cy = union ? union.y + union.height + 8 : (end ? end.y + 16 : start.y + 16);
  try {
    resultWin.showLoading(cx, cy, '识别翻译中...');
    const picked = await pickText(start, end, highlights);
    if (!pipeline.isCurrent(token)) return;
    const text = String(picked.text || '').trim();
    if (!text) {
      const msg = picked.error ? picked.error : (picked.pickSource === 'ocr-fail' ? 'OCR 识别失败' : '未拉取到文字');
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
        session.highlights = [];
        pushOverlay();
      }
      if (!keys.lbutton && lastFallback.lbutton && session.dragging) {
        session.dragging = false;
        if (session.start) session.highlights = selectionLikeRects(session.start, pos);
        pushOverlay();
      }
      if (session.dragging && session.start) {
        session.highlights = selectionLikeRects(session.start, pos);
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
  log.info('[pick] 已启用全局划词取词 modifier=', cfg().hoverModifier || 'alt',
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
  const start = { x: pos.x - 40, y: pos.y };
  const end = { x: pos.x + 40, y: pos.y };
  await doPickTranslate(start, end, selectionLikeRects(start, end));
}

function debugWaitOverlayReady(timeoutMs = 5000) {
  ensureOverlay();
  if (overlayReady && overlayWin && !overlayWin.isDestroyed()) {
    return Promise.resolve(overlayWin);
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('overlay ready timeout')), timeoutMs);
    const check = () => {
      if (overlayReady && overlayWin && !overlayWin.isDestroyed()) {
        clearTimeout(t);
        resolve(overlayWin);
      }
    };
    const timer = setInterval(() => {
      check();
      if (overlayReady) clearInterval(timer);
    }, 50);
  });
}

module.exports = {
  start, stop, setDelay, setMasterEnabled, translateAtCursor, applyConfig,
  isRunning: () => enabled,
  debugEnter: () => enterCapture('self-test'),
  debugCancel: () => cancelCapture('self-test'),
  debugGetOverlay: () => overlayWin,
  debugGetSession: () => session ? { active: session.active, dragging: session.dragging, highlights: session.highlights } : null,
  debugWaitOverlayReady
};
