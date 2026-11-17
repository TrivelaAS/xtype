$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.x C# compiler not found on this Windows installation.' }
$outputDir = Join-Path $projectRoot 'native\bin'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

& $compiler /nologo /target:exe /platform:x64 /optimize+ /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll "/out:$outputDir\TypedPostX.Keyboard.exe" "$projectRoot\native\KeyboardHost.cs"
if ($LASTEXITCODE -ne 0) { throw 'Keyboard helper compilation failed.' }
Write-Host "Built $outputDir\TypedPostX.Keyboard.exe"

& $compiler /nologo /target:winexe /platform:x64 /optimize+ /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll "/out:$projectRoot\TypedPostX.exe" "$projectRoot\native\StandaloneTrayHelper.cs"
if ($LASTEXITCODE -ne 0) { throw 'Standalone TypedPostX.exe compilation failed.' }
Copy-Item -LiteralPath "$projectRoot\TypedPostX.exe" -Destination "$outputDir\TypedPostX.Tray.exe" -Force
Write-Host "Built $projectRoot\TypedPostX.exe"
