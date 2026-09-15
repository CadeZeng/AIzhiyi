# ============================================================
# AI智译 · 应用图标生成脚本
# 生成 256x256 多尺寸 .ico 文件
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  AI智译 · 应用图标生成" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

$buildDir = Join-Path $PSScriptRoot "build"
if (-not (Test-Path $buildDir)) {
    New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
}

$iconPath = Join-Path $buildDir "icon.ico"

# 如果已存在，跳过
if (Test-Path $iconPath) {
    $size = (Get-Item $iconPath).Length
    if ($size -gt 1000) {
        Write-Host "  图标已存在：$iconPath ($size bytes)" -ForegroundColor Green
        Write-Host "  如需重新生成，请先删除该文件" -ForegroundColor Yellow
        exit 0
    }
}

Write-Host "[1/3] 生成 256x256 PNG 图标..." -ForegroundColor Yellow

# 使用 .NET System.Drawing 绘制图标
Add-Type -AssemblyName System.Drawing

$sizes = @(256, 128, 64, 48, 32, 16)
$bitmaps = @()

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = "AntiAlias"
    $g.InterpolationMode = "HighQualityBicubic"
    $g.PixelOffsetMode = "HighQuality"
    $g.Clear([System.Drawing.Color]::Transparent)

    # 圆角矩形背景：蓝青渐变
    $rectPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [int]($size * 0.22)  # 圆角半径
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $rectPath.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
    $rectPath.AddArc($rect.Right - $r, $rect.Y, $r, $r, 270, 90)
    $rectPath.AddArc($rect.Right - $r, $rect.Bottom - $r, $r, $r, 0, 90)
    $rectPath.AddArc($rect.X, $rect.Bottom - $r, $r, $r, 90, 90)
    $rectPath.CloseFigure()

    $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 59, 130, 246),    # #3B82F6
        [System.Drawing.Color]::FromArgb(255, 34, 211, 238),    # #22D3EE
        45
    )
    $g.FillPath($gradient, $rectPath)

    # 高光层（上半部分）
    $highlightPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $highlightRect = New-Object System.Drawing.Rectangle(0, 0, $size, [int]($size * 0.5))
    $highlightPath.AddArc($highlightRect.X, $highlightRect.Y, $r, $r, 180, 90)
    $highlightPath.AddArc($highlightRect.Right - $r, $highlightRect.Y, $r, $r, 270, 90)
    $highlightPath.AddLine($highlightRect.Right, $highlightRect.Y + $r, $highlightRect.Right, $highlightRect.Bottom)
    $highlightPath.AddLine($highlightRect.X, $highlightRect.Bottom, $highlightRect.X, $highlightRect.Y + $r)
    $highlightPath.CloseFigure()
    $highlightBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 255, 255, 255))
    $g.FillPath($highlightBrush, $highlightPath)

    # 绘制文字 "译"
    $fontSize = [int]($size * 0.55)
    $font = New-Object System.Drawing.Font("Microsoft YaHei UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

    # 文字阴影
    $shadowRect = New-Object System.Drawing.RectangleF(1, 2, $size, $size)
    $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(60, 0, 0, 0))
    $g.DrawString("译", $font, $shadowBrush, $shadowRect, $sf)
    # 主文字
    $textRect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $g.DrawString("译", $font, $textBrush, $textRect, $sf)

    $bitmaps += $bmp
    $g.Dispose()
    $font.Dispose()
}

Write-Host "[2/3] 转换为 .ico 多尺寸格式..." -ForegroundColor Yellow

# 从内存中的 bitmaps 生成 ICO
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)

# ICO 文件头
$bw.Write([UInt16]0)      # 保留字 0
$bw.Write([UInt16]1)      # 类型：1 = ICO
$bw.Write([UInt16]$bitmaps.Count)  # 图像数量

# 写入目录
$dataOffset = 6 + ($bitmaps.Count * 16)
$entries = @()
$index = 0
foreach ($bmp in $bitmaps) {
    # 转换为 PNG 字节（ICO 支持 PNG 嵌入）
    $pngMs = New-Object System.IO.MemoryStream
    $bmp.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $pngMs.ToArray()
    $pngMs.Dispose()

    $entries += @{
        width = if ($bmp.Width -ge 256) { 0 } else { $bmp.Width }
        height = if ($bmp.Height -ge 256) { 0 } else { $bmp.Height }
        size = $pngBytes.Length
        offset = $dataOffset
        data = $pngBytes
    }

    # 写入目录条目
    $w = if ($bmp.Width -ge 256) { [byte]0 } else { [byte]$bmp.Width }
    $h = if ($bmp.Height -ge 256) { [byte]0 } else { [byte]$bmp.Height }
    $bw.Write($w)                  # 宽度
    $bw.Write($h)                  # 高度
    $bw.Write([byte]0)             # 调色板颜色数（0 = 无）
    $bw.Write([byte]0)             # 保留字
    $bw.Write([UInt16]1)           # 色面数
    $bw.Write([UInt16]32)          # 每像素位数
    $bw.Write([UInt32]$pngBytes.Length)  # 图像数据大小
    $bw.Write([UInt32]$dataOffset)       # 数据偏移

    $dataOffset += $pngBytes.Length
    $index++
}

# 写入图像数据
foreach ($entry in $entries) {
    $bw.Write($entry.data)
}

# 保存到文件
$bytes = $ms.ToArray()
[System.IO.File]::WriteAllBytes($iconPath, $bytes)
$ms.Dispose()
$bw.Dispose()

# 释放 bitmaps
foreach ($bmp in $bitmaps) { $bmp.Dispose() }

Write-Host "[3/3] 完成" -ForegroundColor Green
$fileSize = (Get-Item $iconPath).Length
Write-Host ""
Write-Host "  图标已生成：$iconPath" -ForegroundColor Green
Write-Host "  文件大小：$fileSize bytes" -ForegroundColor Green
Write-Host "  尺寸：256 / 128 / 64 / 48 / 32 / 16" -ForegroundColor Green
Write-Host ""
