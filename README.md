# AI智译 · Windows 桌面应用

Vibe Coding 辅助翻译与提示词优化工具。基于 Electron 构建，集成多模型 AI 能力。

## 项目结构

```
AI智译/
├── index.html              # 前端应用（UI + 业务逻辑，单文件）
├── package.json            # 工程配置 + electron-builder 打包配置
├── install-node.ps1        # Node.js 自动安装脚本
├── generate-icon.js        # 应用图标生成（多尺寸 PNG + ICO）
├── scripts/
│   └── publish.js          # GitHub Release 发布脚本（含 GH_TOKEN 检查）
├── electron/
│   ├── main.js            # 主进程（窗口、托盘、快捷键、更新、日志、安全存储）
│   ├── preload.js         # 预加载脚本（contextBridge 安全暴露 API）
│   ├── tray.js           # 系统托盘（关闭最小化到托盘）
│   ├── shortcuts.js       # 全局快捷键（Ctrl+Shift+T 唤起）
│   ├── updater.js         # 自动更新（electron-updater）
│   ├── secure-store.js    # API Key 加密存储（safeStorage / DPAPI）
│   └── logger.js          # 日志（electron-log，崩溃捕获）
└── build/
    ├── icon.svg           # 图标 SVG 源
    ├── icon.ico           # 多尺寸 ICO（16/32/48/64/128/256）
    └── icon-{size}.png    # 各尺寸 PNG
```

## 功能一览

- **文本翻译**：DeepSeek / 通义千问 / 自定义 OpenAI 兼容服务
- **图片翻译**：通义千问 VL（qwen-vl-max）多模态视觉模型
- **提示词优化**：七步框架（目标/上下文/约束/格式/示例/语气/修订）
- **历史记录**：最近 50 条，可收藏、可回放
- **术语库**：自定义翻译术语对照表
- **全局快捷键**：Ctrl+Shift+T 唤起窗口（可关闭）
- **系统托盘**：关闭窗口最小化到托盘
- **剪贴板监听**：可选自动翻译复制的外文
- **API Key 加密**：safeStorage / Windows DPAPI 加密保存
- **自动更新**：基于 GitHub Release，启动后自动检查
- **数据导出/导入**：JSON 备份（不含 API Key）
- **崩溃日志**：主进程 + 渲染进程异常捕获
- **首次启动向导**：3 步引导配置 API Key

## 快速开始

### 第一步：安装 Node.js（v18+）

访问 https://nodejs.org/ 下载 LTS 版本（v20.x）→ 双击 MSI 安装。

或右键 `install-node.ps1` → 「用 PowerShell 运行」自动安装。

验证：

```powershell
node --version   # 应输出 v20.x.x
npm --version    # 应输出 10.x.x
```

### 第二步：生成应用图标

```powershell
cd "d:\OPC一人公司项目\AI智译"
npm run gen:icon
```

生成 `build/icon.ico` 多尺寸图标（16/32/48/64/128/256）。

### 第三步：安装依赖

```powershell
npm install
```

首次约 200-400MB，3-10 分钟。

### 第四步：本地试运行

```powershell
npm start
```

验证：
- 自定义标题栏按钮可点击
- 翻译 / 优化 / 历史 / 术语库 / 设置 / 关于 全部正常
- 系统托盘 + 全局快捷键正常

### 第五步：打包为 Windows 安装包

```powershell
npm run build:win          # NSIS 安装包
npm run build:portable    # 便携版
npm run build:dir         # 仅解压目录（调试用）
```

输出在 `dist/`：
- `AI智译-Setup-1.0.0.exe` → NSIS 安装包（约 80-150MB）
- `AI智译-1.0.0-Portable.exe` → 便携版

## 发布到 GitHub Release（自动更新）

### 1. 配置 GH_TOKEN

```powershell
# 当前会话设置（PowerShell）
$env:GH_TOKEN="ghp_xxxxxxxxxxxx"

# 或 CMD
set GH_TOKEN=ghp_xxxxxxxxxxxx
```

Token 申请：https://github.com/settings/tokens → Generate new token (classic) → 勾选 `repo` scope。

> ⚠️ Token 仅在当前终端会话有效，关闭终端后需重新设置。切勿写入 git 或提交到仓库。

### 2. 发布

```powershell
npm run dist:gh
```

