param([string]$RequestedTag = "")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "ci-release-context.ps1")
$context = Get-CiReleaseContext -RequestedTag $RequestedTag
if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN)) { throw "CI release authentication is required." }
$repositoryRoot = $ciReleaseRepositoryRoot
$assetRoot = Join-Path $repositoryRoot "app\release-assets"
$validationRoot = Join-Path $repositoryRoot "app\release-validation"
if (Test-Path -LiteralPath $assetRoot) { throw "Release verification requires an empty asset directory." }
New-Item -ItemType Directory -Path $assetRoot -Force | Out-Null
New-Item -ItemType Directory -Path $validationRoot -Force | Out-Null

$release = Get-CiReleaseDraft -Tag $context.Tag
if ($null -eq $release) { throw "The CI release draft was not found." }
if (-not $release.draft -or $release.target_commitish -ne $context.SourceCommit) {
    throw "The release draft does not match this CI source commit."
}
$catalog = Get-Content -LiteralPath (Join-Path $repositoryRoot "src\earcopy_service\model-downloads.json") -Raw -Encoding utf8 | ConvertFrom-Json
$portable = "EarCopyAssist-$($context.Version)-win-x64"
$expected = @("$portable.exe", "EarCopyAssist-$($context.Version)-copyleft-sources.zip", "RELEASE_NOTES.md", "SHA256SUMS.txt")
foreach ($model in $catalog.models) { $expected += @($model.assets) }
$parts = @($release.assets | Where-Object { $_.name -match "^$([regex]::Escape($portable))\.z\d{2,}$" } | ForEach-Object { $_.name })
if ($parts.Count -lt 1) { throw "The Windows distribution volumes are missing." }
$expected += $parts
$names = @($release.assets | ForEach-Object { $_.name })
if ($names.Count -ne $expected.Count -or @($names | Where-Object { $_ -notin $expected }).Count -ne 0) {
    throw "The release draft asset set does not match the distribution."
}
foreach ($asset in $release.assets) {
    if ($asset.uploader.login -ne "github-actions[bot]" -or $asset.state -ne "uploaded" -or $asset.size -le 0 -or $asset.size -ge 2GB -or $asset.digest -notmatch '^sha256:[0-9a-f]{64}$') {
        throw "A draft asset does not have valid CI provenance or integrity information."
    }
}
& gh release download $context.Tag --repo $env:GITHUB_REPOSITORY --dir $assetRoot
if ($LASTEXITCODE -ne 0) { throw "Release draft download failed." }
foreach ($asset in $release.assets) {
    $path = Join-Path $assetRoot $asset.name
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ((Get-Item -LiteralPath $path).Length -ne $asset.size -or "sha256:$actual" -ne $asset.digest) {
        throw "Downloaded asset integrity verification failed."
    }
}
$notes = [IO.File]::ReadAllText((Join-Path $assetRoot "RELEASE_NOTES.md")).Trim().TrimStart([char]0xFEFF)
if ($notes -ne ([string]$release.body).Trim().TrimStart([char]0xFEFF)) {
    throw "The release body does not match the verified release notes."
}
& python (Join-Path $PSScriptRoot "release_privacy.py") --directory $assetRoot --report (Join-Path $validationRoot "release-attachments-privacy.json")
if ($LASTEXITCODE -ne 0) { throw "Release attachment privacy verification failed." }
& (Join-Path $repositoryRoot "app\packaging\verify-release-package.ps1")
foreach ($model in $catalog.models) {
    foreach ($name in $model.assets) { Remove-Item -LiteralPath (Join-Path $assetRoot $name) -Force }
}
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repositoryRoot "app\packaging\test-zip-self-extractor.ps1") -ReleaseArchive (Join-Path $assetRoot "$portable.exe")
if ($LASTEXITCODE -ne 0) { throw "Self-extractor acceptance tests failed." }

$provenance = [ordered]@{
    passed = $true
    tag = $context.Tag
    sourceCommit = $context.SourceCommit
    workflowRun = $context.RunUrl
    runAttempt = $context.RunAttempt
    draft = $true
    assets = @($release.assets | ForEach-Object { [ordered]@{name=$_.name; sizeBytes=$_.size; digest=$_.digest; uploader=$_.uploader.login} })
}
$provenance | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $validationRoot "ci-provenance.json") -Encoding utf8
if ($env:GITHUB_STEP_SUMMARY) {
    "Verified release draft: $($context.Tag)`n`nSource commit: $($context.SourceCommit)`n`nAll distribution assets were built by GitHub Actions and passed archive, checksum, privacy and extraction validation." | Out-File $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
}
Write-Output "The CI release draft passed distribution validation."
