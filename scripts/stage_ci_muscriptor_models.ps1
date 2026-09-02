param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourceRoot,
    [ValidateRange(1, 1024)]
    [int]$MinimumFreeGiB = 55
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspace = [Environment]::GetEnvironmentVariable("GITHUB_WORKSPACE")
if (
    [Environment]::GetEnvironmentVariable("GITHUB_ACTIONS") -ne "true" -or
    [string]::IsNullOrWhiteSpace($workspace)
) {
    throw "This staging script can only run inside GitHub Actions."
}

$resolvedRepository = [IO.Path]::GetFullPath($repositoryRoot).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
)
$resolvedWorkspace = [IO.Path]::GetFullPath($workspace).TrimEnd(
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
if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    throw "MuScriptor model source directory was not found: $SourceRoot"
}

$resolvedSource = (Resolve-Path -LiteralPath $SourceRoot).Path.TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
)
$repositoryPrefix = $resolvedRepository + [IO.Path]::DirectorySeparatorChar
if (
    $resolvedSource.Equals(
        $resolvedRepository,
        [StringComparison]::OrdinalIgnoreCase
    ) -or
    $resolvedSource.StartsWith(
        $repositoryPrefix,
        [StringComparison]::OrdinalIgnoreCase
    )
) {
    throw "MuScriptor model source must be outside GITHUB_WORKSPACE: $resolvedSource"
}

$relativeFiles = @(
    "small\model.safetensors",
    "small\config.json",
    "medium\model.safetensors",
    "medium\config.json",
    "large\model.safetensors",
    "large\config.json"
)
$modelVerifier = Join-Path $repositoryRoot "app\packaging\verify-muscriptor-models.ps1"
& $modelVerifier -ModelRoot $resolvedSource

$sourceBytes = 0L
foreach ($relativePath in $relativeFiles) {
    $sourcePath = Join-Path $resolvedSource $relativePath
    $sourceBytes += (Get-Item -LiteralPath $sourcePath).Length
}
$workspaceDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($resolvedRepository))
$minimumRemainingBytes = [long]$MinimumFreeGiB * 1GB
$requiredBytes = $sourceBytes + $minimumRemainingBytes
if ($workspaceDrive.AvailableFreeSpace -lt $requiredBytes) {
    throw ((
        "The workspace drive requires at least {0:N2} GiB free before model " +
        "staging and has {1:N2} GiB free."
    ) -f ($requiredBytes / 1GB), ($workspaceDrive.AvailableFreeSpace / 1GB))
}

$destinationRoot = Join-Path $repositoryRoot "models\muscriptor"
try {
    foreach ($relativePath in $relativeFiles) {
        $sourcePath = Join-Path $resolvedSource $relativePath
        $destinationPath = Join-Path $destinationRoot $relativePath
        $destinationDirectory = Split-Path -Parent $destinationPath
        $partialPath = "$destinationPath.partial"
        New-Item -ItemType Directory -Path $destinationDirectory -Force |
            Out-Null
        Remove-Item -LiteralPath $destinationPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $partialPath -Force -ErrorAction SilentlyContinue
        Copy-Item -LiteralPath $sourcePath -Destination $partialPath
        Move-Item -LiteralPath $partialPath -Destination $destinationPath
    }
    & $modelVerifier -ModelRoot $destinationRoot
} catch {
    foreach ($relativePath in $relativeFiles) {
        $destinationPath = Join-Path $destinationRoot $relativePath
        Remove-Item -LiteralPath $destinationPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath "$destinationPath.partial" -Force -ErrorAction SilentlyContinue
    }
    throw
}

$workspaceDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($resolvedRepository))
Write-Output (
    "MuScriptor models staged. Workspace drive free space: {0:N2} GiB" -f
    ($workspaceDrive.AvailableFreeSpace / 1GB)
)
