param([string]$RequestedTag = "")

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
$sourcePattern = "^EarCopyAssist-$([regex]::Escape($package.version))-muscriptor-source-(small|medium|large)\.7z(\.\d{3})?$"

$releaseJson = & gh release view $tag `
    --repo $env:GITHUB_REPOSITORY `
    --json isDraft,assets 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Draft release was not found: $tag"
}
$release = $releaseJson | ConvertFrom-Json
if (-not $release.isDraft) {
    throw "Refusing to modify a published release: $tag"
}

foreach ($asset in $release.assets) {
    if ([string]$asset.name -match $sourcePattern) {
        & gh release delete-asset $tag $asset.name `
            --repo $env:GITHUB_REPOSITORY `
            --yes
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to remove model source asset: $($asset.name)"
        }
    }
}

Write-Output "MuScriptor source assets were removed from draft $tag."
