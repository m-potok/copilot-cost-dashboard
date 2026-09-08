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

Write-Host "[1/2] Install dipendenze di build..." -ForegroundColor Yellow
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci fallito." }

Write-Host "[2/2] Build EXE con @yao-pkg/pkg..." -ForegroundColor Yellow
npm run build:exe
if ($LASTEXITCODE -ne 0) { throw "Build EXE fallita." }

Write-Host "Completato." -ForegroundColor Yellow

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
