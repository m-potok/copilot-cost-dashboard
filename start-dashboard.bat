@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

echo.
echo ════════════════════════════════════════════════════════════════
echo  Copilot Cost Dashboard
echo ════════════════════════════════════════════════════════════════
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js non trovato nel sistema.
    echo Scarica da: https://nodejs.org/
    echo Assicurati di aggiungere Node.js al PATH durante l'installazione.
    echo.
    pause
    exit /b 1
)

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo [INFO] Avvio server Dashboard in corso...
echo [INFO] Percorso: %SCRIPT_DIR%
echo.

REM Start the Node.js server in a new window (disable server-side auto-open)
start "Copilot Cost Dashboard Server" cmd /c "set NO_AUTO_OPEN_BROWSER=1 && node \"%SCRIPT_DIR%app\copilot-cost-dashboard-server.js\""

REM Wait a moment for the server to start
timeout /t 2 /nobreak

REM Open the dashboard in the default browser
echo [INFO] Apertura del browser...
start http://127.0.0.1:4781

echo.
echo ════════════════════════════════════════════════════════════════
echo [OK] Dashboard avviato su http://127.0.0.1:4781
echo.
echo Per chiudere il server, chiudi la finestra "Copilot Cost Dashboard Server"
echo ════════════════════════════════════════════════════════════════
echo.
