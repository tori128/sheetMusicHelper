param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("BeforeBuild", "AfterPackaging")]
    [string]$Phase
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspace = [Environment]::GetEnvironmentVariable("GITHUB_WORKSPACE")
if (
    [Environment]::GetEnvironmentVariable("GITHUB_ACTIONS") -ne "true" -or
    [string]::IsNullOrWhiteSpace($workspace)
) {
    throw "This cleanup script can only run inside GitHub Actions."
}

$resolvedWorkspace = [IO.Path]::GetFullPath($workspace).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
)
$resolvedRepository = [IO.Path]::GetFullPath($repositoryRoot).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
)
if (-not $resolvedWorkspace.Equals(
    $resolvedRepository,
    [StringComparison]::OrdinalIgnoreCase
)) {
    throw (
        "GITHUB_WORKSPACE does not match the repository root. " +
        "workspace=$resolvedWorkspace repository=$resolvedRepository"
    )
}

function Resolve-PathInsideRepository {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $target = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $RelativePath))
    $repositoryPrefix = $resolvedRepository + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith(
        $repositoryPrefix,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to remove a path outside the repository: $target"
    }
    return $target
}

function Remove-DirectoryInsideRepository {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $target = Resolve-PathInsideRepository -RelativePath $RelativePath
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        return
    }
    Write-Output "Removing CI directory: $RelativePath"
    Remove-Item -LiteralPath $target -Recurse -Force
}

function Remove-FileInsideRepository {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $target = Resolve-PathInsideRepository -RelativePath $RelativePath
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        return
    }
    Write-Output "Removing CI file: $RelativePath"
    Remove-Item -LiteralPath $target -Force
}

$modelFiles = @(
    "models\muscriptor\small\model.safetensors",
    "models\muscriptor\small\config.json",
    "models\muscriptor\medium\model.safetensors",
    "models\muscriptor\medium\config.json",
    "models\muscriptor\large\model.safetensors",
    "models\muscriptor\large\config.json"
)

$directories = if ($Phase -eq "BeforeBuild") {
    @(
        ".venv",
        "app\node_modules",
        "app\backend-build",
        "app\backend-dist",
        "app\dist",
        "app\dist-electron",
        "app\release",
        "app\release-assets",
        "app\release-sources",
        "app\release-staging",
        "tools\ffmpeg-lgpl",
        "tools\libsndfile-lgpl"
    )
} else {
    @(
        ".venv",
        "app\node_modules",
        "app\backend-build",
        "app\backend-dist",
        "app\dist",
        "app\dist-electron",
        "app\release-staging",
        "tools\ffmpeg-lgpl",
        "tools\libsndfile-lgpl\build",
        "tools\libsndfile-lgpl\source"
    )
}

foreach ($relativePath in $directories) {
    Remove-DirectoryInsideRepository -RelativePath $relativePath
}
foreach ($relativePath in $modelFiles) {
    Remove-FileInsideRepository -RelativePath $relativePath
    Remove-FileInsideRepository -RelativePath "$relativePath.partial"
}

$workspaceDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($resolvedRepository))
Write-Output (
    "CI cleanup phase $Phase completed. Workspace drive free space: {0:N2} GiB" -f
    ($workspaceDrive.AvailableFreeSpace / 1GB)
)
