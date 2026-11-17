param([string]$DataDirectory)
$ErrorActionPreference = 'Stop'
if (-not $DataDirectory) { $DataDirectory = if ($env:TYPED_POSTX_DATA) { $env:TYPED_POSTX_DATA } else { Join-Path $env:LOCALAPPDATA 'TypedPostX' } }
$configPath = Join-Path $DataDirectory 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Start the helper first to generate its pairing token.' }
(Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).token
