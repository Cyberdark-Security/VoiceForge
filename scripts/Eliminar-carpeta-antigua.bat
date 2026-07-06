@echo off
title Renombrar proyecto a VoiceForge
echo.
echo  Este script elimina la carpeta antigua IA_SOUND
echo  despues de que hayas copiado todo a VoiceForge.
echo.
echo  CIERRA Cursor antes de continuar.
echo.
pause

if exist "e:\CYBERDARK\DEVELOPER\whoami-labs\VoiceForge\index.html" (
    echo VoiceForge OK.
) else (
    echo ERROR: No existe VoiceForge. Copia manual necesaria.
    pause
    exit /b 1
)

if exist "e:\CYBERDARK\DEVELOPER\whoami-labs\IA_SOUND" (
    echo Eliminando IA_SOUND antigua...
    rmdir /s /q "e:\CYBERDARK\DEVELOPER\whoami-labs\IA_SOUND"
    echo Listo. Usa solo la carpeta VoiceForge.
) else (
    echo IA_SOUND ya no existe. Nada que hacer.
)

pause
