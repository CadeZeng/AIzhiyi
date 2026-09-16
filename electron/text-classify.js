// ============================================================
// AI智译 · 原文类型 / 语言检测
// ============================================================

const LANG_ALIASES = {
  '简体中文': 'zh', '中文': 'zh', 'zh': 'zh', 'zh-cn': 'zh', 'zh-hans': 'zh',
  '繁體中文': 'zh-hant', '繁体中文': 'zh-hant', 'zh-tw': 'zh-hant', 'zh-hant': 'zh-hant',
  'english': 'en', 'en': 'en',
  '日本語': 'ja', 'japanese': 'ja', 'ja': 'ja',
  '한국어': 'ko', 'korean': 'ko', 'ko': 'ko',
  'français': 'fr', 'french': 'fr', 'fr': 'fr',
  'deutsch': 'de', 'german': 'de', 'de': 'de',
  'español': 'es', 'spanish': 'es', 'es': 'es',
  'русский': 'ru', 'russian': 'ru', 'ru': 'ru'
};

function normalizeLang(name) {
  if (!name) return '';
  const key = String(name).trim().toLowerCase();
  return LANG_ALIASES[key] || LANG_ALIASES[String(name).trim()] || key;
}

function detectLanguage(text) {
  const s = String(text || '');
  if (!s.trim()) return { code: 'und', name: '未知' };
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const hiraKata = (s.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (s.match(/[\uac00-\ud7af]/g) || []).length;
  const cyr = (s.match(/[\u0400-\u04ff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  const letters = han + hiraKata + hangul + cyr + latin || 1;
  if (hiraKata / letters > 0.08 || (han > 0 && hiraKata > 2)) return { code: 'ja', name: '日本語' };
  if (hangul / letters > 0.08) return { code: 'ko', name: '한국어' };
  if (han / letters > 0.12) return { code: 'zh', name: '中文' };
  if (cyr / letters > 0.12) return { code: 'ru', name: 'Русский' };
  if (latin / letters > 0.12) return { code: 'en', name: 'English' };
  if (han > 0) return { code: 'zh', name: '中文' };
  return { code: 'en', name: 'English' };
}

function sameLanguage(detectedCode, targetName) {
  const a = normalizeLang(detectedCode);
  const b = normalizeLang(targetName);
  if (!a || !b || a === 'und') return false;
  if (a === b) return true;
  if (a.startsWith('zh') && b.startsWith('zh')) return true;
  return false;
}

function isUrl(text) {
  const t = String(text || '').trim();
  return /^(https?:\/\/|www\.)\S+$/i.test(t) || /^[a-z0-9.-]+\.[a-z]{2,}([/?#].*)?$/i.test(t);
}

function isPureNumber(text) {
  return /^[\s\d.,+\-:%$€¥£/]+$/.test(String(text || '').trim());
}

function isCodeLike(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^[A-Za-z_$#.][\w$.]*(\.[A-Za-z_][\w]*)+$/.test(t)) return true;
  if (/^(function|const|let|var|class|import|export|return|if|else|for|while)\b/.test(t)) return true;
  if (/[{};=<>]|=>|::/.test(t) && /[A-Za-z]/.test(t) && t.length < 80) return true;
  if (/^[\w./\\-]+\.(js|ts|tsx|py|java|go|rs|cpp|h|cs|json|yml|xml)$/i.test(t)) return true;
  if (/^\$[\w]+$/.test(t) || /^--[\w-]+$/.test(t)) return true;
  return false;
}

function classify(text) {
  const raw = String(text || '');
  const t = raw.trim();
  if (!t) return { kind: 'empty', skip: true, reason: 'empty' };
  if (isUrl(t)) return { kind: 'url', skip: true, reason: 'url' };
  if (isPureNumber(t)) return { kind: 'number', skip: true, reason: 'number' };
  if (isCodeLike(t)) return { kind: 'code', skip: true, reason: 'code' };

  const letters = t.replace(/[\s\d\p{P}\p{S}]/gu, '');
  const words = t.split(/\s+/).filter(Boolean);
  const hasHans = /[\u4e00-\u9fff]/.test(t);
  const sentencePunct = /[.!?。！？;；]/.test(t);
  const newlines = (t.match(/\n/g) || []).length;

  if (newlines >= 1 || t.length > 140) return { kind: 'paragraph', skip: false };
  if (sentencePunct && (hasHans ? t.length > 8 : words.length >= 4)) return { kind: 'sentence', skip: false };
  if (hasHans) {
    if (t.length <= 4) return { kind: 'word', skip: false };
    if (t.length <= 12) return { kind: 'phrase', skip: false };
    return { kind: 'sentence', skip: false };
  }
  if (words.length <= 1 && letters.length <= 32) return { kind: 'word', skip: false };
  if (words.length <= 5) return { kind: 'phrase', skip: false };
  return { kind: 'sentence', skip: false };
}

function kindLabel(kind) {
  return ({
    word: '单词', phrase: '短语', sentence: '句子', paragraph: '段落',
    code: '代码', url: 'URL', number: '数字', empty: '空'
  })[kind] || kind;
}

module.exports = {
  detectLanguage, sameLanguage, normalizeLang, classify, kindLabel, isUrl, isPureNumber, isCodeLike
};
