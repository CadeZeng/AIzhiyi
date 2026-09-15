# ============================================================
# AI智译 · Node.js 安装脚本
# 用于打包 Windows 桌面应用
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  AI智译 · Node.js 安装脚本" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 Node.js 是否已安装
Write-Host "[1/4] 检查 Node.js 是否已安装..." -ForegroundColor Yellow
$nodePath = Get-Command node -ErrorAction SilentlyContinue
if ($nodePath) {
    $version = & node --version 2>$null
    Write-Host "  Node.js 已安装：$version" -ForegroundColor Green
    
    $npmVersion = & npm --version 2>$null
    Write-Host "  npm 版本：$npmVersion" -ForegroundColor Green
    
    # 检查版本是否 >= 18
    $versionNum = [int]($version -replace 'v(\d+)\..*', '$1')
    if ($versionNum -ge 18) {
        Write-Host ""
        Write-Host "  Node.js 版本满足要求（>= 18）" -ForegroundColor Green
        Write-Host "  无需重新安装，可直接运行打包命令。" -ForegroundColor Green
        Write-Host ""
        Write-Host "  下一步：" -ForegroundColor Cyan
        Write-Host "    cd `"$PSScriptRoot`"" -ForegroundColor White
        Write-Host "    npm install" -ForegroundColor White
        Write-Host "    npm run build:win" -ForegroundColor White
        Write-Host ""
        exit 0
    } else {
        Write-Host "  Node.js 版本过低（需要 18+），将重新安装..." -ForegroundColor Yellow
    }
} else {
    Write-Host "  Node.js 未安装" -ForegroundColor Yellow
}

# 2. 尝试用 winget 安装
Write-Host ""
Write-Host "[2/4] 尝试使用 winget 安装 Node.js LTS..." -ForegroundColor Yellow

$wingetPath = Get-Command winget -ErrorAction SilentlyContinue
if ($wingetPath) {
    Write-Host "  检测到 winget，开始安装..." -ForegroundColor Cyan
    try {
        & winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
        
        # 刷新 PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        
        $nodePath = Get-Command node -ErrorAction SilentlyContinue
        if ($nodePath) {
            $version = & node --version 2>$null
            Write-Host "  winget 安装成功！版本：$version" -ForegroundColor Green
            Write-Host ""
            Write-Host "[3/4] 跳过手动下载" -ForegroundColor Yellow
            Write-Host "[4/4] 安装完成" -ForegroundColor Green
            Write-Host ""
            Write-Host "  下一步（请重新打开终端以刷新环境变量）：" -ForegroundColor Cyan
            Write-Host "    cd `"$PSScriptRoot`"" -ForegroundColor White
            Write-Host "    npm install" -ForegroundColor White
            Write-Host "    npm run build:win" -ForegroundColor White
            Write-Host ""
            exit 0
        } else {
            Write-Host "  winget 安装完成但 node 命令未生效" -ForegroundColor Yellow
            Write-Host "  请关闭并重新打开终端后再次运行此脚本或直接打包" -ForegroundColor Yellow
            Write-Host ""
            exit 0
        }
    } catch {
        Write-Host "  winget 安装失败：$_" -ForegroundColor Red
        Write-Host "  将尝试手动下载..." -ForegroundColor Yellow
    }
} else {
    Write-Host "  未检测到 winget，将使用手动下载方式" -ForegroundColor Yellow
}

# 3. 手动下载安装
Write-Host ""
Write-Host "[3/4] 手动下载 Node.js LTS..." -ForegroundColor Yellow

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
$installerUrl = "https://nodejs.org/dist/v20.11.1/node-v20.11.1-$arch.msi"
$installerPath = "$env:TEMP\nodejs-lts.msi"

Write-Host "  下载地址：$installerUrl" -ForegroundColor Cyan
Write-Host "  下载到：$installerPath" -ForegroundColor Cyan

try {
    Write-Host "  正在下载..." -ForegroundColor Cyan
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
    Write-Host "  下载完成" -ForegroundColor Green
} catch {
    Write-Host "  下载失败：$_" -ForegroundColor Red
    Write-Host ""
    Write-Host "  请手动下载并安装 Node.js LTS：" -ForegroundColor Yellow
    Write-Host "    https://nodejs.org/" -ForegroundColor White
    Write-Host "  安装完成后重新打开终端，运行：" -ForegroundColor Yellow
    Write-Host "    cd `"$PSScriptRoot`"" -ForegroundColor White
    Write-Host "    npm install" -ForegroundColor White
    Write-Host "    npm run build:win" -ForegroundColor White
    Write-Host ""
    exit 1
}

# 4. 运行安装
Write-Host ""
Write-Host "[4/4] 安装 Node.js..." -ForegroundColor Yellow

Write-Host "  正在安装，请稍候（可能需要管理员权限）..." -ForegroundColor Cyan
$installResult = Start-Process msiexec.exe -ArgumentList "/i `"$installerPath`" /quiet /norestart" -Wait -PassThru

if ($installResult.ExitCode -eq 0) {
    # 刷新 PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    
    $nodePath = Get-Command node -ErrorAction SilentlyContinue
    if ($nodePath) {
        $version = & node --version 2>$null
        Write-Host "  安装成功！版本：$version" -ForegroundColor Green
    } else {
        Write-Host "  安装完成，但需要重启终端才能生效" -ForegroundColor Yellow
    }
    
    Write-Host ""
    Write-Host "======================================================" -ForegroundColor Green
    Write-Host "  Node.js 安装完成！" -ForegroundColor Green
    Write-Host "======================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  下一步（请关闭并重新打开终端）：" -ForegroundColor Cyan
    Write-Host "    cd `"$PSScriptRoot`"" -ForegroundColor White
    Write-Host "    npm install" -ForegroundColor White
    Write-Host "    npm run build:win" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host "  安装失败，退出码：$($installResult.ExitCode)" -ForegroundColor Red
    Write-Host ""
    Write-Host "  请手动下载并安装：" -ForegroundColor Yellow
    Write-Host "    https://nodejs.org/" -ForegroundColor White
    Write-Host ""
}

# 清理临时文件
if (Test-Path $installerPath) {
    Remove-Item $installerPath -Force -ErrorAction SilentlyContinue
}
