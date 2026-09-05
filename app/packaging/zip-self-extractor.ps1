$ErrorActionPreference = "Stop"

$zipSelfExtractorFooterMagic = [byte[]](
    0x45, 0x41, 0x43, 0x5F, 0x5A, 0x49, 0x50, 0x5F,
    0x53, 0x46, 0x58, 0x5F, 0x30, 0x30, 0x30, 0x31
)
$zipSelfExtractorFooterLength = 24

function Get-ZipSelfExtractorCompiler {
    $candidates = @(
        "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    throw "The .NET Framework C# compiler was not found."
}

function Copy-ZipSelfExtractorFileRange {
    param(
        [Parameter(Mandatory = $true)][IO.Stream]$Destination,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][long]$Offset,
        [Parameter(Mandatory = $true)][long]$Length
    )

    $buffer = New-Object byte[] 1048576
    $remaining = $Length
    $sourceStream = [IO.File]::OpenRead($Source)
    try {
        $sourceStream.Position = $Offset
        while ($remaining -gt 0) {
            $readLength = [Math]::Min([long]$buffer.Length, $remaining)
            $read = $sourceStream.Read($buffer, 0, [int]$readLength)
            if ($read -eq 0) {
                throw "Unexpected end of self-extracting ZIP data: $Source"
            }
            $Destination.Write($buffer, 0, $read)
            $remaining -= $read
        }
    } finally {
        $sourceStream.Dispose()
    }
}

function ConvertTo-ZipSelfExtractorPartSize {
    param([Parameter(Mandatory = $true)][string]$PartSize)

    if ($PartSize -notmatch "^(\d+)([kKmMgG])$") {
        throw "Invalid ZIP self-extractor volume size: $PartSize"
    }
    $multiplier = switch ($Matches[2].ToLowerInvariant()) {
        "k" { 1KB }
        "m" { 1MB }
        "g" { 1GB }
    }
    $bytes = [long]$Matches[1] * [long]$multiplier
    if ($bytes -le $zipSelfExtractorFooterLength) {
        throw "ZIP self-extractor volume size is too small: $PartSize"
    }
    return $bytes
}

function Split-ZipSelfExtractorArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$PartSize
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "ZIP archive was not found: $Source"
    }
    $partSizeBytes = ConvertTo-ZipSelfExtractorPartSize -PartSize $PartSize
    $sourceLength = (Get-Item -LiteralPath $Source).Length
    if ($sourceLength -le 0) {
        throw "ZIP archive is empty: $Source"
    }
    $destinationParent = Split-Path -Parent $Destination
    $destinationName = Split-Path -Leaf $Destination
    $destinationBaseName = [IO.Path]::GetFileNameWithoutExtension($destinationName)
    $partPattern = "^$([regex]::Escape($destinationBaseName))\.z\d{2,}$"
    Get-ChildItem -LiteralPath $destinationParent -File |
        Where-Object { $_.Name -match $partPattern } |
        Remove-Item -Force
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        Remove-Item -LiteralPath $Destination -Force
    }

    $sourceOffset = 0L
    $partNumber = 1
    while (($sourceLength - $sourceOffset) -gt $partSizeBytes) {
        $partPath = Join-Path $destinationParent (
            "$destinationBaseName.z{0:D2}" -f $partNumber
        )
        $partStream = [IO.File]::Open(
            $partPath,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write
        )
        try {
            $partOffset = 0L
            if ($partNumber -eq 1) {
                $partStream.Write(
                    [byte[]](0x50, 0x4B, 0x07, 0x08),
                    0,
                    4
                )
                $partOffset = 4
            }
            $copyLength = $partSizeBytes - $partOffset
            Copy-ZipSelfExtractorFileRange `
                -Destination $partStream `
                -Source $Source `
                -Offset $sourceOffset `
                -Length $copyLength
            $sourceOffset += $copyLength
        } finally {
            $partStream.Dispose()
        }
        $partNumber++
    }

    $finalStream = [IO.File]::Open(
        $Destination,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write
    )
    try {
        Copy-ZipSelfExtractorFileRange `
            -Destination $finalStream `
            -Source $Source `
            -Offset $sourceOffset `
            -Length ($sourceLength - $sourceOffset)
    } finally {
        $finalStream.Dispose()
    }
}

