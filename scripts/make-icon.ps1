# Generates build/icon.ico — a sakura blossom, rendered at every size Windows asks for.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1
Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'build'
New-Item -ItemType Directory -Force $outDir | Out-Null

function New-SakuraBitmap([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded square backdrop with a soft pink gradient.
  $r = [Math]::Max(2, [int]($s * 0.22))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($s - $d, 0, $d, $d, 270, 90)
  $path.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
  $path.AddArc(0, $s - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 255, 245, 250),
    [System.Drawing.Color]::FromArgb(255, 249, 178, 208),
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  $g.FillPath($bg, $path)

  # Five petals radiating from the centre.
  $cx = $s / 2.0
  $cy = $s / 2.0
  $petalW = $s * 0.30
  $petalH = $s * 0.42
  $offset = $s * 0.17

  for ($i = 0; $i -lt 5; $i++) {
    $state = $g.Save()
    $g.TranslateTransform($cx, $cy)
    $g.RotateTransform(($i * 72.0) - 90.0)
    $g.TranslateTransform($offset, 0)

    $pr = New-Object System.Drawing.RectangleF (
      [float](-$petalH / 2), [float](-$petalW / 2), [float]$petalH, [float]$petalW)
    $pp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pp.AddEllipse($pr)

    # Bite a circle out of the outer tip: the cleft is what makes a five-petal
    # flower read as a cherry blossom rather than a generic daisy.
    $region = New-Object System.Drawing.Region $pp
    if ($s -ge 24) {
      $notchR = $petalW * 0.34
      $notch = New-Object System.Drawing.Drawing2D.GraphicsPath
      $notch.AddEllipse(
        [float]($petalH / 2 - $notchR * 0.72), [float](-$notchR),
        [float]($notchR * 2), [float]($notchR * 2))
      $region.Exclude($notch)
      $notch.Dispose()
    }

    # Highlight sits toward the inner end, so the petal reads flat rather than glossy.
    $pb = New-Object System.Drawing.Drawing2D.PathGradientBrush $pp
    $pb.CenterPoint = New-Object System.Drawing.PointF (
      [float](-$petalH * 0.16), [float]0)
    $pb.CenterColor = [System.Drawing.Color]::FromArgb(255, 255, 233, 242)
    $pb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 233, 104, 149))
    $g.FillRegion($pb, $region)

    $pb.Dispose(); $region.Dispose(); $pp.Dispose()
    $g.Restore($state)
  }

  # Golden centre.
  $cr = $s * 0.105
  $cb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 209, 102))
  $g.FillEllipse($cb, [float]($cx - $cr), [float]($cy - $cr), [float]($cr * 2), [float]($cr * 2))

  $cb.Dispose(); $bg.Dispose(); $path.Dispose(); $g.Dispose()
  return $bmp
}

# Collect each size as a PNG. PNG-compressed entries inside an .ico are supported by
# Windows Vista and later, and keep the file small at 256x256.
$pngs = @()
foreach ($s in $sizes) {
  $bmp = New-SakuraBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , @{ size = $s; bytes = $ms.ToArray() }
  $ms.Dispose(); $bmp.Dispose()
}

# Assemble the ICO container: ICONDIR, then one ICONDIRENTRY per image, then the data.
$icoPath = Join-Path $outDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs

$bw.Write([UInt16]0)               # reserved
$bw.Write([UInt16]1)               # type: icon
$bw.Write([UInt16]$pngs.Count)

$offset = 6 + (16 * $pngs.Count)
foreach ($p in $pngs) {
  $dim = if ($p.size -ge 256) { 0 } else { $p.size }
  $bw.Write([Byte]$dim)            # width
  $bw.Write([Byte]$dim)            # height
  $bw.Write([Byte]0)               # palette entries
  $bw.Write([Byte]0)               # reserved
  $bw.Write([UInt16]1)             # colour planes
  $bw.Write([UInt16]32)            # bits per pixel
  $bw.Write([UInt32]$p.bytes.Length)
  $bw.Write([UInt32]$offset)
  $offset += $p.bytes.Length
}
foreach ($p in $pngs) { $bw.Write($p.bytes) }

$bw.Flush(); $bw.Dispose(); $fs.Dispose()

# A standalone PNG is handy for the window icon and for READMEs.
$big = New-SakuraBitmap 256
$big.Save((Join-Path $outDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

Write-Output ("icon.ico written: {0} sizes, {1:N0} bytes" -f $pngs.Count, (Get-Item $icoPath).Length)
