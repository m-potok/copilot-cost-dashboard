@echo off
setlocal
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\build-standalone.ps1"
if errorlevel 1 (
  echo.
  echo Build fallita.
  exit /b 1
)
echo.
echo Build completata.
