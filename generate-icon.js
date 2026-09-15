// ============================================================
// AI智译 · 应用图标生成（Node.js 内置 zlib，零依赖）
// 生成多尺寸 PNG（16/32/48/64/128/256）+ 多图像 ICO
// ============================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const buildDir = path.join(__dirname, 'build');
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

const svgPath = path.join(buildDir, 'icon.svg');
const icoPath = path.join(buildDir, 'icon.ico');

// === 1. SVG 源文件 ===
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3B82F6"/>
      <stop offset="100%" stop-color="#22D3EE"/>
    </linearGradient>
    <linearGradient id="highlight" x1="0%" y1="0%" x2="0%" y2="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#bg)"/>
  <rect width="256" height="128" rx="56" fill="url(#highlight)"/>
  <text x="128" y="138" font-family="Microsoft YaHei UI, PingFang SC, sans-serif" font-size="150" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="central">译</text>
</svg>`;
fs.writeFileSync(svgPath, svgContent, 'utf8');
console.log('[1/3] SVG 已生成:', svgPath);

// === 2. 像素绘制（基于 256x256 基准）===
const BASE = 256;
const CORNER_R = 56;

// 基准像素函数（256x256）
function getPixelBase(x, y) {
  // 圆角判断
  let inCorner = false;
  if (x < CORNER_R && y < CORNER_R) {
    const dx = CORNER_R - x, dy = CORNER_R - y;
    if (dx * dx + dy * dy > CORNER_R * CORNER_R) inCorner = true;
  } else if (x >= BASE - CORNER_R && y < CORNER_R) {
    const dx = x - (BASE - CORNER_R - 1), dy = CORNER_R - y;
    if (dx * dx + dy * dy > CORNER_R * CORNER_R) inCorner = true;
  } else if (x < CORNER_R && y >= BASE - CORNER_R) {
    const dx = CORNER_R - x, dy = y - (BASE - CORNER_R - 1);
    if (dx * dx + dy * dy > CORNER_R * CORNER_R) inCorner = true;
  } else if (x >= BASE - CORNER_R && y >= BASE - CORNER_R) {
    const dx = x - (BASE - CORNER_R - 1), dy = y - (BASE - CORNER_R - 1);
    if (dx * dx + dy * dy > CORNER_R * CORNER_R) inCorner = true;
  }
  if (inCorner) return [0, 0, 0, 0];

  // 渐变：左上蓝 → 右下青
  const t = (x / BASE + y / BASE) / 2;
  let r = Math.round(59 + (34 - 59) * t);
  let g = Math.round(130 + (211 - 130) * t);
  let b = Math.round(246 + (238 - 246) * t);
  let a = 255;

  // 顶部高光
  if (y < BASE / 2) {
    const hAlpha = 0.20 * (1 - y / (BASE / 2));
    r = Math.min(255, Math.round(r + (255 - r) * hAlpha));
    g = Math.min(255, Math.round(g + (255 - g) * hAlpha));
    b = Math.min(255, Math.round(b + (255 - b) * hAlpha));
  }

  // 简化"译"字图案（白色十字 + 斜划）
  const cx = BASE / 2, cy = BASE / 2;
  const dx = x - cx, dy = y - cy;
  if (Math.abs(dy) < 8 && Math.abs(dx) < 50) r = g = b = 255;
  else if (Math.abs(dx) < 8 && Math.abs(dy) < 50) r = g = b = 255;
  else if (dx < -8 && dy < -8 && Math.abs(dx + dy) < 6) r = g = b = 255;
  else if (dx > 8 && dy < -8 && Math.abs(dx - dy) < 6) r = g = b = 255;
  else if (dx < -8 && dy > 8 && Math.abs(dx - dy) < 6) r = g = b = 255;
  else if (dx > 8 && dy > 8 && Math.abs(dx + dy) < 6) r = g = b = 255;

  return [r, g, b, a];
}

// 缩放采样：将 256x256 像素采样到目标尺寸
function makePixelFn(targetSize) {
  return (x, y) => {
    const sx = Math.min(BASE - 1, Math.floor(x * BASE / targetSize));
    const sy = Math.min(BASE - 1, Math.floor(y * BASE / targetSize));
    return getPixelBase(sx, sy);
  };
}

// === 3. PNG 构造 ===
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crc ^ buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xEDB88320;
      else crc = crc >>> 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createPNG(width, height, pixelFn) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);
  ihdrData.writeUInt8(0, 10);
  ihdrData.writeUInt8(0, 11);
  ihdrData.writeUInt8(0, 12);

  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const offset = y * rowSize + 1 + x * 4;
      rawData[offset] = r;
      rawData[offset + 1] = g;
      rawData[offset + 2] = b;
      rawData[offset + 3] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawData, { level: 9 });

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crc = crc32(crcInput);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc, 0);
    return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
  }

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', compressedData),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// === 4. 生成多尺寸 PNG ===
const SIZES = [16, 32, 48, 64, 128, 256];
const pngBuffers = {};
const pngPaths = {};

SIZES.forEach(size => {
  const buf = createPNG(size, size, makePixelFn(size));
  const p = path.join(buildDir, `icon-${size}.png`);
  fs.writeFileSync(p, buf);
  pngBuffers[size] = buf;
  pngPaths[size] = p;
});

// 同时写一个 256 的 icon.png 作为通用引用
fs.writeFileSync(path.join(buildDir, 'icon.png'), pngBuffers[256]);

console.log(`[2/3] 多尺寸 PNG 已生成 (${SIZES.join(',')}):`);
SIZES.forEach(s => console.log(`  - ${pngPaths[s]} (${pngBuffers[s].length} bytes)`));

// === 5. 多图像 ICO ===
function createMultiICO(images) {
  const headerSize = 6;
  const dirEntrySize = 16;
  const dataOffset = headerSize + images.length * dirEntrySize;

  // 计算每个图像偏移
  let currentOffset = dataOffset;
  const entries = images.map(img => {
    const entry = { size: img.size, buffer: img.buffer, offset: currentOffset };
    currentOffset += img.buffer.length;
    return entry;
  });

  const totalSize = currentOffset;
  const ico = Buffer.alloc(totalSize);
  let offset = 0;

  // ICO 头
  ico.writeUInt16LE(0, offset); offset += 2;   // 保留
  ico.writeUInt16LE(1, offset); offset += 2;    // 类型：1 = ICO
  ico.writeUInt16LE(images.length, offset); offset += 2;  // 图像数量

  // 目录条目
  for (const e of entries) {
    // 256 在 ICO 字段中用 0 表示
    ico.writeUInt8(e.size >= 256 ? 0 : e.size, offset); offset += 1;  // 宽度
    ico.writeUInt8(e.size >= 256 ? 0 : e.size, offset); offset += 1;  // 高度
    ico.writeUInt8(0, offset); offset += 1;   // 调色板
    ico.writeUInt8(0, offset); offset += 1;   // 保留
    ico.writeUInt16LE(1, offset); offset += 2;   // 色面
    ico.writeUInt16LE(32, offset); offset += 2;    // 位深度
    ico.writeUInt32LE(e.buffer.length, offset); offset += 4;  // 数据大小
    ico.writeUInt32LE(e.offset, offset); offset += 4;        // 偏移
  }

  // 图像数据
  for (const e of entries) {
    e.buffer.copy(ico, e.offset);
  }

  return ico;
}

const imagesArray = SIZES.map(s => ({ size: s, buffer: pngBuffers[s] }));
const icoBuffer = createMultiICO(imagesArray);
fs.writeFileSync(icoPath, icoBuffer);
console.log(`[3/3] 多图像 ICO 已生成 (${SIZES.length} 个尺寸): ${icoPath} (${icoBuffer.length} bytes)`);
console.log('');
console.log('完成。electron-builder 和托盘均可使用 build/icon.ico 和 build/icon-16.png');
