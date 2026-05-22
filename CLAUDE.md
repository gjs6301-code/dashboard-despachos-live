# Dashboard Despachos — Guía del proyecto

## Fuente de verdad: carpeta raíz

Todos los archivos editables están en la **carpeta raíz** del proyecto:
`C:\Users\Gabriel Ramirez\OneDrive\Documentos\Claude\Artifacts\dashboard-despachos-live\`

| Archivo | Descripción |
|---------|-------------|
| `historial.html` | App principal (historial + WWP embebido) |
| `wwp.html` | Workforce Platform standalone |
| `index.html` | Dashboard de despachos |
| `proxy.js` | Servidor Node.js (API + archivos estáticos) |
| `lucide.min.js` | Librería de íconos (LOCAL, no CDN) |

## Archivos que NO se editan

- `historial.backup-20260518.html` — backup original, solo lectura
- `.claude/worktrees/` — worktrees anteriores, ignorar

## Servidor

- Correr siempre: doble clic en `restart.bat`
- URL: `http://localhost:3000`
- El servidor sirve desde **la raíz** (no desde ningún worktree)

## Convenciones de código

- **Lucide icons**: `<script src="/lucide.min.js"></script>` — nunca CDN
- Después de inyectar `data-lucide` via innerHTML: `if(window.lucide) lucide.createIcons();`
- **Colores**: variables CSS semánticas (`--green-bg`, `--amber-text`, etc.), nunca hex hardcodeados
- **Tema**: clave localStorage `wwp_theme`, atributo `data-theme` en `<html>`
