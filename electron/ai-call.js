// ============================================================
// AI智译 · 主进程 AI 调用模块
// 供悬停取词、截图 OCR 等后台功能复用
// 从 secureStore + localStorage 配置读取 API 凭据
// ============================================================

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const secure = require('./secure-store');
const log = require('./logger');

const PROVIDERS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  custom: { baseUrl: '' }
};

// 读取本地 settings.json（非加密部分）
function readSettings() {
  const file = path.join(app.getPath('userData'), 'Local Storage', 'leveldb');
  // Electron localStorage 不易从主进程直接读取，改用 secureStore + 默认值
  // 实际策略：apiKey 从 secureStore 读取；其余配置由渲染进程通过 IPC 同步给主进程缓存
  return cachedConfig;
}

// 主进程缓存的配置（由渲染进程 init 时通过 IPC 同步）
let cachedConfig = {
  provider: 'deepseek',
  apiKey: '',
  baseUrl: '',
  model: 'deepseek-chat',
  visionProvider: 'qwen',
  visionApiKey: '',
  visionModel: 'qwen-vl-max',
  visionBaseUrl: '',
  hoverEnabled: false,
  hoverDelay: 300,
  screenshotEnabled: true
};

function updateConfig(partial) {
  // 不用空值覆盖已加载的 API Key（secureStore 加载的值优先）
  if (partial.apiKey === '' || partial.apiKey === undefined) delete partial.apiKey;
  if (partial.visionApiKey === '' || partial.visionApiKey === undefined) delete partial.visionApiKey;
  Object.assign(cachedConfig, partial);
  log.info('[ai-call] 配置已更新, apiKey=' + (cachedConfig.apiKey ? '已配置' : '空') + ', visionApiKey=' + (cachedConfig.visionApiKey ? '已配置' : '空'));
}

function getConfig() {
  return { ...cachedConfig };
}

// 异步加载 secureStore 中的 API Key
async function loadKeysAsync() {
  if (secure.isAvailable()) {
    try {
      const apiKey = secure.get('apiKey');
      if (apiKey) cachedConfig.apiKey = apiKey;
      const visionApiKey = secure.get('visionApiKey');
      if (visionApiKey) cachedConfig.visionApiKey = visionApiKey;
    } catch (e) {
      log.warn('[ai-call] 加载加密 Key 失败:', e.message);
    }
  }
}

// 解析某 provider 的 baseUrl
function resolveBaseUrl(provider, customUrl) {
  if (provider === 'custom') return customUrl || '';
  return PROVIDERS[provider]?.baseUrl || '';
}

// 通用 chat 请求
async function chat(messages, { vision = false } = {}) {
  const cfg = getConfig();
  const provider = vision ? cfg.visionProvider : cfg.provider;
  const apiKey = vision ? cfg.visionApiKey : cfg.apiKey;
  const model = vision ? cfg.visionModel : cfg.model;
  // 视觉模型用 visionBaseUrl，文本模型用 baseUrl
  const customUrl = vision ? (cfg.visionBaseUrl || cfg.baseUrl) : cfg.baseUrl;
  const baseUrl = resolveBaseUrl(provider, customUrl);

  if (!apiKey) throw new Error(vision ? '未配置视觉模型 API Key' : '未配置 API Key');
  if (!baseUrl && provider === 'custom') throw new Error(vision ? '未配置视觉模型 BaseURL' : '未配置 BaseURL');

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model,
    messages,
    temperature: 0.2,
    stream: false
  };

  log.info('[ai-call] 请求:', vision ? 'vision' : 'text', 'provider=' + provider, 'model=' + model, 'url=' + url);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    log.error('[ai-call] API 错误:', res.status, txt.slice(0, 200));
    throw new Error(`API ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.choices || !data.choices[0]) {
    log.error('[ai-call] 返回数据格式异常:', JSON.stringify(data).slice(0, 200));
    throw new Error('API 返回数据格式异常');
  }
  const content = data.choices[0].message?.content || '';
  log.info('[ai-call] 返回内容长度:', content.length, '前100字:', content.slice(0, 100));
  return content;
}

// 翻译文本
async function translateText(text, targetLang = '中文', srcLang = 'auto') {
  // 检测：如果原文和目标语言相同，自动切换目标语言
  const isChinese = /[\u4e00-\u9fff]/.test(text);
  let finalTarget = targetLang;
  if (isChinese && (targetLang === '中文' || targetLang === '简体中文' || targetLang === '繁體中文')) {
    finalTarget = 'English';
  } else if (!isChinese && targetLang === 'English') {
    finalTarget = '简体中文';
  }

  const srcDesc = srcLang === 'auto' ? '自动检测' : srcLang;
  const system = `你是专业翻译。源语言：${srcDesc}。将用户输入翻译为${finalTarget}。
规则：
1. 只返回译文，不要任何解释或前缀
2. 保留代码、路径、URL、变量名等原文
3. 编程术语保留英文原词并附中文解释
4. 保持原文的换行和段落结构
5. 如果原文已经是${finalTarget}，翻译为${isChinese ? 'English' : '简体中文'}`;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: text }
  ];
  return await chat(messages, { vision: false });
}

// 视觉模型：OCR + 翻译一步完成
async function ocrAndTranslate(imageBase64, opts = {}) {
  const { translate = true, targetLang = '简体中文', srcLang = 'auto' } = opts;
  if (translate) {
    const system = `你是专业OCR翻译助手。请执行以下步骤：
1. 识别图片中的所有文字（支持中文、英文、日文、韩文等）
2. 将识别到的文字翻译为${targetLang}
3. 输出格式：每行一条，格式为"原文 | 译文"
4. 保留代码、路径、URL等原文不翻译
5. 如果识别到的文字已经是${targetLang}，将其翻译为${targetLang === '简体中文' || targetLang === '中文' ? 'English' : '简体中文'}
6. 若图片中没有文字或模糊无法识别，只回复"未识别到文字"

重要：译文必须与原文不同语言。中文→${targetLang === '简体中文' || targetLang === '中文' ? 'English' : '简体中文'}，英文→${targetLang}。`;
    const userContent = [
      { type: 'text', text: `请识别这张截图中的文字并翻译为${targetLang}。` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
    ];
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userContent }
    ];
    return await chat(messages, { vision: true });
  } else {
    const system = '识别图片中的所有文字，原样输出。若无法识别，回复"未识别到文字"。';
    const userContent = [
      { type: 'text', text: '请识别这张截图中的所有文字。' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
    ];
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userContent }
    ];
    return await chat(messages, { vision: true });
  }
}

module.exports = {
  updateConfig,
  getConfig,
  loadKeysAsync,
  translateText,
  ocrAndTranslate,
  chat
};
