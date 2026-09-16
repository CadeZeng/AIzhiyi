// 打包完成后把自定义图标写入 Windows exe（不走 winCodeSign 签名工具）
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findRcedit() {
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cache)) return null;
  const names = fs.readdirSync(cache);
  for (const name of names) {
    const candidate = path.join(cache, name, 'rcedit-x64.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exe = path.join(context.appOutDir, exeName);
  const icon = path.join(context.packager.projectDir, 'build', 'icon.ico');
  const rcedit = findRcedit();
  if (!fs.existsSync(exe) || !fs.existsSync(icon)) {
    console.warn('[afterPack] skip icon: exe or ico missing');
    return;
  }
  if (!rcedit) {
    console.warn('[afterPack] rcedit-x64.exe not found in electron-builder cache');
    return;
  }
  execFileSync(rcedit, [exe, '--set-icon', icon]);
  console.log('[afterPack] icon written:', exe);
};
