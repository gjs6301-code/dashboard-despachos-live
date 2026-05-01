@echo off
echo Iniciando servidor local para Dashboard Despachos...
echo.
echo El dashboard se abrira en: http://localhost:8080
echo Para detener el servidor presiona Ctrl+C
echo.
start "" "http://localhost:8080"
python -m http.server 8080
