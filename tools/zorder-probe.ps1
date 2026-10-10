# tools/zorder-probe.ps1 -- independent z-order auditor for the desktop overlay.
#
# WHY THIS EXISTS
#   The overlay's own `--diag` output is produced by the same code that does the
#   placing, so it is not fully independent evidence. This script re-derives the
#   answer from raw Win32 calls only.
#
# WHAT IT PROVES
#   1. The overlay sits *directly above* the desktop-icon anchor (Progman / the
#      SHELLDLL_DefView host) and *below* every other visible window.
#   2. WindowFromPoint over a grid never resolves to the overlay, i.e. the balls
#      are never the top-most thing under the cursor.
#
# USAGE  (PowerShell, NOT Git Bash -- the bash tool blocks invoking powershell)
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\zorder-probe.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\zorder-probe.ps1 -ProbeX 600,700 -ProbeY 356,420
#
# Exit code 0 = pass, 1 = the invariant is broken.
#
# NOTE  keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 as ANSI when
#       there is no BOM, so any non-ASCII literal would silently rot.

param(
  [int[]]$ProbeX = @(139, 360, 600, 720, 1000, 1300),
  [int[]]$ProbeY = @(300, 420, 700, 818)
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ZP {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  // CharSet.Unicode is MANDATORY on the W-suffixed entries: with the default
  // (Ansi) the StringBuilder is marshalled as an ANSI buffer, the W function
  // writes UTF-16 into it, and every name comes back empty -- which silently
  // turns this probe into "no windows found".
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr p, IntPtr c, string cls, string win);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flag);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static string Cls(IntPtr h){ var sb=new StringBuilder(256); GetClassNameW(h,sb,256); return sb.ToString(); }
  public static string Txt(IntPtr h){ var sb=new StringBuilder(512); GetWindowTextW(h,sb,512); return sb.ToString(); }
  public static IntPtr Hit(int x,int y){ var p=new POINT(); p.X=x; p.Y=y; var h=WindowFromPoint(p); return h==IntPtr.Zero?h:GetAncestor(h,2); }
}
"@

# Fail loudly if the P/Invoke shim did not compile -- otherwise every later
# call site dies with a confusing "cannot find type [ZP]" instead.
if (-not ('ZP' -as [type])) { throw 'Add-Type failed: ZP helper type was not created.' }

# --- locate the overlay -----------------------------------------------------
# Discriminator: Electron/Chromium top-level class + WS_EX_TOOLWINDOW(0x80)
# + WS_EX_NOACTIVATE(0x08000000). That pair is what an overlay must have, and it
# separates us from ordinary Electron apps (e.g. editors use plain 0x100).
$MASK = 0x08000080
$overlay = [IntPtr]::Zero
$overlayTitle = ''
$cur = [ZP]::GetTopWindow([IntPtr]::Zero)
$guard = 0
while ($cur -ne [IntPtr]::Zero -and $guard++ -lt 4000) {
  if ([ZP]::IsWindowVisible($cur) -and ([ZP]::Cls($cur) -eq 'Chrome_WidgetWin_1')) {
    if (([ZP]::GetWindowLong($cur, -20) -band $MASK) -eq $MASK) {
      $overlay = $cur
      $overlayTitle = [ZP]::Txt($cur)
    }
  }
  $cur = [ZP]::GetWindow($cur, 2)
}

