$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$workspaceRoot = Split-Path (Split-Path $projectRoot -Parent) -Parent
$runtimeRoot = Join-Path $workspaceRoot 'work'
if (-not (Test-Path (Join-Path $runtimeRoot 'local-config.json'))) {
  throw 'This preview runtime is missing. Follow the portable setup in README.md.'
}
& (Join-Path $runtimeRoot 'pgsql/bin/pg_isready.exe') -h 127.0.0.1 -p 55432 -q
if ($LASTEXITCODE -ne 0) {
  Start-Process -FilePath (Join-Path $runtimeRoot 'pgsql/bin/postgres.exe') -ArgumentList @('-D', ('"' + (Join-Path $runtimeRoot 'pgdata') + '"')) -WindowStyle Hidden
}
try { $response = Invoke-WebRequest 'http://127.0.0.1:8000/api/health' -TimeoutSec 2 } catch { $response = $null }
if (-not $response -or $response.StatusCode -ne 200) {
  Start-Process -FilePath (Get-Command python3).Source -ArgumentList @('work/run_local.py') -WorkingDirectory $workspaceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'app.out.log') -RedirectStandardError (Join-Path $runtimeRoot 'app.err.log')
}
Write-Output 'ResQGIS preview: http://127.0.0.1:8000/ (allow a few seconds to start)'
