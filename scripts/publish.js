// ============================================================
// AI智译 · GitHub Release 发布脚本
// 读取 GH_TOKEN 环境变量后调用 electron-builder 发布到 GitHub
// ============================================================

const { execSync } = require('child_process');

const pkg = require('../package.json');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const CURRENT = String((pkg && pkg.version) || '0.0.0');

if (!TOKEN) {
  console.error('\n[ERROR] 未检测到 GH_TOKEN 环境变量。\n');
  console.error('GitHub 自动更新依赖 Personal Access Token 发布 Release。');
  console.error('请按以下步骤配置：\n');
  console.error('  1. 访问 https://github.com/settings/tokens');
  console.error('  2. 点击 "Generate new token (classic)"');
  console.error('  3. 勾选 scope: [repo] (含 repo:status / public_repo / repo_deployment)');
  console.error('  4. 生成并复制 token');
  console.error('  5. 在终端设置环境变量（不要写入 git）：\n');
  console.error('     PowerShell（仅当前会话）：');
  console.error('       $env:GH_TOKEN="ghp_xxxxxxxxxxxx"');
  console.error('     CMD（仅当前会话）：');
  console.error('       set GH_TOKEN=ghp_xxxxxxxxxxxx\n');
  console.error('  6. 重新运行：npm run dist:gh\n');
  console.error('注意：token 仅在当前终端会话有效，关闭终端后需重新设置。');
  console.error('      切勿将 token 写入 package.json 或提交到 git。\n');
  process.exit(1);
}

console.log('[INFO] GH_TOKEN 已检测到，长度:', TOKEN.length);
console.log('[INFO] 即将发布版本:', CURRENT);
console.log('[INFO] 目标仓库: github.com/CadeZeng/AIzhiyi');
console.log('[INFO] 开始调用 electron-builder 发布...\n');
console.log('[TIP] 若版本仍是上次的号，请先改 package.json 的 version 再发布，否则用户端不会提示更新。\n');

try {
  execSync('electron-builder --win --x64 --publish always', {
    stdio: 'inherit',
    env: process.env,
  });
  console.log('\n[OK] 发布完成。请检查 https://github.com/CadeZeng/AIzhiyi/releases');
} catch (e) {
  console.error('\n[ERROR] 发布失败:', e.message);
  process.exit(1);
}
