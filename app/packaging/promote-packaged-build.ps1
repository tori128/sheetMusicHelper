$ErrorActionPreference = "Stop"

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = Join-Path $appRoot "release"
$stagingRoot = Join-Path $appRoot "release-staging"
$stagedApplication = Join-Path $stagingRoot "win-unpacked"
$liveApplication = Join-Path $releaseRoot "win-unpacked"
$backupApplication = Join-Path $releaseRoot "win-unpacked.previous"
$lockPath = Join-Path $releaseRoot ".packaging.lock"
$guardScript = Join-Path $PSScriptRoot "assert-app-not-running.ps1"

function Assert-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    ) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedPath.StartsWith(
        $resolvedParent,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Path is outside the expected directory: $resolvedPath"
    }
}

function Remove-DirectoryInside {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    Assert-PathInside -Path $Path -Parent $Parent
    Remove-Item -LiteralPath $Path -Recurse -Force
}

if (-not (Test-Path -LiteralPath (
    Join-Path $stagedApplication "EarCopyAssist.exe"
) -PathType Leaf)) {
    throw "Staged application was not found: $stagedApplication"
}

Assert-PathInside -Path $stagedApplication -Parent $stagingRoot
Assert-PathInside -Path $liveApplication -Parent $releaseRoot
Assert-PathInside -Path $backupApplication -Parent $releaseRoot
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
Set-Content `
    -LiteralPath $lockPath `
    -Encoding ascii `
    -Value "Packaging started at $([DateTimeOffset]::Now.ToString('O'))"

try {
    & $guardScript
    Remove-DirectoryInside -Path $backupApplication -Parent $releaseRoot
    if (Test-Path -LiteralPath $liveApplication) {
        Move-Item -LiteralPath $liveApplication -Destination $backupApplication
    }
    try {
        Move-Item -LiteralPath $stagedApplication -Destination $liveApplication
    } catch {
        if (
            -not (Test-Path -LiteralPath $liveApplication) -and
            (Test-Path -LiteralPath $backupApplication)
        ) {
            Move-Item `
                -LiteralPath $backupApplication `
                -Destination $liveApplication
        }
        throw
    }

    Remove-DirectoryInside -Path $backupApplication -Parent $releaseRoot
    Write-Output "Promoted packaged application: $liveApplication"
} finally {
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
