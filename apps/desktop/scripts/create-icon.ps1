# create-icon.ps1 — Generates a simple 256x256 PNG icon for MultiProfile Studio
# Run from apps/desktop directory: powershell -ExecutionPolicy Bypass -File scripts/create-icon.ps1
# Output: public/assets/icon.png

$outputPath = Join-Path $PSScriptRoot "..\public\assets\icon.png"
$outputPath = [System.IO.Path]::GetFullPath($outputPath)

Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bitmap)

# Background: deep blue gradient
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    [System.Drawing.Point]::new(0, 0),
    [System.Drawing.Point]::new($size, $size),
    [System.Drawing.Color]::FromArgb(255, 30, 100, 220),
    [System.Drawing.Color]::FromArgb(255, 10, 50, 150)
)
$g.FillRectangle($bgBrush, 0, 0, $size, $size)

# Rounded corners (clip)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 40
$path.AddArc(0, 0, $radius * 2, $radius * 2, 180, 90)
$path.AddArc($size - $radius * 2, 0, $radius * 2, $radius * 2, 270, 90)
$path.AddArc($size - $radius * 2, $size - $radius * 2, $radius * 2, $radius * 2, 0, 90)
$path.AddArc(0, $size - $radius * 2, $radius * 2, $radius * 2, 90, 90)
$path.CloseFigure()
$g.SetClip($path)

# Redraw background inside clip
$g.FillRectangle($bgBrush, 0, 0, $size, $size)

# Draw letter "M"
$font = New-Object System.Drawing.Font("Segoe UI", 140, [System.Drawing.FontStyle]::Bold)
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("M", $font, $textBrush, [System.Drawing.RectangleF]::new(0, 0, $size, $size), $sf)

$g.Dispose()
$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Host "Icon created at: $outputPath"
