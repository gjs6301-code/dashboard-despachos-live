/**
 * sync-from-prod.js
 * Descarga todos los datos de producción y los guarda en data-local/
 *
 * Uso:
 *   node sync-from-prod.js
 *
 * Requiere tener configurado .env con JWT_SECRET o las credenciales para hacer login.
 * El script hace login automáticamente con las credenciales del .env.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── Configuración ─────────────────────────────────────────────────────────────
const PROD_URL   = 'https://dashboard-despachos.onrender.com';
const LOCAL_DIR  = path.join(__dirname, 'data-local');

// Leer .env para obtener credenciales de login
function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) { console.error('❌ No se encontró .env'); process.exit(1); }
  const env = {};
  fs.readFileSync(envFile, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
    if (m) env[m[1]] = m[2].trim();
  });
  return env;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req    = lib.request(url, {
      method:  options.method  || 'GET',
      headers: options.headers || {},
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();

  console.log('\n🔄 Sincronizando data desde producción...');
  console.log(`   Origen:  ${PROD_URL}`);
  console.log(`   Destino: ${LOCAL_DIR}\n`);

  // 1. Login para obtener token
  console.log('🔐 Iniciando sesión en producción...');
  const email    = env.ODOO_USER;
  const password = process.argv[2] || process.env.RENDER_WWP_PASSWORD; // argumento o variable temporal

  if (!password) {
    console.error('❌ Debes pasar tu contraseña como argumento:');
    console.error('   node sync-from-prod.js TU_CONTRASEÑA');
    console.error('   O usar RENDER_WWP_PASSWORD como variable temporal.');
    process.exit(1);
  }

  const loginRes = await request(`${PROD_URL}/api/wwp/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (loginRes.status !== 200) {
    console.error('❌ Login fallido:', loginRes.body);
    process.exit(1);
  }

  const { accessToken } = JSON.parse(loginRes.body);
  console.log('✅ Login exitoso\n');

  // 2. Descargar export
  console.log('📦 Descargando datos...');
  const exportRes = await request(`${PROD_URL}/api/admin/export-data`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (exportRes.status !== 200) {
    console.error('❌ Error descargando datos:', exportRes.body);
    process.exit(1);
  }

  const { files, exportedAt } = JSON.parse(exportRes.body);
  console.log(`   Exportado: ${new Date(exportedAt).toLocaleString()}\n`);

  // 3. Guardar archivos en data-local/
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });

  const fileMap = {
    'wwp-solicitudes-showroom': 'wwp-solicitudes-showroom.json',
    'wwp-tasks':                'wwp-tasks.json',
    'wwp-users-auth':           'wwp-users-auth.json',
    'wwp-roles':                'wwp-roles.json',
    'wwp-role-defs':            'wwp-role-defs.json',
    'wwp-lunch-breaks':         'wwp-lunch-breaks.json',
    'wwp-notifications':        'wwp-notifications.json',
    'averias':                  'averias.json',
    'empaque-materiales':       'empaque-materiales.json',
    'empaque-reglas':           'empaque-reglas.json',
    'politicas':                'politicas.json',
  };

  let saved = 0;
  for (const [key, filename] of Object.entries(fileMap)) {
    const data = files[key];
    if (data === null || data === undefined) {
      console.log(`   ⚠️  ${filename} — vacío o no existe`);
      continue;
    }
    const dest = path.join(LOCAL_DIR, filename);
    fs.writeFileSync(dest, JSON.stringify(data, null, 2), 'utf-8');
    const count = Array.isArray(data) ? `${data.length} registros` : 'objeto';
    console.log(`   ✅ ${filename} (${count})`);
    saved++;
  }

  console.log(`\n🎉 Sincronización completa — ${saved} archivos guardados en data-local/`);
  console.log('   Reinicia el servidor local para usar los datos nuevos.\n');
}

main().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
