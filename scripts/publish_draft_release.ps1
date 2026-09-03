param([string]$RequestedTag = "")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::GetEnvironmentVariable("GITHUB_ACTIONS") -ne "true") {
    throw "This publishing script can only run inside GitHub Actions."
}
foreach ($name in @("GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_SHA")) {
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

$releaseTitle = "EarCopy Assist $($package.version)"
$assetRoot = Join-Path $repositoryRoot "app\release-assets"
$portableName = "EarCopyAssist-$($package.version)-win-x64"
$sourceName = "EarCopyAssist-$($package.version)-copyleft-sources.zip"
$partPattern = "^$([regex]::Escape($portableName))\.z\d{2,}$"
$partFiles = @(
    Get-ChildItem -LiteralPath $assetRoot -File |
        Where-Object { $_.Name -match $partPattern } |
        Sort-Object Name
)
if ($partFiles.Count -lt 1) {
    throw "Expected at least one .zNN Windows ZIP volume."
}
for ($index = 0; $index -lt $partFiles.Count; $index++) {
    $expected = "$portableName.z{0:D2}" -f ($index + 1)
    if ($partFiles[$index].Name -ne $expected) {
        throw "Split Windows ZIP volume is missing: $expected"
    }
}

$requiredNames = @(
    "$portableName.zip",
    $sourceName,
    "RELEASE_NOTES.md",
    "SHA256SUMS.txt"
)
$requiredFiles = @(
    foreach ($name in $requiredNames) {
        $path = Join-Path $assetRoot $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required release asset is missing: $name"
        }
        Get-Item -LiteralPath $path
    }
)
$assetFiles = @($partFiles + $requiredFiles | Sort-Object Name)
$assets = @($assetFiles | ForEach-Object { $_.FullName })
$desiredAssetNames = @($assetFiles | ForEach-Object { $_.Name })
$modelSourceAssetPattern = (
    "^EarCopyAssist-$([regex]::Escape($package.version))-" +
    "muscriptor-source-(small|medium|large)\.7z(\.\d{3})?$"
)
$releaseNotes = Join-Path $assetRoot "RELEASE_NOTES.md"

$releaseJson = & gh release view $tag `
    --repo $env:GITHUB_REPOSITORY `
    --json isDraft,url,assets 2>$null
$releaseExists = $LASTEXITCODE -eq 0
if ($releaseExists) {
    $release = $releaseJson | ConvertFrom-Json
    if (-not $release.isDraft) {
        throw "Refusing to modify a published release: $tag"
    }
    & gh release edit $tag `
        --repo $env:GITHUB_REPOSITORY `
        --target $env:GITHUB_SHA `
        --title $releaseTitle `
        --notes-file $releaseNotes
    if ($LASTEXITCODE -ne 0) {
        throw "Draft release metadata update failed."
    }
    $existingAssetNames = @($release.assets | ForEach-Object { $_.name })
    foreach ($existingAssetName in $existingAssetNames) {
        if (
            $existingAssetName -notin $desiredAssetNames -and
            $existingAssetName -notmatch $modelSourceAssetPattern
        ) {
            & gh release delete-asset $tag $existingAssetName `
                --repo $env:GITHUB_REPOSITORY `
                --yes
            if ($LASTEXITCODE -ne 0) {
                throw "Unable to remove obsolete release asset: $existingAssetName"
            }
        }
    }
    & gh release upload $tag @assets `
        --repo $env:GITHUB_REPOSITORY `
        --clobber
    if ($LASTEXITCODE -ne 0) {
        throw "Draft release asset update failed."
    }
    $url = [string]$release.url
} else {
    & gh release create $tag @assets `
        --repo $env:GITHUB_REPOSITORY `
        --target $env:GITHUB_SHA `
        --title $releaseTitle `
        --notes-file $releaseNotes `
        --draft
    if ($LASTEXITCODE -ne 0) {
        throw "Draft release creation failed."
    }
    $url = "https://github.com/$env:GITHUB_REPOSITORY/releases/tag/$tag"
}

if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) {
    "Draft release: [$tag]($url)" |
        Out-File $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
}
Write-Output "Draft release updated: $url"
