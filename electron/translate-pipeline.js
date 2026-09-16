// ============================================================
// AI智译 · 翻译管线
// 异步 / 防抖取消 / LRU 缓存 / 失败重试 / 同语言跳过 / 原文分类
// 目标语言严格使用应用内设置，不做自动对调
// ============================================================

const log = require('./logger');
const ai = require('./ai-call');
const { classify, detectLanguage, sameLanguage, kindLabel } = require('./text-classify');

const cache = new Map();
const MAX_CACHE = 200;
let seq = 0;

function nextToken() { return ++seq; }
function isCurrent(token) { return token === seq; }
function cancelPending() { seq += 1; }

function cacheKey(text, targetLang, kind) {
  return `${kind}||${targetLang}||${String(text).trim()}`;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { value, ts: Date.now() });
  while (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function skipKinds(cfg) {
  return {
    code: cfg.skipCode !== false,
    url: cfg.skipUrl !== false,
    number: cfg.skipNumber !== false
  };
}

async function translateSmart(text, opts = {}) {
  const cfg = { ...ai.getConfig(), ...opts };
  const targetLang = opts.targetLang || cfg.targetLang || '简体中文';
  const token = opts.token != null ? opts.token : seq;
  const classified = classify(text);
  const detected = detectLanguage(text);
  const skipMap = skipKinds(cfg);

  log.info('[pipeline] 分类=', classified.kind, '检测=', detected.code, '目标=', targetLang,
    'skip=', classified.skip, 'len=', String(text || '').length);

  if (classified.kind === 'empty') {
    return { skipped: true, reason: 'empty', kind: classified.kind, detected, targetLang, original: text };
  }
  if (classified.skip && skipMap[classified.kind]) {
    return {
      skipped: true,
      reason: classified.reason,
      kind: classified.kind,
      kindLabel: kindLabel(classified.kind),
      detected,
      targetLang,
      original: String(text).trim(),
      translation: '',
      hint: classified.kind === 'url' ? 'URL 默认不翻译' : classified.kind === 'code' ? '代码默认不翻译' : '纯数字默认不翻译'
    };
  }

  if (sameLanguage(detected.code, targetLang)) {
    log.info('[pipeline] 源语言等于目标语言，跳过翻译', detected.code, targetLang);
    return {
      skipped: true,
      reason: 'same-language',
      kind: classified.kind,
      kindLabel: kindLabel(classified.kind),
      detected,
      targetLang,
      original: String(text).trim(),
      translation: '',
      hint: `原文已是${targetLang}，无需翻译`
    };
  }

  const key = cacheKey(text, targetLang, classified.kind);
  const cached = cacheGet(key);
  if (cached) {
    log.info('[pipeline] 命中缓存');
    return { ...cached, cached: true };
  }

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!isCurrent(token)) return { cancelled: true };
    try {
      const payload = classified.kind === 'word'
        ? await ai.translateWord(String(text).trim(), targetLang, { signal: opts.signal })
        : { translation: await ai.translateStrict(String(text).trim(), targetLang, 'auto', { signal: opts.signal }) };
      if (!isCurrent(token)) return { cancelled: true };
      const result = {
        skipped: false,
        kind: classified.kind,
        kindLabel: kindLabel(classified.kind),
        detected,
        targetLang,
        original: String(text).trim(),
        translation: String(payload.translation || '').trim(),
        phonetic: payload.phonetic || '',
        definitions: payload.definitions || []
      };
      if (result.translation && result.translation === result.original) {
        result.error = true;
        result.hint = '译文与原文相同，请检查模型或语言设置';
      }
      cacheSet(key, result);
      return result;
    } catch (e) {
      if (e.name === 'AbortError') return { cancelled: true };
      lastErr = e;
      log.warn('[pipeline] 失败 attempt', attempt + 1, e.message);
      await sleep(400);
    }
  }
  throw lastErr || new Error('翻译失败');
}

async function translateLines(lines, opts = {}) {
  const cfg = { ...ai.getConfig(), ...opts };
  const targetLang = opts.targetLang || cfg.targetLang || '简体中文';
  const token = opts.token != null ? opts.token : seq;
  const skipMap = skipKinds(cfg);
  const joined = lines.map(l => l.text).join('\n');
  const detected = detectLanguage(joined);
  if (sameLanguage(detected.code, targetLang)) {
    return {
      cancelled: false,
      detected,
      targetLang,
      items: lines.map(l => ({ ...l, translation: l.text, skipped: true, reason: 'same-language' }))
    };
  }

  const out = lines.map((line) => {
    const classified = classify(line.text);
    if (classified.skip && skipMap[classified.kind]) {
      return { ...line, translation: line.text, skipped: true, reason: classified.reason };
    }
    return { ...line, translation: '', skipped: false };
  });
  const pendingIdx = [];
  const pendingTexts = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i].skipped) continue;
    const key = cacheKey('line:' + out[i].text, targetLang, 'line');
    const cached = cacheGet(key);
    if (cached) {
      out[i].translation = cached.translation;
      out[i].cached = true;
      continue;
    }
    pendingIdx.push(i);
    pendingTexts.push(out[i].text);
  }
  if (!pendingTexts.length) return { cancelled: false, items: out, detected, targetLang };
  if (!isCurrent(token)) return { cancelled: true, items: out };

  const numbered = pendingTexts.map((t, n) => (n + 1) + '. ' + t).join('\n');
  const system = `你是专业翻译。将下列编号文本翻译为${targetLang}。
规则：
1. 逐行翻译，保持编号数量一致
2. 每行只输出「编号. 译文」
3. 保留代码、路径、URL
4. 译文尽量短，便于原位覆盖显示`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!isCurrent(token)) return { cancelled: true, items: out };
    try {
      const raw = await ai.chat([
        { role: 'system', content: system },
        { role: 'user', content: numbered }
      ], { vision: false, signal: opts.signal, timeout: 45000 });
      if (!isCurrent(token)) return { cancelled: true, items: out };
      const parsed = parseNumbered(raw, pendingTexts.length);
      pendingIdx.forEach((lineIdx, n) => {
        const t = (parsed[n] || pendingTexts[n] || '').trim();
        out[lineIdx].translation = t || out[lineIdx].text;
        cacheSet(cacheKey('line:' + out[lineIdx].text, targetLang, 'line'), { translation: out[lineIdx].translation });
      });
      lastErr = null;
      break;
    } catch (e) {
      if (e.name === 'AbortError') return { cancelled: true, items: out };
      lastErr = e;
      await sleep(400);
    }
  }
  if (lastErr) {
    pendingIdx.forEach((lineIdx) => {
      if (!out[lineIdx].translation) out[lineIdx].translation = out[lineIdx].text;
      out[lineIdx].error = lastErr.message;
    });
  }
  return { cancelled: false, items: out, detected, targetLang };
}

function parseNumbered(raw, count) {
  const lines = String(raw || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out = new Array(count).fill('');
  for (const line of lines) {
    const m = line.match(/^(\d+)[\.、\)]\s*(.*)$/);
    if (m) {
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < count) out[idx] = m[2];
    }
  }
  if (out.filter(Boolean).length < count && lines.length === count) {
    return lines.map(s => s.replace(/^\d+[\.、\)]\s*/, ''));
  }
  return out;
}

module.exports = {
  translateSmart, translateLines, nextToken, isCurrent, cancelPending, cacheGet, cacheSet
};
