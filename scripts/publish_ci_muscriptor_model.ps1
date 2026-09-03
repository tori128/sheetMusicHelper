param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("small", "medium", "large")]
    [string]$Variant,
    [string]$RequestedTag = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

foreach ($name in @(
    "GITHUB_ACTIONS",
    "GITHUB_REPOSITORY",
    "GH_TOKEN"
)) {
    if ([string]::IsNullOrWhiteSpace(
        [Environment]::GetEnvironmentVariable($name)
    )) {
        throw "Required GitHub Actions environment variable is missing: $name"
    }
}
if ([Environment]::GetEnvironmentVariable("GITHUB_ACTIONS") -ne "true") {
    throw "This publishing script can only run inside GitHub Actions."
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

$modelSizes = @{
    small = 411888600L
    medium = 1228144472L
    large = 5465642136L
}
$modelRoot = Join-Path $repositoryRoot "models\muscriptor"
$variantRoot = Join-Path $modelRoot $Variant
$modelFiles = @("model.safetensors", "config.json")
$modelReady = @(
    $modelFiles | ForEach-Object {
        Test-Path -LiteralPath (Join-Path $variantRoot $_) -PathType Leaf
    }
) -notcontains $false

$workspaceDrive = [IO.DriveInfo]::new(
    [IO.Path]::GetPathRoot($repositoryRoot)
)
$requiredBytes = ($modelSizes[$Variant] * 2L) + 512MB
if ($workspaceDrive.AvailableFreeSpace -lt $requiredBytes) {
    throw (
        "Insufficient free space for the $Variant model archive: " +
        "required=$requiredBytes available=$($workspaceDrive.AvailableFreeSpace)"
    )
}

if (-not $modelReady) {
    if ([string]::IsNullOrWhiteSpace($env:HF_TOKEN)) {
        throw "HF_TOKEN is required to download the missing MuScriptor $Variant model."
    }
    Remove-Item -LiteralPath $variantRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $variantRoot -Force | Out-Null
    foreach ($fileName in $modelFiles) {
        $destination = Join-Path $variantRoot $fileName
        $partial = "$destination.partial"
        $uri = (
            "https://huggingface.co/MuScriptor/muscriptor-$Variant/resolve/" +
            "main/${fileName}?download=true"
        )
        Write-Output "Downloading MuScriptor $Variant/$fileName"
        & curl.exe `
            --fail `
            --location `
            --retry 3 `
            --retry-all-errors `
            --connect-timeout 30 `
            --max-time 7200 `
            --header "Authorization: Bearer $env:HF_TOKEN" `
            --output $partial `
            $uri
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
            throw "MuScriptor download failed: $Variant/$fileName"
        }
        Move-Item -LiteralPath $partial -Destination $destination -Force
    }
}

& (Join-Path $repositoryRoot "app\packaging\verify-muscriptor-models.ps1") `
    -ModelRoot $modelRoot `
    -Variant $Variant

$zipExecutable = $env:EARCOPY_ZIP_EXECUTABLE
if ([string]::IsNullOrWhiteSpace($zipExecutable)) {
    $zipCommand = Get-Command "zip.exe" -ErrorAction SilentlyContinue
    if ($null -ne $zipCommand) {
        $zipExecutable = $zipCommand.Source
    }
}
if (
    [string]::IsNullOrWhiteSpace($zipExecutable) -or
    -not (Test-Path -LiteralPath $zipExecutable -PathType Leaf)
) {
    throw "Info-ZIP zip.exe was not found."
}
$unzipExecutable = $env:EARCOPY_UNZIP_EXECUTABLE
if ([string]::IsNullOrWhiteSpace($unzipExecutable)) {
    $unzipCommand = Get-Command "unzip.exe" -ErrorAction SilentlyContinue
    if ($null -ne $unzipCommand) {
        $unzipExecutable = $unzipCommand.Source
    }
}
if (
    [string]::IsNullOrWhiteSpace($unzipExecutable) -or
    -not (Test-Path -LiteralPath $unzipExecutable -PathType Leaf)
) {
    throw "Info-ZIP unzip.exe was not found."
}

$assetRoot = Join-Path $repositoryRoot "app\release-assets"
$stageParent = Join-Path $repositoryRoot "app\model-release-stage"
$portableName = "EarCopyAssist-$($package.version)-win-x64"
$assetBaseName = "EarCopyAssist-$($package.version)-muscriptor-$Variant"
$stageRoot = Join-Path $stageParent $portableName
$stageVariantRoot = Join-Path `
    $stageRoot `
    "resources\models\muscriptor\$Variant"
$archive = Join-Path $assetRoot "$assetBaseName.zip"
$archivePartPattern = "^$([regex]::Escape($assetBaseName))\.z\d{2,}$"

New-Item -ItemType Directory -Path $assetRoot -Force | Out-Null
Remove-Item -LiteralPath $stageParent -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $assetRoot -File |
    Where-Object {
        $_.Name -eq "$assetBaseName.zip" -or
        $_.Name -match $archivePartPattern
    } |
    Remove-Item -Force

try {
    New-Item -ItemType Directory -Path $stageVariantRoot -Force | Out-Null
    foreach ($fileName in $modelFiles) {
        New-Item `
            -ItemType HardLink `
            -Path (Join-Path $stageVariantRoot $fileName) `
            -Target (Join-Path $variantRoot $fileName) |
            Out-Null
    }

    Push-Location $stageParent
    try {
        & $zipExecutable `
            -q `
            -r `
            -s 1800m `
            $archive `
            $portableName
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to create the $Variant model archive."
        }
    } finally {
        Pop-Location
    }

    $archiveParts = @(
        Get-ChildItem -LiteralPath $assetRoot -File |
            Where-Object { $_.Name -match $archivePartPattern } |
            Sort-Object Name
    )
    $assetFiles = @($archiveParts + @(Get-Item -LiteralPath $archive))
    foreach ($asset in $assetFiles) {
        if ($asset.Length -le 0 -or $asset.Length -ge 2GB) {
            throw "Model release asset size is invalid: $($asset.Name)"
        }
    }
    $verificationArchive = Join-Path $assetRoot (
        "$assetBaseName-verification.zip"
    )
    Remove-Item -LiteralPath $verificationArchive -Force -ErrorAction SilentlyContinue
    try {
        & $zipExecutable -s- $archive -O $verificationArchive
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to reconstruct the $Variant model archive for verification."
        }
        & $unzipExecutable -t $verificationArchive
        if ($LASTEXITCODE -ne 0) {
            throw "Model archive integrity check failed: $($archive | Split-Path -Leaf)"
        }
    } finally {
        Remove-Item -LiteralPath $verificationArchive -Force -ErrorAction SilentlyContinue
    }

    $releaseJson = & gh release view $tag `
        --repo $env:GITHUB_REPOSITORY `
        --json isDraft 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Draft release was not found: $tag"
    }
    if (-not ($releaseJson | ConvertFrom-Json).isDraft) {
        throw "Refusing to modify a published release: $tag"
    }
    & gh release upload $tag @($assetFiles.FullName) `
        --repo $env:GITHUB_REPOSITORY `
        --clobber
    if ($LASTEXITCODE -ne 0) {
        throw "Model release asset upload failed: $Variant"
    }

    $checksumRoot = Join-Path $repositoryRoot "app\model-release-checksums"
    Remove-Item -LiteralPath $checksumRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $checksumRoot -Force | Out-Null
    $checksums = Join-Path $checksumRoot "SHA256SUMS.txt"
    & gh release download $tag `
        --repo $env:GITHUB_REPOSITORY `
        --pattern "SHA256SUMS.txt" `
        --dir $checksumRoot
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $checksums)) {
        throw "Unable to retrieve the draft release checksum file."
    }
    $modelAssetNames = @($assetFiles | ForEach-Object { $_.Name })
    $modelAssetNamePattern = (
        $modelAssetNames | ForEach-Object { [regex]::Escape($_) }
    ) -join "|"
    $checksumLines = @(
        Get-Content -LiteralPath $checksums -Encoding ascii |
            Where-Object {
                $_ -notmatch "^[0-9a-f]{64}  ($modelAssetNamePattern)$"
            }
    )
    foreach ($asset in $assetFiles) {
        $hash = (
            (Get-FileHash -LiteralPath $asset.FullName -Algorithm SHA256).Hash
        ).ToLowerInvariant()
        $checksumLines += "$hash  $($asset.Name)"
    }
    Set-Content -LiteralPath $checksums -Value $checksumLines -Encoding ascii
    & gh release upload $tag $checksums --repo $env:GITHUB_REPOSITORY --clobber
    if ($LASTEXITCODE -ne 0) {
        throw "Draft release checksum update failed: $Variant"
    }
} finally {
    Remove-Item -LiteralPath $stageParent -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $repositoryRoot "app\model-release-checksums") `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $assetRoot -File -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "$assetBaseName.zip" -or
            $_.Name -match $archivePartPattern
        } |
        Remove-Item -Force
}

Write-Output "MuScriptor $Variant release assets were added to draft $tag."
