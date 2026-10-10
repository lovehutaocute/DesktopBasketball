# tools/count-magenta.ps1 -- count bright-magenta (#ff00ff-ish) pixels per PNG.
#
# WHY: the --fly-* fixtures paint the ball as a solid magenta disc so that whatever
# magenta survives on the REAL screen is exactly the part that survived SetWindowRgn.
# "I looked at the screenshot and didn't see a ball" is not evidence; a pixel count is.
#
# USAGE  & tools\count-magenta.ps1 -Dir tools\shots\flyB
#
# LIMIT (revised 2026-10-05 evening) -- read this before trusting a zero:
#   "magenta=0" means ONE thing only: this frame did not carry the dynamic layer.
#   It does NOT mean SetWindowRgn clipped the ball. Measured on this machine:
#   an 18-shot burst came back 17 frames byte-identical, magenta=0 everywhere --
#   while the STATIC layer (hoop) and the DOM control bars WERE visible in those
#   same frames, and the app reported circles=1 with WindowFromPoint(ball) = OURS.
#   Root cause of that run: launched from the agent shell the GPU process crashes
#   3x and the app falls back to software compositing, in which the #dyn canvas
#   never reaches the screen at all. (The user's own double-clicked runs log ZERO
#   GPU crashes, so that capture environment was not representative.)
#   => Always check the static layer first. Only if the STATIC layer is missing
#      too is the window region a suspect. See README 6.7 for the full write-up.
#
# NOTE   keep this file pure ASCII.

param(
  [Parameter(Mandatory = $true)][string]$Dir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Get-ChildItem (Join-Path $Dir '*.png') | Sort-Object Name | ForEach-Object {
  $bmp = [System.Drawing.Bitmap]::FromFile($_.FullName)
  $n = 0
  $minX = [int]::MaxValue; $maxX = -1; $minY = [int]::MaxValue; $maxY = -1
  # Step 2 keeps this under a second per frame; a 34px-radius disc is still ~900 hits.
  for ($y = 0; $y -lt $bmp.Height; $y += 2) {
    for ($x = 0; $x -lt $bmp.Width; $x += 2) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.R -gt 200 -and $c.G -lt 90 -and $c.B -gt 200) {
        $n++
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $bmp.Dispose()
  if ($n -gt 0) {
    $cx = [int](($minX + $maxX) / 2); $cy = [int](($minY + $maxY) / 2)
    "$($_.Name) magenta=$n bbox=[$minX,$minY]-[$maxX,$maxY] center=$cx,$cy span=$($maxX-$minX)x$($maxY-$minY)"
  } else {
    "$($_.Name) magenta=0"
  }
}
