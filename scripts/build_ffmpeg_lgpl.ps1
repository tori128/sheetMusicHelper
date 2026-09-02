param(
    [string]$Version = "8.1.2",
    [int]$Jobs = 4
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $repositoryRoot "tools\ffmpeg-lgpl"
$downloadRoot = Join-Path $toolRoot "downloads"
$sourceRoot = Join-Path $toolRoot "source"
$outputRoot = Join-Path $toolRoot "bin"
$msysHomeRoot = Join-Path $toolRoot "msys-home"
$msysTempRoot = Join-Path $toolRoot "msys-tmp"
$archiveName = "ffmpeg-$Version.tar.xz"
$archivePath = Join-Path $downloadRoot $archiveName
$sourceUrl = "https://ffmpeg.org/releases/$archiveName"
$expectedSha256 = "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
$scriptSha256 = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath
).Hash.ToLowerInvariant()
$sourceOfferRoot = Join-Path $repositoryRoot "app\release-sources"
$msys2Root = if ([string]::IsNullOrWhiteSpace($env:EARCOPY_MSYS2_ROOT)) {
    "C:\msys64"
} else {
    [IO.Path]::GetFullPath($env:EARCOPY_MSYS2_ROOT)
}
$bash = Join-Path $msys2Root "usr\bin\bash.exe"
$msysShell = Join-Path $msys2Root "msys2_shell.cmd"
$objdump = Join-Path $msys2Root "mingw64\bin\objdump.exe"
$ffmpegExecutable = Join-Path $outputRoot "ffmpeg.exe"
$ffprobeExecutable = Join-Path $outputRoot "ffprobe.exe"
$outputReadme = Join-Path $outputRoot "README.txt"
$configureOptions = @(
    "--disable-gpl",
    "--disable-nonfree",
    "--disable-autodetect",
    "--disable-everything",
    "--disable-network",
    "--disable-doc",
    "--disable-debug",
    "--disable-ffplay",
    "--disable-x86asm",
    "--disable-response-files",
    "--enable-static",
    "--disable-shared",
    "--extra-ldflags=-static",
    "--enable-ffmpeg",
    "--enable-ffprobe",
    "--enable-protocol=file",
    "--enable-demuxer=wav,mp3,flac,ogg,mov,aac",
    "--enable-decoder=aac,aac_fixed,aac_latm,alac,flac,mp3,mp3float,opus,vorbis,pcm_alaw,pcm_mulaw,pcm_s8,pcm_u8,pcm_s16le,pcm_s16be,pcm_u16le,pcm_u16be,pcm_s24le,pcm_s24be,pcm_u24le,pcm_u24be,pcm_s32le,pcm_s32be,pcm_u32le,pcm_u32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be",
    "--enable-parser=aac,aac_latm,flac,mpegaudio,opus,vorbis",
    "--enable-filter=aformat,aresample,anull",
    "--enable-encoder=pcm_f32le",
    "--enable-muxer=wav"
)

function Write-BuildStage {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("download", "extract", "configure", "compile", "validate")]
        [string]$Stage
    )

    $timestamp = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    Write-Output "[FFmpeg][$timestamp] Starting stage: $Stage"
}

function ConvertTo-WindowsProcessArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }
    $builder = [Text.StringBuilder]::new()
    $null = $builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            $null = $builder.Append(('\' * (($backslashes * 2) + 1)))
            $null = $builder.Append('"')
        } else {
            $null = $builder.Append(('\' * $backslashes))
            $null = $builder.Append($character)
        }
        $backslashes = 0
    }
    $null = $builder.Append(('\' * ($backslashes * 2)))
    $null = $builder.Append('"')
    return $builder.ToString()
}

function Set-ProcessArguments {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.ProcessStartInfo]$StartInfo,
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )

    $StartInfo.Arguments = ($ArgumentList |
        ForEach-Object { ConvertTo-WindowsProcessArgument $_ }) -join " "
}

function Invoke-ProcessWithTimeout {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    Set-ProcessArguments -StartInfo $startInfo -ArgumentList $ArgumentList

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start ${Description}: $FilePath"
    }
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $killTreeMethod = $process.GetType().GetMethod(
                "Kill",
                [type[]]@([bool])
            )
            if ($null -ne $killTreeMethod) {
                $null = $killTreeMethod.Invoke($process, @($true))
            } else {
                & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null
            }
            $process.WaitForExit()
            throw "${Description} timed out after $TimeoutSeconds seconds."
        }
        if ($process.ExitCode -ne 0) {
            throw "${Description} failed with exit code $($process.ExitCode)."
        }
    } finally {
        $process.Dispose()
    }
}

