# ============================================================
# AI智译 · 应用图标生成脚本
# 用系统字体绘制「译」字，生成多尺寸 PNG + ICO
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Generate app icon" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

$buildDir = Join-Path $PSScriptRoot "build"
if (-not (Test-Path $buildDir)) {
    New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
}

$iconPath = Join-Path $buildDir "icon.ico"

Write-Host "[1/3] Generating PNG icons..." -ForegroundColor Yellow

Add-Type -AssemblyName System.Drawing

$sizes = @(256, 128, 64, 48, 32, 16)
$bitmaps = @()

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = "AntiAlias"
    $g.InterpolationMode = "HighQualityBicubic"
    $g.PixelOffsetMode = "HighQuality"
    $g.TextRenderingHint = "AntiAliasGridFit"
    $g.Clear([System.Drawing.Color]::Transparent)

    $rectPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [Math]::Max(2, [int]($size * 0.22))
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $rectPath.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
    $rectPath.AddArc($rect.Right - $r, $rect.Y, $r, $r, 270, 90)
    $rectPath.AddArc($rect.Right - $r, $rect.Bottom - $r, $r, $r, 0, 90)
    $rectPath.AddArc($rect.X, $rect.Bottom - $r, $r, $r, 90, 90)
    $rectPath.CloseFigure()

    $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 59, 130, 246),
        [System.Drawing.Color]::FromArgb(255, 34, 211, 238),
        45
    )
    $g.FillPath($gradient, $rectPath)

    $highlightPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $highlightRect = New-Object System.Drawing.Rectangle(0, 0, $size, [int]($size * 0.5))
    $highlightPath.AddArc($highlightRect.X, $highlightRect.Y, $r, $r, 180, 90)
    $highlightPath.AddArc($highlightRect.Right - $r, $highlightRect.Y, $r, $r, 270, 90)
    $highlightPath.AddLine($highlightRect.Right, $highlightRect.Y + $r, $highlightRect.Right, $highlightRect.Bottom)
    $highlightPath.AddLine($highlightRect.X, $highlightRect.Bottom, $highlightRect.X, $highlightRect.Y + $r)
    $highlightPath.CloseFigure()
    $highlightBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 255, 255, 255))
    $g.FillPath($highlightBrush, $highlightPath)

    $fontSize = [int]($size * 0.55)
    if ($fontSize -lt 8) { $fontSize = 8 }
    $font = New-Object System.Drawing.Font("Microsoft YaHei UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

    $shadowRect = New-Object System.Drawing.RectangleF(1, 2, $size, $size)
    $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(60, 0, 0, 0))
    $glyph = [char]0x8BD1
    $g.DrawString("$glyph", $font, $shadowBrush, $shadowRect, $sf)
    $textRect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $g.DrawString("$glyph", $font, $textBrush, $textRect, $sf)

    $pngPath = Join-Path $buildDir "icon-$size.png"
    $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($size -eq 256) {
        $bmp.Save((Join-Path $buildDir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    }

    $bitmaps += $bmp
    $g.Dispose()
    $font.Dispose()
    $gradient.Dispose()
    $highlightBrush.Dispose()
    $textBrush.Dispose()
    $shadowBrush.Dispose()
}

Write-Host "[2/3] Writing ICO..." -ForegroundColor Yellow

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)

$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$bitmaps.Count)

$dataOffset = 6 + ($bitmaps.Count * 16)
$entries = @()
foreach ($bmp in $bitmaps) {
    $pngMs = New-Object System.IO.MemoryStream
    $bmp.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $pngMs.ToArray()
    $pngMs.Dispose()

    $entries += @{
        size = $pngBytes.Length
        offset = $dataOffset
        data = $pngBytes
    }

    $w = if ($bmp.Width -ge 256) { [byte]0 } else { [byte]$bmp.Width }
    $h = if ($bmp.Height -ge 256) { [byte]0 } else { [byte]$bmp.Height }
    $bw.Write($w)
    $bw.Write($h)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$pngBytes.Length)
    $bw.Write([UInt32]$dataOffset)

    $dataOffset += $pngBytes.Length
}

foreach ($entry in $entries) {
    $bw.Write($entry.data)
}

$bytes = $ms.ToArray()
[System.IO.File]::WriteAllBytes($iconPath, $bytes)
$ms.Dispose()
$bw.Dispose()

foreach ($bmp in $bitmaps) { $bmp.Dispose() }

Write-Host "[3/3] Done" -ForegroundColor Green
$fileSize = (Get-Item $iconPath).Length
Write-Host ""
Write-Host "  icon: $iconPath" -ForegroundColor Green
Write-Host "  size: $fileSize bytes" -ForegroundColor Green
Write-Host "  sizes: 256 / 128 / 64 / 48 / 32 / 16" -ForegroundColor Green
Write-Host ""
