// ============================================================
// AI智译 · 剪贴板取词翻译（应用外）
// 在第三方应用中选中文字 Ctrl+C 后，按 Alt+T 读取剪贴板并翻译
// 复用 ai-call 翻译服务与 result-window 浮动结果窗
// ============================================================

const { clipboard, screen } = require('electron');
const log = require('./logger');
const ai = require('./ai-call');
const resultWin = require('./result-window');

const MAX_LEN = 2000;
let busy = false;

async function trigger() {
  if (busy) return;
  busy = true;
  try {
    const text = (clipboard.readText() || '').trim();
    const pos = screen.getCursorScreenPoint();
    if (!text) {
      log.info('[clipboard-translate] 剪贴板为空');
      resultWin.showAt(pos.x, pos.y, { error: true, msg: '剪贴板中没有文本，请先复制文字（Ctrl+C）' });
      return;
    }
    if (text.length > MAX_LEN) {
      resultWin.showAt(pos.x, pos.y, { error: true, msg: '文本过长（超过 ' + MAX_LEN + ' 字），请复制更短的内容' });
      return;
    }
    // 纯空白/标点/数字不翻译
    if (/^[\s\d\p{P}]+$/u.test(text)) {
      resultWin.showAt(pos.x, pos.y, { error: true, msg: '剪贴板内容无可翻译文本' });
      return;
    }

    resultWin.showLoading(pos.x, pos.y, '剪贴板翻译中...');
    log.info('[clipboard-translate] 文本长度:', text.length);

    // 复用主进程翻译服务（内部自动检测语言方向：中文→English，英文→简体中文）
    const translation = await ai.translateText(text, '简体中文', 'auto');
    const t = (translation || '').trim();
    if (!t) {
      resultWin.showAt(pos.x, pos.y, { error: true, msg: '翻译返回为空，请重试' });
      return;
    }
    if (t === text) {
      resultWin.showAt(pos.x, pos.y, { error: true, msg: '译文与原文相同，请检查语言设置' });
      return;
    }
    resultWin.showAt(pos.x, pos.y, { original: text, translation: t, source: 'clipboard' });
  } catch (e) {
    const pos = screen.getCursorScreenPoint();
    log.error('[clipboard-translate] 失败:', e.message);
    resultWin.showAt(pos.x, pos.y, { error: true, msg: e.message });
  } finally {
    busy = false;
  }
}

module.exports = { trigger };
