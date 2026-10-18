$ErrorActionPreference = "Stop"

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repositoryRoot = (Resolve-Path (Join-Path $appRoot "..")).Path
$releaseRoot = Join-Path $appRoot "release"
$sourceRoot = Join-Path $releaseRoot "win-unpacked"
$backupRoot = Join-Path $releaseRoot ".local-install-backup"
$runtimeNames = @(
    "EarCopyAssist.exe", "locales", "resources",
    "chrome_100_percent.pak", "chrome_200_percent.pak",
    "d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll", "ffmpeg.dll",
    "icudtl.dat", "libEGL.dll", "libGLESv2.dll",
    "LICENSE.electron.txt", "LICENSES.chromium.html", "resources.pak",
    "snapshot_blob.bin", "v8_context_snapshot.bin", "vk_swiftshader_icd.json",
    "vk_swiftshader.dll", "vulkan-1.dll"
)

function Assert-PathInside {
    param([string]$Path, [string]$Parent)
    $absolutePath = [IO.Path]::GetFullPath($Path)
    $absoluteParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') +
        [IO.Path]::DirectorySeparatorChar
    if (-not $absolutePath.StartsWith($absoluteParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the expected directory: $absolutePath"
    }
}

& (Join-Path $PSScriptRoot "assert-app-not-running.ps1")
Assert-PathInside $sourceRoot $releaseRoot
Assert-PathInside $backupRoot $releaseRoot
if (Test-Path -LiteralPath $backupRoot) {
    throw "An unfinished local installation exists: $backupRoot"
}
if ((Get-Item -LiteralPath $sourceRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "The packaged application must be a regular directory: $sourceRoot"
}
foreach ($name in @("EarCopyAssist.exe", "resources", "locales")) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $name))) {
        throw "Required packaged application entry was not found: $name"
    }
}
$entries = @(Get-ChildItem -LiteralPath $sourceRoot -Force)
foreach ($entry in $entries) {
    if ($entry.Name -notin $runtimeNames) {
        throw "Unexpected packaged application entry: $($entry.Name)"
    }
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "The packaged application contains a directory link: $($entry.FullName)"
    }
}
foreach ($name in $runtimeNames) {
    $destination = Join-Path $repositoryRoot $name
    Assert-PathInside $destination $repositoryRoot
    if ((Test-Path -LiteralPath $destination) -and (
        (Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint
    )) {
        throw "The installation destination contains a directory link: $destination"
    }
}

New-Item -ItemType Directory -Path $backupRoot | Out-Null
$replacedNames = @()
$installedNames = @()
try {
    foreach ($name in $runtimeNames) {
        $destination = Join-Path $repositoryRoot $name
        if (Test-Path -LiteralPath $destination) {
            Assert-PathInside $destination $repositoryRoot
            Move-Item -LiteralPath $destination -Destination (Join-Path $backupRoot $name)
            $replacedNames += $name
        }
    }
    foreach ($entry in $entries) {
        Assert-PathInside $entry.FullName $sourceRoot
        Move-Item -LiteralPath $entry.FullName -Destination (Join-Path $repositoryRoot $entry.Name)
        $installedNames += $entry.Name
    }
} catch {
    foreach ($name in $installedNames) {
        $installedPath = Join-Path $repositoryRoot $name
        Assert-PathInside $installedPath $repositoryRoot
        Move-Item -LiteralPath $installedPath -Destination (Join-Path $sourceRoot $name)
    }
    foreach ($name in $replacedNames) {
        $backupPath = Join-Path $backupRoot $name
        Assert-PathInside $backupPath $backupRoot
        Move-Item -LiteralPath $backupPath -Destination (Join-Path $repositoryRoot $name)
    }
    Remove-Item -LiteralPath $backupRoot
    throw
}
Assert-PathInside $backupRoot $releaseRoot
Remove-Item -LiteralPath $backupRoot -Recurse -Force
Assert-PathInside $sourceRoot $releaseRoot
Remove-Item -LiteralPath $sourceRoot
Write-Output "Installed local application: $(Join-Path $repositoryRoot 'EarCopyAssist.exe')"
