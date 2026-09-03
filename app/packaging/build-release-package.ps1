param(
    [switch]$KeepStaging,
    [string]$ApplicationRoot
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repositoryRoot = (Resolve-Path (Join-Path $appRoot "..")).Path
$packageJsonPath = Join-Path $appRoot "package.json"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding utf8 |
    ConvertFrom-Json
$version = [string]$packageJson.version
if ($version -notmatch "^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$") {
    throw "Invalid package version: $version"
}
$sourceCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch "^[0-9a-f]{40}$") {
    throw "Unable to identify the source commit."
}
$trackedChanges = @(& git -C $repositoryRoot status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect the Git worktree."
}
if ($trackedChanges.Count -ne 0) {
    throw (
        "Release packages must be built from a clean Git worktree. " +
        "Commit or restore tracked changes first."
    )
}
$buildUtc = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")

$packagedRoot = if ([string]::IsNullOrWhiteSpace($ApplicationRoot)) {
    Join-Path $appRoot "release\win-unpacked"
} else {
    [IO.Path]::GetFullPath($ApplicationRoot)
}
$releaseAssetsRoot = Join-Path $appRoot "release-assets"
$stagingRoot = Join-Path $releaseAssetsRoot ".staging"
$templateRoot = Join-Path $PSScriptRoot "release"
$sourceOfferRoot = Join-Path $appRoot "release-sources"
$portableName = "EarCopyAssist-$version-win-x64"
$sourceName = "EarCopyAssist-$version-copyleft-sources"
$portableStage = Join-Path $stagingRoot $portableName
$sourceStage = Join-Path $stagingRoot $sourceName
$completeWindowsArchive = Join-Path $stagingRoot "$portableName-complete.zip"
$windowsArchive = Join-Path $releaseAssetsRoot "$portableName.zip"
$sourceArchive = Join-Path $releaseAssetsRoot "$sourceName.zip"
$releaseNotes = Join-Path $releaseAssetsRoot "RELEASE_NOTES.md"
$checksums = Join-Path $releaseAssetsRoot "SHA256SUMS.txt"
$githubAssetLimit = 2GB
$splitPartSize = "1800m"

function Remove-DirectoryInside {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    ) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedPath.StartsWith(
        $resolvedParent,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to remove a directory outside $resolvedParent`: $resolvedPath"
    }
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

function Set-TemplateContent {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $content = Get-Content -LiteralPath $Source -Raw -Encoding utf8
    $content = $content.Replace('${VERSION}', $version)
    $content = $content.Replace('${SOURCE_COMMIT}', $sourceCommit)
    $content = $content.Replace('${BUILD_UTC}', $buildUtc)
    Set-Content -LiteralPath $Destination -Value $content -Encoding utf8
}

function New-ZipArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Force
    }
    $parent = Split-Path -Parent $Directory
    $leaf = Split-Path -Leaf $Directory
    Push-Location $parent
    try {
        & tar.exe -a -c -f $Destination $leaf
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create ZIP archive: $Destination"
        }
    } finally {
        Pop-Location
    }
}

function Assert-GitHubAssetSize {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path
    if ($item.Length -ge $githubAssetLimit) {
        throw (
            "GitHub Release asset must be smaller than 2 GiB: " +
            "$($item.Name) ($($item.Length) bytes)"
        )
    }
}

function Get-InfoZipExecutable {
    $candidates = [Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($env:EARCOPY_ZIP_EXECUTABLE)) {
        $candidates.Add($env:EARCOPY_ZIP_EXECUTABLE)
    }
    $candidates.Add("C:\msys64\usr\bin\zip.exe")
    $pathCommand = Get-Command "zip.exe" -ErrorAction SilentlyContinue
    if ($null -ne $pathCommand) {
        $candidates.Add($pathCommand.Source)
    }

    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        $versionOutput = (& $candidate -v 2>&1) -join "`n"
        if ($LASTEXITCODE -eq 0 -and $versionOutput -match "Info-ZIP") {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw (
        "Info-ZIP zip.exe was not found. Install the MSYS2 'zip' package, " +
        "or set EARCOPY_ZIP_EXECUTABLE to Info-ZIP zip.exe."
    )
}

function New-SplitZipArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ZipExecutable,
        [Parameter(Mandatory = $true)][string]$PartSize
    )

    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        Remove-Item -LiteralPath $Destination -Force
    }
    & $ZipExecutable -q -s $PartSize $Source --out $Destination
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create standard split ZIP archive: $Destination"
    }

    if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
        throw "Final ZIP volume was not created: $Destination"
    }
}