脚本会：
1. 检查 `GH_TOKEN` 环境变量
2. 调用 `electron-builder --win --x64 --publish always`
3. 上传安装包到 https://github.com/CadeZeng/AIzhiyi/releases
4. 用户启动应用后会自动检查并下载更新

### 3. 更新通道配置

`package.json` 中已配置：

```json
"publish": [{
  "provider": "github",
  "owner": "CadeZeng",
  "repo": "AIzhiyi",
  "releaseType": "release"
}]
```

## API Key 加密存储

应用使用 Electron 的 `safeStorage` API（底层为 Windows DPAPI）加密保存 API Key。

- 加密文件位置：`%APPDATA%\ai-translator\secure-store.json`（含 base64 密文）
- localStorage 中**不再保存**明文 API Key
- 首次启动后自动从 localStorage 迁移到加密存储
- 浏览器模式下降级使用 localStorage（无加密）

## 日志与崩溃报告

### 日志位置

```
%APPDATA%\ai-translator\logs\main.log
```

打开方式：应用内「关于」页 → 「打开日志文件夹」按钮。

### 捕获范围

- 主进程未捕获异常（`electron-log` errorHandler）
- 渲染进程未捕获错误（`window.onerror`）
- 未处理的 Promise 拒绝（`unhandledrejection`）
- 关键操作失败（API 调用、剪贴板、JSON 解析、数据导入导出等）

## 代码签名

当前为测试阶段，未签名。Windows SmartScreen 首次运行会拦截，详见下方「SmartScreen 解决办法」章节。

购买 EV 证书后，修改 `package.json`：

```json
"win": {
  "signAndEditExecutable": true,
  "certificateFile": "./certs/your-cert.pfx",
  "certificateSubjectName": ""
}
```

然后 `npm run build:win` 即可生成签名版本。

## 技术细节

### 自定义标题栏

- `frame: false` 无边框窗口
- HTML 绘制标题栏：拖拽区域 + 控制按钮
- 双击标题栏切换最大化

### 安全模型

- `contextIsolation: true`：渲染进程与 Node.js 完全隔离
- `nodeIntegration: false`：渲染进程不能直接访问 Node
- `contextBridge` 白名单 API
- 外部链接（http/https）自动用系统浏览器打开

### 窗口配置

- 默认大小：1200×780
- 最小大小：900×600
- 背景色：`#0B0F14`（深空灰，避免白屏）
- 单实例锁：第二次启动时激活已有窗口

## Windows SmartScreen 拦截的常见解决办法

由于当前版本未购买代码签名证书，Windows SmartScreen 可能在首次运行时拦截安装包（弹出"Windows 已保护你的电脑"提示）。这是 Windows 对未签名应用的默认安全策略，**不代表应用本身有害**。以下为常见解决办法，按推荐度排序。

### 办法 1：用户手动绕过（最简单，适合个人/小范围使用）

1. 双击 `AI智译-Setup-1.0.0.exe`，SmartScreen 弹窗出现。
2. 不要点击"不运行"，点击 **「更多信息」** 链接（位于弹窗底部）。
3. 弹窗下方出现 **「仍要运行」** 按钮，点击即可继续安装。
4. 后续运行此安装包不会再被拦截（Windows 会记住该文件的可信决策）。

> 注意：不同 Windows 版本措辞略有差异，但流程一致——"更多信息" → "仍要运行"。

### 办法 2：用 PowerShell 解除执行策略（适用于便携版被拦截）

如果是便携版 `AI智译-1.0.0-Portable.exe` 被 PowerShell 执行策略拦截：

```powershell
# 临时解除当前会话执行策略
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

# 然后运行便携版
& "D:\路径\AI智译-1.0.0-Portable.exe"
```

### 办法 3：将文件加入 Windows Defender 排除项（避免误报）

如果 Windows Defender 把安装包当病毒删除：

1. 打开 **设置 → 隐私和安全性 → Windows 安全中心**。
2. 进入 **病毒和威胁防护 → 管理设置**。
3. 滚动到底部找到 **排除项 → 添加或移除排除项**。
4. 点击 **添加排除项 → 文件**，选择 `AI智译-Setup-1.0.0.exe`。
5. 重新运行安装包。

### 办法 4：用右键"属性"解除锁定（适用于下载后被标记）

从网络下载的安装包可能被 Windows 加上"锁定标记"（Mark of the Web）：

1. 右键 `AI智译-Setup-1.0.0.exe` → **属性**。
2. 在"常规"选项卡底部，勾选 **「解除锁定」** 复选框。
3. 点击 **应用 → 确定**。
4. 再次双击运行，SmartScreen 警告通常会消失或减弱。

