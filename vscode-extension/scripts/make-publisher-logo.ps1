# Draws the publisher logo: the porthole mark, 128x128, PNG.
#
# Same mark as the extension icon but without the rounded-square plate - a
# publisher logo is shown small and round-cropped in some places, so it wants
# to read as a single symbol rather than an app tile.
#
#   pwsh -File scripts/make-publisher-logo.ps1

Add-Type -AssemblyName System.Drawing

$size = 512
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.InterpolationMode = 'HighQualityBicubic'
$g.PixelOffsetMode = 'HighQuality'

$bg = [System.Drawing.Color]::FromArgb(255, 24, 32, 44)
$ring = [System.Drawing.Color]::FromArgb(255, 120, 200, 255)
$stud = [System.Drawing.Color]::FromArgb(255, 200, 230, 255)

# A filled circle, not a rounded square: it survives being round-cropped.
$g.FillEllipse((New-Object System.Drawing.SolidBrush $bg), 0, 0, $size, $size)

$c = $size / 2
$scale = $size / 24.0

$outer = New-Object System.Drawing.Pen $ring, ($scale * 1.6)
$inner = New-Object System.Drawing.Pen $ring, ($scale * 1.3)

$r1 = 8.2 * $scale
$g.DrawEllipse($outer, ($c - $r1), ($c - $r1), ($r1 * 2), ($r1 * 2))

$r2 = 4.7 * $scale
$g.DrawEllipse($inner, ($c - $r2), ($c - $r2), ($r2 * 2), ($r2 * 2))

$brush = New-Object System.Drawing.SolidBrush $stud
$rs = 1.1 * $scale
foreach ($p in @(, @(3.8, 12)), @(, @(20.2, 12)), @(, @(12, 3.8)), @(, @(12, 20.2))) {
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

$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'publisher-logo.png'
$final.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$final.Dispose()
$bmp.Dispose()

$info = Get-Item $out
"wrote $($info.FullName) ($([int]$info.Length) bytes)"
