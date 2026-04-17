Add-Type -AssemblyName System.Drawing

function New-IconBitmap {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Rounded dark square background with subtle vertical gradient
    $pad = [Math]::Max(1, [int]($Size * 0.03))
    $radius = [int]($Size * 0.20)
    $rect = New-Object System.Drawing.RectangleF $pad, $pad, ($Size - 2*$pad), ($Size - 2*$pad)

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $top = [System.Drawing.Color]::FromArgb(30, 30, 38)
    $bot = [System.Drawing.Color]::FromArgb(12, 12, 16)
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $top, $bot, 90
    $g.FillPath($bgBrush, $path)
    $bgBrush.Dispose()

    # Thin inner highlight ring
    if ($Size -ge 32) {
        $penWidth = [Math]::Max(1.0, $Size * 0.012)
        $ringPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(60, 255, 255, 255)), $penWidth
        $g.DrawPath($ringPen, $path)
        $ringPen.Dispose()
    }
    $path.Dispose()

    # Bold "C" monogram, centered, slight optical lift
    $fontSize = [single]($Size * 0.62)
    $font = [System.Drawing.Font]::new('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240, 240, 245))
    $sf = [System.Drawing.StringFormat]::new()
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textRect = [System.Drawing.RectangleF]::new([single]0, [single](-$Size*0.04), [single]$Size, [single]$Size)
    $g.DrawString('C', $font, $textBrush, $textRect, $sf)
    $font.Dispose()
    $textBrush.Dispose()
    $sf.Dispose()

    # Green status dot (top-right) with dark outline for separation
    $dot = [int]($Size * 0.24)
    $dotX = $Size - $dot - [int]($Size * 0.10)
    $dotY = [int]($Size * 0.10)
    $glow = [Math]::Max(0, [int]($Size * 0.04))
    if ($glow -gt 0) {
        $glowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(60, 34, 197, 94))
        $g.FillEllipse($glowBrush, $dotX - $glow, $dotY - $glow, $dot + 2*$glow, $dot + 2*$glow)
        $glowBrush.Dispose()
    }
    $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(34, 197, 94))
    $g.FillEllipse($dotBrush, $dotX, $dotY, $dot, $dot)
    $dotBrush.Dispose()
    $outlinePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(15, 15, 18)), ([Math]::Max(1.0, $Size * 0.02))
    $g.DrawEllipse($outlinePen, $dotX, $dotY, $dot, $dot)
    $outlinePen.Dispose()

    $g.Dispose()
    return $bmp
}

function Get-PngBytes {
    param($Bitmap)
    $ms = New-Object System.IO.MemoryStream
    $Bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    # Wrap in comma so PowerShell doesn't enumerate the byte array into pipeline
    return ,$ms.ToArray()
}

$outDir = $PSScriptRoot
$sizes = @(16, 32, 48, 64, 128, 256)
$bitmaps = @{}
$pngs = @{}
foreach ($s in $sizes) {
    $bmp = New-IconBitmap -Size $s
    $bitmaps[$s] = $bmp
    $pngs[$s] = Get-PngBytes -Bitmap $bmp
}

# Save the 256px PNG for the tray (main.js reads icon.png)
$pngPath = Join-Path $outDir 'icon.png'
[System.IO.File]::WriteAllBytes($pngPath, $pngs[256])
Write-Host "Wrote $pngPath"

# Assemble .ico with embedded PNGs (valid since Vista)
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)
$offset = 6 + (16 * $sizes.Count)
foreach ($s in $sizes) {
    $len = $pngs[$s].Length
    $w = if ($s -ge 256) { 0 } else { $s }
    $h = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$w)
    $bw.Write([byte]$h)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$len)
    $bw.Write([UInt32]$offset)
    $offset += $len
}
foreach ($s in $sizes) {
    $bytes = [byte[]]$pngs[$s]
    $bw.Write($bytes, 0, $bytes.Length)
}
$bw.Flush()
$icoPath = Join-Path $outDir 'icon.ico'
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose()
Write-Host "Wrote $icoPath"

foreach ($s in $sizes) { $bitmaps[$s].Dispose() }
