# tools/flyscan.ps1 -- score a whole burst of real-screen frames in ONE process,
# each cropped to a box around where the ball was logged to be.
#
# WHY THIS EXISTS
#   tools/ballfind.ps1 scores one image and needs a hand-drawn scan box that
#   contains the ball and nothing else orange. That is fine for a still, but the
#   --fly-test fixture drives the ball around an ellipse that spans ~860x380 px,
#   so no single fixed box can hold it -- and widening the box drags in the hoop
#   rim, the tray icons and the UI accents (all orange).
#
#   So: the app's runtime.log says where the ball was at each moment (FLYSTATE
#   lines, 100 ms apart), the driver interpolates that to each frame's capture
#   instant, and this script crops +/- Box px around the interpolated centre.
#
# WHY IT MEASURES EXTENT AND NOT PIXEL COUNT
#   Counting orange pixels inside the ball does NOT work. The ball sprite is
#   drawn in three passes (base / rotating seam / highlight) and the seam is a
#   WIDE dark band that fully crosses the disc. Depending on the ball's spin
#   phase the orange splits into two or three pieces whose sizes swing by 2x --
#   measured: a frame that is visually a perfect disc came out as
#   b1=1431 b2=1022 b3=311, i.e. "39% of a disc" from the largest blob alone.
#   The desktop behind the overlay makes it worse: this machine runs a code
#   editor whose red/orange syntax highlighting passes the same test and gets
#   merged into the ball's blob set, inventing extents up to 50% too long.
#
# TWO SEGMENTATIONS
#   -Mode orange  (default) segments the real basketball. Works, but carries both
#                 confounds above, so treat it as qualitative.
#   -Mode magenta segments the flat magenta disc that --fly-test --fly-flat makes
#                 the fixture draw instead of the ball. Nothing else on any screen
#                 is magenta, so this is exact: pixel count is the disc's true
#                 area and the extents are its true outline. Use this one for any
#                 number you intend to quote. The window region is computed from
#                 the ball's centre, velocity and radius, so it is identical in
#                 both modes -- the appearance change cannot affect the verdict.
#
#   Either way the measured quantities are the extent along the direction of
#   travel and across it. A lagging region cuts a straight edge perpendicular to
#   travel, so the along-travel extent collapses while the across-travel one does
#   not, and that asymmetry cannot be produced by seams or by spin phase.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/flyscan.ps1 `
#     -Manifest tools\shots\burst\manifest.csv -R 34 -Box 100 -Mode magenta
#
#   manifest.csv is "path,cx,cy,vx,vy" per line, no header. cx,cy is the
#   interpolated ball centre and vx,vy its velocity, both in screen pixels.
#
# OUTPUT
#   FRAME <name> src=cx,cy dCent=D upx=N b1=N b2=N b3=N tot=N dPar=X dPerp=Y lit=P
#     dCent  distance from the predicted centre to the measured blob centroid (px)
#            -- a few px is normal, tens of px means the pairing is wrong
#     upx    pixels in the union of the near-centre blobs (= disc area in magenta mode)
#     dPar   extent along the direction of travel (px)
#     dPerp  extent perpendicular to it (px)
#     lit    percent of the WHOLE frame that is not near-black. A blank capture
#            (DWM returned no frame / display was transitioning) reads lit=0 and
#            must be dropped: otherwise its upx=0 looks exactly like "the region
#            clipped the whole ball away". flyab does this via --lit-min.
#
# NOTE  keep this file pure ASCII: Windows PowerShell 5.1 reads .ps1 as ANSI and
#       a Chinese comment's last byte can swallow the following newline.
# NOTE  never write a backtick inside the C# here-string below. The here-string is
#       double-quoted, so `` followed by n becomes a newline and the line silently
#       splits -- Add-Type then dies with "a newline in a string constant".

