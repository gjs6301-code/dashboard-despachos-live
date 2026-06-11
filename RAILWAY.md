# Despliegue en Railway

Este proyecto puede correr en Railway sin dejar de funcionar en Render.
Render sigue usando `render.yaml`; Railway usa `railway.json`.

## Configuracion requerida

Variables para Railway:

```text
NODE_ENV=production
DATA_DIR=/data
ODOO_URL=...
ODOO_DB=...
ODOO_USER=...
ODOO_API_KEY=...
JWT_SECRET=...
COMPANY_NAME=Altri Tempi
CONT_SHEETS_ID=...
CONT_SHEETS_GID=0
SMTP_HOST=...
SMTP_PORT=...
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=...
```

`PORT` no se debe fijar en Railway. Railway lo asigna automaticamente y
`proxy.js` ya lee `process.env.PORT`.

## Pasos con Railway CLI

En esta maquina el CLI quedo instalado en:

```powershell
C:\Users\Gabriel Ramirez\AppData\Roaming\npm\railway.cmd
```

Si `railway` no funciona en tu terminal, usa esa ruta completa en los comandos.

Desde esta carpeta:

```powershell
railway login --browserless
railway init --name dashboard-despachos
railway add --service dashboard-despachos
.\scripts\import-railway-env.ps1
railway volume add --service dashboard-despachos --mount-path /data
railway up --service dashboard-despachos --detach
railway domain --service dashboard-despachos
```

El script incluido importa las variables secretas desde `.env`:

```powershell
.\scripts\import-railway-env.ps1
```

El script solo importa variables de la app. No sube `RAILWAY_API_TOKEN` ni
`PORT`.

## Despues del primer despliegue

1. Abre el dominio que genere Railway.
2. Verifica `/api/health`.
3. Verifica `/historial.html`.
4. Mantén Render activo en `https://dashboard-despachos.onrender.com/historial.html`.

## Nota sobre datos

Railway necesita un volumen montado en `/data`. Sin ese volumen, tareas,
usuarios, sesiones, fotos y otros datos de runtime se perderian al redesplegar.
