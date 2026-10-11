# Draws build/icon.png (512x512): a folder with an upload arrow on a violet rounded square.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 512
$bitmap = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedRect ([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $r, $r, 180, 90)
    $path.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
    $path.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90)
    $path.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
    $path.CloseFigure()
    $path
}

$violet = [System.Drawing.Color]::FromArgb(124, 58, 237)
$white = [System.Drawing.Color]::White

# Background.
$g.FillPath((New-Object System.Drawing.SolidBrush $violet), (New-RoundedRect 0 0 $size $size 112))

# Folder: tab and body.
$folder = New-Object System.Drawing.Drawing2D.GraphicsPath
$folder.AddPolygon([System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF 96, 140),
    (New-Object System.Drawing.PointF 210, 140),
    (New-Object System.Drawing.PointF 244, 176),
    (New-Object System.Drawing.PointF 416, 176),
    (New-Object System.Drawing.PointF 416, 392),
    (New-Object System.Drawing.PointF 96, 392)
))
$g.FillPath((New-Object System.Drawing.SolidBrush $white), $folder)

# Upload arrow, cut out of the folder in the background color.
$pen = New-Object System.Drawing.Pen $violet, 34
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$g.DrawLine($pen, 256, 350, 256, 230)
$g.DrawLines($pen, [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF 196, 286),
    (New-Object System.Drawing.PointF 256, 226),
    (New-Object System.Drawing.PointF 316, 286)
))

$out = Join-Path $PSScriptRoot '..\build\icon.png'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
$bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bitmap.Dispose()
Write-Output "Wrote $out"