param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [int]$R = 34,
  [int]$Box = 100,
  [int]$Near = 48,
  [ValidateSet('orange','magenta')][string]$Mode = 'orange'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class FlyScan {
  // orange : basketball leather. r must be the max channel, hue in the orange
  //          band, saturated enough to exclude the grey desktop. The hue gate is
  //          what keeps pure red syntax highlighting out (hue ~0).
  // magenta: nothing else on screen, so a plain high/low test is exact.
  public static bool IsBall(int r, int g, int b, bool magenta) {
    if (magenta) return (r > 190 && b > 190 && g < 90);
    if (r < 95) return false;
    int mx = r, mn = r;
    if (g > mx) mx = g; if (g < mn) mn = g;
    if (b > mx) mx = b; if (b < mn) mn = b;
    if (r != mx) return false;
    int d = mx - mn;
    if (d < 30) return false;
    double hue = 60.0 * (g - b) / d;
    if (hue < 0) hue += 360.0;
    if (hue < 12.0 || hue > 52.0) return false;
    return (double)d / mx >= 0.30;
  }

  public static string ScanDir(string path, double cx, double cy, double vx, double vy, int box, int R, int near, bool magenta) {
    using (Bitmap bmp = new Bitmap(path)) {
      int W = bmp.Width, H = bmp.Height;
      int x0 = (int)Math.Floor(cx) - box, y0 = (int)Math.Floor(cy) - box;
      int x1 = (int)Math.Ceiling(cx) + box, y1 = (int)Math.Ceiling(cy) + box;
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
      int tot = 0;
      // Blank-frame guard. A capture that came back all black (DWM produced no
      // frame, or the session was mid display transition) has zero magenta
      // pixels -- which is indistinguishable from "the region clipped the ball
      // away completely" if you only look at upx. That conflation already
      // produced one bogus "lead=1 is worse than lead=0" verdict, so every
      // frame now carries litpct = the percentage of the WHOLE image that is
      // not near-black. flyab drops anything below --lit-min.
      long lit = 0;
      long px_total = (long)W * H;
      for (int y = 0; y < H; y++) {
        int row = y * stride;
        for (int x = 0; x < W; x++) {
          int o = row + x * 4;
          if (((int)buf[o + 2] + buf[o + 1] + buf[o]) > 60) lit++;
        }
      }
      int litpct = (int)Math.Round(100.0 * lit / px_total);
      for (int y = y0; y <= y1; y++) {
        int row = y * stride, my = (y - y0) * bw;
        for (int x = x0; x <= x1; x++) {
          int o = row + x * 4;
          if (IsBall(buf[o + 2], buf[o + 1], buf[o], magenta)) { mask[my + (x - x0)] = 1; tot++; }
        }
      }
      if (tot == 0) return "src=" + (int)cx + "," + (int)cy +
        " dCent=0 upx=0 b1=0 b2=0 b3=0 tot=0 dPar=0 dPerp=0 lit=" + litpct;

      int n = bw * bh;
      int[] stack = new int[n], lab = new int[n];
      int[] cnt = new int[n + 1];
      double[] sx = new double[n + 1], sy = new double[n + 1];
      int id = 0, id1 = 0, id2 = 0, id3 = 0, n1 = 0, n2 = 0, n3 = 0;
      for (int i = 0; i < n; i++) {
        if (mask[i] != 1) continue;
        id++;
        int sp = 0; stack[sp++] = i; mask[i] = 2; lab[i] = id;
        int c = 0; double ax = 0, ay = 0;
        while (sp > 0) {
          int p = stack[--sp]; c++;
          int py = p / bw, px = p % bw;
          ax += px; ay += py;
          if (px > 0    && mask[p - 1]  == 1) { mask[p - 1]  = 2; lab[p - 1]  = id; stack[sp++] = p - 1; }
          if (px < bw - 1 && mask[p + 1] == 1) { mask[p + 1] = 2; lab[p + 1]  = id; stack[sp++] = p + 1; }
          if (py > 0    && mask[p - bw] == 1) { mask[p - bw] = 2; lab[p - bw] = id; stack[sp++] = p - bw; }
          if (py < bh - 1 && mask[p + bw] == 1) { mask[p + bw] = 2; lab[p + bw] = id; stack[sp++] = p + bw; }
        }
        cnt[id] = c; sx[id] = ax / c + x0; sy[id] = ay / c + y0;
        if (c > n1) { n3 = n2; n2 = n1; n1 = c; id3 = id2; id2 = id1; id1 = id; }
        else if (c > n2) { n3 = n2; n2 = c; id3 = id2; id2 = id; }
        else if (c > n3) { n3 = c; id3 = id; }
      }

      // In magenta mode there is exactly one object; otherwise take every blob
      // within Near px of the predicted centre (the ball's seam-split pieces
      // all qualify, the hoop rim and the tray icons do not). Falls back to the
      // single biggest blob if nothing is near.
      byte[] keep = new byte[n + 1];
      double d2 = (double)near * near;
      int upx = 0; double ux = 0, uy = 0;
      for (int k = 1; k <= id; k++) {
        bool take;
        if (magenta) take = true;
        else {
          double ddx = sx[k] - cx, ddy = sy[k] - cy;
          take = (ddx * ddx + ddy * ddy <= d2);
        }
        if (take) { keep[k] = 1; upx += cnt[k]; ux += sx[k] * cnt[k]; uy += sy[k] * cnt[k]; }
      }
      bool fallback = false;
      if (upx == 0) { upx = n1; ux = sx[id1] * n1; uy = sy[id1] * n1; keep[id1] = 1; fallback = true; }
      ux /= upx; uy /= upx;

      double vl = Math.Sqrt(vx * vx + vy * vy);
      if (vl < 1e-6) { vx = 1; vy = 0; vl = 1; }
      double px_ = vx / vl, py_ = vy / vl;
      double qx = -py_, qy = px_;

      double pmin = double.MaxValue, pmax = double.MinValue;
      double qmin = double.MaxValue, qmax = double.MinValue;
      for (int py = 0; py < bh; py++) {
        for (int px = 0; px < bw; px++) {
          int idx = py * bw + px;
          if (mask[idx] != 2) continue;
          if (keep[lab[idx]] != 1) continue;
          double wx = px + x0, wy = py + y0;
          double a = wx * px_ + wy * py_;
          double b = wx * qx + wy * qy;
          if (a < pmin) pmin = a; if (a > pmax) pmax = a;
          if (b < qmin) qmin = b; if (b > qmax) qmax = b;
        }
      }
      if (pmin > pmax) { pmin = 0; pmax = 0; qmin = 0; qmax = 0; }

      double dCent = Math.Sqrt((ux - cx) * (ux - cx) + (uy - cy) * (uy - cy));
      return String.Format(
        "src={0},{1} dCent={2:F1} centroid={3:F0},{4:F0} upx={5} b1={6} b2={7} b3={8} tot={9} dPar={10:F1} dPerp={11:F1} lit={12}{13}",
        (int)cx, (int)cy, dCent, ux, uy, upx, n1, n2, n3, tot, pmax - pmin, qmax - qmin,
        litpct, fallback ? " fb=1" : "");
    }
  }
}
"@
if (-not ('FlyScan' -as [type])) { throw 'Add-Type failed: FlyScan was not created.' }

$mag = ($Mode -eq 'magenta')
Write-Output ('MANIFEST ' + $Manifest + '  mode=' + $Mode + '  R=' + $R + '  Box=' + $Box + '  Near=' + $Near)
$n = 0
foreach ($line in (Get-Content -LiteralPath (Resolve-Path $Manifest).Path)) {
  if (-not $line) { continue }
  $p = $line.Split(',')
  if ($p.Length -lt 3) { continue }
  $file = $p[0].Trim()
  $cx = [double]$p[1]; $cy = [double]$p[2]
  $vx = 0.0; $vy = 0.0
  if ($p.Length -ge 5) { $vx = [double]$p[3]; $vy = [double]$p[4] }
  if (-not (Test-Path $file)) { Write-Output ('FRAME {0} MISSING' -f $file); continue }
  $res = [FlyScan]::ScanDir((Resolve-Path $file).Path, $cx, $cy, $vx, $vy, $Box, $R, $Near, $mag)
  Write-Output ('FRAME {0} {1}' -f (Split-Path -Leaf $file), $res)
  $n++
}
Write-Output ('DONE ' + $n + ' frame(s)')
