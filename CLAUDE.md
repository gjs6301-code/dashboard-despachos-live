# Dashboard Despachos — Guía del proyecto

## Fuente de verdad: carpeta raíz

Todos los archivos editables están en la **carpeta raíz** del proyecto:
`C:\Users\Gabriel Ramirez\OneDrive\Documentos\Claude\Artifacts\dashboard-despachos-live\`

| Archivo | Descripción |
|---------|-------------|
| `historial.html` | App principal (historial + WWP embebido) |
| `wwp.html` | ⚠️ DEPRECADO — redirige a historial.html, no editar |
| `index.html` | Dashboard de despachos |
| `proxy.js` | Servidor Node.js (API + archivos estáticos) |
| `lucide.min.js` | Librería de íconos (LOCAL, no CDN) |
| `leaflet.js` / `leaflet.css` | Mapas (LOCAL, no CDN) — usados en el mapa de ubicaciones |
| `MEMORIA-PROYECTO.md` | Historial de features y decisiones (leer para contexto completo) |

## Archivos que NO se editan

- `historial.backup-20260518.html` — backup original, solo lectura
- `.claude/worktrees/` — worktrees anteriores, ignorar
- `wwp.html` — DEPRECADO. Nunca editar para implementar funcionalidades de la plataforma. Toda la lógica de Workforce Platform vive en `historial.html`. Si algo hay que arreglar o agregar en WWP, el archivo correcto es SIEMPRE `historial.html`.

## Servidor

- Correr siempre: doble clic en `restart.bat`
- URL local: `http://localhost:3000`
- **URL producción (Render): `https://dashboard-despachos.onrender.com`** ⚠️ (NO `altritempi-operaciones`, esa da 404)
- Entrada principal: `/historial.html` (la raíz `/` redirige automáticamente)
- El servidor sirve desde **la raíz** (no desde ningún worktree)
- Datos persistentes en Render: disco `/data` (DATA_DIR env var, 10 GB)
- Datos en local: carpeta `data-local/` (se pasa `DATA_DIR=...data-local` al correr)
- **Deploy**: Render despliega desde la rama `master`. Flujo: commit en `dev` → `git checkout master && git merge dev --no-edit && git push origin master` → volver a `dev`. Tarda ~2-3 min.

## Convenciones de código

- **Lucide icons**: `<script src="/lucide.min.js"></script>` — nunca CDN
- Después de inyectar `data-lucide` via innerHTML: `if(window.lucide) lucide.createIcons();`
- **Colores**: variables CSS semánticas (`--green-bg`, `--amber-text`, etc.), nunca hex hardcodeados
- **Tema**: clave localStorage `wwp_theme`, atributo `data-theme` en `<html>`
