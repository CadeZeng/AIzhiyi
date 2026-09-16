// ============================================================
// AI智译 · 自动更新
// GitHub 直连在国内常被重置（net::ERR_CONNECTION_RESET）。
// 先探测可用镜像，再用 generic provider 下载 latest.yml / 安装包。
// ============================================================

const { app, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('./logger');

const GH_OWNER = 'CadeZeng';
const GH_REPO = 'AIzhiyi';
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;
const GH_RELEASES = `https://github.com/${GH_OWNER}/${GH_REPO}/releases`;
const GH_LATEST_DOWNLOAD = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest/download`;

const FEED_MIRRORS = [
  `https://ghproxy.net/https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest/download`,
  `https://ghfast.top/https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest/download`,
  `https://gh-proxy.com/https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest/download`,
  GH_LATEST_DOWNLOAD
];

let mainWindow = null;
let silentCheck = false;
let checking = false;
let lastCheckResult = null;
let activeFeedBase = '';

const state = {
  status: 'idle', // idle | checking | available | downloading | downloaded | up-to-date | error
  version: null,
  current: null,
  percent: 0,
  message: '',
  htmlUrl: GH_RELEASES,
  setupUrl: ''
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
    packaged: app.isPackaged,
    feed: activeFeedBase
  };
}

function setState(patch) {
  Object.assign(state, patch);
}

function withSlash(url) {
  return String(url || '').replace(/\/?$/, '/');
}

function applyFeed(base) {
  activeFeedBase = withSlash(base);
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: activeFeedBase
  });
  log.info('[updater] feed =', activeFeedBase);
}

function init(win) {
  mainWindow = win;
  setState({ current: app.getVersion() });
  autoUpdater.logger = log;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.requestHeaders = { 'User-Agent': 'AI-Translator-Updater' };
  applyFeed(FEED_MIRRORS[0]);

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
      setState({ status: 'error', message: noReleaseMessage() });
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
  return 'GitHub 上还没有发布过版本，所以现在无法在线更新。';
}

function networkMessage() {
  return '无法直连 GitHub 下载更新（连接被重置）。已切换镜像重试；若仍失败，请点击「立即更新」打开镜像下载页手动安装。';
}

function sanitizeUpdateError(err) {
  const raw = String((err && err.message) || err || '');
  if (isNoPublishedVersions(raw) || /ERR_UPDATER_NO_PUBLISHED_VERSIONS/i.test(raw)) {
    return noReleaseMessage();
  }
  if (looksLikeHtmlDump(raw) || /releases\.atom/i.test(raw) || /HttpError:\s*404/i.test(raw)) {
    return '暂时无法读取更新清单，已保持当前版本。';
  }
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|net::ERR|offline|getaddrinfo|aborted|AbortError/i.test(raw)) {
    return networkMessage();
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

async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal, redirect: 'follow' }));
  } finally {
    clearTimeout(timer);
  }
}

