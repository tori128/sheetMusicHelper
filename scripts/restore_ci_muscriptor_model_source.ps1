param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("small", "medium", "large")]
    [string]$Variant,
    [string]$RequestedTag = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

foreach ($name in @("GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GH_TOKEN")) {
    if ([string]::IsNullOrWhiteSpace(
        [Environment]::GetEnvironmentVariable($name)
    )) {
        throw "Required GitHub Actions environment variable is missing: $name"
    }
}
if ([Environment]::GetEnvironmentVariable("GITHUB_ACTIONS") -ne "true") {
    throw "This script can only run inside GitHub Actions."
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$package = Get-Content `
    -LiteralPath (Join-Path $repositoryRoot "app\package.json") `
    -Raw `
    -Encoding utf8 |
    ConvertFrom-Json
$tag = $RequestedTag.Trim()
if ([string]::IsNullOrWhiteSpace($tag)) {
    $tag = "v$($package.version)"
}
if ($tag -notmatch "^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$") {
    throw "Invalid release tag: $tag"
}

$sevenZip = Get-Command "7z.exe" -ErrorAction SilentlyContinue
if ($null -eq $sevenZip) {
    $sevenZipPath = "C:\Program Files\7-Zip\7z.exe"
    if (-not (Test-Path -LiteralPath $sevenZipPath -PathType Leaf)) {
        throw "7-Zip was not found."
    }
} else {
    $sevenZipPath = $sevenZip.Source
}

$assetBaseName = "EarCopyAssist-$($package.version)-muscriptor-source-$Variant.7z"
$downloadRoot = Join-Path $repositoryRoot "app\model-source-download"
$variantRoot = Join-Path $repositoryRoot "models\muscriptor\$Variant"
Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $variantRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $variantRoot -Force | Out-Null

try {
    & gh release download $tag `
        --repo $env:GITHUB_REPOSITORY `
        --pattern "$assetBaseName*" `
        --dir $downloadRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to download the $Variant model source archive."
    }

    $archive = Join-Path $downloadRoot $assetBaseName
    $testArchive = if ($Variant -eq "large") {
        "$archive.001"
    } else {
        $archive
    }
    if (-not (Test-Path -LiteralPath $testArchive -PathType Leaf)) {
        throw "Model source archive is incomplete: $($testArchive | Split-Path -Leaf)"
    }
    & $sevenZipPath t $testArchive
    if ($LASTEXITCODE -ne 0) {
        throw "Model source archive integrity check failed: $($testArchive | Split-Path -Leaf)"
    }
    & $sevenZipPath x $testArchive "-o$variantRoot" -y
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to extract the $Variant model source archive."
    }

    & (Join-Path $repositoryRoot "app\packaging\verify-muscriptor-models.ps1") `
        -Variant $Variant
} finally {
    Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "MuScriptor $Variant model source was restored and verified."
