$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$application = Join-Path $repositoryRoot "app\release\win-unpacked\EarCopyAssist.exe"
$source = Join-Path $PSScriptRoot "root-launcher.cs"
$output = Join-Path $repositoryRoot "EarCopyAssist.exe"

if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
    throw "Packaged application was not found: $application"
}

$compiler = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $compiler) {
    throw "The .NET Framework C# compiler was not found."
}

& $compiler `
    /nologo `
    /target:winexe `
    /optimize+ `
    /reference:System.Windows.Forms.dll `
    "/out:$output" `
    $source

if ($LASTEXITCODE -ne 0) {
    throw "Failed to build the root launcher."
}

Write-Output "Root launcher: $output"
