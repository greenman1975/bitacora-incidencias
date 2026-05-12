@echo off
title Bitácora de Incidencias - Servidor
echo ============================================
echo   Bitácora de Incidencias - Servidor
echo ============================================
echo.
echo Verificando Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js no esta instalado.
    echo Descargalo de: https://nodejs.org
    pause
    exit /b 1
)
echo Node.js encontrado: 
node --version
echo.
echo Instalando dependencias...
call npm install --silent
if %errorlevel% neq 0 (
    echo ERROR al instalar dependencias.
    pause
    exit /b 1
)
echo.
echo Iniciando servidor...
echo Abrí en el navegador: http://localhost:3000
echo.
echo Para salir, cerrá esta ventana.
echo ============================================
node server.js
pause
