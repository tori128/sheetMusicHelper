$ciReleaseRepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Get-CiReleaseContext {
    param([string]$RequestedTag = "")
    foreach ($name in @("GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKSPACE")) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
            throw "Required CI release context is missing."
        }
    }
    if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted" -or $env:GITHUB_WORKFLOW -ne "Windows Release") {
        throw "Release packaging requires the hosted Windows Release workflow."
    }
    $workspace = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE).TrimEnd("\", "/")
    if (-not $workspace.Equals($ciReleaseRepositoryRoot.TrimEnd("\", "/"), [StringComparison]::OrdinalIgnoreCase)) {
        throw "CI release workspace does not match the checkout."
    }
    $catalog = Get-Content -LiteralPath (Join-Path $ciReleaseRepositoryRoot "src\earcopy_service\model-downloads.json") -Raw -Encoding utf8 | ConvertFrom-Json
    $package = Get-Content -LiteralPath (Join-Path $ciReleaseRepositoryRoot "app\package.json") -Raw -Encoding utf8 | ConvertFrom-Json
    $tag = "v$($package.version)"
    if ((-not [string]::IsNullOrWhiteSpace($RequestedTag)) -and $RequestedTag.Trim() -ne $tag) {
        throw "Release tag must match the package version."
    }
    $commit = (& git -C $ciReleaseRepositoryRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch "^[0-9a-f]{40}$" -or $commit -ne $env:GITHUB_SHA -or $env:GITHUB_RUN_ID -notmatch "^\d+$" -or $env:GITHUB_RUN_ATTEMPT -notmatch "^\d+$" -or $env:GITHUB_REPOSITORY -ne $catalog.repository -or $tag -ne $catalog.releaseTag) {
        throw "CI release source identity does not match the package."
    }
    return [pscustomobject]@{
        Tag = $tag
        Version = [string]$package.version
        SourceCommit = $commit
        RunId = $env:GITHUB_RUN_ID
        RunAttempt = $env:GITHUB_RUN_ATTEMPT
        RunUrl = "https://github.com/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID"
    }
}

function Get-CiReleaseDraft {
    param([Parameter(Mandatory = $true)][string]$Tag)
    $json = & gh api "repos/$env:GITHUB_REPOSITORY/releases?per_page=100" --paginate --slurp
    if ($LASTEXITCODE -ne 0) { throw "The repository release list could not be retrieved." }
    $pages = $json | ConvertFrom-Json
    $matches = @(
        foreach ($page in $pages) {
            foreach ($release in $page) {
                if ($release.tag_name -eq $Tag) { $release }
            }
        }
    )
    if ($matches.Count -gt 1) { throw "The release tag is ambiguous." }
    if ($matches.Count -eq 0) { return $null }
    return $matches[0]
}
