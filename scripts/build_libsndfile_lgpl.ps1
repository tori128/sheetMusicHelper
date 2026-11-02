param(
    [string]$Version = "1.2.2",
    [int]$Jobs = 4
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $repositoryRoot "tools\libsndfile-lgpl"
$sourceOfferRoot = Join-Path $repositoryRoot "app\release-sources"
$downloadRoot = $sourceOfferRoot
$sourceRoot = Join-Path $toolRoot "source"
$buildRoot = Join-Path $toolRoot "build"
$outputRoot = Join-Path $toolRoot "bin"
$archiveName = "libsndfile-$Version.tar.xz"
$archivePath = Join-Path $downloadRoot $archiveName
$sourceDirectory = Join-Path $sourceRoot "libsndfile-$Version"
$sourceUrl = (
    "https://github.com/libsndfile/libsndfile/releases/download/" +
    "$Version/$archiveName"
)
$expectedSha256 = "3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e"
$msys2Root = if ([string]::IsNullOrWhiteSpace($env:EARCOPY_MSYS2_ROOT)) {
    "C:\msys64"
} else {
    [IO.Path]::GetFullPath($env:EARCOPY_MSYS2_ROOT)
}
$gcc = Join-Path $msys2Root "mingw64\bin\gcc.exe"
$gxx = Join-Path $msys2Root "mingw64\bin\g++.exe"
$objdump = Join-Path $msys2Root "mingw64\bin\objdump.exe"
$mingwBin = Split-Path -Parent $gcc
$outputDll = Join-Path $outputRoot "libsndfile_x64.dll"
$outputReadme = Join-Path $outputRoot "README.txt"

function Write-BuildStage {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("download", "extract", "configure", "compile", "validate")]
        [string]$Stage
    )

    $timestamp = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    Write-Output "[libsndfile][$timestamp] Starting stage: $Stage"
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
    $startInfo.Arguments = ($ArgumentList |
        ForEach-Object { ConvertTo-WindowsProcessArgument $_ }) -join " "

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

function Resolve-SevenZip {
    $command = Get-Command "7z.exe" -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }
    $installedPath = Join-Path $env:ProgramFiles "7-Zip\7z.exe"
    if (Test-Path -LiteralPath $installedPath -PathType Leaf) {
        return $installedPath
    }
    throw "7z.exe is required to extract the libsndfile source archive."
}

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

function Assert-SystemOnlyDependencies {
    param([Parameter(Mandatory = $true)][string]$Path)

    $dependencyOutput = (& $objdump -p $Path 2>&1) -join "`n"
    $dependencies = @(
        [regex]::Matches($dependencyOutput, "DLL Name:\s*(\S+)") |
            ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() }
    )
    $unexpectedDependencies = @(
        $dependencies |
            Where-Object { $_ -notin @("kernel32.dll", "msvcrt.dll") }
    )
    if ($unexpectedDependencies.Count -ne 0) {
        throw (
            "Unexpected libsndfile DLL dependencies: " +
            ($unexpectedDependencies -join ", ")
        )
    }
}

$env:Path = "$mingwBin;$env:Path"
foreach ($requiredTool in @("curl.exe", "cmake.exe", "ninja.exe", $gcc, $gxx, $objdump)) {
    if (-not (Get-Command $requiredTool -ErrorAction SilentlyContinue)) {
        throw "Required build tool was not found: $requiredTool"
    }
}

New-Item `
    -ItemType Directory `
    -Force `
    -Path $downloadRoot, $sourceRoot, $outputRoot |
    Out-Null

Write-BuildStage -Stage "download"
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    $temporaryArchive = "$archivePath.download"
    Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
    try {
        Invoke-ProcessWithTimeout `
            -FilePath "curl.exe" `
            -ArgumentList @(
                "--fail", "--location", "--retry", "2",
                "--connect-timeout", "30", "--max-time", "120",
                "--output", $temporaryArchive, $sourceUrl
            ) `
            -TimeoutSeconds 150 `
            -Description "libsndfile source download"
        Move-Item -LiteralPath $temporaryArchive -Destination $archivePath
    } finally {
        Remove-Item `
            -LiteralPath $temporaryArchive `
            -Force `
            -ErrorAction SilentlyContinue
    }
}
$actualSha256 = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath
).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
    throw (
        "libsndfile source SHA-256 mismatch: " +
        "expected=$expectedSha256 actual=$actualSha256"
    )
}

