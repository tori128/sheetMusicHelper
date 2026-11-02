param([string]$RequestedTag = "")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "ci-release-context.ps1")
$context = Get-CiReleaseContext -RequestedTag $RequestedTag
$release = Get-CiReleaseDraft -Tag $context.Tag
if ($null -eq $release) { exit 0 }
if (-not $release.draft -or $release.target_commitish -ne $context.SourceCommit) {
    throw "The release does not match this failed CI draft."
}
& gh api --method DELETE "repos/$env:GITHUB_REPOSITORY/releases/$($release.id)"
if ($LASTEXITCODE -ne 0) { throw "Failed CI draft removal failed." }
Write-Output "The failed CI release draft was removed."
