param([string]$DataDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ($DataDirectory) { $env:TYPED_POSTX_DATA = $DataDirectory }
if (-not (Test-Path -LiteralPath "$projectRoot\native\bin\TypedPostX.Keyboard.exe")) { & "$PSScriptRoot\build.ps1" }
if (-not (Test-Path -LiteralPath "$projectRoot\node_modules\ws")) {
    Push-Location $projectRoot
    try { npm ci --cache "$projectRoot\.npm-cache" --no-fund --no-audit; if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' } } finally { Pop-Location }
}
& node "$projectRoot\helper\server.mjs"
exit $LASTEXITCODE
