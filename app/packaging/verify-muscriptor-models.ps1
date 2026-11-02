param(
    [string]$ModelRoot,
    [ValidateSet("small", "medium", "large")]
    [string]$Variant
)

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($ModelRoot)) {
    $ModelRoot = Join-Path $repositoryRoot "models\muscriptor"
}
$modelRoot = [IO.Path]::GetFullPath($ModelRoot)
$catalogPath = Join-Path $repositoryRoot "src\earcopy_service\model-downloads.json"
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding utf8 | ConvertFrom-Json
$models = @($catalog.models | ForEach-Object {
    @{
        Variant = $_.variant
        Size = $_.weightSizeBytes
        Sha256 = $_.weightSha256
        ConfigSha256 = $_.configSha256
    }
})

if (-not [string]::IsNullOrWhiteSpace($Variant)) {
    $models = @($models | Where-Object { $_.Variant -eq $Variant })
}

foreach ($model in $models) {
    $variantRoot = Join-Path $modelRoot $model.Variant
    $weightPath = Join-Path $variantRoot "model.safetensors"
    $configPath = Join-Path $variantRoot "config.json"
    if (-not (Test-Path -LiteralPath $weightPath -PathType Leaf)) {
        throw "MuScriptor model weight is missing: $weightPath"
    }
    if ((Get-Item -LiteralPath $weightPath).Length -ne $model.Size) {
        throw "MuScriptor model weight size does not match: $weightPath"
    }
    $actualHash = (
        Get-FileHash -LiteralPath $weightPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actualHash -ne $model.Sha256) {
        throw "MuScriptor model weight SHA-256 does not match: $weightPath"
    }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "MuScriptor config is missing: $configPath"
    }
    $actualConfigHash = (
        Get-FileHash -LiteralPath $configPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actualConfigHash -ne $model.ConfigSha256) {
        throw "MuScriptor config SHA-256 does not match: $configPath"
    }
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 |
        ConvertFrom-Json
    if (
        [string]$config.model_type -ne "muscriptor" -or
        [string]$config.variant -ne $model.Variant
    ) {
        throw "MuScriptor config does not match its directory: $configPath"
    }
}

if ([string]::IsNullOrWhiteSpace($Variant)) {
    Write-Output "MuScriptor small, medium, and large models are ready for packaging."
} else {
    Write-Output "MuScriptor $Variant model is ready for packaging."
}