function Invoke-PortableExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$Description,
        [int]$TimeoutSeconds = 30
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $portablePath = @(
        (Join-Path $env:SystemRoot "System32"),
        $env:SystemRoot
    ) -join ";"
    if ($null -ne $startInfo.Environment) {
        $startInfo.Environment["PATH"] = $portablePath
    } else {
        $startInfo.EnvironmentVariables["PATH"] = $portablePath
    }
    Set-ProcessArguments -StartInfo $startInfo -ArgumentList $ArgumentList

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start ${Description}: $FilePath"
    }
    try {
        $standardOutput = $process.StandardOutput.ReadToEndAsync()
        $standardError = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            throw "${Description} timed out after $TimeoutSeconds seconds."
        }
        $output = @(
            $standardOutput.GetAwaiter().GetResult(),
            $standardError.GetAwaiter().GetResult()
        ) -join "`n"
        if ($process.ExitCode -ne 0) {
            throw "${Description} failed with exit code $($process.ExitCode): $FilePath`n$($output.Trim())"
        }
        return $output.Trim()
    } finally {
        $process.Dispose()
    }
}

function Convert-ToMsysPath([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath -notmatch "^([A-Za-z]):[\\/](.*)$") {
        throw "Cannot convert path for MSYS2: $fullPath"
    }
    $drive = $Matches[1].ToLowerInvariant()
    $remainder = $Matches[2].Replace("\", "/")
    return "/$drive/$remainder"
}

function Resolve-SevenZip {
    $command = Get-Command "7z.exe" -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }
    $installedPath = Join-Path $env:ProgramFiles "7-Zip\7z.exe"
    if (Test-Path -LiteralPath $installedPath -PathType Leaf) {
        return $installedPath
    }
    throw "7z.exe is required to extract the FFmpeg source archive."
}

function Invoke-MsysCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    $previousHome = $env:HOME
    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP
    try {
        $env:HOME = $msysHomeRoot
        $env:TEMP = $msysTempRoot
        $env:TMP = $msysTempRoot
        Invoke-ProcessWithTimeout `
            -FilePath $msysShell `
            -ArgumentList @("-defterm", "-no-start", "-mingw64", "-c", $Command) `
            -TimeoutSeconds $TimeoutSeconds `
            -Description $Description
    } finally {
        $env:HOME = $previousHome
        $env:TEMP = $previousTemp
        $env:TMP = $previousTmp
    }
}

function Assert-LgplConfiguration {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $versionOutput = Invoke-PortableExecutable `
        -FilePath $Executable `
        -ArgumentList @("-version") `
        -Description "FFmpeg executable validation"
    $configuration = ($versionOutput -split "`r?`n" |
        Where-Object { $_ -like "configuration:*" }) -join "`n"
    if (
        $configuration -notmatch "--disable-gpl" -or
        $configuration -match "--enable-gpl" -or
        $configuration -match "--enable-nonfree"
    ) {
        throw "Built FFmpeg is not an LGPL-only configuration.`n$configuration"
    }
}

