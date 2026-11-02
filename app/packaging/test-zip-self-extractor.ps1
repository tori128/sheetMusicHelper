param(
    [string]$ReleaseArchive
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "zip-self-extractor.ps1")
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$testParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\")
$testRoot = Join-Path $testParent (
    ".codex-zip-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
)
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$testExecutable = Join-Path $testRoot "ZipSelfExtractorTests.exe"
try {
    $compiler = Get-ZipSelfExtractorCompiler
    & $compiler /nologo /codepage:65001 /target:exe /platform:x64 /optimize+ `
        /main:ZipSelfExtractorTests "/out:$testExecutable" `
        /r:System.IO.Compression.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll `
        (Join-Path $PSScriptRoot "ZipSelfExtractor.cs") `
        (Join-Path $PSScriptRoot "ZipExtractionProgressForm.cs") `
        (Join-Path $PSScriptRoot "tests\ZipSelfExtractorTests.cs")
    if ($LASTEXITCODE -ne 0) {
        throw "ZIP self-extractor test compilation failed."
    }
    if ($ReleaseArchive) {
        & $testExecutable $testRoot ([IO.Path]::GetFullPath($ReleaseArchive))
    } else {
        & $testExecutable $testRoot
    }
    if ($LASTEXITCODE -ne 0) {
        throw "ZIP self-extractor tests failed."
    }
} finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedTestRoot.StartsWith(
        $testParent + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Test directory is outside the repository."
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