function Get-VerifiedSourceArchive {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Sha256
    )

    $destination = Join-Path $sourceOfferRoot $FileName
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        Write-Host "Downloading corresponding source: $FileName"
        Invoke-WebRequest -Uri $Uri -OutFile $destination
    }

    $actual = (
        Get-FileHash -LiteralPath $destination -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) {
        throw (
            "Corresponding source SHA-256 mismatch for $FileName`: " +
            "expected=$Sha256 actual=$actual"
        )
    }
    return $destination
}

if (-not (Test-Path -LiteralPath (Join-Path $packagedRoot "EarCopyAssist.exe"))) {
    throw "Packaged application was not found. Run npm run dist:win first."
}

New-Item -ItemType Directory -Force -Path $releaseAssetsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $sourceOfferRoot | Out-Null
foreach ($staleName in @(
    "$portableName.zip",
    "$portableName-core.zip",
    "$portableName-runtime-1.zip",
    "$portableName-runtime-2.zip",
    "$portableName-EXTRACT.cmd",
    "EarCopyAssist-$version-ffmpeg-source.zip"
)) {
    $stalePath = Join-Path $releaseAssetsRoot $staleName
    if (Test-Path -LiteralPath $stalePath -PathType Leaf) {
        Remove-Item -LiteralPath $stalePath -Force
    }
}
Get-ChildItem -LiteralPath $releaseAssetsRoot -File |
    Where-Object {
        $_.Name -match "^$([regex]::Escape($portableName))\.zip\.\d{3}$" -or
        $_.Name -match "^$([regex]::Escape($portableName))\.z\d{2,}$"
    } |
    Remove-Item -Force
Remove-DirectoryInside -Path $stagingRoot -Parent $releaseAssetsRoot
New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null

Copy-Item -LiteralPath $packagedRoot -Destination $portableStage -Recurse
Remove-DirectoryInside `
    -Path (Join-Path $portableStage "UserData") `
    -Parent $portableStage

Copy-Item `
    -LiteralPath (Join-Path $repositoryRoot "README.md") `
    -Destination (Join-Path $portableStage "README.md")
Set-TemplateContent `
    -Source (Join-Path $templateRoot "BUILD_INFO.txt") `
    -Destination (Join-Path $portableStage "BUILD_INFO.txt")
Copy-Item `
    -LiteralPath (Join-Path $repositoryRoot "LICENSE") `
    -Destination (Join-Path $portableStage "LICENSE.txt")
Copy-Item `
    -LiteralPath (Join-Path $repositoryRoot "THIRD_PARTY_NOTICES.md") `
    -Destination (Join-Path $portableStage "THIRD_PARTY_NOTICES.md")
Copy-Item `
    -LiteralPath (Join-Path $repositoryRoot "THIRD_PARTY_NOTICES.en.md") `
    -Destination (Join-Path $portableStage "THIRD_PARTY_NOTICES.en.md")
New-Item -ItemType Directory -Force -Path (Join-Path $portableStage "docs") |
    Out-Null
Copy-Item `
    -LiteralPath (Join-Path $repositoryRoot "docs\USER_GUIDE.md") `
    -Destination (Join-Path $portableStage "docs\USER_GUIDE.md")
Copy-Item `
    -LiteralPath (Join-Path $repositoryRoot "docs\USER_GUIDE.en.md") `
    -Destination (Join-Path $portableStage "docs\USER_GUIDE.en.md")
