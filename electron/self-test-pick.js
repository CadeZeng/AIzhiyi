// 拖动取词自测：验证遮罩能显示、指针拖动能画出选框
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const log = require('./logger');
const hover = require('./hover-translate');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const report = { ok: false, steps: [] };
  const shotPath = path.join(__dirname, '..', '.self-test-pick.png');
  try {
    await hover.start();
    report.steps.push('start ok');
    hover.debugEnter();
    report.steps.push('enter capture');
    const win = await hover.debugWaitOverlayReady(8000);
    win.show();
    try { win.focus(); } catch (_) {}
    await sleep(300);
    report.visible = !!(win && !win.isDestroyed() && win.isVisible());
    report.ignoreMouse = typeof win.isIgnoreMouseEvents === 'function'
      ? win.isIgnoreMouseEvents()
      : false;
    report.bounds = win.getBounds();

    const drag = await win.webContents.executeJavaScript(`
      (function () {
        function fire(type, x, y, buttons) {
          const ev = new PointerEvent(type, {
            clientX: x,
            clientY: y,
            button: 0,
            buttons: buttons,
            bubbles: true,
            cancelable: true,
            view: window,
            pointerId: 1,
            pointerType: 'mouse'
          });
          document.dispatchEvent(ev);
        }
        fire('pointerdown', 160, 180, 1);
        fire('pointermove', 520, 200, 1);
        fire('pointerup', 520, 200, 0);
        const hls = Array.from(document.querySelectorAll('.hl')).map((el) => ({
          left: el.style.left,
          top: el.style.top,
          width: el.style.width,
          height: el.style.height
        }));
        return {
          count: hls.length,
          highlights: hls,
          firstWidth: hls[0] ? parseFloat(hls[0].width) : 0,
          bodyBg: getComputedStyle(document.body).backgroundColor
        };
      })()
    `);
    report.drag = drag;
    await sleep(200);
    report.session = hover.debugGetSession();

    const img = await win.webContents.capturePage();
    fs.writeFileSync(shotPath, img.toPNG());
    report.shot = shotPath;
    report.shotSize = img.getSize();

    const w = Number(drag && drag.firstWidth) || 0;
    const count = Number(drag && drag.count) || 0;
    report.ok = report.visible && count >= 1 && w >= 200 && report.ignoreMouse === false;
    report.steps.push(report.ok ? 'swipe painted' : 'swipe failed');
  } catch (e) {
    report.error = e.message;
    report.stack = String(e.stack || '').slice(0, 800);
  } finally {
    try { hover.debugCancel(); } catch (_) {}
    try { hover.stop(); } catch (_) {}
  }

  const out = path.join(__dirname, '..', '.self-test-pick.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  log.info('[self-test-pick]', JSON.stringify(report));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

module.exports = { run };
