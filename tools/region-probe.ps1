# tools/region-probe.ps1 -- does the *drawn* content actually sit inside the
# window region (SetWindowRgn)?
#
# WHY THIS EXISTS
#   A transparent overlay gets shaped with SetWindowRgn. Anything outside that
#   region is NOT PAINTED AT ALL. So "the hoop is invisible" can be a region bug,
#   not a drawing bug -- and `webContents.capturePage()` will happily show a
#   perfectly drawn hoop, because it reads the renderer's own compositing result
#   and knows nothing about the window region.
#
# THE TEST
#   WindowFromPoint at a point that has drawn content must resolve to the
#   overlay (otherwise that pixel is clipped away). A desktop blank point must
#   NOT resolve to it (otherwise we are stealing desktop clicks).
#
# USAGE  (PowerShell, NOT Git Bash)
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\region-probe.ps1 `
#     -Points '1348,492,backboard','1412,700,pole','300,400,desktop-blank'
#
# Exit code 0 = pass, 1 = at least one point is wrong.
#
# NOTE  keep this file pure ASCII (Windows PowerShell 5.1 reads .ps1 as ANSI
#       without a BOM).

param(
  [string[]]$Points = @(
    '1348,492,backboard',
    '1175,530,rim-left',
    '1233,595,net',
    '1412,700,pole',
    '1412,840,stand-base',
    '23,790,ctrl-add',
    '23,829,ctrl-minus',
    '300,400,desktop-blank'
  ),
  [int]$ExpectAtLeast = 0
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class RP {
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flag);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static string Cls(IntPtr h){ var sb=new StringBuilder(256); GetClassNameW(h,sb,256); return sb.ToString(); }
  public static string Txt(IntPtr h){ var sb=new StringBuilder(512); GetWindowTextW(h,sb,512); return sb.ToString(); }
  public static IntPtr Hit(int x,int y){ var p=new POINT(); p.X=x; p.Y=y; var h=WindowFromPoint(p); return h==IntPtr.Zero?h:GetAncestor(h,2); }
}
"@
if (-not ('RP' -as [type])) { throw 'Add-Type failed: RP helper type was not created.' }

# --- locate the overlay (same discriminator as zorder-probe.ps1) -------------
$MASK = 0x08000080
$overlay = [IntPtr]::Zero
$cur = [RP]::GetTopWindow([IntPtr]::Zero)
$guard = 0
while ($cur -ne [IntPtr]::Zero -and $guard++ -lt 4000) {
  if ([RP]::IsWindowVisible($cur) -and ([RP]::Cls($cur) -eq 'Chrome_WidgetWin_1')) {
    if (([RP]::GetWindowLong($cur, -20) -band $MASK) -eq $MASK) { $overlay = $cur }
  }
  $cur = [RP]::GetWindow($cur, 2)
}
if ($overlay -eq [IntPtr]::Zero) {
  Write-Output 'FAIL: no desktop overlay found. Is the app running?'
  exit 1
}
Write-Output ('OVERLAY 0x{0:x} "{1}"' -f $overlay.ToInt64(), [RP]::Txt($overlay))
Write-Output ('POINTS  {0} probe point(s)' -f $Points.Count)
Write-Output ''

# Guard: `powershell -File` does not bind a [string[]] from the command line the
# way you'd expect -- the whole comma-joined list can arrive as ONE element,
# which silently degrades this into a single-point probe that still prints PASS.
# So: refuse to run on a suspiciously short list instead of lying.
if ($Points.Count -lt 2) {
  Write-Output ('ABORT: only {0} point(s) parsed -- -File cannot bind [string[]] reliably.' -f $Points.Count)
  Write-Output '       Re-run without -Points to use the built-in default set.'
  exit 2
}

$fail = 0
foreach ($spec in $Points) {
  $parts = $spec.Split(',')
  if ($parts.Count -lt 3) { continue }
  $x = [int]$parts[0]; $y = [int]$parts[1]; $label = $parts[2]
  $h = [RP]::Hit($x, $y)
  $isOurs = ($h -eq $overlay)
  $want = -not $label.StartsWith('desktop')
  $ok = ($isOurs -eq $want)
  if (-not $ok) { $fail++ }
  $verdict = if ($isOurs) { 'OURS (in region)' } else { ('other 0x{0:x}' -f $h.ToInt64()) }
  Write-Output ('{0,-16} @{1,5},{2,-4} {3,-22} {4}' -f $label, $x, $y, $verdict, $(if ($ok) { 'ok' } else { 'WRONG' }))
}

Write-Output ''
if ($fail -eq 0) {
  Write-Output 'RESULT: PASS'
  exit 0
}
Write-Output ('RESULT: FAIL ({0} wrong point(s))' -f $fail)
exit 1
