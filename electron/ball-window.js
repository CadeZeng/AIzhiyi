// ============================================================
// AI智译 · LOGO 浮窗小球
// 始终置顶的可拖动小球，点击切换翻译总开关
// 位置与开关状态持久化到 userData/ball-state.json
// ============================================================

const { BrowserWindow, screen, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('./logger');

const BALL_SIZE = 48;
let ballWin = null;
let enabled = true;          // 翻译总开关（小球状态）
let mainWindowRef = null;
let stateChangeHandler = null;  // 主进程回调（main.js 注入：控制翻译快捷键等）
let dragInfo = null;            // 拖动起始 { winX, winY, curX, curY }

function stateFilePath() {
  return path.join(app.getPath('userData'), 'ball-state.json');
}

function loadState() {
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj.enabled === 'boolean') enabled = obj.enabled;
    return obj;
  } catch (_) {
    return {};
  }
}

function saveState() {
  try {
    const pos = (ballWin && !ballWin.isDestroyed())
      ? { x: ballWin.getPosition()[0], y: ballWin.getPosition()[1] }
      : {};
    fs.writeFileSync(stateFilePath(), JSON.stringify({ enabled, ...pos }));
  } catch (e) {
    log.warn('[ball] 保存状态失败:', e.message);
  }
}

// 小球页面（data URL，通过 preload 的 ballAPI 通信）
function ballHTML() {
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:48px;height:48px;overflow:hidden;background:transparent;
    user-select:none;-webkit-app-region:no-drag;cursor:default}
  #ball{width:44px;height:44px;margin:2px;border-radius:50%;cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    font-family:"Microsoft YaHei UI",sans-serif;font-size:20px;font-weight:700;color:#fff;
    background:linear-gradient(135deg,#3B82F6,#22D3EE);
    box-shadow:0 4px 14px rgba(59,130,246,0.5),0 0 0 1px rgba(255,255,255,0.12) inset;
    transition:background 0.25s,box-shadow 0.25s,filter 0.25s,transform 0.12s}
  #ball:hover{transform:scale(1.07)}
  #ball:active{transform:scale(0.95)}
  #ball.off{background:linear-gradient(135deg,#4B5563,#374151);
    box-shadow:0 3px 10px rgba(0,0,0,0.4);filter:grayscale(0.55)}
</style>
</head>
<body>
<div id="ball" title="AI智译 · 翻译总开关">译</div>
<script>
  const ball = document.getElementById('ball');
  let down = null, moved = false;
  function setState(v){
    ball.classList.toggle('off', !v);
    ball.title = v ? 'AI智译 · 翻译已开启，点击关闭（可拖动）'
                   : 'AI智译 · 翻译已关闭，点击开启（可拖动）';
  }
  if(window.ballAPI){
    window.ballAPI.onState(setState);
    ball.addEventListener('pointerdown', function(e){
      down = { x: e.screenX, y: e.screenY }; moved = false;
    });
    window.addEventListener('pointermove', function(e){
      if(!down) return;
      if(Math.abs(e.screenX - down.x) > 3 || Math.abs(e.screenY - down.y) > 3){
        moved = true;
        window.ballAPI.dragMove();
      }
    });
    window.addEventListener('pointerup', function(){
      if(!down) return;
      if(moved) window.ballAPI.dragEnd();
      else window.ballAPI.toggle();
      down = null;
    });
  }
</script>
</body>
</html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// 创建小球窗口；onStateChange(enabled) 由 main.js 注入
function create(mainWin, onStateChange) {
  mainWindowRef = mainWin || null;
  stateChangeHandler = onStateChange || null;
  const saved = loadState();

  // 初始位置：默认主屏右侧偏上；有记忆则使用记忆位置
  const primary = screen.getPrimaryDisplay().workArea;
  let x = (typeof saved.x === 'number') ? saved.x : primary.x + primary.width - BALL_SIZE - 24;
  let y = (typeof saved.y === 'number') ? saved.y : primary.y + Math.round(primary.height * 0.35);
  // 边界检查：确保小球落在可见显示器工作区内
  const d = screen.getDisplayMatching({ x, y, width: BALL_SIZE, height: BALL_SIZE });
  const wa = d.workArea;
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - BALL_SIZE);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - BALL_SIZE);

  ballWin = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    x, y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,      // 不抢其他应用焦点
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'ball-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  ballWin.setAlwaysOnTop(true, 'screen-saver');
  ballWin.loadURL(ballHTML());
  ballWin.once('ready-to-show', () => ballWin.showInactive());
  ballWin.on('closed', () => { ballWin = null; });

  // ====== 小球 IPC ======
  ipcMain.on('ball:toggle', () => setEnabled(!enabled));

  ipcMain.on('ball:drag-move', () => {
    if (!ballWin || ballWin.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    if (!dragInfo) {
      const [wx, wy] = ballWin.getPosition();
      dragInfo = { winX: wx, winY: wy, curX: cur.x, curY: cur.y };
    }
    let nx = dragInfo.winX + (cur.x - dragInfo.curX);
    let ny = dragInfo.winY + (cur.y - dragInfo.curY);
    // 限制在显示器工作区内
    const dd = screen.getDisplayMatching({ x: nx, y: ny, width: BALL_SIZE, height: BALL_SIZE });
    const wa = dd.workArea;
    nx = Math.min(Math.max(nx, wa.x), wa.x + wa.width - BALL_SIZE);
    ny = Math.min(Math.max(ny, wa.y), wa.y + wa.height - BALL_SIZE);
    ballWin.setPosition(nx, ny, false);
  });

  ipcMain.on('ball:drag-end', () => {
    dragInfo = null;
    saveState();   // 记忆位置
  });

  // 页面就绪后推送当前状态
  ballWin.webContents.once('did-finish-load', () => pushState());
  log.info('[ball] 小球窗口已创建, 初始状态:', enabled ? '开启' : '关闭');
  return ballWin;
}

// 切换开关：推送小球 UI、通知主窗口渲染进程、触发主进程回调
function setEnabled(v) {
  enabled = !!v;
  saveState();
  pushState();
  if (stateChangeHandler) {
    try { stateChangeHandler(enabled); } catch (e) { log.error('[ball] 状态回调失败:', e.message); }
  }
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('ball:state-changed', enabled);
  }
  log.info('[ball] 翻译总开关:', enabled ? '开启' : '关闭');
}

function pushState() {
  if (ballWin && !ballWin.isDestroyed()) {
    ballWin.webContents.send('ball:state', enabled);
  }
}

function getEnabled() { return enabled; }
function setMainWindow(win) { mainWindowRef = win; }

function destroy() {
  if (ballWin && !ballWin.isDestroyed()) ballWin.destroy();
  ballWin = null;
}

module.exports = { create, setEnabled, getEnabled, setMainWindow, destroy, isEnabled: () => enabled };