function New-ZipSelfExtractor {
    param(
        [Parameter(Mandatory = $true)][string]$ZipVolume,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not (Test-Path -LiteralPath $ZipVolume -PathType Leaf)) {
        throw "ZIP volume was not found: $ZipVolume"
    }
    $sourcePath = Join-Path $PSScriptRoot "ZipSelfExtractor.cs"
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "ZIP self-extractor source was not found: $sourcePath"
    }

    $compiler = Get-ZipSelfExtractorCompiler
    $destinationParent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
    $stubPath = Join-Path $destinationParent (
        ".zip-self-extractor-$([guid]::NewGuid().ToString('N')).exe"
    )
    try {
        & $compiler `
            /nologo `
            /target:winexe `
            /platform:x64 `
            /optimize+ `
            "/out:$stubPath" `
            /r:System.IO.Compression.dll `
            /r:System.Windows.Forms.dll `
            $sourcePath
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to compile the ZIP self-extractor."
        }

        $volumeLength = (Get-Item -LiteralPath $ZipVolume).Length
        $destinationStream = [IO.File]::Open(
            $Destination,
            [IO.FileMode]::Create,
            [IO.FileAccess]::Write
        )
        try {
            Copy-ZipSelfExtractorFileRange `
                -Destination $destinationStream `
                -Source $stubPath `
                -Offset 0 `
                -Length (Get-Item -LiteralPath $stubPath).Length
            Copy-ZipSelfExtractorFileRange `
                -Destination $destinationStream `
                -Source $ZipVolume `
                -Offset 0 `
                -Length $volumeLength
            $destinationStream.Write(
                $zipSelfExtractorFooterMagic,
                0,
                $zipSelfExtractorFooterMagic.Length
            )
            $payloadLength = [BitConverter]::GetBytes([long]$volumeLength)
            $destinationStream.Write($payloadLength, 0, $payloadLength.Length)
        } finally {
            $destinationStream.Dispose()
        }
    } finally {
        if (Test-Path -LiteralPath $stubPath -PathType Leaf) {
            Remove-Item -LiteralPath $stubPath -Force
        }
    }
}

function Get-ZipSelfExtractorPayloadMetadata {
    param(
        [Parameter(Mandatory = $true)][string]$SelfExtractor
    )

    $item = Get-Item -LiteralPath $SelfExtractor
    if ($item.Length -lt $zipSelfExtractorFooterLength) {
        throw "ZIP self-extractor footer is missing: $SelfExtractor"
    }
    $footer = New-Object byte[] $zipSelfExtractorFooterLength
    $sourceStream = [IO.File]::OpenRead($SelfExtractor)
    try {
        $sourceStream.Position = $item.Length - $zipSelfExtractorFooterLength
        $read = $sourceStream.Read($footer, 0, $footer.Length)
        if ($read -ne $footer.Length) {
            throw "ZIP self-extractor footer is truncated: $SelfExtractor"
        }
        for ($index = 0; $index -lt $zipSelfExtractorFooterMagic.Length; $index++) {
            if ($footer[$index] -ne $zipSelfExtractorFooterMagic[$index]) {
                throw "ZIP self-extractor footer is invalid: $SelfExtractor"
            }
        }
        $payloadLength = [BitConverter]::ToInt64(
            $footer,
            $zipSelfExtractorFooterMagic.Length
        )
        $payloadOffset = $item.Length - $zipSelfExtractorFooterLength - $payloadLength
        if ($payloadLength -le 0 -or $payloadOffset -lt 0) {
            throw "ZIP self-extractor payload length is invalid: $SelfExtractor"
        }
    } finally {
        $sourceStream.Dispose()
    }

    return [pscustomobject]@{
        Offset = $payloadOffset
        Length = $payloadLength
    }
}

