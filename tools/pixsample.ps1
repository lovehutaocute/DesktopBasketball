# tools/pixsample.ps1 -- average RGB of a small box in every PNG of a folder.
# 验收用：真实屏幕截图里"球到底是什么颜色"用数字说话（避免肉眼在 1440x900 里找一颗球）。
# NOTE keep this file pure ASCII.
param(
  [Parameter(Mandatory=$true)][string]$Dir,
  [Parameter(Mandatory=$true)][string]$Pattern,
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [int]$Box = 9
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$h = [int]($Box / 2)
Get-ChildItem -Path $Dir -Filter $Pattern | Sort-Object Name | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  try {
    $bmp = New-Object System.Drawing.Bitmap $img
    $r = 0; $g = 0; $b = 0; $n = 0
    for ($y = $Y - $h; $y -le $Y + $h; $y++) {
      for ($x = $X - $h; $x -le $X + $h; $x++) {
        if ($x -lt 0 -or $y -lt 0 -or $x -ge $bmp.Width -or $y -ge $bmp.Height) { continue }
        $c = $bmp.GetPixel($x, $y)
        $r += $c.R; $g += $c.G; $b += $c.B; $n++
      }
    }
    $bmp.Dispose()
    Write-Output ('{0} rgb={1},{2},{3}' -f $_.Name, [int]($r / $n), [int]($g / $n), [int]($b / $n))
  } finally { $img.Dispose() }
}
