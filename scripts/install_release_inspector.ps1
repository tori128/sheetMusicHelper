$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "ci-release-context.ps1")
$null = Get-CiReleaseContext
$lock = Join-Path $ciReleaseRepositoryRoot "uv.lock"
$version = & python -c "import sys,tomllib; data=tomllib.load(open(sys.argv[1],'rb')); print(next(p['version'] for p in data['package'] if p['name']=='pyinstaller'))" $lock
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+$') {
    throw "The locked PyInstaller version could not be read."
}
& python -m pip install --disable-pip-version-check --only-binary=:all: "pyinstaller==$version"
if ($LASTEXITCODE -ne 0) { throw "Release inspector installation failed." }
