@echo off
title VoiceForge - Abrir
cd /d "%~dp0.."
set "PROYECTO=%CD%"
set PUERTO=8765

if not exist "%PROYECTO%\index.html" (
    echo ERROR: No se encuentra index.html en %PROYECTO%
    pause
    exit /b 1
)

netstat -ano | findstr ":%PUERTO%" | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    start "" "http://localhost:%PUERTO%"
    exit /b 0
)

where py >nul 2>&1
if %errorlevel% equ 0 (
    set PYEXE=py
) else (
    set PYEXE=python
)

:: Servidor en segundo plano SIN ventana extra
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%PYEXE%' -ArgumentList '-m','http.server','%PUERTO%' -WorkingDirectory '%PROYECTO%' -WindowStyle Hidden"

ping -n 4 127.0.0.1 >nul

netstat -ano | findstr ":%PUERTO%" | findstr "LISTENING" >nul
if %errorlevel% neq 0 (
    echo ERROR: No arranco el servidor. Ejecuta server-runner.bat para ver el error.
    pause
    exit /b 1
)

start "" "http://localhost:%PUERTO%"
exit /b 0