if ($overlay -eq [IntPtr]::Zero) {
  Write-Output 'FAIL: no desktop overlay found. Is the app running?'
  Write-Output '      (looked for class Chrome_WidgetWin_1 with WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE)'
  Write-Output ''
  Write-Output 'Candidates of class Chrome_WidgetWin_1:'
  $cur = [ZP]::GetTopWindow([IntPtr]::Zero)
  $guard = 0
  $any = $false
  while ($cur -ne [IntPtr]::Zero -and $guard++ -lt 4000) {
    if ([ZP]::Cls($cur) -eq 'Chrome_WidgetWin_1') {
      $any = $true
      $ex = [ZP]::GetWindowLong($cur, -20)
      Write-Output ('  0x{0:x}  ex=0x{1:x8}  (ex-band-mask)=0x{2:x8}  visible={3}  title="{4}"' -f `
        $cur.ToInt64(), $ex, ($ex -band $MASK), [ZP]::IsWindowVisible($cur), [ZP]::Txt($cur))
    }
    $cur = [ZP]::GetWindow($cur, 2)
  }
  if (-not $any) { Write-Output '  (none at all -- the app really is not running)' }
  exit 1
}

# --- walk the top-level z-order (top -> bottom) ------------------------------
$list = New-Object System.Collections.ArrayList
$idxOverlay = -1
$idxAnchor  = -1
$cur = [ZP]::GetTopWindow([IntPtr]::Zero)
$guard = 0
while ($cur -ne [IntPtr]::Zero -and $guard++ -lt 4000) {
  if ([ZP]::IsWindowVisible($cur) -and -not [ZP]::IsIconic($cur)) {
    $r = New-Object ZP+RECT
    [void][ZP]::GetWindowRect($cur, [ref]$r)
    $ex = [ZP]::GetWindowLong($cur, -20)
    $hasIconHost = ([ZP]::FindWindowExW($cur, [IntPtr]::Zero, 'SHELLDLL_DefView', $null) -ne [IntPtr]::Zero)
    $tag = ''
    if ($hasIconHost) { $tag += ' <DESKTOP-ICON-ANCHOR>' }
    if ($cur -eq $overlay) { $tag += ' <<<<< OVERLAY'; $idxOverlay = $list.Count }
    [void]$list.Add([pscustomobject]@{
      Idx = $list.Count
      Hwnd = $cur
      Ex = $ex
      Rect = ('[{0},{1} {2}x{3}]' -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T))
      Cls = [ZP]::Cls($cur)
      Title = [ZP]::Txt($cur)
      Tag = $tag
    })
    if ($hasIconHost -and $idxAnchor -lt 0 -and $cur -ne $overlay) { $idxAnchor = $list.Count - 1 }
  }
  $cur = [ZP]::GetWindow($cur, 2)
}

Write-Output ('OVERLAY 0x{0:x} "{1}"' -f $overlay.ToInt64(), $overlayTitle)
Write-Output ''
Write-Output '--- top-level windows, top -> bottom (visible, not minimised) ---'
foreach ($w in $list) {
  Write-Output ('z{0,3}  0x{1:x}  ex=0x{2:x8}  {3,-20}  {4}{5}' -f `
    $w.Idx, $w.Hwnd.ToInt64(), $w.Ex, $w.Rect, $w.Cls, $w.Tag)
}
Write-Output ''

# --- invariant 1: overlay is immediately above the desktop anchor ------------
$ok1 = $false
if ($idxOverlay -ge 0 -and $idxAnchor -ge 0) {
  $ok1 = ($idxOverlay -eq ($idxAnchor - 1))
}
$total = $list.Count
Write-Output ('CHECK 1  overlay directly above the desktop anchor : {0}' -f $(if ($ok1) { 'PASS' } else { 'FAIL' }))
Write-Output ('         overlay z-index = {0} / {1}   anchor z-index = {2}' -f $idxOverlay, ($total - 1), $idxAnchor)

# --- invariant 2: WindowFromPoint never resolves to the overlay --------------
Write-Output ''
Write-Output '--- WindowFromPoint grid (ancestor-normalised, flag = none should be OVERLAY) ---'
$leaks = 0
foreach ($y in $ProbeY) {
  $row = @()
  foreach ($x in $ProbeX) {
    $h = [ZP]::Hit($x, $y)
    if ($h -eq $overlay) { $leaks++ }
    $row += ('{0},{1}->0x{2:x}' -f $x, $y, $h.ToInt64())
  }
  Write-Output ('  ' + ($row -join '  '))
}
Write-Output ('CHECK 2  no probe point resolves to the overlay    : {0}  (leaks={1})' -f `
  $(if ($leaks -eq 0) { 'PASS' } else { 'FAIL' }), $leaks)

Write-Output ''
if ($ok1 -and $leaks -eq 0) {
  Write-Output 'RESULT: PASS'
  exit 0
}
Write-Output 'RESULT: FAIL'
exit 1
