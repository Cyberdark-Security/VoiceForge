@echo off
title VoiceForge - Cerrar
set PUERTO=8765

echo.
echo  VoiceForge - Detener servidor
echo  =============================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort %PUERTO% -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

taskkill /FI "WINDOWTITLE eq VoiceForge Server" /T /F >nul 2>&1

echo  Servidor detenido.
echo.
pause
