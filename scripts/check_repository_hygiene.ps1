$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repositoryRoot
try {
    $trackedFiles = @(git ls-files)
    if ($LASTEXITCODE -ne 0) {
        throw "git ls-files failed"
    }

    $failures = [System.Collections.Generic.List[string]]::new()
    $forbiddenPaths = @(
        '(?i)(^|/)(UserData)(/|$)',
        '(?i)(^|/)\.env(?:\.[^/]*)?$',
        '(?i)(^|/)id_(?:rsa|ed25519)$',
        '(?i)\.(?:exe|dll|pdb|lib|obj|pfx|p12|pem|key|dmp|log)$',
        '(?i)\.(ecaproj|safetensors|ckpt|pt|pth|onnx|th|gguf)$',
        '(?i)\.(wav|mp3|m4a|flac|ogg|aac)$',
        '(?i)^models/.*\.(bin|safetensors|ckpt|pt|pth|onnx|th|gguf)$'
    )
    foreach ($path in $trackedFiles) {
        foreach ($pattern in $forbiddenPaths) {
            if ($path -match $pattern) {
                $failures.Add("Forbidden tracked file: $path")
                break
            }
        }
    }

    $firstPartyExtensions = @(
        ".cjs", ".cmd", ".css", ".html", ".js", ".json", ".md",
        ".ps1", ".py", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"
    )
    $excludedPrefixes = @(
        "app/node_modules/",
        "app/resources/licenses/",
        "app/release",
        "app/backend-",
        "tools/"
    )
    $excludedFiles = @(
        "app/package-lock.json",
        "scripts/check_repository_hygiene.ps1",
        "THIRD_PARTY_NOTICES.md",
        "THIRD_PARTY_NOTICES.en.md",
        "uv.lock"
    )
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

    foreach ($relativePath in $trackedFiles) {
        $extension = [IO.Path]::GetExtension($relativePath)
        if ($firstPartyExtensions -notcontains $extension) {
            continue
        }
        if ($excludedFiles -contains $relativePath) {
            continue
        }
        if ($excludedPrefixes.Where({ $relativePath.StartsWith($_) }).Count -gt 0) {
            continue
        }
        $absolutePath = Join-Path $repositoryRoot $relativePath
        if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
            continue
        }
        $lineNumber = 0
        foreach ($line in Get-Content -LiteralPath $absolutePath -Encoding utf8) {
            $lineNumber += 1
            foreach ($entry in $sensitivePatterns.GetEnumerator()) {
                if ($line -match $entry.Value) {
                    $failures.Add(
                        "Sensitive text ($($entry.Key)): ${relativePath}:${lineNumber}"
                    )
                }
            }
            foreach ($match in [regex]::Matches(
                $line,
                '(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)'
            )) {
                $address = $null
                if (
                    [Net.IPAddress]::TryParse($match.Value, [ref]$address) -and
                    $address.AddressFamily -eq
                        [Net.Sockets.AddressFamily]::InterNetwork -and
                    -not $match.Value.StartsWith("127.")
                ) {
                    $failures.Add(
                        "Sensitive text (non-loopback IPv4 address): " +
                        "${relativePath}:${lineNumber}"
                    )
                }
            }
        }
    }

    if ($failures.Count -gt 0) {
        $failures | ForEach-Object { Write-Error $_ }
        throw "Repository hygiene check failed with $($failures.Count) finding(s)"
    }
    Write-Host "Repository hygiene check passed."
    Write-Host "  Tracked files: $($trackedFiles.Count)"
}
finally {
    Pop-Location
}