function Copy-ZipSelfExtractorPayload {
    param(
        [Parameter(Mandatory = $true)][string]$SelfExtractor,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $payload = Get-ZipSelfExtractorPayloadMetadata -SelfExtractor $SelfExtractor
    $destinationStream = [IO.File]::Open(
        $Destination,
        [IO.FileMode]::Create,
        [IO.FileAccess]::Write
    )
    try {
        Copy-ZipSelfExtractorFileRange `
            -Destination $destinationStream `
            -Source $SelfExtractor `
            -Offset $payload.Offset `
            -Length $payload.Length
    } finally {
        $destinationStream.Dispose()
    }
}

function Restore-ZipSelfExtractorArchive {
    param(
        [Parameter(Mandatory = $true)][string]$SelfExtractor,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $selfExtractorItem = Get-Item -LiteralPath $SelfExtractor
    $baseName = [IO.Path]::GetFileNameWithoutExtension($selfExtractorItem.Name)
    $partPattern = "^$([regex]::Escape($baseName))\.z(\d{2,})$"
    $parts = @(
        Get-ChildItem -LiteralPath $selfExtractorItem.DirectoryName -File |
            Where-Object { $_.Name -match $partPattern } |
            Sort-Object {
                [int]([regex]::Match($_.Name, $partPattern).Groups[1].Value)
            }
    )
    for ($index = 0; $index -lt $parts.Count; $index++) {
        $expected = $index + 1
        $actual = [int]([regex]::Match(
            $parts[$index].Name,
            $partPattern
        ).Groups[1].Value)
        if ($actual -ne $expected) {
            throw "ZIP self-extractor volume is missing: $baseName.z{0:D2}" -f $expected
        }
    }
    $payload = Get-ZipSelfExtractorPayloadMetadata -SelfExtractor $SelfExtractor
    $destinationStream = [IO.File]::Open(
        $Destination,
        [IO.FileMode]::Create,
        [IO.FileAccess]::Write
    )
    try {
        for ($index = 0; $index -lt $parts.Count; $index++) {
            $part = $parts[$index]
            $offset = 0L
            if ($index -eq 0) {
                if ($part.Length -lt 4) {
                    throw "ZIP self-extractor first volume is truncated: $($part.Name)"
                }
                $marker = New-Object byte[] 4
                $partInput = [IO.File]::OpenRead($part.FullName)
                try {
                    $read = $partInput.Read($marker, 0, $marker.Length)
                    if ($read -ne $marker.Length) {
                        throw "ZIP self-extractor first volume is truncated: $($part.Name)"
                    }
                } finally {
                    $partInput.Dispose()
                }
                if (
                    $marker[0] -ne 0x50 -or
                    $marker[1] -ne 0x4B -or
                    $marker[2] -ne 0x07 -or
                    $marker[3] -ne 0x08
                ) {
                    throw "ZIP self-extractor first volume is invalid: $($part.Name)"
                }
                $offset = 4
            }
            Copy-ZipSelfExtractorFileRange `
                -Destination $destinationStream `
                -Source $part.FullName `
                -Offset $offset `
                -Length ($part.Length - $offset)
        }
        Copy-ZipSelfExtractorFileRange `
            -Destination $destinationStream `
            -Source $SelfExtractor `
            -Offset $payload.Offset `
            -Length $payload.Length
    } finally {
        $destinationStream.Dispose()
    }
}

function Test-ZipSelfExtractor {
    param([Parameter(Mandatory = $true)][string]$Path)

    $process = Start-Process `
        -FilePath $Path `
        -ArgumentList "--verify" `
        -Wait `
        -PassThru
    if ($process.ExitCode -ne 0) {
        throw "ZIP self-extractor verification failed: $Path"
    }
}
