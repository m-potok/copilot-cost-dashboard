# Copilot Cost Dashboard - PowerShell Launcher
# Usage: .\start-dashboard.ps1

$ErrorActionPreference = 'Continue'

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Copilot Cost Dashboard" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
try {
    $nodeVersion = & node --version 2>&1
    Write-Host "[INFO] Node.js trovato: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Node.js non trovato nel sistema." -ForegroundColor Red
    Write-Host "Scarica da: https://nodejs.org/" -ForegroundColor Yellow
    Write-Host "Assicurati di aggiungere Node.js al PATH durante l'installazione."
    Write-Host ""
    Read-Host "Premi INVIO per uscire"
    exit 1
}

# Get script directory
$scriptDir = Split-Path -Parent (Get-Item $PSCommandPath).FullName
Set-Location -Path $scriptDir

Write-Host "[INFO] Avvio server Dashboard in corso..." -ForegroundColor Yellow
Write-Host "[INFO] Percorso: $scriptDir" -ForegroundColor Yellow
Write-Host ""

# Start the Node.js server in background
$serverProcess = Start-Process -FilePath "node" -ArgumentList "$scriptDir\app\copilot-cost-dashboard-server.js" `
  -WindowStyle Hidden -PassThru

if ($serverProcess) {
    Write-Host "[OK] Server avviato (PID: $($serverProcess.Id))" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Errore nell'avvio del server" -ForegroundColor Red
    exit 1
}

# Wait for server startup
Start-Sleep -Seconds 2

# Open dashboard in browser
Write-Host "[INFO] Apertura del browser..." -ForegroundColor Yellow
Start-Process "http://127.0.0.1:4781"

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "[OK] Dashboard disponibile su http://127.0.0.1:4781" -ForegroundColor Green
Write-Host ""
Write-Host "Per chiudere il server:" -ForegroundColor Yellow
Write-Host "  Stop-Process -Id $($serverProcess.Id)" -ForegroundColor Gray
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Keep process alive
$serverProcess | Wait-Process
