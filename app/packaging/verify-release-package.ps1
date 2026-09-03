$ErrorActionPreference = "Stop"

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repositoryRoot = (Resolve-Path (Join-Path $appRoot "..")).Path
$releaseAssetsRoot = Join-Path $appRoot "release-assets"
$package = Get-Content `
    -LiteralPath (Join-Path $appRoot "package.json") `
    -Raw `
    -Encoding utf8 |
    ConvertFrom-Json
$version = [string]$package.version
$sourceCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch "^[0-9a-f]{40}$") {
    throw "Unable to identify the source commit."
}

$portableName = "EarCopyAssist-$version-win-x64"
$sourceName = "EarCopyAssist-$version-copyleft-sources"
$windowsArchiveName = "$portableName.zip"
$sourceArchiveName = "$sourceName.zip"
$checksumsPath = Join-Path $releaseAssetsRoot "SHA256SUMS.txt"
$releaseNotesPath = Join-Path $releaseAssetsRoot "RELEASE_NOTES.md"
$githubAssetLimit = 2GB
$partNamePattern = "^$([regex]::Escape($portableName))\.z(\d{2,})$"

function Get-ArchiveEntries {
    param(
        [Parameter(Mandatory = $true)][string]$Archive,
        [Parameter(Mandatory = $true)][string]$ExpectedRoot
    )

    $entries = @(& tar.exe -tf $Archive)
    if ($LASTEXITCODE -ne 0 -or $entries.Count -eq 0) {
        throw "Unable to read release archive: $Archive"
    }
    foreach ($entry in $entries) {
        $normalized = $entry.Replace("\", "/")
        if (
            $normalized -match "^/" -or
            $normalized -match "^[A-Za-z]:" -or
            $normalized -match "(^|/)\.\.(/|$)"
        ) {
            throw "Unsafe archive entry in $Archive`: $entry"
        }
        if (
            $normalized -ne $ExpectedRoot -and
            -not $normalized.StartsWith(
                "$ExpectedRoot/",
                [StringComparison]::Ordinal
            )
        ) {
            throw "Unexpected archive root in $Archive`: $entry"
        }
    }
    return @($entries | ForEach-Object { $_.Replace("\", "/") })
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

if (-not (Test-Path -LiteralPath $checksumsPath -PathType Leaf)) {
    throw "Release checksum file is missing: $checksumsPath"
}
if (-not (Test-Path -LiteralPath $releaseNotesPath -PathType Leaf)) {
    throw "Release notes are missing: $releaseNotesPath"
}

$windowsParts = @(
    Get-ChildItem -LiteralPath $releaseAssetsRoot -File |
        Where-Object { $_.Name -match $partNamePattern } |
        Sort-Object {
            [int]([regex]::Match($_.Name, $partNamePattern).Groups[1].Value)
        }
)
for ($index = 0; $index -lt $windowsParts.Count; $index++) {
    $expectedName = "$portableName.z{0:D2}" -f ($index + 1)
    if ($windowsParts[$index].Name -ne $expectedName) {
        throw (
            "Windows ZIP volume numbering is incomplete. " +
            "Expected=$expectedName Actual=$($windowsParts[$index].Name)"
        )
    }
}

$checksumAssetNames = @(
    $windowsParts | ForEach-Object { $_.Name }
    $windowsArchiveName
    $sourceArchiveName
)
$recordedHashes = @{}
foreach ($line in Get-Content -LiteralPath $checksumsPath -Encoding ascii) {
    if ($line -notmatch "^([0-9a-f]{64})  ([^\\/]+)$") {
        throw "Invalid SHA256SUMS entry: $line"
    }
    $name = $Matches[2]
    if ($recordedHashes.ContainsKey($name)) {
        throw "Duplicate SHA256SUMS entry: $name"
    }
    $recordedHashes[$name] = $Matches[1]
}

$unexpectedChecksumEntries = @(
    $recordedHashes.Keys |
        Where-Object { $_ -notin $checksumAssetNames }
)
$missingChecksumEntries = @(
    $checksumAssetNames |
        Where-Object { -not $recordedHashes.ContainsKey($_) }
)
if (
    $unexpectedChecksumEntries.Count -ne 0 -or
    $missingChecksumEntries.Count -ne 0
) {
    throw (
        "SHA256SUMS entries do not match the split release assets. " +
        "Missing=$($missingChecksumEntries -join ',') " +
        "Unexpected=$($unexpectedChecksumEntries -join ',')"
    )
}

foreach ($assetName in $checksumAssetNames) {
    $asset = Join-Path $releaseAssetsRoot $assetName
    if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) {
        throw "Release asset is missing: $asset"
    }
    $item = Get-Item -LiteralPath $asset
    if ($item.Length -le 0 -or $item.Length -ge $githubAssetLimit) {
        throw "Release asset size is invalid: $assetName ($($item.Length))"
    }
    $actualHash = (
        Get-FileHash -LiteralPath $asset -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actualHash -ne $recordedHashes[$assetName]) {
        throw (
            "Release asset SHA-256 mismatch: $assetName " +
            "expected=$($recordedHashes[$assetName]) actual=$actualHash"
        )
    }
}

foreach ($obsoleteName in @(
    "$portableName-core.zip",
    "$portableName-runtime-1.zip",
    "$portableName-runtime-2.zip",
    "$portableName-EXTRACT.cmd"
)) {
    if (Test-Path -LiteralPath (Join-Path $releaseAssetsRoot $obsoleteName)) {
        throw "Obsolete Windows release asset remains: $obsoleteName"
    }
}
if (
    Get-ChildItem -LiteralPath $releaseAssetsRoot -File |
        Where-Object {
            $_.Name -match (
                "^$([regex]::Escape($portableName))\.zip\.\d{3}$"
            )
        }
) {
    throw "Obsolete raw-split Windows release assets remain."
}

$temporaryWindowsArchive = Join-Path (
    $releaseAssetsRoot
) ".verify-$([guid]::NewGuid().ToString('N')).zip"
try {
    $infoZip = Get-InfoZipExecutable
    $windowsArchive = Join-Path $releaseAssetsRoot $windowsArchiveName
    & $infoZip -q -s 0 $windowsArchive --out $temporaryWindowsArchive
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to reconstruct the standard split Windows ZIP."
    }

    $windowsEntries = @(
        Get-ArchiveEntries `
            -Archive $temporaryWindowsArchive `
            -ExpectedRoot $portableName
    )
    $sourceArchive = Join-Path $releaseAssetsRoot $sourceArchiveName
    $sourceEntries = @(
        Get-ArchiveEntries -Archive $sourceArchive -ExpectedRoot $sourceName
    )

    $requiredWindowsEntries = @(
        "$portableName/EarCopyAssist.exe",
        "$portableName/README.md",
        "$portableName/BUILD_INFO.txt",
        "$portableName/LICENSE.txt",
        "$portableName/THIRD_PARTY_NOTICES.md",
        "$portableName/THIRD_PARTY_NOTICES.en.md",
        "$portableName/docs/USER_GUIDE.md",
        "$portableName/docs/USER_GUIDE.en.md",
        "$portableName/resources/backend/earcopy_service.exe",
        "$portableName/resources/backend/_internal/tools/ffmpeg.exe",
        "$portableName/resources/backend/_internal/tools/ffprobe.exe",
        "$portableName/resources/backend/_internal/torch/lib/torch_cuda.dll",
        "$portableName/resources/backend/_internal/torch/lib/cublasLt64_12.dll",
        "$portableName/resources/soundfonts/MuseScore_General.sf3",
        "$portableName/resources/licenses/MuScriptor/MODEL_NOTICE.txt"
    )
    foreach ($entry in $requiredWindowsEntries) {
        if ($entry -notin $windowsEntries) {
            throw "Required Windows archive entry is missing: $entry"
        }
    }

    $forbiddenWindowsEntries = @(
        $windowsEntries |
            Where-Object {
                $_ -match "(^|/)UserData(/|$)" -or
                $_ -match "\.(ecaproj|wav|mp3|m4a|flac|ogg|aac|log|dmp)$" -or
                $_ -match "\.(safetensors|ckpt|pt|pth|onnx|th|gguf)$"
            }
    )
    if ($forbiddenWindowsEntries.Count -ne 0) {
        throw (
            "Private data, user files, or unexpected model weights found in Windows archive: " +
            ($forbiddenWindowsEntries -join ", ")
        )
    }
    $requiredSourceEntries = @(
        "$sourceName/README.txt",
        "$sourceName/ffmpeg-8.1.2.tar.xz",
        "$sourceName/libsndfile-1.2.2.tar.xz",
        "$sourceName/soxr-1.1.0.tar.gz",
        "$sourceName/build_ffmpeg_lgpl.ps1",
        "$sourceName/build_libsndfile_lgpl.ps1"
    )
    foreach ($entry in $requiredSourceEntries) {
        if ($entry -notin $sourceEntries) {
            throw "Required corresponding-source entry is missing: $entry"
        }
    }
    if ($sourceEntries | Where-Object { $_ -match "\.(exe|dll|pyd)$" }) {
        throw "Binary payload found in corresponding-source archive."
    }

    $buildInfo = (
        & tar.exe -xOf $temporaryWindowsArchive "$portableName/BUILD_INFO.txt"
    ) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $buildInfo -notmatch "Source commit: $sourceCommit") {
        throw "BUILD_INFO.txt does not identify the current source commit."
    }

    $libsndfileBuildInfo = (
        & tar.exe -xOf $temporaryWindowsArchive (
            "$portableName/resources/backend/_internal/licenses/" +
            "libsndfile/README.txt"
        )
    ) -join "`n"
    if ($LASTEXITCODE -ne 0 -or -not $libsndfileBuildInfo) {
        throw "Unable to read the packaged libsndfile build information."
    }
    if ($libsndfileBuildInfo -match "(?im)(^|[\s=])[A-Za-z]:[\\/]") {
        throw "Local absolute path found in packaged libsndfile build information."
    }

    $releaseNotes = Get-Content -LiteralPath $releaseNotesPath -Raw -Encoding utf8
    foreach ($requiredText in @(
        "EarCopy Assist $version",
        $sourceCommit,
        "$portableName.zxx",
        $windowsArchiveName,
        "7-Zip",
        "README.md",
        "docs/USER_GUIDE.md"
    )) {
        if (-not $releaseNotes.Contains($requiredText)) {
            throw "Release notes are missing required text: $requiredText"
        }
    }

    $publicDocuments = [ordered]@{
        "RELEASE_NOTES.md" = $releaseNotes
        "README.md" = (
            & tar.exe -xOf $temporaryWindowsArchive "$portableName/README.md"
        ) -join "`n"
        "BUILD_INFO.txt" = $buildInfo
        "THIRD_PARTY_NOTICES.md" = (
            & tar.exe -xOf $temporaryWindowsArchive (
                "$portableName/THIRD_PARTY_NOTICES.md"
            )
        ) -join "`n"
        "THIRD_PARTY_NOTICES.en.md" = (
            & tar.exe -xOf $temporaryWindowsArchive (
                "$portableName/THIRD_PARTY_NOTICES.en.md"
            )
        ) -join "`n"
        "docs/USER_GUIDE.md" = (
            & tar.exe -xOf $temporaryWindowsArchive (
                "$portableName/docs/USER_GUIDE.md"
            )
        ) -join "`n"
        "docs/USER_GUIDE.en.md" = (
            & tar.exe -xOf $temporaryWindowsArchive (
                "$portableName/docs/USER_GUIDE.en.md"
            )
        ) -join "`n"
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read public documents from the Windows archive."
    }
    $sensitivePatterns = [ordered]@{
        "absolute Windows user path" = '(?i)[A-Z]:\\Users\\[^\\\s]+'
        "absolute developer path" = '(?i)[A-Z]:\\(?:MyDevelop|Projects|Repos|Source)\\'
        "absolute Unix user path" = '(?i)/(?:Users|home)/[^/\s]+'
        "email address" = '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b'
        "private key" = '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
        "GitHub token" = '\bgh[oprsu]_[A-Za-z0-9_]{20,}\b'
        "GitHub fine-grained token" = '\bgithub_pat_[A-Za-z0-9_]{20,}\b'
        "OpenAI-style token" = '\bsk-[A-Za-z0-9_-]{20,}\b'
        "AWS access key" = '\bAKIA[0-9A-Z]{16}\b'
        "Google API key" = '\bAIza[0-9A-Za-z_-]{30,}\b'
        "Slack token" = '\bxox[baprs]-[0-9A-Za-z-]{20,}\b'
        "Windows SID" = '\bS-1-5-21-(?:\d+-){2}\d+(?:-\d+)?\b'
        "phone number" = '(?<!\d)0[1-9]\d{0,3}[- ]\d{1,4}[- ]\d{3,4}(?!\d)'
    }
    foreach ($document in $publicDocuments.GetEnumerator()) {
        foreach ($pattern in $sensitivePatterns.GetEnumerator()) {
            if ($document.Value -match $pattern.Value) {
                throw "Sensitive text ($($pattern.Key)) found in $($document.Key)."
            }
        }
        foreach ($match in [regex]::Matches(
            $document.Value,
            '(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)'
        )) {
            $address = $null
            if (
                [Net.IPAddress]::TryParse($match.Value, [ref]$address) -and
                $address.AddressFamily -eq
                    [Net.Sockets.AddressFamily]::InterNetwork -and
                -not $match.Value.StartsWith("127.")
            ) {
                throw "Non-loopback IPv4 address found in $($document.Key)."
            }
        }
    }
} finally {
    if (Test-Path -LiteralPath $temporaryWindowsArchive -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryWindowsArchive -Force
    }
}

Write-Output "Release package verification passed."
Write-Output "  Version: $version"
Write-Output "  Source commit: $sourceCommit"
foreach ($assetName in $checksumAssetNames) {
    $item = Get-Item -LiteralPath (Join-Path $releaseAssetsRoot $assetName)
    Write-Output ("  {0}: {1:N0} bytes" -f $assetName, $item.Length)
}
