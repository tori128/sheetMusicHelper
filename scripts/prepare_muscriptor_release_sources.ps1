param(
    [string]$OutputDirectory,
    [string]$SevenZipExecutable = "C:\Program Files\7-Zip\7z.exe"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repositoryRoot "app\model-source-assets"
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $SevenZipExecutable -PathType Leaf)) {
    throw "7-Zip was not found: $SevenZipExecutable"
}

$package = Get-Content `
    -LiteralPath (Join-Path $repositoryRoot "app\package.json") `
    -Raw `
    -Encoding utf8 |
    ConvertFrom-Json
$modelRoot = Join-Path $repositoryRoot "models\muscriptor"
& (Join-Path $repositoryRoot "app\packaging\verify-muscriptor-models.ps1") `
    -ModelRoot $modelRoot

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$stageRoot = Join-Path $outputRoot "stage"
Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue

try {
    foreach ($variant in @("small", "medium", "large")) {
        $assetBaseName = "EarCopyAssist-$($package.version)-muscriptor-source-$variant.7z"
        $archive = Join-Path $outputRoot $assetBaseName
        Get-ChildItem -LiteralPath $outputRoot -File |
            Where-Object {
                $_.Name -eq $assetBaseName -or
                $_.Name -match "^$([regex]::Escape($assetBaseName))\.\d{3}$"
            } |
            Remove-Item -Force

        $stageVariantRoot = Join-Path $stageRoot $variant
        New-Item -ItemType Directory -Path $stageVariantRoot -Force | Out-Null
        foreach ($fileName in @("model.safetensors", "config.json")) {
            New-Item `
                -ItemType HardLink `
                -Path (Join-Path $stageVariantRoot $fileName) `
                -Target (Join-Path $modelRoot "$variant\$fileName") |
                Out-Null
        }

        Push-Location $stageVariantRoot
        try {
            $archiveArguments = @("a", "-t7z", "-mx=0")
            if ($variant -eq "large") {
                $archiveArguments += "-v1800m"
            }
            $archiveArguments += @($archive, "model.safetensors", "config.json")
            & $SevenZipExecutable @archiveArguments
            if ($LASTEXITCODE -ne 0) {
                throw "Unable to create the $variant model source archive."
            }
        } finally {
            Pop-Location
        }

        $testArchive = if ($variant -eq "large") {
            "$archive.001"
        } else {
            $archive
        }
        & $SevenZipExecutable t $testArchive
        if ($LASTEXITCODE -ne 0) {
            throw "Model source archive integrity check failed: $($testArchive | Split-Path -Leaf)"
        }
    }
} finally {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "MuScriptor source archives are ready: $outputRoot"
