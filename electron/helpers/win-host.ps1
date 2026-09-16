# AI智译 Windows helper (STA)
# Commands (JSON line in, JSON line out):
#   keys | uia | ocr | exstyle | ping | quit
# Observation only: never Select/SetFocus/Invoke/SendKeys/clipboard.

$ErrorActionPreference = 'Continue'
[Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding           = [Console]::OutputEncoding

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeWin {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
}
"@

try { [void][NativeWin]::SetProcessDpiAwareness(2) } catch { try { [void][NativeWin]::SetProcessDPIAware() } catch {} }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$script:OcrReady = $false
$script:OcrEngine = $null
$script:AsTaskOp = $null

function Get-AsTaskOp {
  if ($script:AsTaskOp) { return $script:AsTaskOp }
  $script:AsTaskOp = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  if (-not $script:AsTaskOp) { throw 'WindowsRuntime AsTask(IAsyncOperation) not found' }
  return $script:AsTaskOp
}

function Await-Op($op, [Type]$resultType) {
  if ($null -eq $op) { return $null }
  $gm = (Get-AsTaskOp).MakeGenericMethod($resultType)
  $task = $gm.Invoke($null, @($op))
  if (-not $task.Wait(20000)) { throw 'WinRT timeout' }
  if ($task.IsFaulted) { throw $task.Exception.GetBaseException() }
  return $task.Result
}

function Write-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 10
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Get-Keys {
  return @{
    alt     = (([NativeWin]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0)
    ctrl    = (([NativeWin]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0)
    shift   = (([NativeWin]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0)
    lbutton = (([NativeWin]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0)
    rbutton = (([NativeWin]::GetAsyncKeyState(0x02) -band 0x8000) -ne 0)
    escape  = (([NativeWin]::GetAsyncKeyState(0x1B) -band 0x8000) -ne 0)
  }
}

function Set-NoActivateStyle([string]$hwndStr) {
  $hwnd = [IntPtr]::new([int64]$hwndStr)
  $GWL_EXSTYLE = -20
  $WS_EX_NOACTIVATE = [int64]0x08000000
  $WS_EX_TOOLWINDOW = [int64]0x00000080
  $WS_EX_TOPMOST    = [int64]0x00000008
  $ex = [NativeWin]::GetWindowLongPtr($hwnd, $GWL_EXSTYLE).ToInt64()
  $next = $ex -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW -bor $WS_EX_TOPMOST
  [void][NativeWin]::SetWindowLongPtr($hwnd, $GWL_EXSTYLE, [IntPtr]::new($next))
  $SWP = [uint32](0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0020) # NOSIZE|NOMOVE|NOACTIVATE|FRAMECHANGED
  [void][NativeWin]::SetWindowPos($hwnd, [IntPtr]::new(-1), 0, 0, 0, 0, $SWP)
  return @{
    hwnd = $hwndStr
    exstyle_before = ('0x{0:X}' -f $ex)
    exstyle_after  = ('0x{0:X}' -f $next)
    noactivate = $true
  }
}

function Get-UiaText($x, $y, $unit) {
  $pt = New-Object System.Windows.Point([double]$x, [double]$y)
  $el = $null
  try { $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt) } catch { $el = $null }
  if (-not $el) {
    return @{ text = ''; source = 'uia-miss'; meta = @{ reason = 'ElementFromPoint null' } }
  }

  $meta = @{
    name         = [string]$el.Current.Name
    controlType  = [string]$el.Current.LocalizedControlType
    className    = [string]$el.Current.ClassName
    framework    = [string]$el.Current.FrameworkId
    automationId = [string]$el.Current.AutomationId
  }

  $tp = $null
  $cur = $el
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  for ($i = 0; $i -lt 6 -and $cur; $i++) {
    try {
      $tp = $cur.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      if ($tp) { break }
    } catch { $tp = $null }
    try { $cur = $walker.GetParent($cur) } catch { $cur = $null }
  }

  if ($tp) {
    try {
      $range = $tp.RangeFromPoint($pt)
      $textUnit = [System.Windows.Automation.TextUnit]::Word
      if ($unit -eq 'paragraph') { $textUnit = [System.Windows.Automation.TextUnit]::Paragraph }
      elseif ($unit -eq 'line' -or $unit -eq 'sentence') { $textUnit = [System.Windows.Automation.TextUnit]::Line }
      elseif ($unit -eq 'document') { $textUnit = [System.Windows.Automation.TextUnit]::Document }
      $range.ExpandToEnclosingUnit($textUnit)
      if ($unit -eq 'phrase') {
        $range.ExpandToEnclosingUnit([System.Windows.Automation.TextUnit]::Word)
        [void]$range.MoveEndpointByUnit(
          [System.Windows.Automation.TextPatternRangeEndpoint]::End,
          [System.Windows.Automation.TextUnit]::Word,
          4
        )
      }
      # NEVER call $range.Select() — would change native selection
      $text = $range.GetText(500)
      if ($text -and $text.Length -gt 0) {
        if ($text.Length -gt 400 -and $unit -ne 'paragraph') {
          $range.ExpandToEnclosingUnit([System.Windows.Automation.TextUnit]::Word)
          $text = $range.GetText(200)
        }
        return @{
          text   = $text.Trim()
          source = 'uia-textpattern'
          meta   = $meta
          note   = 'RangeFromPoint+ExpandToEnclosingUnit; Select not called; focus/clipboard untouched'
        }
      }
    } catch {
      $meta.uiaError = [string]$_.Exception.Message
    }
  }

  $name = [string]$el.Current.Name
  $ct = [string]$el.Current.LocalizedControlType
  $useName = $name -and $name.Length -gt 0 -and $name.Length -le 180
  $looksDocument = $ct -match 'document|documentpane|edit'
  if ($useName -and -not $looksDocument) {
    return @{ text = $name.Trim(); source = 'uia-name'; meta = $meta }
  }
  return @{ text = ''; source = 'uia-empty'; meta = $meta }
}

function Ensure-Ocr {
  if ($script:OcrReady) { return }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
    $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $script:OcrEngine) {
      $lang = New-Object Windows.Globalization.Language('en-US')
      $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    }
    if (-not $script:OcrEngine) {
      $lang = New-Object Windows.Globalization.Language('zh-CN')
      $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    }
    $script:OcrReady = $true
  } catch {
    $script:OcrReady = $false
    throw
  }
}

function Invoke-Ocr([string]$path) {
  Ensure-Ocr
  if (-not $script:OcrEngine) { throw 'Windows OCR engine unavailable (install OCR language pack)' }
  $file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert(
        $bitmap,
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied
      )
      $bitmap.Dispose()
      $bitmap = $converted
    } catch {}
    $result = Await-Op ($script:OcrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
      $words = @()
      $minX = 1e9; $minY = 1e9; $maxX = 0; $maxY = 0
      foreach ($word in $line.Words) {
        $r = $word.BoundingRect
        $bbox = @{ x = [double]$r.X; y = [double]$r.Y; width = [double]$r.Width; height = [double]$r.Height }
        $words += @{ text = [string]$word.Text; bbox = $bbox; confidence = 1 }
        if ($r.X -lt $minX) { $minX = $r.X }
        if ($r.Y -lt $minY) { $minY = $r.Y }
        if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
        if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
      }
      if ($words.Count -eq 0) { continue }
      $lines += @{
        text = [string]$line.Text
        bbox = @{ x = [double]$minX; y = [double]$minY; width = [double]($maxX - $minX); height = [double]($maxY - $minY) }
        confidence = 1
        words = $words
      }
    }
    $lang = ''
    try { $lang = [string]$script:OcrEngine.RecognizerLanguage.LanguageTag } catch { $lang = '' }
    return @{
      engine   = 'windows'
      language = $lang
      text     = [string]$result.Text
      lines    = @($lines)
    }
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

Write-Json @{ ready = $true; sta = $true; pid = $PID }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $trim = $line.Trim()
  if ($trim -eq '') { continue }
  $req = $null
  try { $req = $trim | ConvertFrom-Json } catch {
    Write-Json @{ ok = $false; error = 'invalid json' }
    continue
  }
  $id = $req.id
  $cmd = [string]$req.cmd
  try {
    $data = $null
    switch ($cmd) {
      'ping'    { $data = @{ pong = $true } }
      'keys'    { $data = Get-Keys }
      'quit'    { $data = @{ bye = $true } }
      'uia'     { $data = Get-UiaText $req.x $req.y ([string]$req.unit) }
      'ocr'     { $data = Invoke-Ocr ([string]$req.path) }
      'exstyle' { $data = Set-NoActivateStyle ([string]$req.hwnd) }
      default   { throw "unknown cmd $cmd" }
    }
    Write-Json @{ id = $id; ok = $true; data = $data }
    if ($cmd -eq 'quit') { break }
  } catch {
    Write-Json @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
  }
}
