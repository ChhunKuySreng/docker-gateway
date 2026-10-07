@echo off
REM ==============================================================================
REM 🚀 Global Docker Stack Setup Launcher for Windows
REM ==============================================================================
echo Launching PowerShell Setup Script...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause
