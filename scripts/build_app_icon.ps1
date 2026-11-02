$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resourcesRoot = Join-Path $repositoryRoot "app\resources"
$pngPath = Join-Path $resourcesRoot "icon.png"
$icoPath = Join-Path $resourcesRoot "icon.ico"
New-Item -ItemType Directory -Force -Path $resourcesRoot | Out-Null

if ($env:EARCOPY_REUSE_TRACKED_ICON -eq "1") {
    foreach ($path in @($pngPath, $icoPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Tracked application icon was not found: $path"
        }
    }
    Write-Output "Reusing tracked application icon: $icoPath"
    return
}

function New-RoundedRectanglePath {
    param(
        [Parameter(Mandatory = $true)][System.Drawing.RectangleF]$Rectangle,
        [Parameter(Mandatory = $true)][float]$Radius
    )

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc(
        $Rectangle.Left,
        $Rectangle.Top,
        $diameter,
        $diameter,
        180,
        90
    )
    $path.AddArc(
        $Rectangle.Right - $diameter,
        $Rectangle.Top,
        $diameter,
        $diameter,
        270,
        90
    )
    $path.AddArc(
        $Rectangle.Right - $diameter,
        $Rectangle.Bottom - $diameter,
        $diameter,
        $diameter,
        0,
        90
    )
    $path.AddArc(
        $Rectangle.Left,
        $Rectangle.Bottom - $diameter,
        $diameter,
        $diameter,
        90,
        90
    )
    $path.CloseFigure()
    return $path
}

$bitmap = [System.Drawing.Bitmap]::new(
    256,
    256,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$backgroundPath = $null
$backgroundBrush = $null
$borderPen = $null
$wavePen = $null
$notePen = $null
$noteBrush = $null
try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $backgroundPath = New-RoundedRectanglePath `
        -Rectangle ([System.Drawing.RectangleF]::new(12, 12, 232, 232)) `
        -Radius 42
    $backgroundBrush = [System.Drawing.SolidBrush]::new(
        [System.Drawing.ColorTranslator]::FromHtml("#151A23")
    )
    $borderPen = [System.Drawing.Pen]::new(
        [System.Drawing.ColorTranslator]::FromHtml("#7C6CFF"),
        10
    )
    $graphics.FillPath($backgroundBrush, $backgroundPath)
    $graphics.DrawPath($borderPen, $backgroundPath)

    $wavePen = [System.Drawing.Pen]::new(
        [System.Drawing.ColorTranslator]::FromHtml("#55D6A5"),
        13
    )
    $wavePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $wavePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $wavePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $wavePoints = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(43, 139),
        [System.Drawing.PointF]::new(64, 139),
        [System.Drawing.PointF]::new(78, 104),
        [System.Drawing.PointF]::new(96, 174),
        [System.Drawing.PointF]::new(114, 119),
        [System.Drawing.PointF]::new(132, 139),
        [System.Drawing.PointF]::new(149, 139)
    )
    $graphics.DrawLines($wavePen, $wavePoints)

    $notePen = [System.Drawing.Pen]::new(
        [System.Drawing.Color]::White,
        14
    )
    $notePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $notePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLine($notePen, 178, 72, 178, 164)
    $graphics.DrawLine($notePen, 178, 78, 211, 88)

    $noteBrush = [System.Drawing.SolidBrush]::new(
        [System.Drawing.Color]::White
    )
    $graphics.FillEllipse($noteBrush, 137, 149, 52, 38)

    $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    foreach ($resource in @(
        $noteBrush,
        $notePen,
        $wavePen,
        $borderPen,
        $backgroundBrush,
        $backgroundPath,
        $graphics
    )) {
        if ($null -ne $resource) {
            $resource.Dispose()
        }
    }
    $bitmap.Dispose()
}

$pngBytes = [IO.File]::ReadAllBytes($pngPath)
$stream = [IO.File]::Open(
    $icoPath,
    [IO.FileMode]::Create,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
)
$writer = [IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]1)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$pngBytes.Length)
    $writer.Write([uint32]22)
    $writer.Write($pngBytes)
} finally {
    $writer.Dispose()
    $stream.Dispose()
}

Write-Output "Application icon: $icoPath"
