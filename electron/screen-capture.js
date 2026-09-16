// ============================================================
// AI智译 · 屏幕截取（多屏 / 高 DPI）
// 坐标：Electron DIP；截图像素：物理像素
// ============================================================

const { screen, desktopCapturer } = require('electron');
const log = require('./logger');

function virtualBounds() {
  const displays = screen.getAllDisplays();
  let x = Infinity, y = Infinity, r = -Infinity, b = -Infinity;
  for (const d of displays) {
    x = Math.min(x, d.bounds.x);
    y = Math.min(y, d.bounds.y);
    r = Math.max(r, d.bounds.x + d.bounds.width);
    b = Math.max(b, d.bounds.y + d.bounds.height);
  }
  return { x, y, width: r - x, height: b - y };
}

function physicalRectForDisplay(display) {
  const scale = display.scaleFactor || 1;
  return {
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale)
  };
}

async function captureDisplay(display) {
  const phys = physicalRectForDisplay(display);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: phys.width, height: phys.height }
  });
  let src = sources.find(s => s.display_id && s.display_id === String(display.id));
  if (!src) {
    src = sources.find(s => {
      const sz = s.thumbnail.getSize();
      return Math.abs(sz.width - phys.width) < 8 && Math.abs(sz.height - phys.height) < 8;
    }) || sources[0];
  }
  if (!src) return null;
  const thumb = src.thumbnail;
  const sz = thumb.getSize();
  return {
    displayId: display.id,
    scale: sz.width / display.bounds.width,
    scaleX: sz.width / display.bounds.width,
    scaleY: sz.height / display.bounds.height,
    bounds: { ...display.bounds },
    image: thumb,
    dataUrl: null
  };
}

async function captureAllDisplays() {
  const displays = screen.getAllDisplays();
  const maxW = Math.max(...displays.map(d => physicalRectForDisplay(d).width));
  const maxH = Math.max(...displays.map(d => physicalRectForDisplay(d).height));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH }
  });
  const frames = [];
  for (const display of displays) {
    const phys = physicalRectForDisplay(display);
    let src = sources.find(s => s.display_id && s.display_id === String(display.id));
    if (!src) {
      src = sources.find(s => {
        const sz = s.thumbnail.getSize();
        return Math.abs(sz.width - phys.width) < 8 && Math.abs(sz.height - phys.height) < 8;
      }) || (displays.length === 1 ? sources[0] : null);
    }
    if (!src) continue;
    const thumb = src.thumbnail;
    const sz = thumb.getSize();
    const scaleX = sz.width / display.bounds.width;
    const scaleY = sz.height / display.bounds.height;
    log.info('[screen-capture] display', display.id, 'scale', display.scaleFactor,
      'bounds', JSON.stringify(display.bounds), 'thumb', JSON.stringify(sz), 'pxPerDip', scaleX.toFixed(3));
    frames.push({
      displayId: display.id,
      scale: scaleX,
      scaleX,
      scaleY,
      bounds: { ...display.bounds },
      image: thumb,
      dataUrl: thumb.toDataURL()
    });
  }
  return frames;
}

function cropFromFrames(frames, dipRect) {
  const cx = dipRect.x + dipRect.width / 2;
  const cy = dipRect.y + dipRect.height / 2;
  const frame = frames.find(f => {
    const b = f.bounds;
    return cx >= b.x && cy >= b.y && cx < b.x + b.width && cy < b.y + b.height;
  }) || frames[0];
  if (!frame) return null;
  const scaleX = frame.scaleX || frame.scale;
  const scaleY = frame.scaleY || frame.scale;
  const b = frame.bounds;
  const sz = frame.image.getSize();
  const px = Math.round((dipRect.x - b.x) * scaleX);
  const py = Math.round((dipRect.y - b.y) * scaleY);
  const pw = Math.round(dipRect.width * scaleX);
  const ph = Math.round(dipRect.height * scaleY);
  const x = Math.max(0, Math.min(px, sz.width - 1));
  const y = Math.max(0, Math.min(py, sz.height - 1));
  const w = Math.max(1, Math.min(pw, sz.width - x));
  const h = Math.max(1, Math.min(ph, sz.height - y));
  try {
    const cropped = frame.image.crop({ x, y, width: w, height: h });
    return { image: cropped, scale: scaleX, scaleX, scaleY, frame, cropPx: { x, y, width: w, height: h } };
  } catch (e) {
    log.error('[screen-capture] crop 失败:', e.message);
    return null;
  }
}

async function captureRegion(x, y, w, h) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const frame = await captureDisplay(display);
  if (!frame) return null;
  const cropped = cropFromFrames([frame], { x, y, width: w, height: h });
  if (!cropped) return null;
  return {
    base64: cropped.image.toPNG().toString('base64'),
    image: cropped.image,
    scale: cropped.scale,
    scaleX: cropped.scaleX,
    scaleY: cropped.scaleY
  };
}

function sampleColors(nativeImage, bbox, scale) {
  try {
    const { width, height } = nativeImage.getSize();
    const buf = nativeImage.getBitmap();
    const pts = [
      [bbox.x + 2, bbox.y + 2],
      [bbox.x + bbox.width - 2, bbox.y + 2],
      [bbox.x + 2, bbox.y + bbox.height - 2],
      [bbox.x + bbox.width / 2, bbox.y + bbox.height / 2]
    ];
    let r = 0, g = 0, b = 0, n = 0;
    for (const [px, py] of pts) {
      const x = Math.max(0, Math.min(width - 1, Math.round(px)));
      const y = Math.max(0, Math.min(height - 1, Math.round(py)));
      const i = (y * width + x) * 4;
      b += buf[i]; g += buf[i + 1]; r += buf[i + 2];
      n++;
    }
    if (!n) return { background: '#1f2937', color: '#f9fafb' };
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return {
      background: `rgb(${r},${g},${b})`,
      color: lum > 150 ? '#111827' : '#F9FAFB',
      luminance: lum
    };
  } catch (_) {
    return { background: '#111827', color: '#F9FAFB' };
  }
}

module.exports = {
  virtualBounds, captureAllDisplays, cropFromFrames, captureRegion, sampleColors
};