function parseLatestYml(text) {
  const raw = String(text || '');
  const version = (raw.match(/^version:\s*['"]?([^\s'"]+)/m) || [])[1] || '';
  const pathName = (raw.match(/^path:\s*['"]?([^\s'"]+)/m) || [])[1]
    || (raw.match(/url:\s*['"]?([^\s'"]+\.exe)/m) || [])[1]
    || '';
  return {
    version: String(version).replace(/^v/i, ''),
    fileName: pathName,
    hasYml: /^version:\s*/m.test(raw)
  };
}

function setupUrlFor(fileName, feedBase) {
  const name = fileName || `ai-translator-setup-${state.version || app.getVersion()}.exe`;
  if (feedBase) return withSlash(feedBase) + name;
  return withSlash(FEED_MIRRORS[0]) + name;
}

async function probeFeed() {
  for (const base of FEED_MIRRORS) {
    const ymlUrl = withSlash(base) + 'latest.yml';
    try {
      const res = await fetchWithTimeout(ymlUrl, {
        headers: { 'User-Agent': 'AI-Translator-Updater' }
      }, 10000);
      if (!res.ok) {
        log.warn('[updater] probe', ymlUrl, 'status', res.status);
        continue;
      }
      const text = await res.text();
      const parsed = parseLatestYml(text);
      if (!parsed.hasYml || !parsed.version) {
        log.warn('[updater] probe', ymlUrl, 'invalid yml');
        continue;
      }
      log.info('[updater] probe ok', ymlUrl, 'version', parsed.version);
      return { base: withSlash(base), ...parsed, htmlUrl: GH_RELEASES };
    } catch (e) {
      log.warn('[updater] probe fail', ymlUrl, e.message);
    }
  }
  return null;
}

async function fetchLatestFromApi() {
  try {
    const res = await fetchWithTimeout(GH_API + '/releases/latest', { headers: ghHeaders() }, 10000);
    if (res.status === 404) return { ok: false, reason: 'unavailable' };
    if (!res.ok) return { ok: false, reason: 'github-http', status: res.status };
    const latest = await res.json().catch(() => null);
    if (!latest) return { ok: false, reason: 'parse' };
    const tag = String(latest.tag_name || latest.name || '').replace(/^v/i, '');
    const setupAsset = Array.isArray(latest.assets)
      ? latest.assets.find((a) => /\.exe$/i.test(a.name || '') && !/blockmap/i.test(a.name || ''))
      : null;
    const hasYml = Array.isArray(latest.assets) && latest.assets.some((a) => /latest\.yml$/i.test(a.name || ''));
    return {
      ok: true,
      version: tag,
      hasYml,
      fileName: setupAsset && setupAsset.name,
      htmlUrl: latest.html_url || GH_RELEASES
    };
  } catch (e) {
    log.warn('[updater] api fail', e.message);
    return { ok: false, reason: 'network', message: sanitizeUpdateError(e) };
  }
}

function availablePayload(version, extra = {}) {
  const ver = version || state.version || '未知';
  const message = extra.message || `发现新版本 v${ver}，点击「立即更新」开始下载。`;
  setState({
    status: extra.status || 'available',
    version: ver,
    htmlUrl: extra.htmlUrl || state.htmlUrl,
    setupUrl: extra.setupUrl || state.setupUrl,
    message
  });
  return {
    ok: true,
    reason: extra.reason || 'available',
    version: ver,
    htmlUrl: state.htmlUrl,
    setupUrl: state.setupUrl,
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
    const api = await fetchLatestFromApi();
    const feed = await probeFeed();

    if (!feed && !(api && api.ok)) {
      const message = networkMessage();
      setState({ status: 'error', message });
      if (!silent) send('error', { message });
      return { ok: false, reason: 'network', message };
    }

    if (api && api.reason === 'unavailable' && !feed) {
      const message = noReleaseMessage();
      setState({ status: 'error', message });
      if (!silent) send('error', { message });
      return { ok: false, reason: 'no-release', message };
    }

    const version = (feed && feed.version) || (api && api.version);
    const fileName = (feed && feed.fileName) || (api && api.fileName);
    const htmlUrl = (api && api.htmlUrl) || GH_RELEASES;
    const feedBase = feed ? feed.base : FEED_MIRRORS[0];
    applyFeed(feedBase);
    setState({
      version,
      htmlUrl,
      setupUrl: setupUrlFor(fileName, feedBase)
    });

    if (!version || !isNewer(version, current)) {
      log.info('[updater] 已是最新 current=', current, 'remote=', version);
      setState({ status: 'up-to-date', message: '当前已是最新版本。' });
      if (!silent) send('up-to-date');
      return { ok: true, reason: 'up-to-date', message: '当前已是最新版本。' };
    }

    if (!app.isPackaged) {
      const message = `发现新版本 v${version}。开发运行无法自动安装，点击「立即更新」将打开镜像下载页。`;
      const payload = availablePayload(version, { htmlUrl, setupUrl: state.setupUrl, message, reason: 'available-dev' });
      send('update-available', { version, dev: true });
      return payload;
    }

    if (feed) {
      try {
        lastCheckResult = await autoUpdater.checkForUpdates();
      } catch (e) {
        log.warn('[updater] checkForUpdates failed, fallback to manual:', e.message);
        lastCheckResult = null;
      }
    } else {
      lastCheckResult = null;
    }

    const payload = availablePayload(version, {
      htmlUrl,
      setupUrl: state.setupUrl,
      message: `发现新版本 v${version}，点击「立即更新」开始下载。`
    });
    send('update-available', { version });
    return payload;
  } catch (e) {
    const message = sanitizeUpdateError(e);
    log.error('[updater] 检查更新失败:', e);
    setState({ status: 'error', message });
    if (!silent) send('error', { message });
    return { ok: false, reason: 'error', message };
  } finally {
    silentCheck = false;
    checking = false;
  }
}

async function openSetup() {
  const url = state.setupUrl || setupUrlFor(null, activeFeedBase || FEED_MIRRORS[0]);
  try {
    await shell.openExternal(url);
    return url;
  } catch (e) {
    log.error('[updater] 打开下载页失败:', e);
    try { await shell.openExternal(GH_RELEASES); } catch (_) {}
    return url;
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

  if (!app.isPackaged || !lastCheckResult) {
    const url = await openSetup();
    const message = app.isPackaged
      ? `无法自动下载，已打开镜像安装包：${url}`
      : `开发运行无法自动安装，已打开镜像下载页：${url}`;
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
      message: state.version
        ? `新版本 v${state.version} 已下载完成，点击「立即重启安装」。`
        : '新版本已下载完成，点击「立即重启安装」。'
    };
  } catch (e) {
    log.error('[updater] 下载更新失败:', e);
    const url = await openSetup();
    const message = `自动下载失败，已打开镜像安装包：${url}`;
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
