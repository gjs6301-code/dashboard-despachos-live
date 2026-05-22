@echo off
taskkill /F /IM node.exe 2>nul
timeout /t 2 /nobreak >nul
cd /d "C:\Users\Gabriel Ramirez\OneDrive\Documentos\Claude\Artifacts\dashboard-despachos-live"
start "" cmd /k "node proxy.js"
