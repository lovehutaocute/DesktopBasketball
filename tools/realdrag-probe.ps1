# tools/realdrag-probe.ps1 -- drive a REAL mouse drag (SetCursorPos + mouse_event) and
# hold the button down at a point far away from the ball.
#
# WHY THIS EXISTS
#   The window region (SetWindowRgn) is what decides whether the pointer still belongs
#   to the overlay. While dragging, sendShape() widens that region (by default to the
#   whole window; bench.region='corridor' narrows it to the ball->pointer box instead),
#   so the pointer must keep landing inside it or pointermove leaks to the desktop and
#   the drag silently dies. This script proves it end to end: it presses on the ball,
#   then parks the cursor 400+ px away and keeps holding, so the app's --diag dump
#   (fired mid-hold) can report dragging=true plus the ball position following the cursor.
#
#   Synthetic events cannot fake this: they bypass the OS hit test, which is exactly
#   the thing being verified.
#
# USAGE (keep the timings aligned with --capture-delay on the app side)
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\realdrag-probe.ps1 `
#     -BallX 700 -BallY 784 -AwayX 250 -AwayY 350 -HoldSec 12
#
#   To check that the region is RESTORED after release, start the drag early so it ends
#   before --capture-delay fires, e.g. -StartDelaySec 4 -HoldSec 3 with --capture-delay=12000.
#
# NOTE  keep this file pure ASCII (Windows PowerShell 5.1 reads .ps1 as ANSI).

param(
  [int]$BallX = 700,
  [int]$BallY = 784,
  [int]$AwayX = 250,
  [int]$AwayY = 350,
  [int]$HoldSec = 12,
  [double]$StartDelaySec = 0,
  [string]$StartAtFile = '',
  [int]$StartAtOffsetMs = 0
)

$ErrorActionPreference = 'Stop'

# Absolute-time alignment: the app writes its launch epoch (ms) to $StartAtFile, and this
# script waits until elapsed == StartAtOffsetMs before acting. More reliable than
# StartDelaySec, because PowerShell's own startup cost (1~5s) no longer skews the timing.
if ($StartAtFile -ne '' -and (Test-Path $StartAtFile)) {
  $t0 = [long](Get-Content $StartAtFile -Raw).Trim()
  $nowMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  $waitMs = ($t0 + $StartAtOffsetMs) - $nowMs
  if ($waitMs -gt 0) { Start-Sleep -Milliseconds $waitMs }
  Write-Output ("aligned: elapsed={0}ms (target {1}ms)" -f ((Get-Date).ToUniversalTime() - [DateTime]::UnixEpoch).TotalMilliseconds, $StartAtOffsetMs)
}

if ($StartDelaySec -gt 0) { Start-Sleep -Milliseconds ([int]($StartDelaySec * 1000)) }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class RDrag {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public static void Down() { mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero); }
  public static void Up()   { mouse_event(LEFTUP,   0, 0, 0, IntPtr.Zero); }
}
'@

$orig = New-Object RDrag+POINT
[void][RDrag]::GetCursorPos([ref]$orig)
Write-Output ("cursor before: {0},{1}" -f $orig.X, $orig.Y)

try {
  # 1. press on the ball
  [void][RDrag]::SetCursorPos($BallX, $BallY)
  Start-Sleep -Milliseconds 300
  [RDrag]::Down()
  Write-Output ("DOWN at {0},{1}" -f $BallX, $BallY)
  Start-Sleep -Milliseconds 150

  # 2. jump far away (well outside any ball disc) and keep holding with small jitter
  [void][RDrag]::SetCursorPos($AwayX, $AwayY)
  Write-Output ("MOVED AWAY to {0},{1} (button still held)" -f $AwayX, $AwayY)

  $t0 = Get-Date
  $i = 0
  while (((Get-Date) - $t0).TotalSeconds -lt $HoldSec) {
    $i++
    $dx = [int](3 * [Math]::Sin($i / 3.0))
    $dy = [int](3 * [Math]::Cos($i / 4.0))
    [void][RDrag]::SetCursorPos($AwayX + $dx, $AwayY + $dy)
    Start-Sleep -Milliseconds 120
  }
  Write-Output ("held for {0}s, {1} jitter moves" -f $HoldSec, $i)
}
finally {
  [RDrag]::Up()
  Write-Output "UP"
  [void][RDrag]::SetCursorPos($orig.X, $orig.Y)
  Write-Output ("cursor restored: {0},{1}" -f $orig.X, $orig.Y)
}
