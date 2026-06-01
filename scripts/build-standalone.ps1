$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Build standalone EXE - Copilot Cost Dashboard" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

$projectDir = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
Set-Location -Path $projectDir

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js non trovato. Installa Node.js da https://nodejs.org/"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm non trovato. Verifica l'installazione di Node.js."
}

Write-Host "[1/3] Install dipendenze di build..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install fallito." }

Write-Host "[2/3] Build EXE con pkg..." -ForegroundColor Yellow
npm run build:exe
if ($LASTEXITCODE -ne 0) { throw "Build EXE fallita." }

Write-Host "[3/3] Completato." -ForegroundColor Yellow

$exePath = Join-Path $projectDir "dist\copilot-cost-dashboard.exe"
if (Test-Path $exePath) {
  Write-Host ""
  Write-Host "EXE generato con successo:" -ForegroundColor Green
  Write-Host "  $exePath" -ForegroundColor Green
  Write-Host ""
  Write-Host "Avvio manuale:" -ForegroundColor Gray
  Write-Host "  .\dist\copilot-cost-dashboard.exe" -ForegroundColor Gray
  Write-Host "Poi apri: http://127.0.0.1:4781" -ForegroundColor Gray
} else {
  throw "Build completata ma EXE non trovato in dist/."
}