$scriptSha256 = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath
).Hash.ToLowerInvariant()
if (
    (Test-Path -LiteralPath $outputDll -PathType Leaf) -and
    (Test-Path -LiteralPath $outputReadme -PathType Leaf)
) {
    $existingBuildInfo = Get-Content `
        -LiteralPath $outputReadme `
        -Raw `
        -Encoding utf8
    if (
        $existingBuildInfo.Contains("Source SHA-256: $expectedSha256") -and
        $existingBuildInfo.Contains("Build script SHA-256: $scriptSha256")
    ) {
        Write-BuildStage -Stage "validate"
        Assert-SystemOnlyDependencies -Path $outputDll
        Copy-Item -LiteralPath $PSCommandPath -Destination $sourceOfferRoot -Force
        Write-Output "libsndfile LGPL library is up to date: $outputDll"
        return
    }
}

Remove-DirectoryInside -Path $sourceDirectory -Parent $sourceRoot
Remove-DirectoryInside -Path $buildRoot -Parent $toolRoot
Write-BuildStage -Stage "extract"
$sevenZip = Resolve-SevenZip
$intermediateTar = Join-Path $toolRoot "libsndfile-$Version.tar"
Remove-Item -LiteralPath $intermediateTar -Force -ErrorAction SilentlyContinue
try {
    Invoke-ProcessWithTimeout `
        -FilePath $sevenZip `
        -ArgumentList @(
            "x", "-y", "-bd", "-o$toolRoot", $archivePath
        ) `
        -TimeoutSeconds 120 `
        -Description "libsndfile XZ decompression"
    Invoke-ProcessWithTimeout `
        -FilePath $sevenZip `
        -ArgumentList @(
            "x", "-y", "-bd", "-o$sourceRoot", $intermediateTar
        ) `
        -TimeoutSeconds 120 `
        -Description "libsndfile TAR extraction"
} finally {
    Remove-Item `
        -LiteralPath $intermediateTar `
        -Force `
        -ErrorAction SilentlyContinue
}

$configureOptions = @(
    "-S", $sourceDirectory,
    "-B", $buildRoot,
    "-G", "Ninja",
    "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_C_COMPILER=$gcc",
    "-DCMAKE_CXX_COMPILER=$gxx",
    "-DBUILD_SHARED_LIBS=ON",
    "-DENABLE_EXTERNAL_LIBS=OFF",
    "-DENABLE_MPEG=OFF",
    "-DBUILD_PROGRAMS=OFF",
    "-DBUILD_EXAMPLES=OFF",
    "-DBUILD_TESTING=OFF",
    "-DBUILD_REGTEST=OFF",
    "-DENABLE_CPACK=OFF",
    "-DENABLE_PACKAGE_CONFIG=OFF",
    "-DINSTALL_PKGCONFIG_MODULE=OFF",
    "-DINSTALL_MANPAGES=OFF"
)
$documentedConfigureOptions = @(
    foreach ($option in $configureOptions) {
        $documented = $option.Replace(
            $sourceDirectory,
            "<source>/libsndfile-$Version"
        )
        $documented = $documented.Replace($buildRoot, "<build>")
        $documented = $documented.Replace(
            $gcc,
            "<mingw64>/bin/gcc.exe"
        )
        $documented = $documented.Replace(
            $gxx,
            "<mingw64>/bin/g++.exe"
        )
        $documented
    }
)
Write-BuildStage -Stage "configure"
Invoke-ProcessWithTimeout `
    -FilePath "cmake.exe" `
    -ArgumentList ([string[]]$configureOptions) `
    -TimeoutSeconds 180 `
    -Description "libsndfile configure"
Write-BuildStage -Stage "compile"
Invoke-ProcessWithTimeout `
    -FilePath "cmake.exe" `
    -ArgumentList @(
        "--build", $buildRoot, "--config", "Release",
        "--target", "sndfile", "--parallel", "$Jobs"
    ) `
    -TimeoutSeconds 300 `
    -Description "libsndfile build"

$builtDll = Join-Path $buildRoot "libsndfile.dll"
Copy-Item -LiteralPath $builtDll -Destination $outputDll -Force
Copy-Item `
    -LiteralPath (Join-Path $sourceDirectory "COPYING") `
    -Destination $outputRoot `
    -Force

Write-BuildStage -Stage "validate"
Assert-SystemOnlyDependencies -Path $outputDll

$buildInfo = @"
libsndfile $Version LGPL build for EarCopy Assist

Source: $sourceUrl
Source SHA-256: $expectedSha256
Build script: scripts/build_libsndfile_lgpl.ps1
Build script SHA-256: $scriptSha256
Target: Windows x86-64 shared library
Compiler: MSYS2 MINGW64 GCC

CMake:
$($documentedConfigureOptions -join " ")

External FLAC, Ogg Vorbis, Opus, LAME, and mpg123 support is disabled.
EarCopy Assist passes normalized WAV files to libsndfile. Other input formats
are decoded to WAV by the separately distributed minimal FFmpeg executables.

The DLL depends only on KERNEL32.dll and msvcrt.dll and can be replaced with
an interface-compatible modified build.
"@
Set-Content `
    -LiteralPath $outputReadme `
    -Value $buildInfo `
    -Encoding utf8

Copy-Item -LiteralPath $PSCommandPath -Destination $sourceOfferRoot -Force

Write-Output "libsndfile LGPL library: $outputDll"
Write-Output "Corresponding source cache: $sourceOfferRoot"
