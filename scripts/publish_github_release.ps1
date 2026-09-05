param([string]$RequestedTag = "")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::GetEnvironmentVariable("GITHUB_ACTIONS") -ne "true") {
    throw "This publishing script can only run inside GitHub Actions."
}
foreach ($name in @("GH_TOKEN", "GITHUB_REPOSITORY")) {
    if ([string]::IsNullOrWhiteSpace(
        [Environment]::GetEnvironmentVariable($name)
    )) {
        throw "Required GitHub Actions environment variable is missing: $name"
    }
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

$releaseJson = & gh release view $tag `
    --repo $env:GITHUB_REPOSITORY `
    --json isDraft,assets 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Draft release was not found: $tag"
}
$release = $releaseJson | ConvertFrom-Json
if (-not $release.isDraft) {
    throw "Release is already published: $tag"
}

$portableName = "EarCopyAssist-$($package.version)-win-x64"
$sourceName = "EarCopyAssist-$($package.version)-copyleft-sources.zip"
$smallName = "EarCopyAssist-$($package.version)-muscriptor-small.exe"
$mediumName = "EarCopyAssist-$($package.version)-muscriptor-medium.exe"
$largeBaseName = "EarCopyAssist-$($package.version)-muscriptor-large"
$largeName = "$largeBaseName.exe"
$assetNames = @($release.assets | ForEach-Object { [string]$_.name })
$requiredAssetNames = @(
    "$portableName.exe",
    $sourceName,
    "RELEASE_NOTES.md",
    "SHA256SUMS.txt",
    $smallName,
    $mediumName,
    $largeName
)
$missingAssets = @(
    $requiredAssetNames | Where-Object { $_ -notin $assetNames }
)
if ($missingAssets.Count -ne 0) {
    throw "Draft release assets are missing: $($missingAssets -join ', ')"
}

$largePartPattern = "^$([regex]::Escape($largeBaseName))\.z(\d{2,})$"
$largeParts = @(
    $assetNames |
        Where-Object { $_ -match $largePartPattern } |
        Sort-Object {
            [int]([regex]::Match($_, $largePartPattern).Groups[1].Value)
        }
)
if ($largeParts.Count -lt 1) {
    throw "Draft release large model ZIP volumes are missing."
}
for ($index = 0; $index -lt $largeParts.Count; $index++) {
    $expectedName = "$largeBaseName.z{0:D2}" -f ($index + 1)
    if ($largeParts[$index] -ne $expectedName) {
        throw (
            "Large model ZIP volume numbering is incomplete. " +
            "Expected=$expectedName Actual=$($largeParts[$index])"
        )
    }
}

$checksumRoot = Join-Path $repositoryRoot "app\release-publish-checksums"
Remove-Item -LiteralPath $checksumRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $checksumRoot -Force | Out-Null
try {
    & gh release download $tag `
        --repo $env:GITHUB_REPOSITORY `
        --pattern "SHA256SUMS.txt" `
        --dir $checksumRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to retrieve the draft release checksum file."
    }
    $checksums = Join-Path $checksumRoot "SHA256SUMS.txt"
    if (-not (Test-Path -LiteralPath $checksums -PathType Leaf)) {
        throw "Draft release checksum file is missing."
    }
    $recordedNames = @(
        Get-Content -LiteralPath $checksums -Encoding ascii |
            ForEach-Object {
                if ($_ -notmatch "^[0-9a-f]{64}  ([^\\/]+)$") {
                    throw "Invalid SHA256SUMS entry: $_"
                }
                $Matches[1]
            }
    )
    $expectedChecksumNames = @(
        $assetNames | Where-Object {
            $_ -ne "RELEASE_NOTES.md" -and $_ -ne "SHA256SUMS.txt"
        }
    )
    $missingChecksums = @(
        $expectedChecksumNames | Where-Object { $_ -notin $recordedNames }
    )
    $unexpectedChecksums = @(
        $recordedNames | Where-Object { $_ -notin $expectedChecksumNames }
    )
    if (
        $missingChecksums.Count -ne 0 -or
        $unexpectedChecksums.Count -ne 0
    ) {
        throw (
            "SHA256SUMS does not match draft release assets. " +
            "Missing=$($missingChecksums -join ', ') " +
            "Unexpected=$($unexpectedChecksums -join ', ')"
        )
    }
} finally {
    Remove-Item -LiteralPath $checksumRoot -Recurse -Force -ErrorAction SilentlyContinue
}

& gh release edit $tag --repo $env:GITHUB_REPOSITORY --draft=false
if ($LASTEXITCODE -ne 0) {
    throw "Release publication failed: $tag"
}
Write-Output "Release published: https://github.com/$env:GITHUB_REPOSITORY/releases/tag/$tag"
