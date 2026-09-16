// ============================================================
// AI智译 · OCR 引擎接口（可替换）
// 统一返回: { engine, language, text, lines:[{text,bbox,confidence,words}] }
// bbox 为图像物理像素坐标
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../logger');
const winHost = require('../win-host');
const ai = require('../ai-call');

class OcrEngine {
  constructor() {
    this.name = 'base';
  }
  async recognize(_image, _opts) {
    throw new Error('OCR engine not implemented');
  }
}

function sortAndFilter(result, minSize = 2) {
  if (!result || !Array.isArray(result.lines)) return result;
  const lines = result.lines
    .map(l => {
      if (!l) return l;
      if (!Array.isArray(l.words)) l.words = l.words ? [l.words] : [];
      return l;
    })
    .filter(l => l && String(l.text || '').trim() && l.bbox && l.bbox.width >= minSize && l.bbox.height >= minSize)
    .sort((a, b) => (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x));
  for (const line of lines) {
    if (Array.isArray(line.words)) {
      line.words = line.words
        .filter(w => w && String(w.text || '').trim())
        .sort((a, b) => (a.bbox.x - b.bbox.x));
    }
  }
  result.lines = lines;
  result.text = lines.map(l => l.text).join('\n');
  return result;
}

function pickWordAt(result, px, py) {
  if (!result || !result.lines) return '';
  let best = '', bestDist = Infinity;
  for (const line of result.lines) {
    const words = line.words && line.words.length ? line.words : [line];
    for (const w of words) {
      const b = w.bbox;
      if (!b) continue;
      if (px >= b.x && py >= b.y && px <= b.x + b.width && py <= b.y + b.height) {
        return String(w.text || '').trim();
      }
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const d = (cx - px) ** 2 + (cy - py) ** 2;
      if (d < bestDist) { bestDist = d; best = String(w.text || '').trim(); }
    }
  }
  return best;
}

class WindowsOcrEngine extends OcrEngine {
  constructor() {
    super();
    this.name = 'windows';
  }
  async recognize(image, _opts = {}) {
    const png = Buffer.isBuffer(image) ? image : image.toPNG();
    const file = path.join(os.tmpdir(), `aizhiyi-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    fs.writeFileSync(file, png);
    try {
      const raw = await winHost.ocrFile(file);
      const lines = Array.isArray(raw.lines) ? raw.lines : (raw.lines ? [raw.lines] : []);
      const normalized = {
        engine: 'windows',
        language: raw.language || '',
        text: raw.text || '',
        lines
      };
      return sortAndFilter(normalized);
    } finally {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
}

class VisionOcrEngine extends OcrEngine {
  constructor() {
    super();
    this.name = 'vision';
  }
  async recognize(image, opts = {}) {
    const base64 = Buffer.isBuffer(image) ? image.toString('base64') : image.toPNG().toString('base64');
    const text = await ai.ocrOnly(base64);
    const lines = String(text || '').split(/\n/).map((t, i) => ({
      text: t.trim(),
      bbox: { x: 0, y: i * 22, width: 400, height: 20 },
      confidence: 1,
      words: []
    })).filter(l => l.text);
    return sortAndFilter({
      engine: 'vision',
      language: opts.language || '',
      text: lines.map(l => l.text).join('\n'),
      lines,
      hasGeometry: false
    });
  }
}

const registry = {
  windows: new WindowsOcrEngine(),
  vision: new VisionOcrEngine()
};

function getEngine(name) {
  return registry[name] || registry.windows;
}

async function recognizeWithFallback(image, preferred = 'windows') {
  const order = preferred === 'vision' ? ['vision'] : ['windows', 'vision'];
  let lastErr = null;
  for (const name of order) {
    try {
      log.info('[ocr] 使用引擎', name);
      const result = await getEngine(name).recognize(image);
      if (result && (result.text || (result.lines && result.lines.length))) return result;
      lastErr = new Error(name + ' 未识别到文字');
    } catch (e) {
      log.warn('[ocr] 引擎失败', name, e.message);
      lastErr = e;
    }
  }
  throw lastErr || new Error('OCR 失败');
}

module.exports = {
  OcrEngine, WindowsOcrEngine, VisionOcrEngine,
  getEngine, recognizeWithFallback, pickWordAt, sortAndFilter, registry
};
