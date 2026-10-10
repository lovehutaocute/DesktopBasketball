param(
  [string]$Out = 'tools\shots\desktop.png',
  [int]$Count = 1,
  [int]$GapMs = 160,
  [int]$StartDelayMs = 0,
  [switch]$Restore
)

# tools/cap-desktop.ps1 - screen grab with all normal windows minimized first.
#
# WHY: this project's overlay sits between the desktop and normal windows, so a
# foreground app (the IDE / editor) hides it entirely - a plain screen grab shows
# only that app, and you would wrongly conclude "the fire trail does not render".
# Shell.Application's MinimizeAll() is a user-level shell verb (it is what Win+D
# does), so the desktop becomes visible and the overlay is on top of it.
#
# NOTE keep this file pure ASCII.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DwmF { [DllImport("dwmapi.dll")] public static extern int DwmFlush(); public static void F(){ DwmFlush(); } }
"@

if ($Count -lt 1) { $Count = 1 }

$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Milliseconds 450

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  Write-Output ('START {0}' -f (Get-Date).ToString('o'))
  if ($StartDelayMs -gt 0) { Start-Sleep -Milliseconds $StartDelayMs }
  for ($i = 0; $i -lt $Count; $i++) {
    if ($i -gt 0) { Start-Sleep -Milliseconds $GapMs }
    [DwmF]::F()
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    if ($Count -eq 1) { $path = $Out }
    else {
      $dir = Split-Path -Parent $Out
      $name = [System.IO.Path]::GetFileNameWithoutExtension($Out)
      $ext = [System.IO.Path]::GetExtension($Out)
      $path = Join-Path $dir ('{0}_{1:d2}{2}' -f $name, $i, $ext)
    }
    $d = Split-Path -Parent $path
    if ($d -and -not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ('SHOT {0}' -f $path)
  }
  Write-Output ('SAVED {0} frame(s)' -f $Count)
} finally {
  $g.Dispose(); $bmp.Dispose()
  if ($Restore) { $shell.UndoMinimizeAll() }
}
