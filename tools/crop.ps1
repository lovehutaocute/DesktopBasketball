# tools/crop.ps1 -- crop + nearest-neighbour zoom a region of a PNG.
#
# WHY THIS EXISTS
#   Verdicts on this project are often sub-pixel at 1:1 ("is the control bar
#   actually drawn?", "did the ball's seam collapse?"). Reading the raw
#   screenshot is not enough; zoom the exact rectangle instead of guessing.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\crop.ps1 `
#     -In tools\shots\screen.png -Out tools\shots\_crop_ctrl.png `
#     -X 0 -Y 750 -W 120 -H 110 -Zoom 4
#
# NOTE  keep this file pure ASCII.

param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][int]$W,
  [Parameter(Mandatory=$true)][int]$H,
  [int]$Zoom = 3
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Resolve-Path $In).Path)
try {
  if ($X + $W -gt $src.Width -or $Y + $H -gt $src.Height) {
    Write-Output ('WARN: crop rect exceeds image ({0}x{1}) -- clamping' -f $src.Width, $src.Height)
    $W = [Math]::Min($W, $src.Width - $X)
    $H = [Math]::Min($H, $src.Height - $Y)
  }
  $dst = New-Object System.Drawing.Bitmap ($W * $Zoom), ($H * $Zoom)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $srcRect = New-Object System.Drawing.Rectangle $X, $Y, $W, $H
    $dstRect = New-Object System.Drawing.Rectangle 0, 0, ($W * $Zoom), ($H * $Zoom)
    $g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  } finally { $g.Dispose() }
  $dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose()
  Write-Output ('SAVED {0}  src={1},{2} {3}x{4}  zoom={5}' -f $Out, $X, $Y, $W, $H, $Zoom)
} finally {
  $src.Dispose()
}
