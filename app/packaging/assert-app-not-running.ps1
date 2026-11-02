$ErrorActionPreference = "Stop"

$running = @(
    Get-Process -Name "EarCopyAssist", "earcopy_service" `
        -ErrorAction SilentlyContinue
)
if ($running.Count -eq 0) {
    Write-Output "EarCopy Assist is not running."
    return
}

$details = (
    $running |
        Sort-Object ProcessName, Id |
        ForEach-Object { "$($_.ProcessName) (PID $($_.Id))" }
) -join ", "
throw (
    "EarCopy Assist is running. Packaging cannot modify or read the live " +
    "application while it is in use. Close the application first. $details"
)
