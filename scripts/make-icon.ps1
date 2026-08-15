# Generates build/icon.ico — a sakura blossom, rendered at every size Windows asks for.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1
#
# The blossom is white on a saturated rose field rather than pink on pink. An icon has
# to survive being 16 pixels wide in a taskbar, where the only thing that still reads is
# the silhouette — and a silhouette needs contrast against its own background.
#
# Everything inside that silhouette is flat: one solid white flower, one diagonal gradient
# behind it, nothing else. The earlier version had shading in the petals, a ring of stamens
# and an amber heart, all of which are invisible below 64 px and, above it, read as an icon
# from a decade ago. Detail that only exists at one size is not detail, it is noise — and
# the flower it decorated is the whole subject.
Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'build'
New-Item -ItemType Directory -Force $outDir | Out-Null

function Add-Cubic($path, $x1, $y1, $cx1, $cy1, $cx2, $cy2, $x2, $y2) {
  $path.AddBezier([float]$x1, [float]$y1, [float]$cx1, [float]$cy1,
    [float]$cx2, [float]$cy2, [float]$x2, [float]$y2)
}

# One petal, lying along +X with its base at the origin: swelling out from the stem,
# broad and round at the far end, and split by the cleft that tells a cherry blossom
# apart from a daisy.
function New-PetalPath([double]$len, [double]$halfW, [double]$notch) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $lobeY = $halfW * 0.46
  $cleft = $len - $notch

  Add-Cubic $p 0 0 ($len * 0.20) (-$halfW * 0.86) ($len * 0.74) (-$halfW * 1.02) $len (-$lobeY)
  # Quadratics expressed as cubics: GDI+ has no quadratic segment.
  Add-Cubic $p $len (-$lobeY) ($len * 0.95) (-$lobeY * 0.55) ($cleft * 1.02) (-$lobeY * 0.30) $cleft 0
  Add-Cubic $p $cleft 0 ($cleft * 1.02) ($lobeY * 0.30) ($len * 0.95) ($lobeY * 0.55) $len $lobeY
  Add-Cubic $p $len $lobeY ($len * 0.74) ($halfW * 1.02) ($len * 0.20) ($halfW * 0.86) 0 0
  $p.CloseFigure()
  return $p
}

function New-SakuraBitmap([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded square, deep rose so the white blossom has something to sit against.
  $r = [Math]::Max(2, [int]($s * 0.22))
  $card = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $card.AddArc(0, 0, $d, $d, 180, 90)
  $card.AddArc($s - $d, 0, $d, $d, 270, 90)
  $card.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
  $card.AddArc(0, $s - $d, $d, $d, 90, 90)
  $card.CloseFigure()

  # One diagonal gradient and nothing else. It is the only depth in the icon, which is
  # what lets the flower be perfectly flat and still not look like a sticker.
  $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 255, 166, 199),
    [System.Drawing.Color]::FromArgb(255, 219, 74, 130),
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  $g.FillPath($bg, $card)

  $cx = $s / 2.0
  $cy = $s / 2.0
  # Slightly longer and narrower than a round-petalled daisy would be: the proportion is
  # most of what says "cherry" before the cleft is big enough to be seen.
  $len = $s * 0.335
  $halfW = $s * 0.172
  # The cleft shrinks with the icon: at 16 px a proportional notch is sub-pixel mush
  # that splits each petal into two specks, so it flattens out entirely.
  $notch = $len * 0.20
  if ($s -lt 32) { $notch = $len * 0.08 }
  if ($s -lt 24) { $notch = 0 }
  # Petals sit close enough to overlap. Spaced apart they read as five separate blobs
  # once the icon is small, instead of one flower.
  $offset = $s * 0.045

  for ($i = 0; $i -lt 5; $i++) {
    $state = $g.Save()
    $g.TranslateTransform([float]$cx, [float]$cy)
    $g.RotateTransform([float](($i * 72.0) - 90.0))
    $g.TranslateTransform([float]$offset, 0)

    $pp = New-PetalPath $len $halfW $notch
    # Solid white, edge to edge. A gradient inside a shape this small is a gradient
    # nobody sees, and it costs the one thing the shape has: a clean edge.
    $g.FillPath([System.Drawing.Brushes]::White, $pp)
    $pp.Dispose()
    $g.Restore($state)
  }

  # The petals are pushed out from the middle so they overlap rather than radiate, which
  # leaves a small gap where their five points meet. Filled white, because a hole in the
  # middle of the flower is what the eye finds first — and because it is the alternative
  # to a stamen, not a place for one.
  $cr = $s * 0.155
  $g.FillEllipse([System.Drawing.Brushes]::White,
    [float]($cx - $cr), [float]($cy - $cr), [float]($cr * 2), [float]($cr * 2))

  $bg.Dispose(); $card.Dispose(); $g.Dispose()
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

# A contact sheet of the small sizes, so the taskbar-scale result can be judged.
$sheetW = 16 + 24 + 32 + 48 + 64 + 5 * 12
$sheet = New-Object System.Drawing.Bitmap $sheetW, 76, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$sg = [System.Drawing.Graphics]::FromImage($sheet)
$sg.Clear([System.Drawing.Color]::FromArgb(255, 245, 245, 247))
$x = 6
foreach ($s in @(16, 24, 32, 48, 64)) {
  $b = New-SakuraBitmap $s
  $sg.DrawImage($b, $x, [int]((70 - $s) / 2))
  $x += $s + 12
  $b.Dispose()
}
$sg.Dispose()
$sheet.Save((Join-Path $outDir 'icon-preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose()

Write-Output ("icon.ico written: {0} sizes, {1:N0} bytes" -f $pngs.Count, (Get-Item $icoPath).Length)