Copy-Item `
    -LiteralPath (Join-Path $templateRoot "models") `
    -Destination (Join-Path $portableStage "models") `
    -Recurse

$forbiddenWeightExtensions = @(
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pth",
    ".onnx",
    ".th",
    ".gguf"
)
$unexpectedWeights = @(
    Get-ChildItem -LiteralPath $portableStage -Recurse -File |
        Where-Object {
            $_.Extension.ToLowerInvariant() -in $forbiddenWeightExtensions
        }
)
if ($unexpectedWeights.Count -ne 0) {
    $paths = $unexpectedWeights.FullName -join [Environment]::NewLine
    throw "Unexpected model weights found in the release package:`n$paths"
}
if (Test-Path -LiteralPath (Join-Path $portableStage "UserData")) {
    throw "UserData must not be included in the release package."
}

$requiredPortableFiles = @(
    "EarCopyAssist.exe",
    "README.md",
    "BUILD_INFO.txt",
    "LICENSE.txt",
    "THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_NOTICES.en.md",
    "docs\USER_GUIDE.md",
    "docs\USER_GUIDE.en.md",
    "resources\licenses\EarCopy_Assist_LICENSE.txt",
    "resources\licenses\THIRD_PARTY_NOTICES.md",
    "resources\licenses\THIRD_PARTY_NOTICES.en.md",
    "resources\licenses\MuseScore_General\LICENSE.md",
    "resources\licenses\MuScriptor\MODEL_NOTICE.txt",
    "resources\backend\earcopy_service.exe",
    "resources\backend\_internal\tools\ffmpeg.exe",
    "resources\backend\_internal\tools\ffprobe.exe",
    "resources\backend\_internal\licenses\ffmpeg\LICENSE",
    "resources\backend\_internal\licenses\ffmpeg\README.txt",
    "resources\backend\_internal\licenses\python\soundfile-0.14.0\COPYING",
    "resources\backend\_internal\licenses\python\soxr-1.1.0\licenses\COPYING.LGPL",
    "resources\backend\_internal\licenses\libsndfile\COPYING",
    "resources\backend\_internal\licenses\libsndfile\README.txt",
    "resources\backend\_internal\_soundfile_data\libsndfile_x64.dll",
    "resources\backend\_internal\soxr\soxr_ext.cp311-win_amd64.pyd",
    "resources\soundfonts\MuseScore_General.sf3"
)
foreach ($relativePath in $requiredPortableFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $portableStage $relativePath) -PathType Leaf)) {
        throw "Required release file is missing: $relativePath"
    }
}

$ffmpeg = Join-Path $portableStage "resources\backend\_internal\tools\ffmpeg.exe"
$ffmpegVersion = (& $ffmpeg -version 2>&1) -join "`n"
if (
    $ffmpegVersion -notmatch "ffmpeg version 8\.1\.2" -or
    $ffmpegVersion -notmatch "--disable-gpl" -or
    $ffmpegVersion -match "--enable-gpl" -or
    $ffmpegVersion -match "--enable-nonfree"
) {
    throw "The packaged FFmpeg is not the expected LGPL-only 8.1.2 build."
}

$packagedLibsndfile = Join-Path `
    $portableStage `
    "resources\backend\_internal\_soundfile_data\libsndfile_x64.dll"
$builtLibsndfile = Join-Path `
    $repositoryRoot `
    "tools\libsndfile-lgpl\bin\libsndfile_x64.dll"
if (-not (Test-Path -LiteralPath $builtLibsndfile -PathType Leaf)) {
    throw "Project-built libsndfile DLL is missing. Run npm run build:libsndfile."
}
$packagedLibsndfileHash = (
    Get-FileHash -LiteralPath $packagedLibsndfile -Algorithm SHA256
).Hash
$builtLibsndfileHash = (
    Get-FileHash -LiteralPath $builtLibsndfile -Algorithm SHA256
).Hash
if ($packagedLibsndfileHash -ne $builtLibsndfileHash) {
    throw "The packaged libsndfile is not the project-built minimal DLL."
}

$soundfont = Join-Path $portableStage "resources\soundfonts\MuseScore_General.sf3"
$soundfontExpected = "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3"
$soundfontActual = (
    Get-FileHash -LiteralPath $soundfont -Algorithm SHA256
).Hash.ToLowerInvariant()
if ($soundfontActual -ne $soundfontExpected) {
    throw "MuseScore General SHA-256 mismatch: $soundfontActual"
}

