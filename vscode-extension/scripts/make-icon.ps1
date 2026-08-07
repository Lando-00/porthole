# Draws the marketplace icon: the porthole mark, at 128x128, as a PNG.
#
# The activity-bar SVG uses `currentColor` so the theme can tint it. A
# marketplace icon cannot - it sits on both light and dark gallery pages and in
# the Extensions view - so it carries its own colours and a solid ground.
# The gallery also rejects SVG outright, which is why this exists at all.
#
#   pwsh -File scripts/make-icon.ps1

Add-Type -AssemblyName System.Drawing

$size = 512   # drawn large and downsampled, so the thin strokes stay clean
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.InterpolationMode = 'HighQualityBicubic'
$g.PixelOffsetMode = 'HighQuality'

$bg = [System.Drawing.Color]::FromArgb(255, 24, 32, 44)
$ring = [System.Drawing.Color]::FromArgb(255, 120, 200, 255)
$stud = [System.Drawing.Color]::FromArgb(255, 200, 230, 255)

# Rounded square, the shape the gallery expects.
$radius = [int]($size * 0.22)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc(($size - $d), 0, $d, $d, 270, 90)
$path.AddArc(($size - $d), ($size - $d), $d, $d, 0, 90)
$path.AddArc(0, ($size - $d), $d, $d, 90, 90)
$path.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush $bg), $path)

$c = $size / 2
$scale = $size / 24.0   # the source artwork is on a 24-unit grid

$outer = New-Object System.Drawing.Pen $ring, ($scale * 1.8)
$inner = New-Object System.Drawing.Pen $ring, ($scale * 1.4)

$r1 = 9 * $scale
$g.DrawEllipse($outer, ($c - $r1), ($c - $r1), ($r1 * 2), ($r1 * 2))

$r2 = 5.2 * $scale
$g.DrawEllipse($inner, ($c - $r2), ($c - $r2), ($r2 * 2), ($r2 * 2))

# The four studs at the compass points.
$brush = New-Object System.Drawing.SolidBrush $stud
$rs = 1.2 * $scale
foreach ($p in @(, @(3, 12)), @(, @(21, 12)), @(, @(12, 3)), @(, @(12, 21))) {
    $x = $p[0][0] * $scale
    $y = $p[0][1] * $scale
    $g.FillEllipse($brush, ($x - $rs), ($y - $rs), ($rs * 2), ($rs * 2))
}

$g.Dispose()

$final = New-Object System.Drawing.Bitmap 128, 128
$fg = [System.Drawing.Graphics]::FromImage($final)
$fg.InterpolationMode = 'HighQualityBicubic'
$fg.SmoothingMode = 'AntiAlias'
$fg.DrawImage($bmp, 0, 0, 128, 128)
$fg.Dispose()

$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'icon.png'
$final.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$final.Dispose()
$bmp.Dispose()

$info = Get-Item $out
"wrote $($info.FullName) ($([int]$info.Length) bytes)"