function Write-BinaryDependencies {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $dependencies = & $objdump -p $Executable 2>&1 |
        Select-String -Pattern "DLL Name:" |
        ForEach-Object { $_.Line.Trim() }
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to inspect executable dependencies: $Executable"
    }
    $unexpected = $dependencies | Where-Object {
        $_ -match "(?i)DLL Name:\s+(libwinpthread|libgcc|libstdc\+\+)"
    }
    if (@($unexpected).Count -gt 0) {
        throw "Executable depends on a MinGW runtime DLL: $Executable`n$($unexpected -join "`n")"
    }
    Write-Output "[FFmpeg] Dependencies for $([IO.Path]::GetFileName($Executable)):"
    $dependencies | ForEach-Object { Write-Output "[FFmpeg]   $_" }
}

function Assert-FunctionalConversion {
    param(
        [Parameter(Mandatory = $true)][string]$Ffmpeg,
        [Parameter(Mandatory = $true)][string]$Ffprobe
    )

    $smokeRoot = Join-Path $toolRoot "smoke-test"
    $inputWave = Join-Path $smokeRoot "input.wav"
    $outputWave = Join-Path $smokeRoot "output.wav"
    New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
    try {
        $sampleRate = 8000
        $sampleCount = 800
        $dataSize = $sampleCount * 2
        $stream = [IO.File]::Open($inputWave, [IO.FileMode]::Create)
        try {
            $writer = [IO.BinaryWriter]::new($stream)
            $writer.Write([Text.Encoding]::ASCII.GetBytes("RIFF"))
            $writer.Write([int](36 + $dataSize))
            $writer.Write([Text.Encoding]::ASCII.GetBytes("WAVEfmt "))
            $writer.Write([int]16)
            $writer.Write([int16]1)
            $writer.Write([int16]1)
            $writer.Write([int]$sampleRate)
            $writer.Write([int]($sampleRate * 2))
            $writer.Write([int16]2)
            $writer.Write([int16]16)
            $writer.Write([Text.Encoding]::ASCII.GetBytes("data"))
            $writer.Write([int]$dataSize)
            $writer.Write([byte[]]::new($dataSize))
        } finally {
            if ($null -ne $writer) {
                $writer.Dispose()
            } else {
                $stream.Dispose()
            }
        }

        $null = Invoke-PortableExecutable `
            -FilePath $Ffmpeg `
            -ArgumentList @(
                "-v", "error", "-y", "-i", $inputWave,
                "-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le", $outputWave
            ) `
            -Description "FFmpeg functional conversion"
        $probeOutput = Invoke-PortableExecutable `
            -FilePath $Ffprobe `
            -ArgumentList @(
                "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name,sample_rate,channels",
                "-of", "default=noprint_wrappers=1", $outputWave
            ) `
            -Description "FFprobe functional validation"
        foreach ($expected in @(
            "codec_name=pcm_f32le",
            "sample_rate=16000",
            "channels=1"
        )) {
            if ($probeOutput -notmatch "(?m)^$([regex]::Escape($expected))`r?$") {
                throw "FFprobe validation did not report ${expected}:`n$probeOutput"
            }
        }
    } finally {
        Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Assert-BuiltTools {
    Write-BinaryDependencies -Executable $ffmpegExecutable
    Write-BinaryDependencies -Executable $ffprobeExecutable
    Assert-LgplConfiguration -Executable $ffmpegExecutable
    $null = Invoke-PortableExecutable `
        -FilePath $ffprobeExecutable `
        -ArgumentList @("-version") `
        -Description "FFprobe executable validation"
    Assert-FunctionalConversion `
        -Ffmpeg $ffmpegExecutable `
        -Ffprobe $ffprobeExecutable
    Write-Output "[FFmpeg] Portable launch and functional conversion passed."
}

function Write-SourceOffer {
    New-Item -ItemType Directory -Force -Path $sourceOfferRoot | Out-Null
    Copy-Item -LiteralPath $archivePath -Destination $sourceOfferRoot -Force
    Copy-Item -LiteralPath $PSCommandPath -Destination $sourceOfferRoot -Force
    Set-Content -LiteralPath (Join-Path $sourceOfferRoot "README.txt") -Encoding utf8 -Value @"
This directory is published beside the EarCopy Assist Windows binary.

$archiveName
SHA-256: $expectedSha256
Build instructions: build_ffmpeg_lgpl.ps1
Build prerequisite: MSYS2 MINGW64 with GCC, make, and diffutils.
"@
}

if (
    -not (Test-Path -LiteralPath $bash) -or
    -not (Test-Path -LiteralPath $msysShell)
) {
    throw "MSYS2 was not found under $msys2Root"
}

New-Item -ItemType Directory -Force -Path `
    $downloadRoot, $sourceRoot, $outputRoot, $sourceOfferRoot, `
    $msysHomeRoot, $msysTempRoot |
    Out-Null

Write-BuildStage -Stage "download"
if (-not (Test-Path -LiteralPath $archivePath)) {
    $curl = Get-Command "curl.exe" -ErrorAction SilentlyContinue
    if ($null -eq $curl) {
        throw "curl.exe is required to download the FFmpeg source archive."
    }
    & $curl.Source `
        --fail `
        --location `
        --silent `
        --show-error `
        --retry 3 `
        --retry-all-errors `
        --connect-timeout 30 `
        --max-time 300 `
        --output $archivePath `
        $sourceUrl
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
        throw "FFmpeg source download failed."
    }
} else {
    Write-Output "[FFmpeg] Using cached source archive: $archivePath"
}
$actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
    throw "FFmpeg source SHA-256 mismatch: expected=$expectedSha256 actual=$actualSha256"
}

$cachedFiles = @(
    $ffmpegExecutable,
    $ffprobeExecutable,
    $outputReadme,
    (Join-Path $outputRoot "LICENSE"),
    (Join-Path $outputRoot "COPYING.LGPLv3"),
    (Join-Path $outputRoot "LICENSE.md")
)
if (@($cachedFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -eq 0) {
    $existingBuildInfo = Get-Content -LiteralPath $outputReadme -Raw -Encoding utf8
    if (
        $existingBuildInfo.Contains("Source SHA-256: $expectedSha256") -and
        $existingBuildInfo.Contains("Build script SHA-256: $scriptSha256")
    ) {
        Write-BuildStage -Stage "validate"
        Assert-BuiltTools
        Write-SourceOffer
        Write-Output "FFmpeg LGPL tools are up to date: $outputRoot"
        Write-Output "Corresponding source offer: $sourceOfferRoot"
        return
    }
}

$sourceDirectory = Join-Path $sourceRoot "ffmpeg-$Version"
if (Test-Path -LiteralPath $sourceDirectory) {
    $resolvedToolRoot = [IO.Path]::GetFullPath($toolRoot)
    $resolvedSource = [IO.Path]::GetFullPath($sourceDirectory)
    if (-not $resolvedSource.StartsWith($resolvedToolRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a source directory outside the tool root: $resolvedSource"
    }
    Remove-Item -LiteralPath $resolvedSource -Recurse -Force
}
Write-BuildStage -Stage "extract"
$sevenZip = Resolve-SevenZip
$tarArchivePath = Join-Path $downloadRoot "ffmpeg-$Version.tar"
Remove-Item -LiteralPath $tarArchivePath -Force -ErrorAction SilentlyContinue
try {
    Invoke-ProcessWithTimeout `
        -FilePath $sevenZip `
        -ArgumentList @("x", $archivePath, "-o$downloadRoot", "-y") `
        -TimeoutSeconds 120 `
        -Description "FFmpeg XZ decompression"
    if (-not (Test-Path -LiteralPath $tarArchivePath -PathType Leaf)) {
        throw "FFmpeg XZ decompression did not create: $tarArchivePath"
    }
    Invoke-ProcessWithTimeout `
        -FilePath $sevenZip `
        -ArgumentList @("x", $tarArchivePath, "-o$sourceRoot", "-y") `
        -TimeoutSeconds 120 `
        -Description "FFmpeg TAR extraction"
} finally {
    Remove-Item -LiteralPath $tarArchivePath -Force -ErrorAction SilentlyContinue
}

$sourceMsys = Convert-ToMsysPath $sourceDirectory
$homeMsys = Convert-ToMsysPath $msysHomeRoot
$tempMsys = Convert-ToMsysPath $msysTempRoot
$configureCommand = @(
    "export PATH=/mingw64/bin:/usr/bin",
    "export HOME='$homeMsys' TMPDIR='$tempMsys' TMP='$tempMsys' TEMP='$tempMsys'",
    "cd '$sourceMsys'",
    "./configure $($configureOptions -join ' ')"
) -join "; "
Write-BuildStage -Stage "configure"
Invoke-MsysCommand `
    -Command $configureCommand `
    -Description "FFmpeg configure" `
    -TimeoutSeconds 300

$buildCommand = @(
    "export PATH=/mingw64/bin:/usr/bin",
    "export HOME='$homeMsys' TMPDIR='$tempMsys' TMP='$tempMsys' TEMP='$tempMsys'",
    "cd '$sourceMsys'",
    "mingw32-make -j$Jobs ffmpeg.exe ffprobe.exe"
) -join "; "
Write-BuildStage -Stage "compile"
Invoke-MsysCommand `
    -Command $buildCommand `
    -Description "FFmpeg build" `
    -TimeoutSeconds 900

Copy-Item -LiteralPath (Join-Path $sourceDirectory "ffmpeg.exe") -Destination $outputRoot -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory "ffprobe.exe") -Destination $outputRoot -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory "COPYING.LGPLv2.1") -Destination (Join-Path $outputRoot "LICENSE") -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory "COPYING.LGPLv3") -Destination $outputRoot -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory "LICENSE.md") -Destination $outputRoot -Force

Write-BuildStage -Stage "validate"
Assert-BuiltTools

$buildInfo = @"
FFmpeg $Version LGPL build for EarCopy Assist

Source: $sourceUrl
Source SHA-256: $expectedSha256
Build script: scripts/build_ffmpeg_lgpl.ps1
Build script SHA-256: $scriptSha256
Target: Windows x86-64, static command-line executables

Configure:
$($configureOptions -join " ")

EarCopy Assist starts ffmpeg.exe and ffprobe.exe as separate programs.
The executables are replaceable files under the packaged backend tools directory.
"@
Set-Content -LiteralPath (Join-Path $outputRoot "README.txt") -Value $buildInfo -Encoding utf8

Write-SourceOffer

Write-Output "FFmpeg LGPL tools: $outputRoot"
Write-Output "Corresponding source offer: $sourceOfferRoot"
