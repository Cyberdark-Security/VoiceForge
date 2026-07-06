@echo off
title VoiceForge Server
cd /d "%~dp0.."
set PUERTO=8765

echo VoiceForge Audio Labs
echo http://localhost:%PUERTO%
echo Carpeta: %CD%
echo.
echo No cierres esta ventana mientras uses el editor.
echo Para cerrar usa VoiceForge-Cerrar.bat
echo.

where py >nul 2>&1
if %errorlevel% equ 0 (
    py -m http.server %PUERTO%
    goto fin
)

python -m http.server %PUERTO%

:fin
echo.
echo Servidor detenido.
pause