### 办法 5：以管理员身份运行（适用于权限被拦截）

1. 右键 `AI智译-Setup-1.0.0.exe` → **以管理员身份运行**。
2. 在 UAC 弹窗中点"是"。
3. 若仍出现 SmartScreen，回到办法 1。

### 办法 6：安装时暂时关闭 SmartScreen（不推荐，临时方案）

> ⚠️ 此方法会降低系统整体安全性，安装完成后请务必恢复。

1. 打开 **Windows 安全中心 → 应用和浏览器控制 → 基于声誉的保护设置**。
2. 将"检查应用和文件"设置为 **关闭**。
3. 运行安装包完成安装。
4. 安装完成后，将上述设置恢复为 **默认** 或 **阻止**。

### 长期方案：购买代码签名证书（商业发布推荐）

若要彻底消除 SmartScreen 拦截，建议购买 **EV 代码签名证书**（约 ¥1500-3000/年）：

1. 申请渠道：DigiCert / Sectigo / GlobalSign 等。
2. EV 证书通过硬件 USB Token 签发，签名后的应用**首次运行不会**触发 SmartScreen。
3. 拿到证书后，修改 `package.json`：

   ```json
   "win": {
     "signAndEditExecutable": true,
     "certificateFile": "./certs/your-cert.pfx",
     "certificateSubjectName": ""
   }
   ```

4. 运行 `npm run build:win` 即可生成签名版本。
5. EV 签名还能让应用在 Windows 安全中心显示发布者名称，提升用户信任。

## 常见问题

### Q: 打包时报错"icon.ico not found"

运行 `npm run gen:icon` 生成图标，或删除 `package.json` 中 `build.win.icon` 字段使用默认图标。

### Q: 应用启动白屏

检查 `index.html` 路径是否正确。在 `electron/main.js` 中 `loadFile` 使用相对路径。

### Q: 翻译功能失效

翻译功能依赖外部 AI API（DeepSeek/通义千问）。需要在应用内「设置」页配置 API Key。API Key 通过 Windows DPAPI 加密保存，不会上传。

### Q: 图片翻译报错

图片翻译需配置视觉模型 API Key（通义千问 VL 推荐）。在「设置」页找到「视觉模型配置」section，填入 DashScope API Key。

### Q: 自动更新不工作

- 开发模式下（`npm start`）不会触发更新检查
- 需要打包后（`npm run build:win`）并发布到 GitHub Release
- 确认 `package.json` 的 `build.publish` 配置正确
- 检查 `%APPDATA%\ai-translator\logs\main.log` 中的更新日志

### Q: 打包后的应用体积大

Electron 应用基础体积约 80-150MB（包含 Chromium）。若追求更小体积，可考虑后续迁移到 Tauri（约 5-10MB）。

### Q: Windows Defender 报毒

由于应用未签名，Windows SmartScreen 可能弹出警告。点击「更多信息」→「仍要运行」即可。详见上方「SmartScreen 解决办法」章节。

## 打包验证清单

- [ ] Node.js 已安装（v18+）
- [ ] `npm install` 成功
- [ ] `npm run gen:icon` 生成图标
- [ ] `npm start` 应用正常启动，UI 完整
- [ ] 自定义标题栏按钮可点击（最小化/最大化/关闭）
- [ ] 文本翻译功能正常（配置 API Key 后）
- [ ] 图片翻译功能正常（配置视觉模型 API Key 后）
- [ ] 提示词优化功能正常
- [ ] 历史/术语库/收藏功能正常
- [ ] 全局快捷键 Ctrl+Shift+T 唤起正常
- [ ] 系统托盘最小化/恢复正常
- [ ] 剪贴板自动翻译（开启后复制外文可自动翻译）
- [ ] 首次启动向导（清除 localStorage 后重启触发）
- [ ] 关于页显示版本号 + 检查更新 + 打开日志文件夹
- [ ] API Key 加密（`%APPDATA%\ai-translator\secure-store.json` 存在）
- [ ] 数据导出/导入正常
- [ ] 深色/浅色主题切换正常
- [ ] `npm run build:win` 成功生成 `dist/AI智译-Setup-1.0.0.exe`
- [ ] 安装包可正常安装、运行、卸载
- [ ] 桌面快捷方式和开始菜单项正确创建
