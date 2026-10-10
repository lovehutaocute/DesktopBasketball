# tools/ballfind.ps1 -- locate the basketball inside a real-screen screenshot and
# report whether it is a COMPLETE disc.
#
# WHY THIS EXISTS
#   The overlay is shaped by SetWindowRgn, so a ball flying fast can be clipped by
#   the region and lose a chunk in the direction of travel. Screenshots are the
#   only ground truth (capturePage() reads the renderer's own compositing result
#   and cannot see the region at all), and "squint at the PNG" is not a verdict.
#
#   So this returns numbers instead. For a solid disc:
#     - maxRowChord ~= maxColChord ~= 2R
#     - area ~= PI*R^2
#   A disc clipped on one side keeps its chord along one axis and loses it along
#   the other -- that asymmetry IS the signature of the region cutting it.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\ballfind.ps1 `
#     -In tools\shots\fly_00.png -X0 200 -Y0 150 -X1 1120 -Y1 600 -R 34
#
#   Always pass a scan box that contains the ball and nothing else orange
#   (the hoop rim and the tray icons are orange too).
#
# NOTE keep this file pure ASCII: Windows PowerShell 5.1 reads .ps1 as ANSI.

param(
  [Parameter(Mandatory=$true)][string]$In,
  [int]$X0 = 0,
  [int]$Y0 = 0,
  [int]$X1 = 0,
  [int]$Y1 = 0,
  [int]$R = 34
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class BallFind {
  public static string Scan(string path, int x0, int y0, int x1, int y1, int R) {
    using (Bitmap bmp = new Bitmap(path)) {
      int W = bmp.Width, H = bmp.Height;
      if (x1 <= x0) x1 = W - 1;
      if (y1 <= y0) y1 = H - 1;
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
      if (x1 > W - 1) x1 = W - 1; if (y1 > H - 1) y1 = H - 1;

      BitmapData d = bmp.LockBits(new Rectangle(0, 0, W, H),
          ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      int stride = d.Stride;
      byte[] buf = new byte[stride * H];
      Marshal.Copy(d.Scan0, buf, 0, buf.Length);
      bmp.UnlockBits(d);

      int bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      byte[] mask = new byte[bw * bh];
      int total = 0;
      for (int y = y0; y <= y1; y++) {
        int row = y * stride, my = (y - y0) * bw;
        for (int x = x0; x <= x1; x++) {
          int o = row + x * 4;                 // BGRA
          int b = buf[o], g = buf[o + 1], r = buf[o + 2];
          // basketball leather: strongly red-dominant, low blue.
          if (r > 95 && (r - b) > 55 && (r - g) > 25) { mask[my + (x - x0)] = 1; total++; }
        }
      }
      if (total == 0) return "BALL none (no orange pixel in box " + x0 + "," + y0 + ".." + x1 + "," + y1 + ")";

      // Largest 4-connected blob = the ball. Everything else orange on screen is
      // small (hoop rim, tray icons, UI accents), so picking the biggest blob keeps
      // the verdict independent of how wide the scan box was drawn.
      int[] stack = new int[bw * bh];
      int[] lab = new int[bw * bh];
      int best = 0, bestId = 0, id = 0;
      for (int i = 0; i < mask.Length; i++) {
        if (mask[i] != 1) continue;
        id++;
        int sp = 0; stack[sp++] = i; mask[i] = 2; lab[i] = id;
        int n = 0;
        while (sp > 0) {
          int p = stack[--sp]; n++;
          int py = p / bw, px = p % bw;
          if (px > 0     && mask[p - 1]  == 1) { mask[p - 1]  = 2; lab[p - 1]  = id; stack[sp++] = p - 1; }
          if (px < bw - 1 && mask[p + 1] == 1) { mask[p + 1]  = 2; lab[p + 1]  = id; stack[sp++] = p + 1; }
          if (py > 0     && mask[p - bw] == 1) { mask[p - bw] = 2; lab[p - bw] = id; stack[sp++] = p - bw; }
          if (py < bh - 1 && mask[p + bw] == 1) { mask[p + bw] = 2; lab[p + bw] = id; stack[sp++] = p + bw; }
        }
        if (n > best) { best = n; bestId = id; }
      }

      // bbox + widest chord of the winning blob
      int bx0 = int.MaxValue, by0 = int.MaxValue, bx1 = -1, by1 = -1;
      int[] rowC = new int[bh], colC = new int[bw];
      for (int py = 0; py < bh; py++) {
        for (int px = 0; px < bw; px++) {
          if (lab[py * bw + px] != bestId) continue;
          if (px < bx0) bx0 = px; if (px > bx1) bx1 = px;
          if (py < by0) by0 = py; if (py > by1) by1 = py;
          rowC[py]++; colC[px]++;
        }
      }
      int maxRow = 0, maxCol = 0;
      for (int i = 0; i < bh; i++) if (rowC[i] > maxRow) maxRow = rowC[i];
      for (int i = 0; i < bw; i++) if (colC[i] > maxCol) maxCol = colC[i];

      double full = Math.PI * R * R;
      return String.Format(
        "BALL blob={0},{1} {2}x{3} center={4},{5} px={6} area/full={7:F2} maxRowChord={8} maxColChord={9} chordRatio={10:F2} totalOrange={11} blobs_all={12}",
        bx0 + x0, by0 + y0, bx1 - bx0 + 1, by1 - by0 + 1,
        (bx0 + bx1) / 2 + x0, (by0 + by1) / 2 + y0, best, best / full,
        maxRow, maxCol, (double)maxRow / Math.Max(1, maxCol), total, id);
    }
  }
}
"@
if (-not ('BallFind' -as [type])) { throw 'Add-Type failed: BallFind was not created.' }

Write-Output ('IMAGE  ' + $In)
Write-Output ('BOX    {0},{1} .. {2},{3}   R={4}  (full disc = {5}px wide, area ~{6})' -f `
  $X0, $Y0, $X1, $Y1, $R, (2 * $R), [int]([Math]::PI * $R * $R))
Write-Output ([BallFind]::Scan((Resolve-Path $In).Path, $X0, $Y0, $X1, $Y1, $R))
