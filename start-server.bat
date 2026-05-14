@echo off
echo ============================================
echo  Dashboard Despachos — Servidor con Odoo
echo ============================================
echo.

:: Verificar que Node.js esta instalado
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: Node.js no encontrado. Instalalo desde https://nodejs.org
  pause
  exit /b 1
)

:: Verificar que proxy.js existe
if not exist "%~dp0proxy.js" (
  echo ERROR: No se encontro proxy.js en esta carpeta.
  pause
  exit /b 1
)

echo Conectando con Odoo ERP...
echo El dashboard se abrira en: http://localhost:3000/historial.html
echo Para detener el servidor presiona Ctrl+C
echo.

:: Abrir browser despues de 2 segundos para dar tiempo al servidor
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000/historial.html"

:: Iniciar servidor proxy
cd /d "%~dp0"
node proxy.js
