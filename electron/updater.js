// ============================================================
// AI智译 · 自动更新
// 不走 github.com/releases.atom（私有仓库会 404 并返回整页 HTML）。
// 改用 GitHub REST API。没有可访问的 Release 时视为当前已是最新。
// 用户需在关于页点击「立即更新」才会下载，下载完成后点「立即重启安装」。
// ============================================================

const { app, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('./logger');

const GH_OWNER = 'CadeZeng';
const GH_REPO = 'AIzhiyi';
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;
const GH_RELEASES = `https://github.com/${GH_OWNER}/${GH_REPO}/releases`;

let mainWindow = null;
let silentCheck = false;
let checking = false;
let lastCheckResult = null;

const state = {
  status: 'idle', // idle | checking | available | downloading | downloaded | up-to-date | error
  version: null,
  current: null,
  percent: 0,
  message: '',
  htmlUrl: GH_RELEASES
};

function ghHeaders() {
  const headers = {
    'User-Agent': 'AI-Translator-Updater',
    Accept: 'application/vnd.github+json'
  };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function getState() {
  return {
    ...state,
    current: app.getVersion(),
    packaged: app.isPackaged
  };
}

function setState(patch) {
  Object.assign(state, patch);
}

function init(win) {
  mainWindow = win;
  setState({ current: app.getVersion() });
  autoUpdater.logger = log;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.requestHeaders = Object.assign({ 'User-Agent': 'AI-Translator-Updater' }, ghHeaders());

  autoUpdater.on('checking-for-update', () => {
    if (!silentCheck) send('checking');
  });
  autoUpdater.on('update-available', (info) => {
    setState({
      status: state.status === 'downloading' || state.status === 'downloaded' ? state.status : 'available',
      version: info && info.version ? info.version : state.version,
      message: `发现新版本 v${(info && info.version) || '未知'}，点击「立即更新」开始下载。`
    });
    send('update-available', { version: state.version });
  });
  autoUpdater.on('update-not-available', () => {
    if (state.status === 'downloaded' || state.status === 'downloading' || state.status === 'available') return;
    setState({ status: 'up-to-date', message: '当前已是最新版本。' });
    if (!silentCheck) send('up-to-date');
  });
  autoUpdater.on('download-progress', (p) => {
    const percent = Number(p && p.percent) || 0;
    setState({
      status: 'downloading',
      percent,
      message: `正在下载更新 ${Math.round(percent)}%`
    });
    send('progress', {
      percent,
      transferred: p.transferred,
      total: p.total
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    const version = (info && info.version) || state.version;
    setState({
      status: 'downloaded',
      version,
      percent: 100,
      message: version
        ? `新版本 v${version} 已下载完成，点击「立即重启安装」。`
        : '新版本已下载完成，点击「立即重启安装」。'
    });
    send('downloaded', { version });
  });
  autoUpdater.on('error', (e) => {
    const message = sanitizeUpdateError(e);
    log.error('[updater] error:', message);
    if (isNoPublishedVersions(e)) {
      setState({ status: 'up-to-date', message: noReleaseMessage() });
      if (!silentCheck) send('error', { message: noReleaseMessage() });
      return;
    }
    if (state.status !== 'downloaded') {
      setState({ status: 'error', message });
    }
    if (!silentCheck) send('error', { message });
  });
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:' + channel, data);
  }
}

function looksLikeHtmlDump(text) {
  return /content-security-policy|_gh_sess|text\/html|<!DOCTYPE|<html/i.test(text);
}

function isNoPublishedVersions(err) {
  const raw = String((err && err.message) || err || '');
  return /No published versions on GitHub/i.test(raw);
}

function noReleaseMessage() {
  return 'GitHub 上还没有发布过版本，所以现在无法在线更新。请先运行 npm run dist:gh，把安装包发到 CadeZeng/AIzhiyi 的 Release。';
}

function sanitizeUpdateError(err) {
  const raw = String((err && err.message) || err || '');
  if (isNoPublishedVersions(raw) || /ERR_UPDATER_NO_PUBLISHED_VERSIONS/i.test(raw)) {
    return noReleaseMessage();
  }
  if (looksLikeHtmlDump(raw) || /releases\.atom/i.test(raw) || /HttpError:\s*404/i.test(raw)) {
    return '暂时无法从 GitHub 读取更新清单，已保持当前版本。';
  }
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|net::ERR|offline|getaddrinfo/i.test(raw)) {
    return '网络无法连接到 GitHub，请检查网络或代理后重试。';
  }
  const stripped = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped.length > 160) return stripped.slice(0, 160) + '…';
  return stripped || '检查更新失败';
}

function isNewer(remote, local) {
  try {
    const semver = require('semver');
    const a = semver.coerce(String(remote || '').replace(/^v/i, ''));
    const b = semver.coerce(String(local || '').replace(/^v/i, ''));
    if (!a || !b) return false;
    return semver.gt(a, b);
  } catch (_) {
    const pa = String(remote || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(local || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const a = pa[i] || 0;
      const b = pb[i] || 0;
      if (a > b) return true;
      if (a < b) return false;
    }
    return false;
  }
}

async function fetchLatestRelease() {
  const headers = ghHeaders();
  let res;
  try {
    res = await fetch(GH_API + '/releases/latest', { headers });
  } catch (e) {
    return { ok: false, reason: 'network', message: sanitizeUpdateError(e) };
  }
  if (res.status === 404) {
    return { ok: false, reason: 'unavailable', message: noReleaseMessage() };
  }
  if (!res.ok) {
    return { ok: false, reason: 'github-http', message: `GitHub 返回 ${res.status}，暂时无法检查更新。` };
  }
  const latest = await res.json().catch(() => null);
  if (!latest) return { ok: false, reason: 'parse', message: '当前已是最新版本。' };
  const tag = String(latest.tag_name || latest.name || '').replace(/^v/i, '');
  const hasYml = Array.isArray(latest.assets) && latest.assets.some((a) => /latest\.yml$/i.test(a.name || ''));
  return { ok: true, tag, version: tag, hasYml, htmlUrl: latest.html_url || GH_RELEASES };
}

function availablePayload(version, extra = {}) {
  const ver = version || state.version || '未知';
  const message = extra.message || `发现新版本 v${ver}，点击「立即更新」开始下载。`;
  setState({
    status: extra.status || 'available',
    version: ver,
    htmlUrl: extra.htmlUrl || state.htmlUrl,
    message
  });
  return {
    ok: true,
    reason: extra.reason || 'available',
    version: ver,
    htmlUrl: state.htmlUrl,
    packaged: app.isPackaged,
    message
  };
}

async function checkNow(opts = {}) {
  const silent = !!opts.silent;
  if (checking) return getState();
  if (state.status === 'downloading') {
    return { ok: true, reason: 'downloading', version: state.version, message: state.message || '正在下载更新…' };
  }
  if (state.status === 'downloaded') {
    if (!silent) send('downloaded', { version: state.version });
    return {
      ok: true,
      reason: 'downloaded',
      version: state.version,
      message: `新版本 v${state.version || ''} 已下载完成，点击「立即重启安装」。`
    };
  }

  silentCheck = silent;
  checking = true;
  try {
    if (!silent) {
      setState({ status: 'checking', message: '正在检查更新...' });
      send('checking');
    }
    const current = app.getVersion();
    const remote = await fetchLatestRelease();

    if (!remote.ok) {
      const message = remote.reason === 'unavailable' ? noReleaseMessage() : (remote.message || '当前已是最新版本。');
      log.info('[updater] 远程无可用 Release（', remote.reason, '）');
      setState({ status: remote.reason === 'unavailable' ? 'error' : 'up-to-date', message });
      if (!silent) {
        if (remote.reason === 'unavailable') send('error', { message });
        else send('up-to-date');
      }
      return {
        ok: remote.reason !== 'unavailable',
        reason: remote.reason === 'unavailable' ? 'no-release' : 'up-to-date',
        message
      };
    }

    setState({ htmlUrl: remote.htmlUrl || GH_RELEASES, version: remote.version });

    if (!isNewer(remote.version, current)) {
      log.info('[updater] 已是最新 current=', current, 'remote=', remote.version);
      setState({ status: 'up-to-date', message: '当前已是最新版本。' });
      if (!silent) send('up-to-date');
      return { ok: true, reason: 'up-to-date', message: '当前已是最新版本。' };
    }

    if (!app.isPackaged) {
      const message = `发现新版本 v${remote.version}。开发运行无法自动安装，点击「立即更新」将打开下载页。`;
      log.info('[updater]', message);
      const payload = availablePayload(remote.version, { htmlUrl: remote.htmlUrl, message, reason: 'available-dev' });
      send('update-available', { version: remote.version, dev: true });
      return payload;
    }

    if (!remote.hasYml) {
      const message = `发现新版本 v${remote.version}，但 Release 缺少 latest.yml，无法自动安装。点击「立即更新」将打开下载页。`;
      const payload = availablePayload(remote.version, {
        htmlUrl: remote.htmlUrl,
        message,
        reason: 'no-yml',
        status: 'available'
      });
      send('update-available', { version: remote.version, manual: true });
      return payload;
    }

    try {
      lastCheckResult = await autoUpdater.checkForUpdates();
    } catch (e) {
      if (isNoPublishedVersions(e)) {
        const message = noReleaseMessage();
        setState({ status: 'error', message });
        send('error', { message });
        return { ok: false, reason: 'no-release', message };
      }
      throw e;
    }
    if (!lastCheckResult) {
      const message = `发现新版本 v${remote.version}，点击「立即更新」将打开下载页。`;
      const payload = availablePayload(remote.version, { htmlUrl: remote.htmlUrl, message, reason: 'inactive' });
      send('update-available', { version: remote.version, manual: true });
      return payload;
    }
    return availablePayload(remote.version, { htmlUrl: remote.htmlUrl });
  } catch (e) {
    log.error('[updater] 检查更新失败:', e);
    log.info('[updater] 回退为已是最新，避免把 GitHub HTML 错误展示给用户');
    setState({ status: 'up-to-date', message: '当前已是最新版本。' });
    if (!silent) send('up-to-date');
    return { ok: true, reason: 'up-to-date', message: '当前已是最新版本。' };
  } finally {
    silentCheck = false;
    checking = false;
  }
}

async function downloadNow() {
  if (state.status === 'downloaded') {
    quitAndInstall();
    return { ok: true, reason: 'installing', message: '正在重启并安装新版本…' };
  }
  if (state.status === 'downloading') {
    return { ok: true, reason: 'downloading', version: state.version, message: state.message || '正在下载更新…' };
  }

  if (state.status !== 'available') {
    const checked = await checkNow();
    if (checked.reason === 'up-to-date') return checked;
    if (state.status === 'downloaded') {
      quitAndInstall();
      return { ok: true, reason: 'installing', message: '正在重启并安装新版本…' };
    }
  }

  const canAutoInstall = app.isPackaged && lastCheckResult;
  if (!canAutoInstall) {
    const url = state.htmlUrl || GH_RELEASES;
    try { await shell.openExternal(url); } catch (e) {
      log.error('[updater] 打开下载页失败:', e);
    }
    const message = app.isPackaged
      ? `无法自动安装，已打开下载页：${url}`
      : `开发运行无法自动安装，已打开下载页：${url}`;
    send('error', { message });
    return { ok: false, reason: 'open-release', message, htmlUrl: url };
  }

  try {
    setState({ status: 'downloading', percent: 0, message: '正在下载更新…' });
    send('progress', { percent: 0, transferred: 0, total: 0 });
    await autoUpdater.downloadUpdate();
    return {
      ok: true,
      reason: 'downloaded',
      version: state.version,
      message: `新版本 v${state.version || ''} 已下载完成，点击「立即重启安装」。`
    };
  } catch (e) {
    const message = sanitizeUpdateError(e);
    log.error('[updater] 下载更新失败:', message);
    setState({ status: 'available', message });
    send('error', { message });
    return { ok: false, reason: 'download-failed', message };
  }
}

function quitAndInstall() {
  try {
    autoUpdater.quitAndInstall(false, true);
    return { ok: true, reason: 'installing', message: '正在重启并安装新版本…' };
  } catch (e) {
    log.error('[updater] 安装更新失败:', e);
    const message = sanitizeUpdateError(e);
    send('error', { message: '安装失败：' + message });
    return { ok: false, reason: 'install-failed', message };
  }
}

module.exports = { init, checkNow, downloadNow, quitAndInstall, getState };
