param(
    [string[]] $Path,
    [switch] $RequireValid
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ($null -eq $Path -or $Path.Count -eq 0) {
    $Path = @(
        (Join-Path $repositoryRoot "app/release/win-unpacked/EarCopyAssist.exe"),
        (Join-Path $repositoryRoot "app/release/win-unpacked/resources/backend/earcopy_service.exe")
    )
}

$invalid = [System.Collections.Generic.List[string]]::new()
foreach ($candidate in $Path) {
    $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction Stop
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    [pscustomobject]@{
        Path = $resolved.Path
        Status = $signature.Status
        Subject = if ($null -eq $signature.SignerCertificate) {
            ""
        } else {
            $signature.SignerCertificate.Subject
        }
        Thumbprint = if ($null -eq $signature.SignerCertificate) {
            ""
        } else {
            $signature.SignerCertificate.Thumbprint
        }
    }
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        $invalid.Add($resolved.Path)
    }
}

if ($RequireValid -and $invalid.Count -gt 0) {
    throw "Authenticode signature is not valid: $($invalid -join ', ')"
}
