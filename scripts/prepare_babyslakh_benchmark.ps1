param(
    [string]$Destination = "app/benchmark/public-data"
)

$ErrorActionPreference = "Stop"

$archiveUrl = "https://zenodo.org/records/4603870/files/babyslakh_16k.tar.gz?download=1"
$expectedMd5 = "311096dc2bde7d61c97e930edbfc7f78"
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$downloadDirectory = Join-Path ([System.IO.Path]::GetDirectoryName($destinationPath)) "downloads"
$archivePath = Join-Path $downloadDirectory "babyslakh_16k.tar.gz"
$datasetPath = Join-Path $destinationPath "babyslakh_16k"

if (Test-Path (Join-Path $datasetPath "Track00020/all_src.mid")) {
    Write-Host "BabySlakh is already available at $datasetPath"
    exit 0
}

New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null

if (-not (Test-Path $archivePath)) {
    Write-Host "Downloading BabySlakh v2 (about 883 MB) from Zenodo..."
    & curl.exe -L --fail --retry 3 --connect-timeout 30 `
        --output $archivePath $archiveUrl
    if ($LASTEXITCODE -ne 0) {
        throw "BabySlakh download failed with exit code $LASTEXITCODE"
    }
}

$actualMd5 = (Get-FileHash -Algorithm MD5 $archivePath).Hash.ToLowerInvariant()
if ($actualMd5 -ne $expectedMd5) {
    throw "BabySlakh checksum mismatch: expected $expectedMd5, got $actualMd5"
}

Write-Host "Extracting BabySlakh..."
& tar.exe -xzf $archivePath -C $destinationPath
if ($LASTEXITCODE -ne 0) {
    throw "BabySlakh extraction failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path (Join-Path $datasetPath "Track00020/all_src.mid"))) {
    throw "BabySlakh extraction completed without the expected files"
}

Write-Host "BabySlakh is ready at $datasetPath"
