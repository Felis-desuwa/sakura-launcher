# Generates build/icon.ico — a sakura blossom, rendered at every size Windows asks for.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1
#
# The blossom is white on a saturated rose field rather than pink on pink. An icon has
# to survive being 16 pixels wide in a taskbar, where the only thing that still reads is
# the silhouette — and a silhouette needs contrast against its own background.
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

  $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 255, 150, 187),
    [System.Drawing.Color]::FromArgb(255, 206, 55, 105),
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  $g.FillPath($bg, $card)

  # A light bloom in the top-left keeps the field from looking like flat vinyl.
  if ($s -ge 32) {
    $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glowPath.AddEllipse([float](-$s * 0.35), [float](-$s * 0.45),
      [float]($s * 1.15), [float]($s * 1.15))
    $glow = New-Object System.Drawing.Drawing2D.PathGradientBrush $glowPath
    $glow.CenterColor = [System.Drawing.Color]::FromArgb(70, 255, 255, 255)
    $glow.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
    $oldClip = $g.Clip
    $g.SetClip($card)
    $g.FillPath($glow, $glowPath)
    $g.Clip = $oldClip
    $glow.Dispose(); $glowPath.Dispose()
  }

  $cx = $s / 2.0
  $cy = $s / 2.0
  $len = $s * 0.355
  $halfW = $s * 0.195
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

    # White at the rim, warming to pink toward the stem: the flower gets a soft glow at
    # its heart while every outer edge stays maximally distinct from the background.
    $pb = New-Object System.Drawing.Drawing2D.PathGradientBrush $pp
    $pb.CenterPoint = New-Object System.Drawing.PointF ([float]($len * 0.06), [float]0)
    $pb.CenterColor = [System.Drawing.Color]::FromArgb(255, 255, 205, 227)
    $pb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $g.FillPath($pb, $pp)

    $pb.Dispose(); $pp.Dispose()
    $g.Restore($state)
  }

  # Stamens: only where they can be more than one muddy pixel.
  if ($s -ge 64) {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(210, 244, 138, 175)), ([float]($s * 0.012))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    for ($i = 0; $i -lt 10; $i++) {
      $a = ($i * 36.0 + 18.0) * [Math]::PI / 180.0
      $r1 = $s * 0.055
      $r2 = $s * 0.135
      $g.DrawLine($pen,
        [float]($cx + [Math]::Cos($a) * $r1), [float]($cy + [Math]::Sin($a) * $r1),
        [float]($cx + [Math]::Cos($a) * $r2), [float]($cy + [Math]::Sin($a) * $r2))
    }
    $pen.Dispose()
  }

  # Amber heart.
  $cr = $s * 0.072
  $centre = New-Object System.Drawing.Drawing2D.GraphicsPath
  $centre.AddEllipse([float]($cx - $cr), [float]($cy - $cr), [float]($cr * 2), [float]($cr * 2))
  $cb = New-Object System.Drawing.Drawing2D.PathGradientBrush $centre
  $cb.CenterColor = [System.Drawing.Color]::FromArgb(255, 255, 226, 150)
  $cb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 246, 179, 61))
  $g.FillPath($cb, $centre)

  $cb.Dispose(); $centre.Dispose(); $bg.Dispose(); $card.Dispose(); $g.Dispose()
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
