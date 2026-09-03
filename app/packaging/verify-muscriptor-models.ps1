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
$models = @(
    @{
        Variant = "small"
        Size = 411888600
        Sha256 = "bbd482c786b895cf7d8f44185073d951adae2ebb8a66f82ca84cd1f84569549c"
        ConfigSha256 = "3008fc481e4a1cd978e337eb3759260c270892204db5039235ac939e1f42aeb2"
    },
    @{
        Variant = "medium"
        Size = 1228144472
        Sha256 = "ac80adbdf85d87231735fd948af7013441c0afced316c4e9067fd5d8a7fb97ec"
        ConfigSha256 = "43e13a70fc9ae0af36b7447c06f3eac2282daeb69d79c1ff840ede7fdaa26a3b"
    },
    @{
        Variant = "large"
        Size = 5465642136
        Sha256 = "ac4eb6ea87dfc26b6ca6b954c6b967ab87ad4c7d08e078b25214f13ed051f397"
        ConfigSha256 = "16bedd02b18770e43740419b0d5777f231047e96e8987f498e8a1123c39c9852"
    }
)

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