$sourceArchives = @(
    @{
        FileName = "ffmpeg-8.1.2.tar.xz"
        Uri = "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz"
        Sha256 = "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
    },
    @{
        FileName = "libsndfile-1.2.2.tar.xz"
        Uri = "https://github.com/libsndfile/libsndfile/releases/download/1.2.2/libsndfile-1.2.2.tar.xz"
        Sha256 = "3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e"
    },
    @{
        FileName = "soxr-1.1.0.tar.gz"
        Uri = "https://files.pythonhosted.org/packages/ed/11/27cebce4a108f77afea7c80545115536b45e3f11ebfb914f638fdd9ba847/soxr-1.1.0.tar.gz"
        Sha256 = "9f228ae21c78fa9359ca98d8a5e8e91f30639e438e574133dace62c5b5309e44"
    }
)

New-Item -ItemType Directory -Force -Path $sourceStage | Out-Null
foreach ($archive in $sourceArchives) {
    $source = Get-VerifiedSourceArchive `
        -FileName $archive.FileName `
        -Uri $archive.Uri `
        -Sha256 $archive.Sha256
    Copy-Item -LiteralPath $source -Destination $sourceStage
}
Copy-Item `
    -LiteralPath (Join-Path $repositoryRoot "scripts\build_ffmpeg_lgpl.ps1") `
    -Destination $sourceStage
Copy-Item `
    -LiteralPath (Join-Path $repositoryRoot "scripts\build_libsndfile_lgpl.ps1") `
    -Destination $sourceStage
Set-TemplateContent `
    -Source (Join-Path $templateRoot "COPYLEFT_SOURCES_README.txt") `
    -Destination (Join-Path $sourceStage "README.txt")

Set-TemplateContent `
    -Source (Join-Path $templateRoot "RELEASE_NOTES.md") `
    -Destination $releaseNotes

Write-Output "Creating complete Windows ZIP..."
New-ZipArchive -Directory $portableStage -Destination $completeWindowsArchive

if (-not $KeepStaging) {
    Remove-DirectoryInside -Path $portableStage -Parent $stagingRoot
}

Write-Output "Creating standard split Windows ZIP volumes..."
$infoZip = Get-InfoZipExecutable
New-SplitZipArchive `
    -Source $completeWindowsArchive `
    -Destination $windowsArchive `
    -ZipExecutable $infoZip `
    -PartSize $splitPartSize
Remove-Item -LiteralPath $completeWindowsArchive -Force

$windowsVolumes = @(
    Get-ChildItem -LiteralPath $releaseAssetsRoot -File |
        Where-Object {
            $_.Name -eq "$portableName.zip" -or
            $_.Name -match "^$([regex]::Escape($portableName))\.z\d{2,}$"
        } |
        Sort-Object @{ Expression = { $_.Name -eq "$portableName.zip" } }, Name
)
if ($windowsVolumes.Count -lt 1) {
    throw "Windows ZIP archive was not created."
}
foreach ($volume in $windowsVolumes) {
    Assert-GitHubAssetSize -Path $volume.FullName
}

Write-Output "Creating corresponding source ZIP..."
New-ZipArchive -Directory $sourceStage -Destination $sourceArchive
Assert-GitHubAssetSize -Path $sourceArchive

$checksumAssets = @($windowsVolumes.FullName + @($sourceArchive))
$checksumLines = foreach ($asset in $checksumAssets) {
    $item = Get-Item -LiteralPath $asset
    $hash = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $($item.Name)"
}
Set-Content -LiteralPath $checksums -Value $checksumLines -Encoding ascii

if (-not $KeepStaging) {
    Remove-DirectoryInside -Path $stagingRoot -Parent $releaseAssetsRoot
}

Write-Output ""
Write-Output "GitHub Release assets:"
foreach ($path in @($checksumAssets + @($releaseNotes, $checksums))) {
    $item = Get-Item -LiteralPath $path
    Write-Output ("  {0} ({1:N0} bytes)" -f $item.FullName, $item.Length)
}
