# tools/screencap.ps1 -- grab the real screen (not the renderer's own composite).
#
# WHY THIS EXISTS
#   `webContents.capturePage()` reads the renderer's compositing result. It knows
#   nothing about (a) the window region set by SetWindowRgn, or (b) which window
#   is actually on top. So it will happily show a hoop that is clipped away, or
#   balls that are covered by another window. This script captures what the user
#   actually sees.
#
#   Same for Electron's desktopCapturer: on this machine it hands back one stale
#   bitmap over and over (8 shots byte-identical, even across a process restart),
#   so a flying ball can never be caught with it. GDI+ CopyFromScreen can.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\screencap.ps1 `
#     -Out tools\shots\screencap.png
#
#   Burst mode (the reason for -Count): a ball crossing the window at 1300 px/s is
#   only in a given spot for a few ms, so a single shot is a lottery. Grab a series
#   in one process and let the analysis pick the frame that caught it.
#     ... -Out tools\shots\burst\c.png -Count 8 -GapMs 250 -StartDelayMs 6000
#   -> tools\shots\burst\c_00.png ... c_07.png, plus a "SHOT <file> t=<ms>" line per
#      frame so the app's own log can be lined up with it.
#
# NOTE  keep this file pure ASCII.

param(
  [string]$Out = 'tools\shots\screencap.png',
  [int]$Count = 1,
  [int]$GapMs = 250,
  [int]$StartDelayMs = 0,
  [switch]$NoSync
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# DwmFlush() blocks until the desktop compositor has finished the next pass.
# Without it a grab can return the *previous* composition - on this machine that is
# not a theoretical worry: a burst of 12 shots came back byte-identical several
# times in a row while the overlay was redrawing a ball at 60 Hz.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ScSync {
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr r, IntPtr u, uint f);
  public static void Flush() { DwmFlush(); }
  public static void Repaint() {
    // RDW_INVALIDATE|RDW_ERASE|RDW_ALLCHILDREN|RDW_UPDATENOW|RDW_ERASENOW
    RedrawWindow(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0x0001 | 0x0004 | 0x0080 | 0x0100 | 0x0200);
  }
}
"@

if ($Count -lt 1) { $Count = 1 }

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
  Write-Output ('START {0}' -f (Get-Date).ToString('o'))
  if ($StartDelayMs -gt 0) { Start-Sleep -Milliseconds $StartDelayMs }
  for ($i = 0; $i -lt $Count; $i++) {
    if ($i -gt 0) { Start-Sleep -Milliseconds $GapMs }
    if (-not $NoSync) { [ScSync]::Repaint(); [ScSync]::Flush() }
    # Timestamp MUST be taken before CopyFromScreen. PNG encode + flush costs
    # 50~100ms; stamping after it shifts the "capture instant" forward and invents
    # a lag that is not there (the first cut of this tool did exactly that and
    # reported "the frame trails the ball by 70ms" for every single shot).
    $tBefore = $sw.ElapsedMilliseconds
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $tCopied = $sw.ElapsedMilliseconds
    if ($Count -eq 1) {
      $path = $Out
    } else {
      $dir = Split-Path -Parent $Out
      $name = [System.IO.Path]::GetFileNameWithoutExtension($Out)
      $ext = [System.IO.Path]::GetExtension($Out)
      $path = Join-Path $dir ('{0}_{1:d2}{2}' -f $name, $i, $ext)
    }
    $d = Split-Path -Parent $path
    if ($d -and -not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ('SHOT {0} t={1}ms copy={2}ms' -f $path, $tBefore, ($tCopied - $tBefore))
  }
  Write-Output ('SAVED {0} frame(s) {1}x{2}' -f $Count, $bounds.Width, $bounds.Height)
} finally {
  $g.Dispose()
  $bmp.Dispose()
}
