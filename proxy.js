/**
 * proxy.js — Servidor local para Dashboard Despachos
 * Sirve archivos estáticos + hace de proxy a Odoo JSON-RPC (resuelve CORS)
 */
const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const url        = require('url');
const crypto     = require('crypto');
// nodemailer se carga de forma lazy (solo si está instalado y se usa SMTP)
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* no disponible en este entorno */ }

// ── Helpers de persistencia JSON ─────────────────────────────────────────────
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback !== undefined ? fallback : []; }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Leer credenciales desde archivo .env / .env.txt ──────────────────────────
// Carga temprana: las vars del archivo se inyectan en process.env ANTES de
// que se usen DATA_DIR y el resto de constantes de configuración.
// process.env (variables de Render) siempre tienen prioridad sobre el archivo.
function loadEnv(filename) {
  const candidates = [filename, path.join(__dirname, filename)];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      const lines = fs.readFileSync(f, 'utf-8').split('\n');
      const env = {};
      lines.forEach(line => {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
        if (m) env[m[1]] = m[2].trim();
      });
      return env;
    }
  }
  return {};
}
// Inyectar variables del archivo .env (o .env.txt) en process.env si no existen ya
(function applyEnvFile() {
  const fileEnv = loadEnv('.env');
  const src = Object.keys(fileEnv).length ? fileEnv : loadEnv('.env.txt');
  for (const [k, v] of Object.entries(src)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

// ── Directorio de datos persistentes ────────────────────────────────────────
// En Render: DATA_DIR=/data (disco persistente). En local: ./data-local (desde .env)
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Archivo de persistencia de averías ───────────────────────────────────────
const AVERIAS_FILE  = path.join(DATA_DIR, 'averias.json');
const AV_FOTOS_DIR  = path.join(DATA_DIR, 'av-fotos');
if (!fs.existsSync(AV_FOTOS_DIR)) fs.mkdirSync(AV_FOTOS_DIR, { recursive: true });

function loadAverias() { return loadJson(AVERIAS_FILE, []); }
function saveAverias(list) { saveJson(AVERIAS_FILE, list); }

// ── Empaque — persistencia ────────────────────────────────────────────────────
const EMP_MATERIALES_FILE = path.join(DATA_DIR, 'emp-materiales.json');
const EMP_REGLAS_FILE     = path.join(DATA_DIR, 'emp-reglas.json');
const EMP_FOTOS_DIR       = path.join(DATA_DIR, 'emp-fotos');
if (!fs.existsSync(EMP_FOTOS_DIR)) fs.mkdirSync(EMP_FOTOS_DIR, { recursive: true });

function loadEmpMateriales() { return loadJson(EMP_MATERIALES_FILE, []); }
function saveEmpMateriales(d) { saveJson(EMP_MATERIALES_FILE, d); }
function loadEmpReglas()      { return loadJson(EMP_REGLAS_FILE, []); }
function saveEmpReglas(d)     { saveJson(EMP_REGLAS_FILE, d); }

// Cache de categorías Odoo para empaque (se refresca cada 30 min)
let _empCategCache = null;
let _empCategCacheAt = 0;
const EMP_CATEG_TTL = 30 * 60 * 1000;

// ── WWP (Warehouse Workforce Platform) — persistencia ────────────────────────
const WWP_TASKS_FILE  = path.join(DATA_DIR, 'wwp-tasks.json');
const WWP_ROLES_FILE  = path.join(DATA_DIR, 'wwp-roles.json');
const WWP_FOTOS_DIR   = path.join(DATA_DIR, 'wwp-fotos');
const WWP_LUNCH_FILE        = path.join(DATA_DIR, 'wwp-lunch-breaks.json');
const WWP_INSPECTIONS_FILE  = path.join(DATA_DIR, 'wwp-inspecciones.json');
if (!fs.existsSync(WWP_FOTOS_DIR)) fs.mkdirSync(WWP_FOTOS_DIR, { recursive: true });

function loadLunchBreaks() { return loadJson(WWP_LUNCH_FILE, []); }
function saveLunchBreaks(b) { saveJson(WWP_LUNCH_FILE, b); }

function loadInspections() { return loadJson(WWP_INSPECTIONS_FILE, []); }
function saveInspections(d) { saveJson(WWP_INSPECTIONS_FILE, d); }

function loadWwpTasks() { return loadJson(WWP_TASKS_FILE, []); }
function saveWwpTasks(list) { saveJson(WWP_TASKS_FILE, list); }

// Construye items desde las LÍNEAS DE OPERACIÓN (stock.move.line) de los picks
// 'assigned' (preparado) de una orden. Cada move.line = (bin real, cantidad reservada).
// → un bin por unidad (unitBins), cantidad = total reservado en el pick.
async function buildItemsFromPicks(orderName) {
  // Resolver nombre real de la orden (tolera ref sin prefijo, ej. "7647" → "S07647")
  let realName = orderName;
  try {
    const so = await odooCall('sale.order','search_read',[[['name','ilike',orderName]]],{fields:['name'],limit:1});
    if (so && so.length) realName = so[0].name;
  } catch {}
  const picksAll = await odooCall('stock.picking','search_read',
    [[['origin','=',realName],['state','=','assigned']]],
    {fields:['id','name','picking_type_id'],limit:30});
  const pickList = (picksAll||[]).filter(p => /\/PICK\//i.test(p.name)); // tipo "Pick"
  if (!pickList.length) return { noPick:true, items:[], pickNames:[] };
  const pickIds = pickList.map(p=>p.id);
  const pickNameById = {}; pickList.forEach(p=>{ pickNameById[p.id]=p.name; });
  const mls = await odooCall('stock.move.line','search_read',
    [[['picking_id','in',pickIds]]],
    {fields:['product_id','location_id','product_uom_qty','qty_done','picking_id'],limit:3000});
  const byProd = {};
  mls.forEach(ml=>{
    if(!ml.product_id) return;
    const qty = Math.max(0, Math.round(ml.product_uom_qty||ml.qty_done||0));
    if(qty<=0) return;
    const pid = ml.product_id[0];
    const bin = ml.location_id ? ml.location_id[1] : '';
    if(!byProd[pid]) byProd[pid]={ pid, name:ml.product_id[1], pickName:pickNameById[ml.picking_id&&ml.picking_id[0]]||'', unitBins:[] };
    for(let i=0;i<qty;i++) byProd[pid].unitBins.push(bin);
  });
  const pids = Object.keys(byProd).map(Number);
  if(!pids.length) return { noPick:false, items:[], pickNames:pickList.map(p=>p.name) };
  const prods = await odooCall('product.product','read',[pids],{fields:['id','barcode','default_code','image_128']});
  const pm={}; prods.forEach(p=>{ pm[p.id]=p; });
  const kitMap = await resolveKitInfo(prods); // componente → info del kit (BOM phantom)
  const items = pids.map(pid=>{
    const g=byProd[pid], prod=pm[pid]||{}, units=g.unitBins.length, kit=kitMap[pid];
    return { item_id:'oi_'+pid, odoo_product_id:pid, odoo_line_id:null,
      sku:prod.barcode||prod.default_code||'', barcode:prod.barcode||'',
      product_name:g.name||'', quantity:units, units,
      image:prod.image_128?'data:image/png;base64,'+prod.image_128:null,
      unitBins:g.unitBins, pickName:g.pickName, fromPick:true,  // bin por unidad desde el pick
      ...(kit ? { kitId:kit.kitId, kitRef:kit.kitRef, kitName:kit.kitName, kitImage:kit.kitImage } : {}),
      locations:[], selected_location:null,
      selected:false, evidence_images:[], comments:'', status:'pending' };
  });
  return { noPick:false, items, pickNames:pickList.map(p=>p.name) };
}

// Detecta componentes de kit (.Cn) y devuelve map productId → {kitId,kitRef,kitName,kitImage}
// usando BOM tipo 'phantom' en Odoo. Reutilizable para etiquetar artículos de tareas.
async function resolveKitInfo(products) {
  const rx = /^(.+)\.C\d+$/i;
  const compIds = (products||[]).filter(p => rx.test(p.default_code||p.ref||'')).map(p => p.id);
  const out = {};
  if (!compIds.length) return out;
  try {
    const bomLines = await odooCall('mrp.bom.line','search_read',
      [[['product_id','in',compIds]]], {fields:['bom_id','product_id'],limit:1000});
    const bomIds = [...new Set(bomLines.map(l => l.bom_id[0]))];
    if (!bomIds.length) return out;
    const boms = await odooCall('mrp.bom','read',[bomIds],{fields:['id','product_id','product_tmpl_id','type']});
    const kitBoms = boms.filter(b => b.type === 'phantom');
    if (!kitBoms.length) return out;
    const kitPids = kitBoms.map(b => b.product_id ? b.product_id[0] : null).filter(Boolean);
    const kitTmplIds = kitBoms.filter(b => !b.product_id).map(b => b.product_tmpl_id[0]);
    let kitProds = [];
    if (kitPids.length) kitProds = await odooCall('product.product','search_read',[[['id','in',kitPids]]],{fields:['id','default_code','name','image_512','image_128','product_tmpl_id'],limit:300});
    if (!kitProds.length && kitTmplIds.length) kitProds = await odooCall('product.product','search_read',[[['product_tmpl_id','in',kitTmplIds]]],{fields:['id','default_code','name','image_512','image_128','product_tmpl_id'],limit:300});
    const tmplIds = kitProds.filter(k=>!k.image_512&&!k.image_128).map(k=>k.product_tmpl_id?.[0]).filter(Boolean);
    const tmplImg = {};
    if (tmplIds.length) { try { (await odooCall('product.template','read',[tmplIds],{fields:['id','image_512','image_128']})).forEach(t=>{tmplImg[t.id]=t.image_512||t.image_128||'';}); } catch(_){} }
    const kpMap = {}, kpByTmpl = {};
    kitProds.forEach(k => {
      const o = { ...k, _img: k.image_512||k.image_128||(k.product_tmpl_id?tmplImg[k.product_tmpl_id[0]]:'')||'' };
      kpMap[k.id] = o;
      if (k.product_tmpl_id) kpByTmpl[k.product_tmpl_id[0]] = o;
    });
    // Resuelve el producto kit de un BOM por product_id o por product_tmpl_id (BOMs a nivel template)
    const kpForBom = (bom) =>
      (bom.product_id && kpMap[bom.product_id[0]]) ||
      (bom.product_tmpl_id && kpByTmpl[bom.product_tmpl_id[0]]) || null;
    bomLines.forEach(line => {
      const bom = kitBoms.find(b => b.id === line.bom_id[0]); if (!bom) return;
      const kp = kpForBom(bom); if (!kp) return;
      out[line.product_id[0]] = {
        kitId: 'bom_'+bom.id, kitRef: kp.default_code||'', kitName: kp.name||'',
        kitImage: kp._img ? ('data:image/png;base64,'+kp._img) : '' };
    });
  } catch(_) { /* mrp no instalado o sin permiso */ }
  return out;
}

// Etiqueta una lista de items (con odoo_product_id) con su info de kit (kitId, kitName, kitImage)
async function tagKitInfo(items) {
  const prods = [...new Map((items||[]).filter(i=>i.odoo_product_id).map(i=>[i.odoo_product_id,{id:i.odoo_product_id,default_code:i.sku}])).values()];
  if (!prods.length) return items;
  const km = await resolveKitInfo(prods);
  items.forEach(i => { const k = km[i.odoo_product_id]; if (k) { i.kitId=k.kitId; i.kitRef=k.kitRef; i.kitName=k.kitName; i.kitImage=k.kitImage; } });
  return items;
}

// Secuencia incremental de tareas (alto agua persistente; no se reutiliza al borrar)
const WWP_SEQ_FILE = path.join(DATA_DIR, 'wwp-task-seq.json');
function nextTaskSeq() {
  let meta = loadJson(WWP_SEQ_FILE, { seq: 0 });
  // Defensa: si el contador quedó por debajo del máximo existente, lo sube
  try {
    const tasks = loadWwpTasks();
    const maxExisting = tasks.reduce((m,t)=> (typeof t.seq==='number' && t.seq>m)?t.seq:m, 0);
    if (maxExisting > meta.seq) meta.seq = maxExisting;
  } catch {}
  meta.seq += 1;
  saveJson(WWP_SEQ_FILE, meta);
  return meta.seq;
}
// roles: objeto { "oe_<id>": "admin"|"manager"|"assistant" }
function loadWwpRoles() { return loadJson(WWP_ROLES_FILE, {}); }
function saveWwpRoles(obj) { saveJson(WWP_ROLES_FILE, obj); }

// ── Role Definitions — permisos viven en el rol, no en el usuario ─────────
const WWP_ROLE_DEFS_FILE = path.join(DATA_DIR, 'wwp-role-defs.json');
// sectionPerms mínimos por defecto para cada rol built-in.
// NOTA: 'wwp.validar_tarea' NO se incluye para manager — solo admin puede validar.
const BUILTIN_ROLE_DEFS = [
  { id:'admin',     name:'Admin',     isBuiltin:true, sectionPerms:null },
  { id:'manager',   name:'Encargado', isBuiltin:true, sectionPerms:{
      'wwp.crear_tarea':    true,
      'wwp.editar_tarea':   true,
      'wwp.eliminar_tarea': true,
      'wwp.usuarios':       true,
      'wwp.dashboard':      true,
    }
  },
  { id:'assistant', name:'Auxiliar',  isBuiltin:true, sectionPerms:{} },
];
function loadRoleDefs() {
  let defs;
  try { defs = fs.existsSync(WWP_ROLE_DEFS_FILE) ? JSON.parse(fs.readFileSync(WWP_ROLE_DEFS_FILE,'utf-8')) : null; }
  catch { defs = null; }
  if (!defs) {
    defs = BUILTIN_ROLE_DEFS.map(r=>({...r, sectionPerms: r.sectionPerms ? {...r.sectionPerms} : r.sectionPerms}));
  } else {
    // Asegurar que los roles built-in existen
    BUILTIN_ROLE_DEFS.forEach(br => { if (!defs.find(r=>r.id===br.id)) defs.unshift({...br}); });
    // Migración: si el manager tiene sectionPerms vacíos ({}) aplicar los defaults built-in
    let changed = false;
    defs.forEach(def => {
      const builtin = BUILTIN_ROLE_DEFS.find(b=>b.id===def.id);
      if (!builtin || !builtin.sectionPerms) return;
      const sp = def.sectionPerms || {};
      if (Object.keys(sp).length === 0) {
        def.sectionPerms = {...builtin.sectionPerms};
        changed = true;
      }
    });
    if (changed) saveRoleDefs(defs); // persiste la migración
  }
  return defs;
}
function saveRoleDefs(defs) { fs.writeFileSync(WWP_ROLE_DEFS_FILE, JSON.stringify(defs,null,2)); }
/** Devuelve sectionPerms para un roleId. Admin → {} (bypassed en frontend). */
function getRoleDefPerms(roleId) {
  if (roleId === 'admin') return {};
  const defs = loadRoleDefs();
  const def = defs.find(r => r.id === roleId);
  return def ? (def.sectionPerms || {}) : {};
}

// ── Solicitudes Showroom ──────────────────────────────────────────────────
const WWP_SOLICITUDES_FILE = path.join(DATA_DIR, 'wwp-solicitudes-showroom.json');
function loadSolicitudes() { return loadJson(WWP_SOLICITUDES_FILE, []); }
function saveSolicitudes(list) { saveJson(WWP_SOLICITUDES_FILE, list); }

function wwpId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}

// ── Caché en memoria para /api/analysis/reposicion ───────────────────────────
// Guarda el resultado por showroomId. TTL: 10 minutos.
// Se invalida con ?refresh=1 o automáticamente al vencer.
const _repoCache = new Map(); // showroomId → { json, ts }
const REPO_CACHE_TTL = 10 * 60 * 1000; // 10 minutos en ms

// ── WWP Auth — sin dependencias externas ────────────────────────────────────
const WWP_AUTH_FILE     = path.join(DATA_DIR, 'wwp-users-auth.json');
const WWP_SESSIONS_FILE = path.join(DATA_DIR, 'wwp-sessions.json');

// Secreto JWT persistente
const JWT_SECRET = (() => {
  const secretFile = path.join(DATA_DIR, '.jwt-secret');
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile,'utf-8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, s, 'utf-8');
  return s;
})();

// JWT HS256 puro (sin librerías)
function jwtSign(payload, expiresInSec) {
  const h = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const p = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now()/1000),
    exp: Math.floor(Date.now()/1000) + expiresInSec
  })).toString('base64url');
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
function jwtVerify(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT malformado');
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  const sBuf = Buffer.from(s.padEnd(Math.ceil(s.length/4)*4,'='), 'base64');
  const eBuf = Buffer.from(expected.padEnd(Math.ceil(expected.length/4)*4,'='), 'base64');
  if (sBuf.length !== eBuf.length || !crypto.timingSafeEqual(sBuf, eBuf)) throw new Error('Firma inválida');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (payload.exp < Math.floor(Date.now()/1000)) throw new Error('Token expirado');
  return payload;
}

// Hash de contraseña con PBKDF2 (equivalente a bcrypt en seguridad)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `pbkdf2:${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2:')) return false;
  const [, salt, hash] = stored.split(':');
  const attempt = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(attempt,'hex'), Buffer.from(hash,'hex')); }
  catch { return false; }
}

function loadAuthUsers() { return loadJson(WWP_AUTH_FILE, []); }
function saveAuthUsers(u) { saveJson(WWP_AUTH_FILE, u); }

function loadSessions() { return loadJson(WWP_SESSIONS_FILE, []); }
function saveSessions(s) { saveJson(WWP_SESSIONS_FILE, s); }

// Middleware de autenticación JWT (lanza 401 si falla)
function requireJwt(req, res) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No autenticado'})); return null; }
  try { return jwtVerify(h.slice(7)); }
  catch(e) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); return null; }
}

// RBAC middleware — valida que el rol del JWT esté en la lista permitida
// Uso: const jp = requireJwt(req,res); if(!jp) return; if(!requireRole(jp,res,['admin'])) return;
function requireRole(jp, res, roles) {
  if (!roles.includes(jp.role)) {
    res.writeHead(403, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:false, error:`Acceso denegado. Requiere rol: ${roles.join(' o ')}`}));
    return false;
  }
  return true;
}

// ── Helper de respuesta JSON ─────────────────────────────────────────────────
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// ── Audit log ───────────────────────────────────────────────────────────────
const WWP_AUDIT_FILE = path.join(DATA_DIR, 'wwp-audit.json');
function appendAuditLog(event, data) {
  try {
    const logs = fs.existsSync(WWP_AUDIT_FILE)
      ? JSON.parse(fs.readFileSync(WWP_AUDIT_FILE, 'utf-8'))
      : [];
    logs.push({ timestamp: new Date().toISOString(), event, ...data });
    if (logs.length > 10000) logs.splice(0, logs.length - 10000);
    fs.writeFileSync(WWP_AUDIT_FILE, JSON.stringify(logs, null, 2), 'utf-8');
  } catch(e) { console.warn('[audit]', e.message); }
}

// ── Rate limiting para login ─────────────────────────────────────────────────
const _loginAttempts = new Map(); // email → { count, resetAt }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS    = 15 * 60 * 1000;

function checkLoginRateLimit(email) {
  // Bloqueo por intentos fallidos DESACTIVADO (solicitado para pruebas en vivo).
  return false;
}
function recordFailedLogin(email) {
  const key   = (email || '').toLowerCase().trim();
  const now   = Date.now();
  const entry = _loginAttempts.get(key) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (entry.resetAt < now) { entry.count = 0; entry.resetAt = now + LOGIN_WINDOW_MS; }
  entry.count++;
  _loginAttempts.set(key, entry);
}
function clearLoginAttempts(email) {
  _loginAttempts.delete((email || '').toLowerCase().trim());
}

// ── Rate limiting por IP (endpoints costosos) ────────────────────────────────
const _ipRateMap = new Map();
const IP_RATE_RULES = {
  '/api/odoo':              { max: 30, windowMs: 60_000 },
  '/api/sheets':            { max: 20, windowMs: 60_000 },
  '/api/transfer/search':   { max: 30, windowMs: 60_000 },
  '/api/averias/search':    { max: 30, windowMs: 60_000 },
  '/api/analysis':          { max: 20, windowMs: 60_000 },
  '/api/wwp/tasks':         { max: 60, windowMs: 60_000 },
};
function checkIpRateLimit(reqPath, ip) {
  const rule = Object.keys(IP_RATE_RULES).find(p => reqPath.startsWith(p));
  if (!rule) return false;
  const { max, windowMs } = IP_RATE_RULES[rule];
  const key = `${rule}:${ip}`;
  const now = Date.now();
  const entry = _ipRateMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (entry.resetAt < now) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  _ipRateMap.set(key, entry);
  return entry.count > max;
}
// Limpiar entradas expiradas cada 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _ipRateMap) { if (v.resetAt < now) _ipRateMap.delete(k); }
}, 5 * 60_000);

// ── Sanitización de errores (evitar leakage de internos) ─────────────────────
function safeError(e) {
  if (process.env.NODE_ENV === 'development') return e.message;
  const msg = (e.message || '').toLowerCase();
  if (msg.includes('econnrefused') || msg.includes('enotfound')) return 'Servicio no disponible';
  if (msg.includes('timeout'))      return 'La operación tardó demasiado';
  if (msg.includes('cannot read') || msg.includes('undefined')) return 'Error procesando solicitud';
  if (msg.includes('enoent') || msg.includes('path')) return 'Error interno';
  return e.message; // Mensajes de validación propios son seguros
}

// ── Validación de fotos (MIME, extensión, tamaño) ───────────────────────────
const PHOTO_MAX_BYTES  = 5 * 1024 * 1024; // 5 MB
const PHOTO_VALID_MIME = /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i;
const PHOTO_VALID_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

function validatePhoto(f) {
  if (!f || !f.data) throw new Error('Foto inválida: sin datos');
  if (!PHOTO_VALID_MIME.test(f.data))
    throw new Error('Tipo de imagen no permitido. Usa JPEG, PNG, WebP o GIF');
  const rawExt = (f.ext || 'jpg').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const ext    = rawExt === 'jpeg' ? 'jpg' : rawExt;
  if (!PHOTO_VALID_EXTS.includes(ext))
    throw new Error(`Extensión .${ext} no permitida`);
  const b64   = f.data.replace(/^data:[^;]+;base64,/, '');
  const bytes = Math.ceil(b64.length * 0.75);
  if (bytes > PHOTO_MAX_BYTES)
    throw new Error(`Foto demasiado grande (${(bytes/1024/1024).toFixed(1)} MB, máx 5 MB)`);
  return { b64, ext };
}

// ── Cola de escritura para evitar race conditions ────────────────────────────
const _writeQueues = new Map();
function queueWrite(key, writeFn) {
  const prev = _writeQueues.get(key) || Promise.resolve();
  const next  = prev.then(writeFn).catch(e => console.error(`[write-queue:${key}]`, e.message));
  _writeQueues.set(key, next);
  return next;
}

// Mapa de permisos por módulo (única fuente de verdad)
const ROLE_PERMISSIONS = {
  dashboard:    ['admin'],
  users_manage: ['admin'],
  users_view:   ['admin','manager'],   // para dropdown de asignación
  create_task:  ['admin','manager'],
  edit_task:    ['admin','manager'],
  delete_task:  ['admin','manager'],
  validate_task:['admin'],          // Solo admin puede validar tareas
  assign_task:  ['admin','manager'],
  update_status:['admin','manager','assistant'],
  evidence:     ['admin','manager','assistant'],
};

// Seed usuarios iniciales (sólo si el archivo no existe)
function seedAuthUsers() {
  if (fs.existsSync(WWP_AUTH_FILE)) return;
  const defPw = hashPassword('WWP2026!');
  const now   = new Date().toISOString();
  const mk = (id,name,email,role,odooId,pw) => ({id,name,email,passwordHash:pw||defPw,role,odooId,active:true,lastLogin:null,resetToken:null,resetTokenExpiry:null,createdAt:now});
  const users = [
    mk('au_gsanchez','Gabriel Joaquín Sánchez Ramírez','gsanchez@altritempi.com.do','admin',95,hashPassword('Admin2026!')),
    mk('au_jbencini','Jacopo Bencini Tesi Checo','jbencini@altritempi.com.do','admin',37),
    mk('au_fcandelario','Franklin Antonio De Jesus Candelario','fcandelario@altritempi.com.do','manager',48),
    mk('au_juena','Jose Ismael Ureña Montas','juena@altritempi.com.do','manager',49),
    mk('au_albert','Albert Josue De La Cruz Ysabel','adelacruz@altritempi.com.do','assistant',96),
    mk('au_hcheco','Harold Eduardo Checo Guzman','hcheco@altritempi.com.do','assistant',8),
    mk('au_fmunoz','Franchi Muñoz','fmunoz@altritempi.com.do','assistant',80),
    mk('au_dfamilia','Dennis Antonio Familia Baez','dfamilia@altritempi.com.do','assistant',79),
    mk('au_jdelarosa','Jose Angel De La Rosa Mayi','jdelarosa@altritempi.com.do','assistant',16),
    mk('au_jmdejesus','Jose Miguel De Jesus De Jesus','jmdejesus@altritempi.com.do','assistant',17),
    mk('au_jlinares','Jose Rafael Linares Baez','jlinares@altritempi.com.do','assistant',18),
    mk('au_jrodriguez','Jose Rodriguez Gonzalez','jrodriguez@altritempi.com.do','assistant',19),
    mk('au_jpache','Julio Cesar Pache Jourdain','jpache@altritempi.com.do','assistant',20),
    mk('au_mgrullon','Melvin Staling Grullon Gomez','mgrullon@altritempi.com.do','manager',41),
    mk('au_wrodriguez','Welby Silvestre Rodríguez Martínez','wrodriguez@altritempi.com.do','assistant',84),
  ];
  saveAuthUsers(users);
  console.warn('🔐 WWP Auth: usuarios iniciales creados (contraseña default: WWP2026!)');
}

// Todas las vars ya están en process.env (inyectadas al inicio desde .env / Render)
const ODOO_URL   = process.env.ODOO_URL   || '';
const ODOO_DB    = process.env.ODOO_DB    || '';
const ODOO_USER  = process.env.ODOO_USER  || '';
const ODOO_KEY   = process.env.ODOO_API_KEY || '';
const PORT       = parseInt(process.env.PORT || '3000', 10);
const odooOrigin = ODOO_URL ? new url.URL(ODOO_URL).origin : '';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Altri Tempi';

// ── Notificaciones vía Odoo Discuss (sin SMTP) ───────────────────────────────
// Construye el HTML que aparecerá en el inbox de Discuss del usuario
function buildSinAdjOdooMsg(userName, pickings, period, supervisorName) {
  const inboxUrl    = `${ODOO_URL}/odoo/discuss/inbox`;
  const rows = pickings.map(p => {
    const fecha      = (p.date_done || '').slice(0, 10);
    const ref        = p.name   || '—';
    const pickingUrl = p.id ? `${ODOO_URL}/odoo/inventory/${p.id}` : null;
    const refHtml    = pickingUrl
      ? `<a href="${pickingUrl}" style="color:#1b3b6f;font-weight:700;text-decoration:none">${ref}</a>`
      : `<b>${ref}</b>`;
    const ov  = (p.sale_id && p.sale_id[1]) || p.origin || '—';
    const cli = p.partner_id ? p.partner_id[1] : '—';
    return `<tr>
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb">${refHtml}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;white-space:nowrap">${fecha}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb">${ov}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb">${cli}</td>
    </tr>`;
  }).join('');
  const supNote = supervisorName
    ? `<p style="margin:12px 0 0;font-size:12px;color:#6b7280">Tu supervisor <b>${supervisorName}</b> también ha recibido esta notificación.</p>`
    : '';
  return `<p>Hola <b>${userName}</b>,</p>
<p>Tienes <b style="color:#dc2626">${pickings.length} despacho${pickings.length !== 1 ? 's' : ''}</b> pendiente${pickings.length !== 1 ? 's' : ''} de comprobante adjunto en el período <b>${period}</b>. Por favor adjunta los documentos en Odoo a la brevedad.</p>
<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:8px">
  <thead><tr style="background:#f3f4f6">
    <th style="padding:6px 8px;text-align:left;font-weight:600">Transferencia</th>
    <th style="padding:6px 8px;text-align:left;font-weight:600">Fecha</th>
    <th style="padding:6px 8px;text-align:left;font-weight:600">Orden de Venta</th>
    <th style="padding:6px 8px;text-align:left;font-weight:600">Cliente</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
${supNote}
<p style="margin:16px 0 0;padding:10px 14px;background:#f0f4ff;border-radius:6px;font-size:12px">
  📬 Para ver este mensaje: abre <a href="${inboxUrl}" style="color:#1b3b6f;font-weight:600">Odoo → Discuss → Bandeja de entrada</a>
</p>`;
}

// ════════════════════════════════════════════════════════════════════════════
// ── NOTIFICACIONES ───────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

// SSE clients: userId → Set<res>
const sseClients = new Map();
const wwpWsClients = new Set();
let wwpStateVersion = Date.now();

// Limpieza periódica de conexiones SSE destruidas (cada 5 min)
setInterval(() => {
  sseClients.forEach((set, uid) => {
    set.forEach(r => { if (r.destroyed) set.delete(r); });
    if (set.size === 0) sseClients.delete(uid);
  });
}, 5 * 60 * 1000);

// Almuerzo: mapa de timers activos userId → timeout handle
const lunchTimerMap = new Map();

const WWP_NOTIF_FILE = path.join(DATA_DIR, 'wwp-notifications.json');
function loadNotifications()    { try { return JSON.parse(fs.readFileSync(WWP_NOTIF_FILE,'utf-8')); } catch { return []; } }
function saveNotifications(arr) { fs.writeFileSync(WWP_NOTIF_FILE, JSON.stringify(arr)); }

function wsEncodeFrame(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function wsSend(socket, payload) {
  if (!socket || socket.destroyed) return;
  try { socket.write(wsEncodeFrame(payload)); } catch {}
}

function broadcastWwp(event, payload={}) {
  const msg = {
    scope: 'wwp',
    event,
    version: ++wwpStateVersion,
    at: new Date().toISOString(),
    ...payload
  };
  wwpWsClients.forEach(socket => wsSend(socket, msg));
}

function broadcastWwpTasks(action, task=null, extra={}) {
  broadcastWwp('tasks:changed', {
    action,
    task,
    taskId: task?.id || extra.taskId || null,
    tasks: loadWwpTasks(),
    dashboardDirty: true,
    ...extra
  });
}

// Mapear oe_<n> → auth userId
function odooStrToAuthId(odooStr) {
  if (!odooStr) return null;
  const num = parseInt((odooStr+'').replace('oe_',''));
  const u = loadAuthUsers().find(u => Number(u.odooId) === num);
  return u?.id || null;
}

const NOTIF_LABELS = {
  task_assigned   : '📋 Nueva tarea asignada',
  subtask_assigned: '📋 Subtarea asignada',
  status_changed  : '🔄 Cambio de estado',
  task_overdue    : '⚠️ Tarea vencida',
  task_completed  : '✅ Tarea completada',
  task_validated  : '🎉 Tarea validada',
  task_rejected   : '↩️ Tarea devuelta',
  comment_new     : '💬 Comentario nuevo',
  lunch_ended     : '🍴 Almuerzo terminado',
};

function createNotification(userId, {type, title, message, relatedTaskId=null, priority=null, dueDate=null, by=null}) {
  if (!userId) return null;
  const notif = {
    id: wwpId('notif'), userId, type,
    title: title || NOTIF_LABELS[type] || type,
    message, relatedTaskId, priority, dueDate, by,
    status: 'sent', createdAt: new Date().toISOString(), readAt: null
  };
  const all = loadNotifications();
  all.unshift(notif);
  // Mantener máx 200 notificaciones por usuario (trim total a 2000)
  const trimmed = all.slice(0, 2000);
  saveNotifications(trimmed);
  // Push SSE a todos los clientes del usuario
  const data = `data: ${JSON.stringify({event:'notification', notif})}\n\n`;
  (sseClients.get(userId)||new Set()).forEach(res => { try { res.write(data); } catch {} });
  broadcastWwp('notification', { notif, userId });
  return notif;
}

function notifyMany(userIds, payload) {
  [...new Set(userIds.filter(Boolean))].forEach(uid => createNotification(uid, payload));
}

// ── Auto-cierre de almuerzo ───────────────────────────────────────────────────

/**
 * Programa el auto-cierre del almuerzo de un usuario.
 * startTime: ISO string del inicio; allowedMinutes: límite configurado.
 */
function scheduleLunchAutoClose(userId, startTime, allowedMinutes) {
  // Cancelar timer previo si existe
  if (lunchTimerMap.has(userId)) {
    clearTimeout(lunchTimerMap.get(userId));
    lunchTimerMap.delete(userId);
  }
  const endMs    = new Date(startTime).getTime() + allowedMinutes * 60 * 1000;
  const remaining = endMs - Date.now();
  if (remaining <= 0) {
    // Ya expiró (e.g., recuperación tras reinicio)
    setImmediate(() => autoCloseLunch(userId));
    return;
  }
  const handle = setTimeout(() => autoCloseLunch(userId), remaining);
  lunchTimerMap.set(userId, handle);
}

/**
 * Cierra el almuerzo automáticamente al vencer el tiempo,
 * restaura presencia y notifica al usuario + todos los encargados/admins.
 */
function autoCloseLunch(userId) {
  lunchTimerMap.delete(userId);
  const users = loadAuthUsers();
  const idx   = users.findIndex(u => u.id === userId);
  if (idx < 0) return;
  const user = users[idx];

  // Cerrar el registro de break abierto
  const now    = new Date().toISOString();
  const breaks = loadLunchBreaks();
  const openIdx = breaks.findIndex(b => b.userId === userId && b.endTime === null);
  if (openIdx >= 0) {
    const ob = breaks[openIdx];
    ob.endTime        = now;
    ob.totalMinutes   = Math.round((new Date(now) - new Date(ob.startTime)) / 60000);
    ob.exceededMinutes = Math.max(0, ob.totalMinutes - ob.allowedMinutes);
    ob.compliant      = ob.exceededMinutes === 0;
    saveLunchBreaks(breaks);
  }

  // Restaurar presencia a 'active' solo si todavía está en 'lunch'
  if (user.presenceStatus === 'lunch') {
    user.presenceStatus = 'active';
    user.presenceAt     = now;
    saveAuthUsers(users);
  }

  // Broadcast SSE: presencia restaurada con flag lunchEnded para toast en cliente
  const presenceEvent = JSON.stringify({
    event           : 'presence_changed',
    userId,
    presenceStatus  : 'active',
    presenceAt      : now,
    name            : user.name,
    lunchTimeAllowed: user.lunchTimeAllowed || 60,
    lunchEnded      : true,            // señal para mostrar toast en cliente
  });
  sseClients.forEach(set => set.forEach(r => { try { r.write(`data: ${presenceEvent}\n\n`); } catch {} }));

  // Notificar al usuario que su almuerzo terminó
  createNotification(userId, {
    type   : 'lunch_ended',
    title  : '🍴 Tiempo de almuerzo terminado',
    message: `Tu tiempo de almuerzo (${user.lunchTimeAllowed || 60} min) ha finalizado. Ya estás marcado como disponible.`,
    by     : 'Sistema',
  });

  // Notificar a encargados y admins (excepto al mismo usuario)
  const supervisors = users.filter(u => (u.role === 'manager' || u.role === 'admin') && u.active && u.id !== userId);
  supervisors.forEach(sup => {
    createNotification(sup.id, {
      type   : 'lunch_ended',
      title  : '🍴 Almuerzo finalizado',
      message: `${user.name.split(' ')[0]} completó su almuerzo (${user.lunchTimeAllowed || 60} min permitidos)`,
      by     : 'Sistema',
    });
  });
}

/**
 * Al arrancar el servidor: cierra breaks que quedaron abiertos
 * y programa timers para los que todavía no han expirado.
 */
function recoverOpenLunchBreaks() {
  const breaks = loadLunchBreaks();
  const users  = loadAuthUsers();
  let changed  = false;
  breaks.forEach(b => {
    if (b.endTime !== null) return; // ya cerrado
    const user = users.find(u => u.id === b.userId);
    const stillInLunch = user && user.presenceStatus === 'lunch';
    const endMs = new Date(b.startTime).getTime() + b.allowedMinutes * 60 * 1000;

    if (stillInLunch && Date.now() < endMs) {
      // Todavía dentro del tiempo: programar auto-cierre con tiempo restante
      scheduleLunchAutoClose(b.userId, b.startTime, b.allowedMinutes);
    } else {
      // Tiempo ya vencido o usuario no está en lunch: cerrar ahora
      const now          = new Date().toISOString();
      b.endTime          = now;
      b.totalMinutes     = Math.round((new Date(now) - new Date(b.startTime)) / 60000);
      b.exceededMinutes  = Math.max(0, b.totalMinutes - b.allowedMinutes);
      b.compliant        = b.exceededMinutes === 0;
      // Restaurar presencia si el usuario sigue marcado como lunch
      if (user && user.presenceStatus === 'lunch') {
        const uIdx = users.findIndex(u => u.id === b.userId);
        users[uIdx].presenceStatus = 'active';
        users[uIdx].presenceAt     = now;
      }
      changed = true;
    }
  });
  if (changed) {
    saveLunchBreaks(breaks);
    saveAuthUsers(users);
  }
}

// Chequear tareas vencidas y generar notificaciones (máx 1 por tarea por día)
function checkOverdueTasks() {
  const today = new Date().toISOString().slice(0,10);
  const tasks = loadWwpTasks();
  const existing = loadNotifications();
  const sentToday = new Set(
    existing.filter(n => n.type==='task_overdue' && (n.createdAt||'').startsWith(today))
            .map(n => n.relatedTaskId)
  );
  tasks.filter(t =>
    t.dueDate && t.dueDate < today &&
    !['completed','validated'].includes(t.status) &&
    !t.parentId &&
    !sentToday.has(t.id)
  ).forEach(t => {
    const recipients = [t.managerId, odooStrToAuthId(t.assignedTo)].filter(Boolean);
    notifyMany([...new Set(recipients)], {
      type:'task_overdue',
      title:'⚠️ Tarea vencida',
      message:`"${t.title}" venció el ${t.dueDate}`,
      relatedTaskId:t.id, priority:t.priority, dueDate:t.dueDate
    });
  });
}

// ── Estado de sesión Odoo ────────────────────────────────────────────────────
let odooUid  = null;
let authBusy = false;
const authQueue = [];

// ── JSON-RPC helper ──────────────────────────────────────────────────────────
function odooRpc(endpoint, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: Date.now(), method: 'call', params
    });
    const parsed   = new url.URL(odooOrigin + endpoint);
    const options  = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.data?.message || JSON.stringify(json.error)));
          else resolve(json.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Autenticar con Odoo ──────────────────────────────────────────────────────
async function authenticate() {
  const uid = await odooRpc('/jsonrpc', {
    service: 'common', method: 'authenticate',
    args: [ODOO_DB, ODOO_USER, ODOO_KEY, {}]
  });
  if (!uid) throw new Error('Credenciales incorrectas — uid no recibido');
  odooUid = uid;
  return uid;
}

// ── execute_kw wrapper ───────────────────────────────────────────────────────
async function odooCall(model, method, args, kwargs = {}) {
  if (!odooUid) await authenticate();
  return odooRpc('/jsonrpc', {
    service: 'object', method: 'execute_kw',
    args: [ODOO_DB, odooUid, ODOO_KEY, model, method, args, kwargs]
  });
}

// ── MIME types básicos ───────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Leer body JSON de una request (con límite de tamaño) ────────────────────
const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50 MB máximo por request
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        return reject(new Error('Solicitud demasiado grande (máx 50 MB)'));
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── Google Sheets — CSV público ──────────────────────────────────────────────
const SHEETS_ID  = '1UXWSVXlW5zRjlYjYBEjYePNnGB1Rk_4f';
const SHEETS_URL = `https://docs.google.com/spreadsheets/d/${SHEETS_ID}/export?format=csv`;
const SHEETS_TTL = 5 * 60 * 1000; // 5 minutos de caché
let sheetsCache    = null;
let sheetsCacheTime = 0;

/** Fetch con seguimiento de redirecciones */
function fetchText(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(urlStr);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0 DashboardDespachos/1.0' }
    };
    https.get(opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/** Parser CSV simple con soporte de comillas */
function parseCSVLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inQ)          { inQ = true; }
    else if (c === '"' && inQ)      { if (line[i+1] === '"') { cur += '"'; i++; } else { inQ = false; } }
    else if (c === ',' && !inQ)     { out.push(cur); cur = ''; }
    else                            { cur += c; }
  }
  out.push(cur);
  return out;
}

/** "Monday, March 02, 2026" → "02/03/2026" */
function fmtGSDate(s) {
  if (!s) return '';
  const M = {January:1,February:2,March:3,April:4,May:5,June:6,July:7,August:8,September:9,October:10,November:11,December:12};
  const m = s.match(/\w+,\s+(\w+)\s+(\d+),\s+(\d+)/);
  if (!m) return s;
  return `${String(parseInt(m[2])).padStart(2,'0')}/${String(M[m[1]]||1).padStart(2,'0')}/${m[3]}`;
}

/**
 * Extrae la clave numérica canónica de un número de orden.
 * Maneja: "S09115", "S9115", "SO9115", "s09115", "9115", "  S0 9115 " → "9115"
 * Paso 1: quitar espacios
 * Paso 2: quitar letras iniciales (S, O, o cualquier letra)
 * Paso 3: quitar ceros iniciales
 */
function canonicKey(raw) {
  return (raw || '').trim()
    .replace(/^[A-Za-z]+/, '')   // quita letras iniciales (S, SO, s, etc.)
    .replace(/^0+/, '')           // quita ceros iniciales
    || (raw || '').trim().toUpperCase(); // fallback si el resultado está vacío
}

/** Obtiene datos de Sheets (con caché TTL) */
async function getSheetsData() {
  const now = Date.now();
  if (sheetsCache && (now - sheetsCacheTime) < SHEETS_TTL) return sheetsCache;

  const csv  = await fetchText(SHEETS_URL);
  const lines = csv.split('\n').filter(l => l.trim());
  if (!lines.length) throw new Error('Sheets CSV vacío');

  const headers = parseCSVLine(lines[0]);
  const idx = {};
  headers.forEach((h, i) => idx[h.trim()] = i);

  const data = {};
  let rowsProcessed = 0;

  lines.slice(1).forEach(line => {
    const v = parseCSVLine(line);
    const get = col => (v[idx[col]] || '').trim();
    const rawKey = get('No. Orden');
    if (!rawKey) return;

    const record = {
      tipoMov:       get('Tipo de Movimiento'),
      cliente:       get('Nombre Cliente'),
      ciudad:        get('Ciudades'),
      lugarEntrega:  get('Lugar de Entrega'),
      fSolicitada:   fmtGSDate(get('Fecha Solicitada')),
      fEntrega:      fmtGSDate(get('Fecha de Entrega')),
      vendedor:      get('VENDEDOR'),
      diasPrep:      parseInt(get('Dias de preparacion'))  || 0,
      diasRest:      parseInt(get('Dias Restantes'))       || 0,
      instalacion:   get('Lleva instalacion?'),
      horario:       get('Horario de Entrega'),
      origen:        get('LUGAR DE DESPACHO'),
      prioridad:     get('Prioridad'),
      articulos:     parseInt(get('Cantidad de Articulos')) || 0,
      vehiculo:      get('Vehículo'),
      transporte:    get('Tipo de Transporte'),
      estatus:       get('estatus'),
      comentario:    get('Comentario'),
      artAdicionales:parseInt(get('Articulos Adicionales')) || 0
    };

    // El campo No. Orden puede contener múltiples órdenes separadas por espacios
    // Ej: "S08011 S08723" → registrar ambas con el mismo registro de despacho
    const rawParts = rawKey.split(/\s+/).filter(Boolean);
    rowsProcessed++;

    rawParts.forEach(part => {
      const num = canonicKey(part); // clave numérica: "9115"
      // Indexar bajo todas las variantes que puedan usarse como búsqueda:
      data[part]          = record; // original: "S09115"
      if (num !== part)   data[num] = record; // numérico: "9115"
    });
  });

  sheetsCache    = data;
  sheetsCacheTime = now;
  return data;
}

// ── Google Sheets — Control de Contenedores ──────────────────────────────────
const CONT_SHEETS_ID  = process.env.CONT_SHEETS_ID  || '';
const CONT_SHEETS_GID = process.env.CONT_SHEETS_GID || '0';
const CONT_SHEETS_URL = CONT_SHEETS_ID
  ? `https://docs.google.com/spreadsheets/d/${CONT_SHEETS_ID}/export?format=csv&gid=${CONT_SHEETS_GID}`
  : '';
const CONT_TTL = 5 * 60 * 1000;
let contCache     = null;
let contCacheTime = 0;

/** Mapa flexible de encabezados CSV → campo interno
 *  Las claves ya deben estar en minúsculas y SIN tildes (como las procesa stripAccents).
 *  También se incluyen variantes con tildes por si el raw match funciona primero. */
const CONT_COL_MAP = {
  // ── EXP / PO ──────────────────────────────────────────────────────────────
  'exp / po':'exp','exp/po':'exp','expediente':'exp','exp':'exp','po':'exp',
  // ── Proveedor ──────────────────────────────────────────────────────────────
  'proveedor':'proveedor','supplier':'proveedor',
  // ── Descripción del Embarque ───────────────────────────────────────────────
  'embarque':'embarque',
  'descripcion del embarque':'embarque','descripcion embarque':'embarque',
  // ── No de Orden Odoo ───────────────────────────────────────────────────────
  'no de orden odoo':'noOrdenOdoo','no orden odoo':'noOrdenOdoo','no. orden odoo':'noOrdenOdoo',
  'orden odoo':'noOrdenOdoo','numero orden odoo':'noOrdenOdoo','num orden odoo':'noOrdenOdoo',
  'oc odoo':'noOrdenOdoo','orden compra odoo':'noOrdenOdoo','ordenes compra':'noOrdenOdoo','oc':'noOrdenOdoo',
  // ── País de Origen ─────────────────────────────────────────────────────────
  'origen':'origen','origin':'origen',
  'pais de origen':'origen','pais origen':'origen',
  // ── Método de Envío ────────────────────────────────────────────────────────
  'metodo':'metodo','metodo transporte':'metodo','method':'metodo',
  'metodo de envio':'metodo',
  'metodo de envio (maritimo/aereo)':'metodo',
  // ── Fecha de Salida ────────────────────────────────────────────────────────
  'f. salida':'fSalida','fecha salida':'fSalida','fsalida':'fSalida','salida':'fSalida',
  'fecha de salida':'fSalida',
  // ── Fecha Estimada de Llegada ──────────────────────────────────────────────
  'f. est. llegada':'fEst','fecha estimada':'fEst','eta':'fEst','fecha eta':'fEst','estimada':'fEst',
  'fecha estimada de llegada':'fEst',
  // ── Fecha de Llegada Real ──────────────────────────────────────────────────
  'f. real':'fReal','fecha real':'fReal','freal':'fReal','llegada real':'fReal',
  'fecha de llegada real':'fReal',
  // ── Días en Tránsito ───────────────────────────────────────────────────────
  'dias tr.':'diasTr','dias tr':'diasTr',
  'dias transito':'diasTr','dias en transito':'diasTr',
  // ── Días Restantes ─────────────────────────────────────────────────────────
  'dias rest.':'diasRest','dias rest':'diasRest',
  'dias restantes':'diasRest','dias restantes de llegada':'diasRest',
  // ── Localidad de Entrega ───────────────────────────────────────────────────
  'localidad':'localidad','localidad de entrega':'localidad',
  // ── Etapas (booleanos) ─────────────────────────────────────────────────────
  'en transito':'enTransito','transito':'enTransito',
  'llego al pais':'llego','llego':'llego',
  'pago impuestos':'pagoImp','aduana':'pagoImp','pago imp.':'pagoImp','pago imp':'pagoImp',
  'pago de impuestos':'pagoImp',
  'cita entrega':'citaEnt','cita':'citaEnt','citaent':'citaEnt','cita de entrega':'citaEnt',
  'recibido almacen':'recAlm','recibido':'recAlm','recalm':'recAlm',
  'recibido en almacen':'recAlm',
  // ── Responsable / Comentarios ──────────────────────────────────────────────
  'responsable':'responsable',
  'comentarios':'comentario','comentario':'comentario',
};

function parseBool(v) {
  const s = (v || '').toString().trim().toUpperCase();
  return s === 'TRUE' || s === 'SI' || s === 'SÍ' || s === 'X' || s === 'VERDADERO' || s === '1' || s === 'YES';
}

/** Normaliza texto quitando tildes para comparar encabezados */
function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Convierte fecha M/D/YYYY o MM/DD/YYYY → DD/MM/YYYY */
function parseMDYDate(s) {
  if (!s) return '';
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return s;
  return `${m[2].padStart(2,'0')}/${m[1].padStart(2,'0')}/${m[3]}`;
}

/** Lee y parsea un CSV de contenedores (string) → array de objetos */
function parseContCSV(csv) {
  const lines = csv.split('\n').filter(l => l.trim());
  if (!lines.length) throw new Error('CSV vacío');

  // ── Auto-detectar fila de encabezados ────────────────────────────────────
  // El Excel tiene: fila 1 = nota "Llenar con x", fila 2 = encabezados reales
  // Buscamos la primera fila (entre las 5 primeras) que tenga ≥ 3 columnas reconocidas
  let headerLineIdx = 0;
  let headerMap = {};

  for (let li = 0; li < Math.min(5, lines.length); li++) {
    const cols = parseCSVLine(lines[li]);
    const testMap = {};
    let hits = 0;
    cols.forEach((h, i) => {
      const raw  = h.trim().toLowerCase();
      const norm = stripAccents(raw);
      const field = CONT_COL_MAP[raw] || CONT_COL_MAP[norm];
      if (field) { testMap[i] = field; hits++; }
    });
    if (hits >= 3) {
      headerLineIdx = li;
      headerMap = testMap;
      break;
    }
  }

  if (!Object.keys(headerMap).length) {
    throw new Error('No se pudo identificar la fila de encabezados en el CSV. Verifica el formato del archivo.');
  }

  const BOOL_FIELDS = ['enTransito','llego','pagoImp','citaEnt','recAlm'];
  const NUM_FIELDS  = ['diasTr','diasRest'];
  const DATE_FIELDS = ['fSalida','fEst','fReal'];

  return lines.slice(headerLineIdx + 1).map(line => {
    const v   = parseCSVLine(line);
    const rec = {};
    Object.keys(headerMap).forEach(i => {
      const f   = headerMap[i];
      const val = (v[parseInt(i)] || '').trim();
      if (BOOL_FIELDS.includes(f))      rec[f] = parseBool(val);
      else if (NUM_FIELDS.includes(f))  rec[f] = val === '' ? null : (parseInt(val) || 0);
      else if (DATE_FIELDS.includes(f)) rec[f] = parseMDYDate(val);
      else                              rec[f] = val;
    });
    if (!rec.exp) return null;
    return rec;
  }).filter(Boolean);
}

const LOCAL_CSV          = path.join(__dirname, 'contenedores.csv');
const LOCAL_CSV_PROYECTO = path.join(__dirname, '..', '..', '..', 'contenedores.csv');
const LOCAL_CSV_DATA     = path.join(DATA_DIR, 'contenedores.csv');   // disco persistente Render

async function getContainerData() {
  const now = Date.now();
  if (contCache && (now - contCacheTime) < CONT_TTL) return contCache;

  let csv    = null;
  let source = '';

  // 1️⃣  Google Sheets (si CONT_SHEETS_ID está configurado)
  if (CONT_SHEETS_URL) {
    try {
      csv    = await fetchText(CONT_SHEETS_URL);
      source = 'Google Sheets';
    } catch (e) {
      console.warn(`⚠️  Error leyendo Sheets: ${e.message}`);
    }
  }

  // 2️⃣  Disco persistente Render (/data/contenedores.csv) — sobrevive deploys
  if (!csv && fs.existsSync(LOCAL_CSV_DATA)) {
    csv    = fs.readFileSync(LOCAL_CSV_DATA, 'utf-8');
    source = 'contenedores.csv (disco persistente)';
  }

  // 3️⃣  Archivo local junto al servidor (dev)
  if (!csv && fs.existsSync(LOCAL_CSV)) {
    csv    = fs.readFileSync(LOCAL_CSV, 'utf-8');
    source = 'contenedores.csv (local)';
  }

  // 4️⃣  Fallback: contenedores.csv en la carpeta raíz del proyecto
  if (!csv && fs.existsSync(LOCAL_CSV_PROYECTO)) {
    csv    = fs.readFileSync(LOCAL_CSV_PROYECTO, 'utf-8');
    source = 'contenedores.csv (proyecto)';
  }

  if (!csv) {
    throw new Error(
      'No hay fuente de datos configurada. ' +
      'Opciones: (A) agrega CONT_SHEETS_ID en .env.txt, ' +
      'o (B) sube contenedores.csv al disco persistente (/data/) vía Render Shell.'
    );
  }

  const data = parseContCSV(csv);
  contCache     = data;
  contCacheTime = now;
  return data;
}

// ── Servidor HTTP ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed  = url.parse(req.url, true);
  const reqPath = parsed.pathname;

  // ── CORS restrictivo ────────────────────────────────────────────────────────
  const _allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const _reqOrigin     = req.headers['origin'] || '';
  const _originOk      = !_reqOrigin                              // misma origen
    || _reqOrigin.startsWith('http://localhost')                  // desarrollo local
    || _reqOrigin.startsWith('http://127.0.0.1')
    || (_allowedOrigin && _reqOrigin === _allowedOrigin);         // producción
  res.setHeader('Access-Control-Allow-Origin', _originOk ? (_reqOrigin || '*') : 'null');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // ── Headers de seguridad ────────────────────────────────────────────────────
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' https://altritempi.odoo.com https://docs.google.com https://sheets.googleapis.com; " +
    "frame-ancestors 'self'; " +
    "base-uri 'self'; " +
    "form-action 'self'"
  );
  if (req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Rate limit por IP en rutas de API costosas ───────────────────────────────
  const _ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (reqPath.startsWith('/api/') && checkIpRateLimit(reqPath, _ip)) {
    res.writeHead(429, {'Content-Type': 'application/json', 'Retry-After': '60'});
    res.end(JSON.stringify({ ok: false, error: 'Demasiadas solicitudes. Espera un momento.' }));
    return;
  }

  // ── /api/odoo/auth — verificar conexión (cualquier usuario autenticado) ──────
  // Los encargados/auxiliares también necesitan saber si Odoo está en línea
  // (crean tareas con datos de Odoo). No expone datos: solo dice si conecta.
  if (reqPath === '/api/odoo/auth' && req.method === 'GET') {
    const _jpOdoo = requireJwt(req, res); if (!_jpOdoo) return;
    try {
      if (!odooUid) await authenticate();
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: true, connected: true }));
    } catch (e) {
      res.writeHead(502, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /api/health — validar conexión con Odoo y Google Sheets ─────────────
  if (reqPath === '/api/health' && req.method === 'GET') {
    const health = {
      timestamp: new Date().toISOString(),
      mode: 'live',
      odoo: { ok: false, source: 'Odoo', error: null, uid: null, db: ODOO_DB, user: ODOO_USER, url: ODOO_URL },
      sheets: { ok: false, source: 'Google Sheets', error: null, rows: 0 },
      contenedores: {
        ok: false,
        source: CONT_SHEETS_URL ? 'Google Sheets' : (fs.existsSync(LOCAL_CSV) ? 'contenedores.csv' : 'sin fuente'),
        error: null,
        rows: 0
      }
    };

    try {
      if (!odooUid) await authenticate();
      health.odoo.ok = true;
      health.odoo.uid = odooUid;
    } catch (e) {
      health.odoo.error = e.message;
    }

    try {
      const data = await getSheetsData();
      health.sheets.ok = true;
      health.sheets.rows = Object.keys(data || {}).length;
    } catch (e) {
      health.sheets.error = e.message;
    }

    try {
      const cont = await getContainerData();
      health.contenedores.ok = true;
      health.contenedores.rows = Array.isArray(cont) ? cont.length : 0;
    } catch (e) {
      health.contenedores.error = e.message;
    }

    health.allOk = health.odoo.ok && health.sheets.ok && health.contenedores.ok;

    // Siempre 200 — Render usa este endpoint para health check y un 502 aquí
    // haría que Render considere el servicio caído aunque el servidor esté corriendo.
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(health));
    return;
  }

  // ── /api/smoke-test — Pruebas de funcionalidad básica ─────────────────
  if (reqPath === '/api/smoke-test' && req.method === 'GET') {
    const tests = [];

    // Test 1: Odoo real
    try {
      if (!odooUid) await authenticate();
      tests.push({ name: 'Odoo', passed: true, detail: `EN VIVO · uid ${odooUid}` });
    } catch (e) {
      tests.push({ name: 'Odoo', passed: false, detail: e.message });
    }

    // Test 2: Sheets real
    try {
      const data = await getSheetsData();
      tests.push({ name: 'Google Sheets principal', passed: true, detail: `EN VIVO · ${Object.keys(data || {}).length} claves` });
    } catch (e) {
      tests.push({ name: 'Google Sheets principal', passed: false, detail: e.message });
    }

    // Test 3: Control de contenedores
    try {
      const data = await getContainerData();
      const source = CONT_SHEETS_URL ? 'Google Sheets' : 'contenedores.csv';
      tests.push({ name: 'Control de contenedores', passed: true, detail: `EN VIVO · ${source} · ${data.length} registros` });
    } catch (e) {
      tests.push({ name: 'Control de contenedores', passed: false, detail: e.message });
    }

    // Test 4: Averías persistencia
    const averiasExist = fs.existsSync(AVERIAS_FILE);
    tests.push({ name: 'Archivo averias.json', passed: averiasExist, detail: averiasExist ? 'OK' : 'No existe' });

    // Test 5: Carpeta fotos
    const fotosExist = fs.existsSync(AV_FOTOS_DIR);
    tests.push({ name: 'Carpeta av-fotos', passed: fotosExist, detail: fotosExist ? 'OK' : 'No existe' });

    // Test 6: Variables de entorno
    const envOk = ODOO_URL && ODOO_DB && ODOO_USER && ODOO_KEY;
    tests.push({ name: 'Variables de entorno Odoo', passed: envOk, detail: envOk ? 'OK' : 'Faltan credenciales' });

    const passed = tests.filter(t => t.passed).length;
    const total = tests.length;
    const allOk = passed === total;

    res.writeHead(allOk ? 200 : 502, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: `${passed}/${total} tests pasados`,
      allOk,
      tests,
      version: '2.0',
      mode: 'live',
      port: PORT,
      environment: {
        node: process.version,
        uptime: Math.round(process.uptime()),
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
      }
    }));
    return;
  }
  // ── /api/odoo — llamada genérica ─────────────────────────────────────────
  if (reqPath === '/api/odoo' && req.method === 'POST') {
    try {
      const body   = await readBody(req);
      const { model, method, args = [[]], kwargs = {} } = body;
      if (!model || !method) throw new Error('Faltan campos: model, method');
      const result = await odooCall(model, method, args, kwargs);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      if (e.message?.includes('Access Denied') || e.message?.includes('uid')) {
        odooUid = null; // forzar re-auth en próxima llamada
      }
      res.writeHead(502, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /api/sheets — datos en vivo de Google Sheets (despachos) ───────────
  if (reqPath === '/api/sheets' && req.method === 'GET') {
    try {
      const data = await getSheetsData();
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: true, result: data, ts: sheetsCacheTime }));
    } catch (e) {
      res.writeHead(502, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /api/sheets/contenedores — Control de Contenedores ─────────────────
  if (reqPath === '/api/sheets/contenedores' && req.method === 'GET') {
    try {
      const data = await getContainerData();
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: true, result: data, ts: contCacheTime }));
    } catch (e) {
      res.writeHead(502, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── GET /api/products/search?q= — búsqueda global de productos en Odoo ──
  if (reqPath.startsWith('/api/products/search') && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const qs    = url.parse(req.url, true).query;
      const q     = (qs.q || '').trim();
      const limit = Math.min(parseInt(qs.limit || '30', 10), 100);
      if (!q) return sendJson(res, 200, { ok: true, items: [] });

      // Buscar en product.product por nombre, barcode y referencia interna
      // Solo productos con stock positivo
      const domain = ['&',
        ['qty_available', '>', 0],
        ['|', '|',
          ['name', 'ilike', q],
          ['barcode', 'ilike', q],
          ['default_code', 'ilike', q],
        ],
      ];
      const products = await odooCall('product.product', 'search_read',
        [domain],
        { fields: ['id', 'name', 'barcode', 'default_code', 'qty_available', 'uom_id'], limit }
      );

      const items = products.map(p => ({
        id:       p.id,
        name:     p.name     || '',
        barcode:  p.barcode  || '',
        ref:      p.default_code || '',
        qty:      p.qty_available || 0,
        uom:      p.uom_id ? p.uom_id[1] : '',
      }));

      return sendJson(res, 200, { ok: true, items, total: items.length });
    } catch(e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── /api/analysis/localities — ubicaciones internas de Odoo ─────────────
  if (reqPath === '/api/analysis/localities' && req.method === 'GET') {
    try {
      const locs = await odooCall('stock.location', 'search_read',
        [[['usage', '=', 'internal'], ['active', '=', true]]],
        { fields: ['id', 'name', 'complete_name'], limit: 500 }
      );
      locs.sort((a, b) => a.complete_name.localeCompare(b.complete_name));
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: true, locations: locs }));
    } catch (e) {
      res.writeHead(502, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /api/analysis/reposicion — artículos en almacén sin stock en showroom ──
  if (reqPath === '/api/analysis/reposicion' && req.method === 'GET') {
    const _jpR = requireJwt(req, res); if (!_jpR) return;
    const showroomId = parseInt(parsed.query.showroom || 0);
    if (!showroomId) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: 'Se requiere showroom' }));
      return;
    }

    // ── Caché: devolver resultado guardado si es fresco y no se pidió refresh ──
    const _cacheKey    = String(showroomId);
    const _forceRefresh = parsed.query.refresh === '1';
    const _cached = _repoCache.get(_cacheKey);
    if (!_forceRefresh && _cached && (Date.now() - _cached.ts) < REPO_CACHE_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(_cached.json);
      return;
    }

    let _step = 'init';
    try {
      // ── BATCH 1: 4 llamadas independientes en paralelo ───────────────────────
      // loc-read, loc-list, quants y categories no se bloquean entre sí
      _step = 'batch1';
      const [srLocInfo, allLocs, allQuants, allCategs] = await Promise.all([
        odooCall('stock.location', 'read',
          [[showroomId]], { fields: ['id', 'complete_name'] }),
        odooCall('stock.location', 'search_read',
          [[['usage', '=', 'internal']]], { fields: ['id', 'complete_name'], limit: 1000 }),
        odooCall('stock.quant', 'search_read',
          [[['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]],
          { fields: ['product_id', 'location_id', 'quantity', 'reserved_quantity'], limit: 10000 }),
        odooCall('product.category', 'search_read',
          [[]], { fields: ['id', 'name', 'parent_id'], limit: 500 })
      ]);

      // Validar showroom
      const srBase = (srLocInfo[0]?.complete_name || '').trim();
      if (!srBase) throw new Error('Showroom no encontrado (id=' + showroomId + ')');

      // Calcular qty disponible (qty_on_hand - reserved)
      allQuants.forEach(q => {
        q._availQty = Math.max(0, q.quantity - (q.reserved_quantity || 0));
      });

      // Mapa locId → complete_name
      const locNameMap = {};
      allLocs.forEach(l => { locNameMap[l.id] = l.complete_name; });

      // Etiqueta de almacén
      function almLabel(cn) {
        if (!cn) return '—';
        if (/A-CDP/i.test(cn))          return 'CDP';
        if (/D-PTN/i.test(cn))          return 'PTN';
        if (/B-STI/i.test(cn))          return 'STI';
        if (/OUTLET|NAC\b/i.test(cn))   return 'OUTLET';
        if (/OUT27/i.test(cn))          return 'OUT27';
        const parts = cn.split('/').map(s => s.trim()).filter(Boolean);
        return parts[1] || parts[0] || '—';
      }

      // Sets de ubicaciones
      const srLocSet = new Set(allLocs.filter(l => l.complete_name.startsWith(srBase)).map(l => l.id));
      const srLocIds = [...srLocSet];
      const obsLocSet = new Set(allLocs.filter(l => /obsoleto/i.test(l.complete_name)).map(l => l.id));
      const ptnLocSet = new Set(allLocs.filter(l => /D-PTN/i.test(l.complete_name)).map(l => l.id));
      const recepcionLocSet = new Set(allLocs.filter(l => /recepci[oó]n|embarque/i.test(l.complete_name)).map(l => l.id));
      const cdpLocSet = new Set(allLocs.filter(l => {
        const cn = l.complete_name || '';
        return almLabel(cn) === 'CDP' && !/obsoleto/i.test(cn) && !/devoluci[oó]n/i.test(cn);
      }).map(l => l.id));

      const EXCLUDED_ALM_LABELS = new Set([
        'DIF.PTN', 'Existencias', 'MICHELL II',
        'MONTIBELLO NACO', 'Stam House', 'Stock',
        'MONTIBELLO PTN-LOB1', 'MONTIBELLO PTN-LOB2', 'MONTIBELLO PTN-LOB3',
        'MONTIBELLO PTN-LOB4', 'MONTIBELLO PTN-LOB5'
      ]);

      // Acumular stock por producto
      const almMap = {}, prodLocMap = {}, srMap = {}, cdpMap = {};
      const _unknownLocs = new Set(); // ubicaciones sin etiqueta reconocida (diagnóstico)
      allQuants.forEach(q => {
        const lid = q.location_id[0];
        const avail = q._availQty;
        if (srLocSet.has(lid)) {
          srMap[q.product_id[0]] = (srMap[q.product_id[0]] || 0) + q.quantity;
          return;
        }
        if (obsLocSet.has(lid) || ptnLocSet.has(lid) || recepcionLocSet.has(lid)) return;
        const cn  = locNameMap[lid] || (Array.isArray(q.location_id) ? q.location_id[1] : '') || '';
        const lbl = almLabel(cn);
        if (EXCLUDED_ALM_LABELS.has(lbl) || /^MONTIBELLO\s+PTN/i.test(lbl) || /MONTIBELLO.*PTN/i.test(cn)) return;
        if (avail <= 0) return;
        // Ignorar ubicaciones sin etiqueta reconocida para evitar el grupo "—"
        if (lbl === '—') { _unknownLocs.add(cn || `id:${lid}`); return; }
        const pid = q.product_id[0];
        almMap[pid] = (almMap[pid] || 0) + avail;
        if (!prodLocMap[pid]) prodLocMap[pid] = [];
        const ex = prodLocMap[pid].find(x => x.cn === cn);
        if (ex) ex.qty += avail; else prodLocMap[pid].push({ cn, alm: lbl, qty: avail });
        if (cdpLocSet.has(lid)) cdpMap[pid] = (cdpMap[pid] || 0) + avail;
      });

      const targetIds = Object.keys(almMap).map(Number).filter(pid => !(srMap[pid] > 0));
      if (!targetIds.length) {
        const empty = JSON.stringify({ ok: true, items: [], total: 0 });
        _repoCache.set(_cacheKey, { json: empty, ts: Date.now() });
        res.writeHead(200, {'Content-Type': 'application/json'}); res.end(empty); return;
      }

      // Categorías (ya llegaron del BATCH 1)
      const MUEBLES_ID = 53;
      const categMap = {};
      allCategs.forEach(c => { categMap[c.id] = c; });
      function getFamilia(categId) {
        if (!categId || !categMap[categId]) return null;
        let cur = categMap[categId], prev = null;
        while (cur.parent_id && categMap[cur.parent_id[0]]) {
          prev = cur; cur = categMap[cur.parent_id[0]];
          if (cur.id === MUEBLES_ID) return prev.name;
        }
        if (cur.id === MUEBLES_ID) return categMap[categId]?.name || null;
        return null;
      }

      // ── BATCH 2: products + moves-to + moves-from en paralelo ───────────────
      _step = 'batch2';
      const [prodsRaw, movesTo, movesFrom] = await Promise.all([
        odooCall('product.product', 'search_read',
          [[['id', 'in', targetIds]]],
          { fields: ['id', 'default_code', 'name', 'barcode', 'image_128', 'categ_id'], limit: 5000 }),
        srLocIds.length ? odooCall('stock.move', 'search_read',
          [[['product_id', 'in', targetIds], ['state', '=', 'done'], ['location_dest_id', 'in', srLocIds]]],
          { fields: ['product_id', 'date'], limit: 5000, order: 'date desc' }) : Promise.resolve([]),
        srLocIds.length ? odooCall('stock.move', 'search_read',
          [[['product_id', 'in', targetIds], ['state', '=', 'done'], ['location_id', 'in', srLocIds]]],
          { fields: ['product_id', 'date'], limit: 5000, order: 'date desc' }) : Promise.resolve([])
      ]);
      const prods = prodsRaw; // mutable — kit parents se agregan abajo

      // ── BATCH 3: padres kit (depende de prods) ───────────────────────────────
      _step = 'parent-lookup';
      {
        const _pr3 = /^(\d)(\d)(\d)\.(.+)$/, _pr2 = /^(\d)(\d)\.(.+)$/;
        const _pSet = new Set();
        prods.forEach(p => {
          const m3 = _pr3.exec(p.barcode || '');
          if (m3) {
            _pSet.add(m3[1] + '0'   + m3[3] + '.' + m3[4]);
            _pSet.add(m3[1] + m3[2] + '0'   + '.' + m3[4]);
            _pSet.add(m3[1] + '00.' + m3[4]);
          } else {
            const m2 = _pr2.exec(p.barcode || '');
            if (m2) _pSet.add('0' + m2[2] + '.' + m2[3]);
          }
        });
        const _existBcs = new Set(prods.map(p => p.barcode || '').filter(Boolean));
        const _missing  = [..._pSet].filter(bc => bc && !_existBcs.has(bc));
        if (_missing.length) {
          const _kitProds = await odooCall('product.product', 'search_read',
            [[['barcode', 'in', _missing]]],
            { fields: ['id', 'default_code', 'name', 'barcode', 'image_128', 'categ_id'], limit: 500 }
          );
          _kitProds.forEach(p => { p._isKitParent = true; prods.push(p); });
        }
      }

      // Último movimiento por producto
      const lastMoveMap = {};
      [...movesTo, ...movesFrom]
        .sort((a, b) => b.date.localeCompare(a.date))
        .forEach(m => { const p = m.product_id[0]; if (!lastMoveMap[p]) lastMoveMap[p] = m.date; });

      // ── PASO 6: construir resultado ──────────────────────────────────────────
      const copiaRx = /\s*\((copia|copy)\)\s*/gi;
      const today = new Date(); today.setHours(0,0,0,0);
      const items = prods.map(p => {
        const raw = lastMoveMap[p.id];
        let ultimaVez = null, diasSin = null;
        if (raw) { ultimaVez = raw.slice(0,10); diasSin = Math.round((today - new Date(ultimaVez)) / 86400000); }
        const locs = (prodLocMap[p.id] || []).sort((a, b) => b.qty - a.qty);
        copiaRx.lastIndex = 0;
        return {
          id:       p.id,
          ref:      p.default_code || '',
          name:     (p.name || '').replace(copiaRx, '').trim(),
          barcode:  p.barcode || '',
          image:    p.image_128 || '',
          qtyAlm:   almMap[p.id] || 0,
          qtyCdp:   cdpMap[p.id] || 0,
          familia:  getFamilia(p.categ_id ? p.categ_id[0] : null),
          almacen:  [...new Set(locs.map(l => l.alm))].join(' · ') || '—',
          ubicacion: locs.map(l => l.cn).join(' · ') || '—',
          ultimaVez, diasSin,
          ...(p._isKitParent ? { isKitParent: true } : {})
        };
      }).filter(item => item.qtyAlm > 0 || item.isKitParent);

      items.sort((a, b) => {
        if (a.diasSin !== null && b.diasSin !== null) return b.diasSin - a.diasSin;
        if (a.diasSin !== null) return -1;
        if (b.diasSin !== null) return 1;
        return (a.name||'').localeCompare(b.name||'');
      });

      // ── BATCH 4: origen de artículos "nunca en showroom" ─────────────────────
      // Solo para los productos con ultimaVez=null. Busca su PRIMER movimiento
      // hacia cualquier ubicación interna para identificar si vino de una OC/embarque
      // o fue una carga inicial del sistema.
      _step = 'batch4-origen';
      {
        const nuncaIds = items.filter(i => i.ultimaVez === null && !i.isKitParent).map(i => i.id);
        if (nuncaIds.length) {
          // Pedimos los primeros moves para cada producto (orden: fecha ASC = más antiguo primero)
          const firstMoves = await odooCall('stock.move', 'search_read', [[
            ['product_id', 'in', nuncaIds],
            ['state', '=', 'done'],
            ['location_dest_id.usage', '=', 'internal']
          ]], { fields: ['product_id', 'date', 'location_id', 'origin'], order: 'date asc', limit: nuncaIds.length * 3 });

          // Quedarnos con el move más antiguo por producto
          const firstMoveByProd = {};
          firstMoves.forEach(m => {
            const pid = m.product_id[0];
            if (!firstMoveByProd[pid]) firstMoveByProd[pid] = m;
          });

          // Clasificar origen según la ubicación de procedencia
          items.forEach(item => {
            if (item.ultimaVez !== null || item.isKitParent) return;
            const m = firstMoveByProd[item.id];
            if (!m) { item.origen = 'desconocido'; return; }

            const locId   = Array.isArray(m.location_id) ? m.location_id[0] : 0;
            const locName = (Array.isArray(m.location_id) ? m.location_id[1] : '') || locNameMap[locId] || '';
            item.primeraEntrada = m.date ? m.date.slice(0, 10) : null;
            item.origenRef      = m.origin || '';

            if (recepcionLocSet.has(locId) || /recepci[oó]n|embarque/i.test(locName)) {
              item.origen = 'embarque';   // vino por un picking de recepción / OC
            } else if (/inventari|ajuste|opening|virtual/i.test(locName)) {
              item.origen = 'inicial';    // carga inicial o ajuste de inventario
            } else {
              item.origen = 'otro';       // transferencia interna, proveedor directo, etc.
            }
          });
        }
      }

      const _meta = {
        cdpLocs: cdpLocSet.size, cdpItems: Object.keys(cdpMap).length,
        recepLocs: recepcionLocSet.size, reservedUsed: true,
        cachedAt: new Date().toISOString(),
        // Ubicaciones ignoradas por no tener etiqueta reconocida (A-CDP, B-STI, etc.)
        // Si aparecen ubicaciones legítimas aquí, hay que agregarlas a almLabel()
        unknownLocs: _unknownLocs.size ? [..._unknownLocs] : undefined
      };
      const _responseJson = JSON.stringify({ ok: true, items, total: items.length, _meta });

      // Guardar en caché
      _repoCache.set(_cacheKey, { json: _responseJson, ts: Date.now() });

      res.writeHead(200, {'Content-Type': 'application/json', 'X-Cache': 'MISS'});
      res.end(_responseJson);
    } catch(e) {
      res.writeHead(502, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: '[' + _step + '] ' + e.message }));
    }
    return;
  }

  // ── /api/analysis/container — comparar artículos PO vs stock.move a ubicación
  if (reqPath === '/api/analysis/container' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { poNumbers, locationId } = body;
      if (!Array.isArray(poNumbers) || !poNumbers.length) throw new Error('poNumbers requerido');
      if (!locationId) throw new Error('locationId requerido');

      // Nombre de la ubicación destino
      const locInfo = await odooCall('stock.location', 'read',
        [[locationId]], { fields: ['id', 'complete_name'] }
      );
      const locationName = locInfo.length ? locInfo[0].complete_name : `Ubicación #${locationId}`;

      // Step 1: productos en las OC (purchase.order.line)
      const cleanPOs = [...new Set(poNumbers.map(p => p.trim()).filter(Boolean))];
      const pos = await odooCall('purchase.order', 'search_read',
        [[['name', 'in', cleanPOs]]],
        { fields: ['id', 'name'], limit: 200 }
      );

      const poProducts = [];
      if (pos.length) {
        const poIds = pos.map(p => p.id);
        const lines = await odooCall('purchase.order.line', 'search_read',
          [[['order_id', 'in', poIds]]],
          { fields: ['product_id', 'product_qty', 'order_id'], limit: 1000 }
        );
        const prodIds = [...new Set(lines.map(l => l.product_id[0]))];
        const prods = prodIds.length ? await odooCall('product.product', 'search_read',
          [[['id', 'in', prodIds]]],
          { fields: ['id', 'default_code', 'name', 'barcode', 'image_128'], limit: 500 }
        ) : [];
        const prodMap = {};
        prods.forEach(p => prodMap[p.id] = {
          ref:     p.default_code || '',
          name:    p.name,
          barcode: p.barcode || '',
          image:   p.image_128 || ''
        });

        const agg = {};
        lines.forEach(l => {
          const pid = l.product_id[0];
          const pm  = prodMap[pid] || {};
          const poName = (pos.find(p => p.id === l.order_id[0]) || {}).name || '';
          if (!agg[pid]) agg[pid] = {
            id: pid,
            ref:     pm.ref  || '',
            name:    pm.name || l.product_id[1] || '',
            barcode: pm.barcode || '',
            image:   pm.image   || '',
            qty: 0,
            posSet: new Set()
          };
          agg[pid].qty += l.product_qty;
          agg[pid].posSet.add(poName);
        });
        Object.values(agg).forEach(a => {
          poProducts.push({
            id: a.id, ref: a.ref, name: a.name,
            barcode: a.barcode, image: a.image,
            qty: a.qty, po: [...a.posSet].join(', ')
          });
        });
      }

      // Limpiar nombres/refs que contengan "(copia)" o "(copy)" — el producto sí
      // se incluye en el análisis pero se muestra con el nombre limpio
      const copiaRegex = /\s*\((copia|copy)\)\s*/gi;
      poProducts.forEach(p => {
        if (copiaRegex.test(p.name || '')) {
          p.name = p.name.replace(copiaRegex, '').trim();
        }
        copiaRegex.lastIndex = 0; // reset flag tras test()
        if (copiaRegex.test(p.ref || '')) {
          p.ref = p.ref.replace(copiaRegex, '').trim();
        }
        copiaRegex.lastIndex = 0;
      });

      // Step 2: identificar componentes de kits (.Cn) y consultar mrp.bom en Odoo
      const kitCompRegex = /^(.+)\.C\d+$/i;
      const componentIds = poProducts
        .filter(p => kitCompRegex.test(p.ref || ''))
        .map(p => p.id);

      const kitInfoMap = {}; // productId -> { ref, name, image, bomId }

      if (componentIds.length) {
        try {
          // Buscar BOMs de tipo 'phantom' (kit) que contengan estos componentes
          const bomLines = await odooCall('mrp.bom.line', 'search_read',
            [[['component_id', 'in', componentIds]]],
            { fields: ['bom_id', 'component_id'], limit: 500 }
          );

          const bomIds = [...new Set(bomLines.map(l => l.bom_id[0]))];

          if (bomIds.length) {
            // Leer los BOMs — filtrar solo los de tipo phantom (kit)
            const boms = await odooCall('mrp.bom', 'read',
              [bomIds],
              { fields: ['id', 'product_id', 'product_tmpl_id', 'type'] }
            );
            const kitBoms = boms.filter(b => b.type === 'phantom');

            if (kitBoms.length) {
              // Obtener info completa del producto kit (imagen, ref, nombre)
              const kitProdIds = kitBoms.map(b => b.product_id ? b.product_id[0] : null).filter(Boolean);
              const kitTmplIds = kitBoms.filter(b => !b.product_id).map(b => b.product_tmpl_id[0]);

              let kitProds = [];
              if (kitProdIds.length) {
                kitProds = await odooCall('product.product', 'search_read',
                  [[['id', 'in', kitProdIds]]],
                  { fields: ['id', 'default_code', 'name', 'image_512', 'image_128', 'product_tmpl_id'], limit: 200 }
                );
              }
              // Fallback: buscar por template si no hay product_id directo
              if (!kitProds.length && kitTmplIds.length) {
                kitProds = await odooCall('product.product', 'search_read',
                  [[['product_tmpl_id', 'in', kitTmplIds]]],
                  { fields: ['id', 'default_code', 'name', 'image_512', 'image_128', 'product_tmpl_id'], limit: 200 }
                );
              }
              // Si aún no hay imagen, buscar en product.template
              const tmplIds = kitProds.filter(k => !k.image_512 && !k.image_128).map(k => k.product_tmpl_id?.[0]).filter(Boolean);
              const tmplImgMap = {};
              if (tmplIds.length) {
                try {
                  const tmpls = await odooCall('product.template', 'read',
                    [tmplIds], { fields: ['id', 'image_512', 'image_128'] }
                  );
                  tmpls.forEach(t => { tmplImgMap[t.id] = t.image_512 || t.image_128 || ''; });
                } catch(_) {}
              }

              const kitProdMap = {};
              kitProds.forEach(k => {
                const img = k.image_512 || k.image_128 || (k.product_tmpl_id ? tmplImgMap[k.product_tmpl_id[0]] : '') || '';
                kitProdMap[k.id] = { ...k, _img: img };
              });

              // Mapear componente -> info del kit via bomLine
              // Usar bomId como clave de agrupación para que todas las piezas del mismo BOM se agrupen juntas
              bomLines.forEach(line => {
                const bom = kitBoms.find(b => b.id === line.bom_id[0]);
                if (!bom) return;
                const kitProdId = bom.product_id ? bom.product_id[0] : null;
                const kp = kitProdId ? kitProdMap[kitProdId] : null;
                if (!kp) return;
                kitInfoMap[line.component_id[0]] = {
                  ref:   kp.default_code || '',
                  name:  kp.name         || '',
                  image: kp._img         || '',
                  bomId: bom.id          // clave única por kit
                };
              });
            }
          }
        } catch(_) { /* si mrp no está instalado o falla, continuar sin kits */ }
      }

      // Adjuntar info del kit a cada componente confirmado por Odoo BOM
      // Solo se asigna kitGroupKey si Odoo confirmó el BOM — sin fallback por código inferido,
      // para que el Step 2b pueda agrupar por barcode cuando Odoo no tenga BOM registrado
      poProducts.forEach(p => {
        if (kitCompRegex.test(p.ref || '')) {
          p.kitBaseCode = (p.ref.match(kitCompRegex) || [])[1] || p.ref;
          if (kitInfoMap[p.id]) {
            // Kit confirmado por BOM de Odoo — usar bomId como clave de grupo
            p.kit = kitInfoMap[p.id];
            p.kitGroupKey = 'bom_' + kitInfoMap[p.id].bomId;
          }
          // Si no hay BOM en Odoo → no asignar kitGroupKey aquí;
          // el Step 2b lo agrupará por barcode (o quedará como individual)
        }
      });

      // Step 2b: agrupar por lógica de barcode [cat][parte][total].[itemID].[empresa]
      // Ejemplo: 114.0059.GVF (parte 1 de 4) y 124.0059.GVF (parte 2 de 4) → mismo set
      {
        const bcPartRegex = /^(\d)(\d)(\d)\.(.+)$/;
        const bcGroups    = {}; // groupKey -> { total, rest, entries[] }

        poProducts.forEach(p => {
          if (p.kitGroupKey) return; // ya agrupado por BOM de Odoo
          const m = bcPartRegex.exec(p.barcode || '');
          if (!m) return;
          const cat = m[1], total = parseInt(m[3]), rest = m[4];
          if (total < 2) return; // pieza única, no aplica
          const key = 'bc_' + cat + m[3] + '.' + rest;
          if (!bcGroups[key]) bcGroups[key] = { total, rest, entries: [] };
          bcGroups[key].entries.push({ p, part: parseInt(m[2]) });
        });

        // grupos sin padre en la OC → guardar para lookup en Step 2c
        const orphanGroups = []; // { derivedBarcode, piecesPs }

        Object.entries(bcGroups).forEach(([key, group]) => {
          group.entries.sort((a, b) => a.part - b.part);

          // Separar padre (part=0) de piezas (part>0)
          const parent     = group.entries.find(e => e.part === 0);
          const pieces     = group.entries.filter(e => e.part > 0);

          // Necesitamos al menos 1 pieza real para formar un set visible
          if (pieces.length < 1) return;
          // Si solo hay 1 pieza y no hay padre, tratarla como individual
          if (pieces.length < 2 && !parent) return;

          // Representante del set: preferir parte=0 (padre), fallback a parte=1
          const rep = parent || pieces.find(e => e.part === 1) || pieces[0];
          const kitImage   = rep.p.image   || '';
          const kitBarcode = rep.p.barcode || group.rest;
          // Nombre legible: usar ref del padre si existe, sino parte más baja
          const kitRef = rep.p.kitBaseCode || rep.p.ref || group.rest;

          // Marcar SOLO las piezas (part>0) como componentes del kit;
          // el padre (part=0) actúa únicamente como cabecera — no aparece como fila
          pieces.forEach(({ p }) => {
            p.kitGroupKey = key;
            p.kit = { ref: kitBarcode, name: kitRef, image: kitImage, isBarcodeSet: true,
                      parentBarcode: parent ? parent.p.barcode : null };
          });
          // Marcar el padre también (para que no quede como fila suelta),
          // pero con una bandera que lo excluya de los componentes
          if (parent) {
            parent.p.kitGroupKey = key;
            parent.p.kit         = { ref: kitBarcode, name: kitRef, image: kitImage,
                                     isBarcodeSet: true, isKitParent: true };
          } else {
            // Sin padre en OC: derivar su barcode (2do dígito → 0) para buscarlo en Odoo
            const piece1 = pieces.find(e => e.part === 1) || pieces[0];
            if (piece1 && piece1.p.barcode) {
              const derivedBarcode = piece1.p.barcode.replace(/^(\d)\d/, '$10');
              orphanGroups.push({ derivedBarcode, piecesPs: pieces.map(e => e.p) });
            }
          }
        });

        // Step 2c: buscar producto padre en Odoo para sets cuyo padre no está en la OC
        if (orphanGroups.length) {
          const barcodes = [...new Set(orphanGroups.map(o => o.derivedBarcode))];
          try {
            const parentProds = await odooCall('product.product', 'search_read',
              [[['barcode', 'in', barcodes]]],
              { fields: ['id', 'default_code', 'name', 'barcode', 'image_128'], limit: 100 }
            );
            const parentByBarcode = {};
            parentProds.forEach(pp => parentByBarcode[pp.barcode] = pp);

            orphanGroups.forEach(({ derivedBarcode, piecesPs }) => {
              const pp = parentByBarcode[derivedBarcode];
              // Usar datos del padre si lo encontramos; si no, al menos mostrar su barcode
              const newRef   = pp ? (pp.barcode        || derivedBarcode) : derivedBarcode;
              const newName  = pp ? (pp.default_code   || pp.name || '') : '';
              const newImage = pp ? (pp.image_128      || '') : '';
              piecesPs.forEach(p => {
                if (!p.kit) return;
                p.kit.ref          = newRef;
                p.kit.parentBarcode = derivedBarcode;
                if (newName)  p.kit.name  = newName;
                if (newImage) p.kit.image = newImage;
              });
            });
          } catch(_) { /* si falla el lookup, quedan con datos de la pieza */ }
        }
      }

      // Step 3: stock.move DONE hacia esa ubicación para esos productos
      const sentProductIds = new Set();
      if (poProducts.length) {
        const poProductIds = poProducts.map(p => p.id);
        const moves = await odooCall('stock.move', 'search_read',
          [[
            ['location_dest_id', '=', locationId],
            ['state', '=', 'done'],
            ['product_id', 'in', poProductIds]
          ]],
          { fields: ['product_id', 'product_uom_qty'], limit: 5000 }
        );
        moves.forEach(m => sentProductIds.add(m.product_id[0]));
      }

      // Step 4: comparar
      const sent    = poProducts.filter(p =>  sentProductIds.has(p.id));
      const notSent = poProducts.filter(p => !sentProductIds.has(p.id));

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({
        ok: true, locationId, locationName,
        posSearched: cleanPOs, posFound: pos.length,
        total: poProducts.length, sent, notSent
      }));
    } catch (e) {
      res.writeHead(502, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /api/transfer/search?q= — buscar transferencias en Odoo ─────────────
  if (reqPath === '/api/transfer/search' && req.method === 'GET') {
    const q = (parsed.query.q || '').trim();
    try {
      const results = q ? await odooCall('stock.picking', 'search_read',
        [[['name', 'ilike', q]]],
        { fields: ['id','name','state','picking_type_id','partner_id','scheduled_date','date_done','origin'], limit: 15, order: 'id desc' }
      ) : [];
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: true, results }));
    } catch(e) {
      res.writeHead(502, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /api/transfer/detail?id=N — detalle + análisis escáner/teclado ───────
  if (reqPath === '/api/transfer/detail' && req.method === 'GET') {
    const pickingId = parseInt(parsed.query.id || '0');
    if (!pickingId) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: 'id requerido' }));
      return;
    }
    try {
      // ── Cabecera de la transferencia ───────────────────────────────────────
      const pickingArr = await odooCall('stock.picking', 'read',
        [[pickingId]],
        { fields: ['id','name','state','picking_type_id','partner_id','scheduled_date','date_done','origin','note','move_type','backorder_id','location_id','location_dest_id'] }
      );
      if (!pickingArr.length) throw new Error('Transferencia no encontrada');
      const picking = pickingArr[0];

      // ── Líneas de movimiento (stock.move.line) ─────────────────────────────
      const moveLines = await odooCall('stock.move.line', 'search_read',
        [[['picking_id', '=', pickingId]]],
        { fields: ['id','product_id','lot_id','lot_name','qty_done','product_uom_qty','result_package_id','package_id'], limit: 500 }
      );

      // ── Demanda planeada (stock.move) ──────────────────────────────────────
      const moves = await odooCall('stock.move', 'search_read',
        [[['picking_id', '=', pickingId], ['state', 'not in', ['draft','cancel']]]],
        { fields: ['id','product_id','product_uom_qty','quantity_done'], limit: 500 }
      );

      // ── Información del producto (barcode, tracking, imagen) ───────────────
      const prodIds = [...new Set([
        ...moveLines.map(l => l.product_id[0]),
        ...moves.map(m => m.product_id[0])
      ])];
      const prods = prodIds.length ? await odooCall('product.product', 'search_read',
        [[['id', 'in', prodIds]]],
        { fields: ['id','default_code','name','barcode','image_128','tracking'], limit: 300 }
      ) : [];
      const prodMap = {};
      prods.forEach(p => prodMap[p.id] = p);

      // ── Agrupar move.line por producto ─────────────────────────────────────
      const linesByProd = {};
      moveLines.forEach(l => {
        const pid = l.product_id[0];
        if (!linesByProd[pid]) linesByProd[pid] = [];
        linesByProd[pid].push(l);
      });

      const moveByProd = {};
      moves.forEach(m => { moveByProd[m.product_id[0]] = m; });

      // ── Estimar método de entrada para transferencias históricas ────────────
      // Odoo no guarda el origen real del input en stock.move.line. Esta lectura
      // infiere por patrón: varias líneas qty=1 sugieren escaneo; una línea con
      // qty_done > 1 sugiere entrada manual/teclado.
      const processedPids = new Set();

      const lines = Object.entries(linesByProd).map(([pidStr, pLines]) => {
        const pid = parseInt(pidStr);
        processedPids.add(pid);
        const prod     = prodMap[pid] || {};
        const move     = moveByProd[pid] || {};
        const hasBarcode = !!(prod.barcode);
        const tracking   = prod.tracking || 'none'; // 'none' | 'lot' | 'serial'
        const demanded   = move.product_uom_qty || 0;
        const totalDone  = pLines.reduce((s, l) => s + (l.qty_done || 0), 0);
        const lineCount  = pLines.length;
        const allQtyOne  = pLines.length > 0 && pLines.every(l => l.qty_done === 1);
        const hasLots    = pLines.some(l => l.lot_id || l.lot_name);

        let method, methodReason, confidence;
        const entryBasis = 'estimated';

        if (!hasBarcode) {
          method = 'teclado';
          methodReason = 'Estimado: el artículo no tiene código de barras en Odoo, por lo que debió procesarse manualmente';
          confidence = 'media';
        } else if (tracking === 'serial') {
          if (allQtyOne && lineCount === Math.round(demanded)) {
            method = 'escaner';
            methodReason = 'Estimado: ' + lineCount + ' líneas individuales con qty=1, patrón típico de escaneo por serie';
            confidence = 'media';
          } else {
            method = 'teclado';
            methodReason = 'Estimado: cantidad realizada no coincide con líneas individuales por serie';
            confidence = 'media';
          }
        } else if (tracking === 'lot' && hasLots && lineCount > 1 && allQtyOne) {
          method = 'escaner';
          methodReason = 'Estimado: ' + lineCount + ' líneas de lote con qty=1, patrón compatible con escaneo';
          confidence = 'media';
        } else if (lineCount > 1) {
          method = 'escaner';
          methodReason = 'Estimado: ' + lineCount + ' líneas separadas para el mismo artículo, patrón compatible con escaneo';
          confidence = 'baja';
        } else if (totalDone > 1 && lineCount === 1) {
          method = 'teclado';
          methodReason = 'Estimado: ' + totalDone + ' unidades realizadas en una sola línea, patrón típico de teclado/manual';
          confidence = 'media';
        } else if (totalDone === 1 && hasBarcode) {
          method = 'ambiguo';
          methodReason = 'Estimado: una sola unidad con código de barras; escáner y teclado son indistinguibles históricamente';
          confidence = 'baja';
        } else {
          method = 'ambiguo';
          methodReason = 'Estimado: no hay patrón suficiente para determinar el método';
          confidence = 'baja';
        }

        return {
          prodId: pid,
          ref:     prod.default_code || '',
          name:    prod.name || '',
          barcode: prod.barcode || '',
          image:   prod.image_128 || '',
          tracking, hasBarcode,
          demanded, totalDone, lineCount,
          lots: pLines.map(l => l.lot_name || (l.lot_id ? l.lot_id[1] : '')).filter(Boolean),
          method, methodReason, confidence, entryBasis,
          diff: Math.round((totalDone - demanded) * 100) / 100
        };
      });

      // Productos planeados no procesados (qty_done = 0)
      moves.forEach(m => {
        const pid = m.product_id[0];
        if (processedPids.has(pid)) return;
        const prod = prodMap[pid] || {};
        lines.push({
          prodId: pid,
          ref:     prod.default_code || '',
          name:    prod.name || m.product_id[1] || '',
          barcode: prod.barcode || '',
          image:   prod.image_128 || '',
          tracking: prod.tracking || 'none',
          hasBarcode: !!(prod.barcode),
          demanded: m.product_uom_qty,
          totalDone: 0,
          lineCount: 0,
          lots: [],
          method: 'pendiente',
          methodReason: 'Artículo no procesado en la transferencia',
          confidence: 'n/a',
          entryBasis: 'not_processed',
          diff: -m.product_uom_qty
        });
      });

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: true, picking, lines }));
    } catch(e) {
      res.writeHead(502, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /api/averias/search?q= — búsqueda incremental de productos (ilike) ──────
  if (reqPath === '/api/averias/search' && req.method === 'GET') {
    const q = (parsed.query.q || '').trim();
    if (q.length < 2) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,results:[]})); return; }
    try {
      // Buscar por barcode exacto primero, luego ilike en referencia y nombre
      const [byBar, byRef, byName] = await Promise.all([
        odooCall('product.product','search_read',
          [[['barcode','ilike',q],['active','=',true]]],
          {fields:['id','default_code','name','barcode','image_128'],limit:5}),
        odooCall('product.product','search_read',
          [[['default_code','ilike',q],['active','=',true]]],
          {fields:['id','default_code','name','barcode','image_128'],limit:5}),
        odooCall('product.product','search_read',
          [[['name','ilike',q],['active','=',true]]],
          {fields:['id','default_code','name','barcode','image_128'],limit:5})
      ]);
      // Deduplicar por id, prioridad: barcode > ref > nombre
      const seen = new Set();
      const results = [];
      for (const p of [...byBar,...byRef,...byName]) {
        if (!seen.has(p.id)) { seen.add(p.id); results.push({id:p.id,ref:p.default_code||'',name:p.name,barcode:p.barcode||'',image:p.image_128||null}); }
        if (results.length >= 8) break;
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,results}));
    } catch(e) { res.writeHead(502,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── /api/averias/lookup?q= — buscar producto en Odoo por barcode o ref ─────
  if (reqPath === '/api/averias/lookup' && req.method === 'GET') {
    const q = (parsed.query.q || '').trim();
    if (!q) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'vacío'})); return; }
    try {
      let prods = await odooCall('product.product','search_read',
        [[['barcode','=',q]]],
        {fields:['id','default_code','name','barcode','image_128','categ_id','list_price'],limit:1});
      if (!prods.length) {
        prods = await odooCall('product.product','search_read',
          [[['default_code','=ilike',q]]],
          {fields:['id','default_code','name','barcode','image_128','categ_id','list_price'],limit:1});
      }
      if (!prods.length) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
      const p = prods[0];
      const quants = await odooCall('stock.quant','search_read',
        [[['product_id','=',p.id],['location_id.usage','=','internal'],['quantity','>',0]]],
        {fields:['location_id','quantity'],limit:8,order:'quantity desc'});
      const location = quants.length ? quants[0].location_id[1] : '—';
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,product:{
        id:p.id, ref:p.default_code||'', name:p.name,
        barcode:p.barcode||'', image:p.image_128||null, location,
        quants:quants.map(q=>({loc:q.location_id[1],qty:q.quantity}))
      }}));
    } catch(e) { res.writeHead(502,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── GET /api/report/dev-cdp — devoluciones de tiendas recibidas en CDP ──────
  // Lógica correcta (verificada contra Odoo real):
  //   Las devoluciones de clientes a CDP usan picking_type_id=6 (ALMACEN VENTAS: Returns)
  //   con location_dest_id=691 (A-CDP/DEVOLUCION).
  //   Para saber si venía de tienda (vs venta CDP), rastreamos:
  //     RET picking → origin → OUT picking → group_id → PICK picking → move.lines → location
  if (reqPath === '/api/report/dev-cdp' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;

    // Detecta tienda a partir del complete_name de la ubicación del PICK
    const STORE_LOC_PATTERNS = [
      { re: /D-PTN/i,         label: 'PTN' },
      { re: /B-STI/i,         label: 'STI' },
      { re: /NAC|OUTLET/i,    label: 'OUTLET' },
      { re: /OUT27/i,         label: 'OUT27' },
      { re: /A-CDP/i,         label: null },   // venta CDP → excluir
    ];
    function storeFromLoc(completeName) {
      if (!completeName) return undefined;
      for (const p of STORE_LOC_PATTERNS) {
        if (p.re.test(completeName)) return p.label; // null = CDP, string = tienda
      }
      return undefined; // desconocido
    }

    try {
      const sinceParam  = parsed.query.since  || '';
      const storeFilter = parsed.query.store  || '';

      // ── Paso 1: RET pickings que llegaron a A-CDP/DEVOLUCION (id=691) ────────
      const retFilter = [['location_dest_id', '=', 691], ['state', '=', 'done']];
      if (sinceParam) retFilter.push(['date_done', '>=', sinceParam + ' 00:00:00']);

      const rets = await odooCall('stock.picking', 'search_read', [retFilter],
        { fields: ['id','name','origin','date_done','partner_id'], limit: 500, order: 'date_done desc' });

      if (!rets.length) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok:true, rows:[], total:0, byStore:{}, retCount:0 }));
        return;
      }

      // ── Paso 2: Extraer referencia OUT del campo origin ─────────────────────
      // origin típico: "Retorno de ALVEN/OUT/06996"
      const retToOutRef = {};
      const outNamesSet = new Set();
      rets.forEach(r => {
        const m = (r.origin || '').match(/ALVEN\/(?:OUT|RET)\/\d+/);
        if (m) { retToOutRef[r.id] = m[0]; outNamesSet.add(m[0]); }
      });

      // ── Paso 3: OUT pickings → group_id ────────────────────────────────────
      const outNames = [...outNamesSet];
      const outs = outNames.length ? await odooCall('stock.picking', 'search_read',
        [[['name', 'in', outNames]]],
        { fields: ['id','name','group_id'], limit: 500 }) : [];

      const outNameToGroup = {};
      const groupIds = new Set();
      outs.forEach(o => {
        if (o.group_id) { outNameToGroup[o.name] = o.group_id[0]; groupIds.add(o.group_id[0]); }
      });

      // ── Paso 4: PICK pickings por group_id ─────────────────────────────────
      const picks = groupIds.size ? await odooCall('stock.picking', 'search_read',
        [[['group_id', 'in', [...groupIds]], ['name', 'like', 'ALVEN/PICK/']]],
        { fields: ['id','name','group_id'], limit: 2000 }) : [];

      const pickToGroup = {};
      picks.forEach(p => { if (p.group_id) pickToGroup[p.id] = p.group_id[0]; });

      // ── Paso 5: Move lines del PICK → ubicación de origen (tienda) ──────────
      const pickIds = picks.map(p => p.id);
      const pickMoveLines = pickIds.length ? await odooCall('stock.move.line', 'search_read',
        [[['picking_id', 'in', pickIds], ['state', '=', 'done']]],
        { fields: ['id','picking_id','location_id'], limit: 5000 }) : [];

      // ── Paso 6: Nombres completos de ubicaciones ────────────────────────────
      const locIds = [...new Set(pickMoveLines.map(ml => ml.location_id[0]))];
      const locs = locIds.length ? await odooCall('stock.location', 'search_read',
        [[['id', 'in', locIds]]],
        { fields: ['id','complete_name'], limit: 500 }) : [];
      const locMap = {};
      locs.forEach(l => locMap[l.id] = l.complete_name);

      // ── Paso 7: group_id → tienda ───────────────────────────────────────────
      const groupToStore = {};
      pickMoveLines.forEach(ml => {
        const gid = pickToGroup[ml.picking_id[0]];
        if (gid === undefined || gid in groupToStore) return;
        const s = storeFromLoc(locMap[ml.location_id[0]]);
        if (s !== undefined) groupToStore[gid] = s;   // null = CDP, string = tienda
      });

      // ── Paso 8: Move lines del RET → detalle de productos ──────────────────
      const retIds = rets.map(r => r.id);
      const retMoveLines = await odooCall('stock.move.line', 'search_read',
        [[['picking_id', 'in', retIds], ['state', '=', 'done']]],
        { fields: ['id','picking_id','product_id','qty_done'], limit: 2000 });

      const prodIds = [...new Set(retMoveLines.map(ml => ml.product_id[0]))];
      const prods = prodIds.length ? await odooCall('product.product', 'search_read',
        [[['id', 'in', prodIds]]],
        { fields: ['id','default_code','name'], limit: prodIds.length }) : [];
      const prodMap = {};
      prods.forEach(p => prodMap[p.id] = p);

      const mlByRet = {};
      retMoveLines.forEach(ml => {
        if (!mlByRet[ml.picking_id[0]]) mlByRet[ml.picking_id[0]] = [];
        mlByRet[ml.picking_id[0]].push(ml);
      });

      // ── Paso 9: Construir filas — solo devoluciones de tienda (no CDP) ──────
      const rows = [];
      const byStore = {};

      rets.forEach(ret => {
        const outRef  = retToOutRef[ret.id];
        const groupId = outRef ? outNameToGroup[outRef] : undefined;
        const store   = groupId !== undefined ? groupToStore[groupId] : undefined;

        // store === null → venta CDP (excluir)
        // store === undefined → no se pudo determinar (excluir)
        if (!store) return;
        if (storeFilter && store !== storeFilter) return;

        const lines = mlByRet[ret.id] || [];
        lines.forEach(ml => {
          const prod = prodMap[ml.product_id[0]] || {};
          rows.push({
            retRef:      ret.name,            // ALVEN/RET/XXXXX
            outRef:      outRef || '',        // ALVEN/OUT/XXXXX (venta original)
            store,                            // PTN | STI | OUTLET | OUT27
            dateDone:    ret.date_done || '',
            partner:     ret.partner_id ? ret.partner_id[1] : '',
            productRef:  prod.default_code || '',
            productName: prod.name || ml.product_id[1] || '',
            qty:         ml.qty_done || 0
          });
          byStore[store] = (byStore[store] || 0) + 1;
        });
      });

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, rows, total:rows.length, byStore, retCount:rets.length }));
    } catch(e) {
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }
    return;
  }

  // ── GET /api/averias — lista todas las averías ───────────────────────────
  if (reqPath === '/api/averias' && req.method === 'GET') {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,averias:loadAverias()}));
    return;
  }

  // ── GET /api/averias/product?ref= — averías de un artículo ─────────────
  if (reqPath === '/api/averias/product' && req.method === 'GET') {
    const ref = (parsed.query.ref||'').trim().toUpperCase();
    const all = loadAverias();
    const found = all.filter(a=>(a.ref||'').toUpperCase()===ref||(a.barcode||'').toUpperCase()===ref);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,averias:found}));
    return;
  }

  // ── POST /api/averias — registrar nueva avería ───────────────────────────
  if (reqPath === '/api/averias' && req.method === 'POST') {
    try {
      const d = await readBody(req);
      const list = loadAverias();
      const id = Date.now().toString(36)+Math.random().toString(36).slice(2,6);
      const now = new Date().toISOString();
      const rec = {
        id, productId:d.productId||null, ref:d.ref||'', name:d.name||'',
        barcode:d.barcode||'', image:d.image||null, location:d.location||'',
        qty:parseInt(d.qty)||1, comentario:d.comentario||'',
        status:'Recibido',
        statusHistory:[{status:'Recibido',date:now,nota:d.comentario||''}],
        createdAt:now, updatedAt:now
      };
      list.unshift(rec);
      saveAverias(list);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,averia:rec}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:safeError(e)})); }
    return;
  }

  // ── PATCH /api/averias/:id — actualizar estatus / comentario ────────────
  if (reqPath.match(/^\/api\/averias\/[a-z0-9]+$/) && req.method === 'PATCH') {
    const id = reqPath.split('/').pop();
    try {
      const d = await readBody(req);
      const list = loadAverias();
      const idx = list.findIndex(a=>a.id===id);
      if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
      const now = new Date().toISOString();
      if (d.status) { list[idx].status=d.status; list[idx].statusHistory.push({status:d.status,date:now,nota:d.nota||''}); }
      if (d.comentario!==undefined) list[idx].comentario=d.comentario;
      if (d.qty!==undefined) list[idx].qty=parseInt(d.qty)||1;
      list[idx].updatedAt=now;
      saveAverias(list);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,averia:list[idx]}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:safeError(e)})); }
    return;
  }

  // ── POST /api/averias/:id/fotos — subir fotos de daño (base64) ─────────────
  if (reqPath.match(/^\/api\/averias\/[a-z0-9]+\/fotos$/) && req.method === 'POST') {
    const id = reqPath.split('/')[3];
    try {
      const d = await readBody(req); // {fotos:[{data:base64,ext:'jpg',caption:''}]}
      const list = loadAverias();
      const idx = list.findIndex(a=>a.id===id);
      if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
      if (!list[idx].fotos) list[idx].fotos=[];
      const saved=[];
      (d.fotos||[]).forEach((f,fi)=>{
        const { b64, ext } = validatePhoto(f);
        const fname=`${id}_${Date.now()}_${fi}.${ext}`;
        const fpath=path.join(AV_FOTOS_DIR,fname);
        fs.writeFileSync(fpath,Buffer.from(b64,'base64'));
        const entry={url:`/av-fotos/${fname}`,caption:f.caption||'',date:new Date().toISOString()};
        list[idx].fotos.push(entry);
        saved.push(entry);
      });
      list[idx].updatedAt=new Date().toISOString();
      saveAverias(list);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,fotos:saved,total:list[idx].fotos.length}));
    } catch(e){ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:safeError(e)})); }
    return;
  }

  // ── DELETE /api/averias/:id/fotos/:fname — eliminar foto ───────────────────
  if (reqPath.match(/^\/api\/averias\/[a-z0-9]+\/fotos\/.+$/) && req.method === 'DELETE') {
    const parts=reqPath.split('/');
    const id=parts[3], fname=parts[5];
    const list=loadAverias();
    const idx=list.findIndex(a=>a.id===id);
    if (idx===-1){ res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
    list[idx].fotos=(list[idx].fotos||[]).filter(f=>!f.url.endsWith(fname));
    const fpath=path.join(AV_FOTOS_DIR,fname);
    if(fs.existsSync(fpath)) try{fs.unlinkSync(fpath);}catch(e){}
    list[idx].updatedAt=new Date().toISOString();
    saveAverias(list);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true}));
    return;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ── NOTIFICACIONES API ───────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/wwp/notifications/stream — SSE (token en query param porque EventSource no soporta headers)
  if (reqPath === '/api/wwp/notifications/stream' && req.method === 'GET') {
    const token = (parsed.query||{}).token;
    let jwtPayload = null;
    try {
      if (!token) throw new Error('Sin token');
      jwtPayload = jwtVerify(token);
    } catch(e) {
      res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Token inválido'})); return;
    }
    const userId = jwtPayload.userId;
    res.writeHead(200, {
      'Content-Type':'text/event-stream',
      'Cache-Control':'no-cache',
      'Connection':'keep-alive',
      'X-Accel-Buffering':'no',  // para nginx
    });
    // Enviar evento de conexión establecida
    res.write(`data: ${JSON.stringify({event:'connected',userId})}\n\n`);
    // Registrar cliente
    if (!sseClients.has(userId)) sseClients.set(userId, new Set());
    sseClients.get(userId).add(res);
    // Heartbeat cada 25 s para que el proxy no cierre la conexión
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { clearInterval(hb); } }, 25000);
    // Chequear vencidas al conectar
    try { checkOverdueTasks(); } catch {}
    const _ssCleanup = () => {
      clearInterval(hb);
      sseClients.get(userId)?.delete(res);
      if (sseClients.get(userId)?.size === 0) sseClients.delete(userId);
    };
    req.on('close', _ssCleanup);
    req.on('error', _ssCleanup);
    return;
  }

  // GET /api/wwp/notifications — listar notificaciones del usuario actual
  if (reqPath === '/api/wwp/notifications' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    const all = loadNotifications().filter(n => n.userId === jp.userId);
    const limit = parseInt((parsed.query||{}).limit)||60;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, notifications:all.slice(0, limit)}));
    return;
  }

  // PATCH /api/wwp/notifications/:id/read — marcar como leída
  if (reqPath.match(/^\/api\/wwp\/notifications\/notif_[a-z0-9]+\/read$/) && req.method === 'PATCH') {
    const jp = requireJwt(req, res); if (!jp) return;
    const nid = reqPath.split('/')[4];
    const all = loadNotifications();
    const idx = all.findIndex(n => n.id === nid && n.userId === jp.userId);
    if (idx >= 0) { all[idx].readAt = new Date().toISOString(); all[idx].status = 'read'; saveNotifications(all); }
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    return;
  }

  // PATCH /api/wwp/notifications/read-all — marcar todas como leídas
  if (reqPath === '/api/wwp/notifications/read-all' && req.method === 'PATCH') {
    const jp = requireJwt(req, res); if (!jp) return;
    const now = new Date().toISOString();
    const all = loadNotifications().map(n => n.userId===jp.userId&&!n.readAt ? {...n,readAt:now,status:'read'} : n);
    saveNotifications(all);
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    return;
  }

  // DELETE /api/wwp/notifications/read — borrar todas las leídas del usuario
  if (reqPath === '/api/wwp/notifications/read' && req.method === 'DELETE') {
    const jp = requireJwt(req, res); if (!jp) return;
    const all = loadNotifications().filter(n => !(n.userId===jp.userId && n.readAt));
    saveNotifications(all);
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    return;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ── WWP AUTH API ─────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════

  // POST /api/wwp/auth/login
  if (reqPath === '/api/wwp/auth/login' && req.method === 'POST') {
    try {
      const { email, password } = await readBody(req);
      const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

      // Rate limiting
      if (checkLoginRateLimit(email)) {
        appendAuditLog('login_blocked', { email, ip, reason: 'rate_limit' });
        res.writeHead(429,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false,error:'Demasiados intentos fallidos. Espera 15 minutos.'})); return;
      }

      const users = loadAuthUsers();
      const user  = users.find(u => u.email === (email||'').toLowerCase().trim() && u.active);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        recordFailedLogin(email);
        appendAuditLog('login_fail', { email, ip, reason: 'bad_credentials' });
        res.writeHead(401,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false,error:'Correo o contraseña incorrectos'})); return;
      }

      clearLoginAttempts(email);
      appendAuditLog('login_ok', { userId: user.id, email, role: user.role, ip });

      const accessToken  = jwtSign({userId:user.id,role:user.role,name:user.name,odooId:user.odooId}, 8*3600);
      const refreshToken = crypto.randomBytes(32).toString('hex');
      const sessionId    = wwpId('sess');
      const device       = (req.headers['user-agent']||'').substring(0,120);
      // Limpiar sesiones expiradas + guardar nueva
      const sessions = loadSessions().filter(s => new Date(s.expiresAt) > new Date());
      sessions.push({id:sessionId, userId:user.id, refreshToken, device,
        lastActivity:new Date().toISOString(),
        expiresAt: new Date(Date.now()+30*24*60*60*1000).toISOString()});
      saveSessions(sessions);
      user.lastLogin = new Date().toISOString();
      user.presenceStatus = 'active';
      user.presenceAt = new Date().toISOString();
      saveAuthUsers(users);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, accessToken, refreshToken, sessionId,
        user:{id:user.id,name:user.name,email:user.email,role:user.role,odooId:user.odooId,presenceStatus:user.presenceStatus||'active',sectionPerms:getRoleDefPerms(user.role)}}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // POST /api/wwp/auth/refresh
  if (reqPath === '/api/wwp/auth/refresh' && req.method === 'POST') {
    try {
      const { refreshToken } = await readBody(req);
      const sessions = loadSessions().filter(s => new Date(s.expiresAt) > new Date());
      const session  = sessions.find(s => s.refreshToken === refreshToken);
      if (!session) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Sesión inválida o expirada'})); return; }
      const users = loadAuthUsers();
      const user  = users.find(u => u.id === session.userId && u.active);
      if (!user)  { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Usuario no encontrado'})); return; }
      const accessToken = jwtSign({userId:user.id,role:user.role,name:user.name,odooId:user.odooId}, 8*3600);
      session.lastActivity = new Date().toISOString();
      saveSessions(sessions);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, accessToken, user:{id:user.id,name:user.name,email:user.email,role:user.role,odooId:user.odooId,presenceStatus:user.presenceStatus||'active',sectionPerms:getRoleDefPerms(user.role)}}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // POST /api/wwp/auth/logout
  if (reqPath === '/api/wwp/auth/logout' && req.method === 'POST') {
    try {
      const { refreshToken } = await readBody(req);
      saveSessions(loadSessions().filter(s => s.refreshToken !== refreshToken));
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    } catch { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); }
    return;
  }

  // GET /api/wwp/auth/me
  if (reqPath === '/api/wwp/auth/me' && req.method === 'GET') {
    const jwtPayload = requireJwt(req, res); if (!jwtPayload) return;
    const user = loadAuthUsers().find(u => u.id === jwtPayload.userId);
    if (!user) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Usuario no encontrado'})); return; }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,user:{id:user.id,name:user.name,email:user.email,role:user.role,odooId:user.odooId,presenceStatus:user.presenceStatus||'active',lastLogin:user.lastLogin}}));
    return;
  }

  // POST /api/wwp/auth/forgot-password
  if (reqPath === '/api/wwp/auth/forgot-password' && req.method === 'POST') {
    try {
      const { email } = await readBody(req);
      const users = loadAuthUsers();
      const user  = users.find(u => u.email === (email||'').toLowerCase().trim() && u.active);
      if (user) {
        user.resetToken       = crypto.randomBytes(32).toString('hex');
        user.resetTokenExpiry = new Date(Date.now()+60*60*1000).toISOString();
        saveAuthUsers(users);
        const resetUrl = `http://localhost:3000/historial.html?reset=${user.resetToken}`;
        console.warn(`\n📧 Reset password → ${user.name}\n   URL: ${resetUrl}\n`);
      }
    } catch {}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,message:'Si el correo existe recibirás instrucciones de recuperación'}));
    return;
  }

  // POST /api/wwp/auth/reset-password
  if (reqPath === '/api/wwp/auth/reset-password' && req.method === 'POST') {
    try {
      const { token, password } = await readBody(req);
      const users = loadAuthUsers();
      const user  = users.find(u => u.resetToken === token && u.resetTokenExpiry && new Date(u.resetTokenExpiry) > new Date());
      if (!user) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Token inválido o expirado'})); return; }
      if (!password || password.length < 6) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'La contraseña debe tener al menos 6 caracteres'})); return; }
      user.passwordHash     = hashPassword(password);
      user.resetToken       = null;
      user.resetTokenExpiry = null;
      saveAuthUsers(users);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,message:'Contraseña actualizada correctamente'}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // GET /api/wwp/auth/sessions — admin: sesiones activas
  if (reqPath === '/api/wwp/auth/sessions' && req.method === 'GET') {
    const jwtPayload = requireJwt(req, res); if (!jwtPayload) return;
    if (jwtPayload.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Se requiere rol admin'})); return; }
    const sessions = loadSessions().filter(s => new Date(s.expiresAt) > new Date());
    const users    = loadAuthUsers();
    const result   = sessions.map(s => { const u=users.find(u=>u.id===s.userId); return {id:s.id,userId:s.userId,userName:u?.name,userRole:u?.role,device:s.device,lastActivity:s.lastActivity,expiresAt:s.expiresAt}; });
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(result));
    return;
  }

  // DELETE /api/wwp/auth/sessions/:id — admin: terminar sesión
  if (reqPath.startsWith('/api/wwp/auth/sessions/') && req.method === 'DELETE') {
    const jwtPayload = requireJwt(req, res); if (!jwtPayload) return;
    if (jwtPayload.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Se requiere rol admin'})); return; }
    const sessId = reqPath.split('/').pop();
    saveSessions(loadSessions().filter(s => s.id !== sessId));
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    return;
  }

  // GET /api/wwp/auth/users — admin/manager: listar usuarios del sistema
  if (reqPath === '/api/wwp/auth/users' && req.method === 'GET') {
    const jwtPayload = requireJwt(req, res); if (!jwtPayload) return;
    if (!['admin','manager'].includes(jwtPayload.role)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Se requiere rol admin o manager'})); return; }
    const users = loadAuthUsers().map(u => ({id:u.id,name:u.name,email:u.email,role:u.role,odooId:u.odooId,active:u.active,lastLogin:u.lastLogin,createdAt:u.createdAt,presenceStatus:u.presenceStatus||'active',presenceAt:u.presenceAt||null,lunchTimeAllowed:u.lunchTimeAllowed||60,sectionPerms:getRoleDefPerms(u.role)}));
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(users));
    return;
  }

  // ── GET /api/wwp/role-defs — listar definiciones de roles ─────────────────
  if (reqPath === '/api/wwp/role-defs' && req.method === 'GET') {
    const _jpRd = requireJwt(req, res); if (!_jpRd) return;
    if (_jpRd.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Solo admin'})); return; }
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(loadRoleDefs())); return;
  }

  // ── POST /api/wwp/role-defs — crear rol personalizado ────────────────────
  if (reqPath === '/api/wwp/role-defs' && req.method === 'POST') {
    const _jpRd = requireJwt(req, res); if (!_jpRd) return;
    if (_jpRd.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Solo admin'})); return; }
    try {
      const d = await readBody(req);
      if (!d.name||!d.name.trim()) { res.writeHead(422,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Nombre requerido'})); return; }
      const defs = loadRoleDefs();
      const newRole = { id:'role_'+Date.now().toString(36), name:d.name.trim(), isBuiltin:false, sectionPerms:d.sectionPerms||{} };
      defs.push(newRole);
      saveRoleDefs(defs);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,role:newRole}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── PATCH /api/wwp/role-defs/:id — editar rol ────────────────────────────
  if (reqPath.match(/^\/api\/wwp\/role-defs\/[^/]+$/) && req.method === 'PATCH') {
    const _jpRd = requireJwt(req, res); if (!_jpRd) return;
    if (_jpRd.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Solo admin'})); return; }
    try {
      const roleId = reqPath.split('/').pop();
      if (roleId === 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No se puede modificar el rol admin'})); return; }
      const d = await readBody(req);
      const defs = loadRoleDefs();
      const idx = defs.findIndex(r=>r.id===roleId);
      if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Rol no encontrado'})); return; }
      if (!defs[idx].isBuiltin && d.name && d.name.trim()) defs[idx].name = d.name.trim();
      if (d.sectionPerms!==undefined && typeof d.sectionPerms==='object') defs[idx].sectionPerms = d.sectionPerms;
      saveRoleDefs(defs);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,role:defs[idx]}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── DELETE /api/wwp/role-defs/:id — eliminar rol personalizado ────────────
  if (reqPath.match(/^\/api\/wwp\/role-defs\/[^/]+$/) && req.method === 'DELETE') {
    const _jpRd = requireJwt(req, res); if (!_jpRd) return;
    if (_jpRd.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Solo admin'})); return; }
    try {
      const roleId = reqPath.split('/').pop();
      const defs = loadRoleDefs();
      const def = defs.find(r=>r.id===roleId);
      if (!def) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Rol no encontrado'})); return; }
      if (def.isBuiltin) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No se pueden eliminar roles predeterminados'})); return; }
      const inUse = loadAuthUsers().some(u=>u.role===roleId);
      if (inUse) { res.writeHead(409,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'El rol está asignado a uno o más usuarios'})); return; }
      saveRoleDefs(defs.filter(r=>r.id!==roleId));
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── GET /api/solicitudes-showroom ─────────────────────────────────────────
  if (reqPath === '/api/solicitudes-showroom' && req.method === 'GET') {
    const _jpSol = requireJwt(req, res); if (!_jpSol) return;
    const list = loadSolicitudes();

    // ── Auto-detectar completados ─────────────────────────────────────────
    // Una solicitud se marca 'completado' automáticamente cuando existe un
    // stock.move DONE con destino PTN SHOWROOM para ese producto, ocurrido
    // DESPUÉS de que fue creada la solicitud. Es permanente: nunca revierte.
    const activas = list.filter(s => s.status === 'activo');
    if (activas.length) {
      try {
        // 1. Ubicaciones internas de PTN/SHOWROOM
        const srLocs = await odooCall('stock.location', 'search_read',
          [[['complete_name', 'ilike', 'D-PTN'], ['complete_name', 'ilike', 'SHOWROOM'],
            ['usage', '=', 'internal']]],
          { fields: ['id', 'complete_name'], limit: 20 }
        );
        const srLocIds = srLocs.map(l => l.id);

        if (srLocIds.length) {
          // 2. Resolver solicitud → product_id de Odoo
          const prodIdMap = {}; // solId → odoo product_id
          const repoAct = activas.filter(s => s.source === 'reposicion' && s.productId);
          const contAct = activas.filter(s => s.source === 'contenedores' && s.contId);

          repoAct.forEach(s => { prodIdMap[s.id] = s.productId; });

          if (contAct.length) {
            const bcs = [...new Set(contAct.map(s => s.contId))];
            const cProds = await odooCall('product.product', 'search_read',
              [[['barcode', 'in', bcs]]], { fields: ['id', 'barcode'], limit: 500 }
            );
            const byBc = {};
            cProds.forEach(p => { byBc[p.barcode] = p.id; });
            contAct.forEach(s => { const pid = byBc[s.contId]; if (pid) prodIdMap[s.id] = pid; });
          }

          // 3. stock.move DONE → showroom para esos productos
          const allPids = [...new Set(Object.values(prodIdMap))];
          if (allPids.length) {
            const moves = await odooCall('stock.move', 'search_read',
              [[['product_id','in',allPids], ['location_dest_id','in',srLocIds], ['state','=','done']]],
              { fields: ['id','product_id','date','reference'], limit: 2000 }
            );

            // Agrupar todos los movimientos por producto (guardar todos, no solo uno)
            const mvByProd = {}; // pid → [{ date, ref }, ...]
            moves.forEach(m => {
              const pid = m.product_id[0];
              if (!mvByProd[pid]) mvByProd[pid] = [];
              mvByProd[pid].push({ date: m.date, ref: m.reference || '' });
            });

            // 4. Marcar completadas:
            //    Busca si ALGÚN movimiento hacia showroom ocurrió después de la solicitud.
            //    Tolerancia: acepta movimientos hasta 48h ANTES de la solicitud (cubre casos
            //    donde el operario transfirió en Odoo antes de marcar la solicitud).
            //
            //    Normalización de fechas: Odoo usa espacio ("2026-05-28 14:00:00"),
            //    fechaSolicitud es ISO con T. Se convierten a timestamp para comparar.
            function parseFecha(s) {
              if (!s) return 0;
              const norm = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
              return Date.parse(norm) || 0;
            }
            const TOLERANCIA_MS = 48 * 60 * 60 * 1000; // 48 horas de tolerancia
            let changed = false;
            list.forEach(sol => {
              if (sol.status !== 'activo') return;
              const pid = prodIdMap[sol.id];
              if (!pid) return;
              const movs = mvByProd[pid];
              if (!movs || !movs.length) return;
              const solTs = parseFecha(sol.fechaSolicitud);
              // Buscar cualquier movimiento dentro de la ventana: (solicitud - 48h) en adelante
              const match = movs
                .filter(mv => parseFecha(mv.date) >= (solTs - TOLERANCIA_MS))
                .sort((a, b) => parseFecha(b.date) - parseFecha(a.date))[0]; // más reciente primero
              if (match) {
                sol.status          = 'completado';
                sol.fechaCompletado = match.date;
                sol.completadoRef   = match.ref;
                sol.completadoPor   = { id: 'sistema', name: 'Sistema (Odoo)' };
                changed = true;
              }
            });

            if (changed) saveSolicitudes(list);
          }
        }
      } catch(_) { /* silencioso — si falla el check, devolver lista tal cual */ }
    }

    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, solicitudes: list}));
    return;
  }

  // ── GET /api/solicitudes-showroom/movimientos ────────────────────────────
  // Para cada solicitud activa: ¿hubo movimientos en Odoo después de crearla?
  // ¿Dónde está el artículo ahora? Devuelve mapa solId → { hasMoved, lastMove, currentLocs }
  if (reqPath === '/api/solicitudes-showroom/movimientos' && req.method === 'GET') {
    const _jpMov = requireJwt(req, res); if (!_jpMov) return;
    try {
      const list    = loadSolicitudes();
      const activas = list.filter(s => s.status === 'activo');

      if (!activas.length) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, movimientos: {} })); return;
      }

      // ── 1. Resolver solId → productId de Odoo ──────────────────────────────
      const prodIdMap = {};
      activas.filter(s => s.productId).forEach(s => { prodIdMap[s.id] = s.productId; });

      const contAct = activas.filter(s => !s.productId && s.contId);
      if (contAct.length) {
        const bcs    = [...new Set(contAct.map(s => s.contId))];
        const cProds = await odooCall('product.product', 'search_read',
          [[['barcode', 'in', bcs]]], { fields: ['id', 'barcode'], limit: 500 });
        const byBc = {};
        cProds.forEach(p => { byBc[p.barcode] = p.id; });
        contAct.forEach(s => { const pid = byBc[s.contId]; if (pid) prodIdMap[s.id] = pid; });
      }

      const allPids = [...new Set(Object.values(prodIdMap))];
      if (!allPids.length) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, movimientos: {} })); return;
      }

      // ── 2. Fecha límite inferior: solicitud más antigua (con 24h de margen) ─
      function parseFechaMov(s) {
        if (!s) return 0;
        const norm = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
        return Date.parse(norm) || 0;
      }
      const oldest = activas.reduce((mn, s) => {
        const ts = parseFechaMov(s.fechaSolicitud);
        return (ts && ts < mn) ? ts : mn;
      }, Date.now());
      const oldestStr = new Date(oldest - 24*3600*1000).toISOString().slice(0,19).replace('T',' ');

      // ── 3. Consultas paralelas: moves + quants actuales ─────────────────────
      const [moves, quants] = await Promise.all([
        odooCall('stock.move', 'search_read', [[
          ['product_id', 'in', allPids],
          ['state', '=', 'done'],
          ['date', '>=', oldestStr],
          ['location_dest_id.usage', '=', 'internal']
        ]], { fields: ['product_id','date','reference','location_dest_id'], limit: 3000 }),
        odooCall('stock.quant', 'search_read', [[
          ['product_id', 'in', allPids],
          ['quantity', '>', 0],
          ['location_id.usage', '=', 'internal']
        ]], { fields: ['product_id','location_id','quantity'], limit: 3000 })
      ]);

      // Agrupar moves por producto
      const movesByProd = {};
      moves.forEach(m => {
        const pid = m.product_id[0];
        if (!movesByProd[pid]) movesByProd[pid] = [];
        movesByProd[pid].push({
          date:     m.date,
          ref:      m.reference || '',
          destName: Array.isArray(m.location_dest_id) ? m.location_dest_id[1] : ''
        });
      });

      // Agrupar quants (ubicaciones actuales) por producto
      const quantsByProd = {};
      quants.forEach(q => {
        const pid  = q.product_id[0];
        const name = Array.isArray(q.location_id) ? q.location_id[1] : '';
        if (!quantsByProd[pid]) quantsByProd[pid] = [];
        if (name) quantsByProd[pid].push(name);
      });

      // ── 4. Construir resultado por solicitud ────────────────────────────────
      const TOLERANCIA_MOV = 24 * 3600 * 1000; // 24h de margen hacia atrás
      const resultado = {};
      activas.forEach(sol => {
        const pid = prodIdMap[sol.id];
        if (!pid) return;
        const solTs = parseFechaMov(sol.fechaSolicitud);
        const movsDespues = (movesByProd[pid] || [])
          .filter(m => parseFechaMov(m.date) >= (solTs - TOLERANCIA_MOV))
          .sort((a, b) => parseFechaMov(b.date) - parseFechaMov(a.date));
        const currentLocs = [...new Set((quantsByProd[pid] || []))];
        resultado[sol.id] = {
          hasMoved:     movsDespues.length > 0,
          lastMoveDate: movsDespues[0]?.date   || null,
          lastMoveRef:  movsDespues[0]?.ref    || null,
          lastMoveDest: movsDespues[0]?.destName || null,
          currentLocs
        };
      });

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, movimientos: resultado }));
    } catch(e) {
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST /api/solicitudes-showroom — crear solicitud ─────────────────────
  if (reqPath === '/api/solicitudes-showroom' && req.method === 'POST') {
    const _jpSol = requireJwt(req, res); if (!_jpSol) return;
    try {
      const d = await readBody(req);
      if (!d.productId && !d.contId && !d.barcode) {
        res.writeHead(422,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'productId o contId requerido'})); return;
      }
      const list = loadSolicitudes();
      // Verificar duplicado activo
      const dup = list.find(s =>
        s.status === 'activo' &&
        s.source === d.source &&
        (d.productId
          ? s.productId === d.productId
          : d.contId
            ? s.contId === d.contId
            : s.barcode === d.barcode)
      );
      if (dup) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, solicitud: dup, existing: true})); return; }
      const users = loadAuthUsers();
      const user  = users.find(u => u.id === _jpSol.userId);
      const sol = {
        id:              wwpId('sol'),
        source:          d.source || 'reposicion',   // 'reposicion' | 'contenedores'
        productId:       d.productId || null,
        contId:          d.contId    || null,
        name:            d.name      || '',
        ref:             d.ref       || '',
        barcode:         d.barcode   || '',
        imageBase64:     d.imageBase64 || '',
        almacen:         d.almacen   || '',
        ubicacion:       d.ubicacion || '',
        nota:            (d.nota || '').trim(),
        status:          'activo',
        solicitadoPor:   { id: _jpSol.userId, name: user ? user.name : _jpSol.name },
        fechaSolicitud:  new Date().toISOString(),
        canceladoPor:    null,
        fechaCancelacion: null
      };
      list.push(sol);
      saveSolicitudes(list);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, solicitud: sol}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── GET /api/admin/export-data — exportar todos los archivos JSON para sync local ──
  // Solo admins. Excluye sesiones activas y audit log (datos sensibles/grandes).
  if (reqPath === '/api/admin/export-data' && req.method === 'GET') {
    const _jpEx = requireJwt(req, res); if (!_jpEx) return;
    if (_jpEx.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Solo admin'})); return; }
    try {
      const exportFiles = [
        { key: 'wwp-solicitudes-showroom', file: WWP_SOLICITUDES_FILE },
        { key: 'wwp-tasks',      file: WWP_TASKS_FILE },
        { key: 'wwp-users-auth', file: WWP_AUTH_FILE },
        { key: 'wwp-roles',      file: WWP_ROLES_FILE },
        { key: 'wwp-role-defs',  file: WWP_ROLE_DEFS_FILE },
        { key: 'wwp-lunch-breaks', file: WWP_LUNCH_FILE },
        { key: 'wwp-notifications', file: WWP_NOTIF_FILE },
        { key: 'averias',        file: AVERIAS_FILE },
        { key: 'empaque-materiales', file: EMP_MATERIALES_FILE },
        { key: 'empaque-reglas', file: EMP_REGLAS_FILE },
      ];
      const data = { exportedAt: new Date().toISOString(), files: {} };
      exportFiles.forEach(({ key, file }) => {
        try { data.files[key] = JSON.parse(fs.readFileSync(file, 'utf-8')); }
        catch { data.files[key] = null; }
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="data-export.json"' });
      res.end(JSON.stringify(data, null, 2));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── DELETE /api/solicitudes-showroom/bulk — eliminar solicitudes por IDs (admin) ──
  if (reqPath === '/api/solicitudes-showroom/bulk' && req.method === 'DELETE') {
    const _jpDel = requireJwt(req, res); if (!_jpDel) return;
    if (_jpDel.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Solo admin'})); return; }
    try {
      const { ids } = await readBody(req);
      if (!Array.isArray(ids) || !ids.length) throw new Error('ids requerido (array)');
      const list = loadSolicitudes();
      const idSet = new Set(ids);
      const before = list.length;
      const kept = list.filter(s => !idSet.has(s.id));
      const removed = before - kept.length;
      saveSolicitudes(kept);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, removed, remaining: kept.length}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── PATCH /api/solicitudes-showroom/:id — cancelar o editar nota ──────────
  if (reqPath.match(/^\/api\/solicitudes-showroom\/[^/]+$/) && req.method === 'PATCH') {
    const _jpSol = requireJwt(req, res); if (!_jpSol) return;
    try {
      const solId = reqPath.split('/').pop();
      const d = await readBody(req);
      const list = loadSolicitudes();
      const idx  = list.findIndex(s => s.id === solId);
      if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Solicitud no encontrada'})); return; }
      if (d.status === 'cancelado') {
        if (list[idx].status === 'completado') {
          // Completado es permanente — no se puede cancelar
          res.writeHead(409,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:'Esta solicitud ya fue completada (artículo transferido al showroom) y no puede cancelarse.'}));
          return;
        }
        if (list[idx].status !== 'cancelado') {
          const users = loadAuthUsers();
          const user  = users.find(u => u.id === _jpSol.userId);
          list[idx].status           = 'cancelado';
          list[idx].canceladoPor     = { id: _jpSol.userId, name: user ? user.name : _jpSol.name };
          list[idx].fechaCancelacion = new Date().toISOString();
        }
      }
      if (d.nota !== undefined) list[idx].nota = (d.nota || '').trim();
      saveSolicitudes(list);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, solicitud: list[idx]}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // POST /api/wwp/auth/users — admin: crear usuario
  if (reqPath === '/api/wwp/auth/users' && req.method === 'POST') {
    const jwtPayload = requireJwt(req, res); if (!jwtPayload) return;
    if (jwtPayload.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Se requiere rol admin'})); return; }
    try {
      const d = await readBody(req);
      const { name, email, password, role, odooId } = d;
      if (!name||!email||!password) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'name, email y password son requeridos'})); return; }
      const users = loadAuthUsers();
      if (users.find(u => u.email === email.toLowerCase().trim())) { res.writeHead(409,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'El correo ya está registrado'})); return; }
      const newUser = {id:wwpId('au'),name,email:email.toLowerCase().trim(),passwordHash:hashPassword(password),role:role||'assistant',odooId:odooId||null,active:true,lastLogin:null,resetToken:null,resetTokenExpiry:null,createdAt:new Date().toISOString()};
      users.push(newUser);
      saveAuthUsers(users);
      res.writeHead(201,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,user:{id:newUser.id,name:newUser.name,email:newUser.email,role:newUser.role}}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // PATCH /api/wwp/auth/presence — actualiza estado de presencia + gestiona breaks de almuerzo
  if (reqPath === '/api/wwp/auth/presence' && req.method === 'PATCH') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const d = await readBody(req);
      const status = d.status; // 'active' | 'working' | 'lunch' | 'offline'
      const VALID_STATES = ['active','lunch','offline'];
      if (!VALID_STATES.includes(status)) {
        res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Estado inválido. Use: '+VALID_STATES.join(', ')})); return;
      }
      const users = loadAuthUsers();
      const idx = users.findIndex(u => u.id === jp.userId);
      if (idx < 0) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Usuario no encontrado'})); return; }

      const prevStatus = users[idx].presenceStatus || 'active';
      const now = new Date().toISOString();
      const today = now.slice(0, 10);

      // ── Lunch break tracking ──────────────────────────────────────────
      const breaks = loadLunchBreaks();

      // Si estaba en almuerzo y sale manualmente → cerrar registro y cancelar timer
      if (prevStatus === 'lunch' && status !== 'lunch') {
        // Cancelar el auto-cierre programado
        if (lunchTimerMap.has(jp.userId)) {
          clearTimeout(lunchTimerMap.get(jp.userId));
          lunchTimerMap.delete(jp.userId);
        }
        const openIdx = breaks.findIndex(b => b.userId === jp.userId && b.endTime === null);
        if (openIdx >= 0) {
          const ob = breaks[openIdx];
          ob.endTime = now;
          ob.totalMinutes = Math.round((new Date(now) - new Date(ob.startTime)) / 60000);
          ob.exceededMinutes = Math.max(0, ob.totalMinutes - ob.allowedMinutes);
          ob.compliant = ob.exceededMinutes === 0;
          saveLunchBreaks(breaks);
        }
      }

      // Si entra en almuerzo → abrir nuevo registro y programar auto-cierre
      if (status === 'lunch') {
        // Cerrar cualquier registro abierto previo (por si acaso)
        breaks.forEach(b => {
          if (b.userId === jp.userId && b.endTime === null) {
            b.endTime = now;
            b.totalMinutes = Math.round((new Date(now) - new Date(b.startTime)) / 60000);
            b.exceededMinutes = Math.max(0, b.totalMinutes - b.allowedMinutes);
            b.compliant = b.exceededMinutes === 0;
          }
        });
        const allowedMins = users[idx].lunchTimeAllowed || 60;
        breaks.push({
          id: wwpId('lb'),
          userId: jp.userId,
          userName: jp.name,
          userRole: users[idx].role,
          date: today,
          startTime: now,
          endTime: null,
          totalMinutes: null,
          allowedMinutes: allowedMins,
          exceededMinutes: null,
          compliant: null,
        });
        saveLunchBreaks(breaks);
        // Programar auto-cierre al vencer el tiempo permitido
        scheduleLunchAutoClose(jp.userId, now, allowedMins);
      }

      // ── Actualizar usuario ─────────────────────────────────────────────
      users[idx].presenceStatus = status;
      users[idx].presenceAt = now;
      saveAuthUsers(users);

      // Broadcast SSE a todos (incluye lunchTimeAllowed para que el cliente pueda mostrar el timer)
      const event = JSON.stringify({
        event: 'presence_changed',
        userId: jp.userId,
        presenceStatus: status,
        presenceAt: now,
        name: jp.name,
        lunchTimeAllowed: users[idx].lunchTimeAllowed || 60,
      });
      sseClients.forEach(clientSet => clientSet.forEach(r => { try { r.write(`data: ${event}\n\n`); } catch {} }));

      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, presenceStatus:status, presenceAt:now, lunchTimeAllowed:users[idx].lunchTimeAllowed||60}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // PATCH /api/wwp/auth/users/:id — admin: actualizar usuario
  if (reqPath.startsWith('/api/wwp/auth/users/') && req.method === 'PATCH') {
    const jwtPayload = requireJwt(req, res); if (!jwtPayload) return;
    if (jwtPayload.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Se requiere rol admin'})); return; }
    try {
      const userId = reqPath.split('/').pop();
      const d = await readBody(req);
      const users = loadAuthUsers();
      const idx   = users.findIndex(u => u.id === userId);
      if (idx < 0) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Usuario no encontrado'})); return; }
      if (d.role && !loadRoleDefs().map(r=>r.id).includes(d.role)) { res.writeHead(422,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Rol inválido'})); return; }
      if (d.name)     users[idx].name   = d.name;
      if (d.email)    users[idx].email  = d.email.toLowerCase().trim();
      if (d.role)     users[idx].role   = d.role;
      if (d.odooId !== undefined) users[idx].odooId = d.odooId;
      if (d.active !== undefined) users[idx].active = d.active;
      if (d.password) users[idx].passwordHash = hashPassword(d.password);
      // photoData no longer used — avatar is generated from initials
      if (d.lunchTimeAllowed !== undefined) users[idx].lunchTimeAllowed = Math.max(0, parseInt(d.lunchTimeAllowed)||60);
      saveAuthUsers(users);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,user:{id:users[idx].id,name:users[idx].name,email:users[idx].email,role:users[idx].role,active:users[idx].active,lunchTimeAllowed:users[idx].lunchTimeAllowed||60,sectionPerms:getRoleDefPerms(users[idx].role)}}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ── WWP API ──────────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/wwp/users — empleados de Odoo (Operaciones) + roles locales
  if (reqPath === '/api/wwp/users' && req.method === 'GET') {
    try {
      const employees = await odooCall('hr.employee','search_read',
        [[['department_id','child_of',[69,91]],['active','=',true]]],
        { fields:['id','name','job_title','image_128','department_id'], order:'department_id asc,name asc', limit:200 }
      );
      const roles = loadWwpRoles();
      const users = (employees||[]).map(emp => ({
        id:       'oe_' + emp.id,
        odooId:   emp.id,
        name:     emp.name,
        jobTitle: emp.job_title || '',
        image:    emp.image_128 || null,
        dept:     Array.isArray(emp.department_id) ? emp.department_id[1] : '',
        role:     roles['oe_' + emp.id] || 'assistant',
        active:   true
      }));
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(users));
    } catch(e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // PATCH /api/wwp/users/:id — actualizar rol local (oe_<odooId>)
  if (reqPath.match(/^\/api\/wwp\/users\/oe_\d+$/) && req.method === 'PATCH') {
    const _jpRole = requireJwt(req, res); if (!_jpRole) return;
    if (!requireRole(_jpRole, res, ['admin'])) return;
    const id = reqPath.split('/')[4]; // "oe_95"
    try {
      const d = await readBody(req);
      const validRoles = ['admin','manager','assistant'];
      if (d.role && !validRoles.includes(d.role)) { res.writeHead(422,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Rol inválido'})); return; }
      const roles = loadWwpRoles();
      const prevRole = roles[id];
      if (d.role) roles[id] = d.role;
      saveWwpRoles(roles);
      appendAuditLog('role_change', { changedBy: _jpRole.userId, targetId: id, prevRole, newRole: roles[id] });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, id, role:roles[id]}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // GET /api/wwp/tasks — listar tareas (filtros opcionales, filtrado por rol)
  if (reqPath === '/api/wwp/tasks' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    const q = parsed.query || {};
    let tasks = loadWwpTasks();
    // Filtros opcionales (URL query params)
    if (q.status)     tasks = tasks.filter(t=>t.status===q.status);
    if (q.type)       tasks = tasks.filter(t=>t.type===q.type);
    if (q.assignedTo) tasks = tasks.filter(t=>t.assignedTo===q.assignedTo);
    // Filtrado por rol: admins ven todo; managers/assistants solo sus tareas
    if (jp.role !== 'admin') {
      const uid = jp.userId;
      const isParticipant = (t) =>
        t.managerId   === uid ||
        t.createdBy   === uid ||
        odooStrToAuthId(t.assignedTo) === uid ||
        (t.executors||[]).some(e => e === uid || odooStrToAuthId(e) === uid) ||
        (t.assignees||[]).includes(uid);
      const direct = tasks.filter(isParticipant);
      const ids = new Set(direct.map(t => t.id));
      // Incluir relacionadas para contexto de cadena:
      //  - el padre de una subtarea visible (el chofer necesita el contexto de la orden)
      //  - las subtareas de un padre visible
      tasks.forEach(t => {
        if (ids.has(t.id)) return;
        if (direct.some(d => d.parentId === t.id)) ids.add(t.id);          // padre de mi subtarea
        if (t.parentId && direct.some(d => d.id === t.parentId)) ids.add(t.id); // hija de mi tarea
      });
      tasks = tasks.filter(t => ids.has(t.id));
    }
    // Ordenar por fecha límite asc (nulls al final), luego por creación desc
    tasks.sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return new Date(b.createdAt) - new Date(a.createdAt);
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      const dd = a.dueDate.localeCompare(b.dueDate);
      return dd !== 0 ? dd : new Date(b.createdAt) - new Date(a.createdAt);
    });
    // Excluir array de mensajes del listado (para reducir payload)
    const slim = tasks.map(({messages, ...rest}) => rest);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(slim));
    return;
  }

  // GET /api/wwp/tasks/:id/messages — obtener mensajes de chat
  if (reqPath.match(/^\/api\/wwp\/tasks\/wt_[a-z0-9]+\/messages$/) && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    const taskId = reqPath.split('/')[4];
    const tasks = loadWwpTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tarea no encontrada'})); return; }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, messages: task.messages||[]}));
    return;
  }

  // POST /api/wwp/tasks/:id/messages — enviar mensaje de chat
  if (reqPath.match(/^\/api\/wwp\/tasks\/wt_[a-z0-9]+\/messages$/) && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    const taskId = reqPath.split('/')[4];
    const tasks = loadWwpTasks();
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tarea no encontrada'})); return; }
    const d = await readBody(req);
    const _txt = (d.text||'').trim();
    // Imagen opcional en el mensaje
    let _imgUrl = null;
    if (d.image) {
      try {
        const { b64, ext } = validatePhoto({ data:d.image, ext:d.ext||'jpg' });
        const ts = Date.now();
        const fname = `${taskId}_chat_${ts}.${ext}`;
        fs.writeFileSync(path.join(WWP_FOTOS_DIR, fname), Buffer.from(b64,'base64'));
        _imgUrl = `/wwp-fotos/${fname}`;
      } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); return; }
    }
    if (!_txt && !_imgUrl) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Mensaje vacío'})); return; }
    const msg = {
      id: wwpId('msg'),
      fromId: jp.userId,
      fromName: jp.name,
      text: _txt,
      imageUrl: _imgUrl,
      createdAt: new Date().toISOString()
    };
    if (!tasks[idx].messages) tasks[idx].messages = [];
    tasks[idx].messages.push(msg);
    tasks[idx].updatedAt = msg.createdAt;
    saveWwpTasks(tasks);
    // Notificar a los participantes de la tarea (excepto quien envió)
    const task = tasks[idx];
    const recipients = new Set();
    if (task.managerId && task.managerId !== jp.userId) recipients.add(task.managerId);
    const assigneeId = odooStrToAuthId(task.assignedTo);
    if (assigneeId && assigneeId !== jp.userId) recipients.add(assigneeId);
    if (task.createdBy && task.createdBy !== jp.userId) recipients.add(task.createdBy);
    recipients.forEach(uid => createNotification(uid, {
      type: 'comment_new',
      title: '💬 Mensaje nuevo',
      message: msg.text ? `${jp.name}: "${msg.text.length>60?msg.text.slice(0,57)+'…':msg.text}"` : `${jp.name} envió una foto 📷`,
      relatedTaskId: taskId,
      by: jp.name
    }));
    // Push SSE del mensaje nuevo a todos los que tienen el drawer abierto
    // (incluyendo al sender para multi-tab sync)
    const allParticipants = new Set([task.managerId, assigneeId, task.createdBy].filter(Boolean));
    const sseData = `data: ${JSON.stringify({event:'chat_message', taskId, message:msg})}\n\n`;
    allParticipants.forEach(uid => {
      (sseClients.get(uid)||new Set()).forEach(r => { try { r.write(sseData); } catch {} });
    });
    broadcastWwpTasks('message_created', task, { taskId, message: msg });
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, message:msg}));
    return;
  }

  // POST /api/wwp/tasks — crear tarea (padre o subtarea) [admin|manager]
  if (reqPath === '/api/wwp/tasks' && req.method === 'POST') {
    const _jpTask = requireJwt(req, res); if (!_jpTask) return;
    if (!requireRole(_jpTask, res, ROLE_PERMISSIONS.create_task)) return;
    try {
      const d = await readBody(req);
      if (!d.title || !d.type) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Faltan campos: title y type son requeridos'})); return; }
      if (typeof d.title === 'string' && d.title.trim().length > 255) { res.writeHead(422,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Título máx 255 caracteres'})); return; }
      if (typeof d.description === 'string' && d.description.length > 5000) { res.writeHead(422,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Descripción máx 5000 caracteres'})); return; }
      const _validTypes     = ['dispatch_order','packaging','item_pickup','truck_loading','warehouse_move','general'];
      const _validPriorities= ['low','medium','high','urgent'];
      if (!_validTypes.includes(d.type)) { res.writeHead(422,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tipo de tarea inválido'})); return; }
      if (d.priority && !_validPriorities.includes(d.priority)) { res.writeHead(422,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Prioridad inválida'})); return; }
      if (d.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(d.dueDate)) { res.writeHead(422,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Formato de fecha inválido (YYYY-MM-DD)'})); return; }
      const now = new Date().toISOString();
      const isSubtask = !!(d.parentId);
      const task = {
        id: wwpId('wt'),
        seq: isSubtask ? null : nextTaskSeq(),   // número de secuencia (solo tareas principales)
        parentId: d.parentId||null,          // null = tarea principal
        title: d.title.trim(),
        type: d.type,
        description: d.description||'',
        priority: d.priority||'medium',
        status: 'pending',
        assignedTo: d.assignedTo||null,       // Encargado (solo tareas principales)
        managerId: d.managerId||null,          // Auth user ID del encargado
        managerName: d.managerName||null,      // Nombre del encargado
        executors: Array.isArray(d.executors) ? d.executors : [],  // Auxiliares (subtareas)
        assignees: Array.isArray(d.assignees) ? d.assignees : [],  // Múltiples encargados (auth user IDs)
        odooRef: d.odooRef||'',
        client: d.client||'',                 // cliente (de Odoo) — contexto para la cadena
        salesperson: d.salesperson||'',       // vendedor
        deliveryAddress: d.deliveryAddress||'', // dirección de entrega
        phone: d.phone||'',                   // teléfono del destinatario
        location: d.location||'',
        dueDate: d.dueDate||null,
        actionNote: d.actionNote||'',
        dependsOnPrev: isSubtask ? !!d.dependsOnPrev : false, // cadena: requiere paso anterior completado
        subIndex: null,                       // posición en la cadena (se asigna abajo)
        evidence: [],
        fotos_guia: [],
        statusHistory: [{ status:'pending', date:now, by:d.createdBy||'', note:'' }],
        createdBy: d.createdBy||'',
        createdAt: now,
        updatedAt: now
      };
      const tasks = loadWwpTasks();
      // Numeración de cadena: posición de la subtarea entre sus hermanas
      if (isSubtask) {
        task.subIndex = tasks.filter(x => x.parentId === task.parentId).length + 1;
      }
      // Con encargado (assignedTo/managerId) o auxiliares (executors) → marcar 'assigned'.
      // No saltamos a in_progress: el inicio es explícito (y puede depender del paso anterior).
      if (task.assignedTo || task.managerId || (isSubtask && task.executors.length > 0)) {
        task.status='assigned';
        task.statusHistory.push({ status:'assigned', date:now, by:d.createdBy||'', note:d.note||'' });
      }
      tasks.push(task);
      // Si es subtarea, marcar tarea padre como in_progress si estaba assigned
      if (isSubtask && d.parentId) {
        const pIdx = tasks.findIndex(t=>t.id===d.parentId);
        if (pIdx!==-1 && tasks[pIdx].status==='assigned') {
          tasks[pIdx].status='in_progress';
          tasks[pIdx].statusHistory.push({ status:'in_progress', date:now, by:'system', note:'Primera subtarea creada' });
          tasks[pIdx].updatedAt=now;
        }
      }
      saveWwpTasks(tasks);
      // ── Notificaciones al crear tarea ────────────────────────────────
      try {
        const byName = d.by || 'Sistema';
        if (task.managerId) {
          createNotification(task.managerId, {
            type:'task_assigned',
            title: task.parentId ? '📋 Subtarea asignada' : '📋 Nueva tarea asignada',
            message:`"${task.title}"${task.odooRef?' · '+task.odooRef:''}${task.dueDate?' · Vence: '+task.dueDate:''}`,
            relatedTaskId:task.id, priority:task.priority, dueDate:task.dueDate, by:byName
          });
        }
        const assigneeAuthId = odooStrToAuthId(task.assignedTo);
        if (assigneeAuthId && assigneeAuthId !== task.managerId) {
          createNotification(assigneeAuthId, {
            type:'task_assigned',
            title:'📋 Tarea asignada',
            message:`"${task.title}"${task.dueDate?' · Vence: '+task.dueDate:''}`,
            relatedTaskId:task.id, priority:task.priority, dueDate:task.dueDate, by:byName
          });
        }
      } catch(ne) { console.error('Notif error:', ne.message); }
      broadcastWwpTasks(isSubtask ? 'subtask_created' : 'task_created', task, { parentId: task.parentId });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,task}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // PATCH /api/wwp/tasks/:id — actualizar tarea [JWT requerido; permisos según rol]
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+$/) && req.method === 'PATCH') {
    const jp = requireJwt(req, res); if (!jp) return;
    const id = reqPath.split('/')[4];
    try {
      const d = await readBody(req);
      const tasks = loadWwpTasks();
      const idx = tasks.findIndex(t=>t.id===id);
      if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }

      // ── RBAC granular ────────────────────────────────────────────────────
      const isAdminOrMgr = ROLE_PERMISSIONS.edit_task.includes(jp.role);
      if (!isAdminOrMgr) {
        // Auxiliar: solo puede cambiar status (in_progress o completed) en tareas propias
        const task = tasks[idx];
        const myAuthId = jp.userId;
        const myOdooStr = 'oe_' + jp.odooId;
        const isParticipant = task.managerId === myAuthId ||
                              task.assignedTo === myOdooStr ||
                              (task.executors||[]).some(e => e === myOdooStr || e === myAuthId) ||
                              (task.assignees||[]).includes(myAuthId);
        if (!isParticipant) {
          res.writeHead(403,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'No tienes permiso para modificar esta tarea'}));
          return;
        }
        // Solo se permite cambiar 'status' y campos de evidencia/nota
        const ASSISTANT_ALLOWED_FIELDS = new Set(['status','note','by','byUserId']);
        const forbidden = Object.keys(d).filter(k => !ASSISTANT_ALLOWED_FIELDS.has(k));
        if (forbidden.length) {
          res.writeHead(403,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:`Auxiliar no puede modificar: ${forbidden.join(', ')}`}));
          return;
        }
        // Auxiliar no puede validar ni devolver a pending
        if (d.status && !['in_progress','completed'].includes(d.status)) {
          res.writeHead(403,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Auxiliar solo puede pasar a En Progreso o Completado'}));
          return;
        }
      }
      // Solo admin puede validar
      if (d.status === 'validated' && jp.role !== 'admin') {
        res.writeHead(403,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false,error:'Solo administradores pueden validar tareas'}));
        return;
      }
      // ── Fin RBAC ─────────────────────────────────────────────────────────

      const oldTask = {...tasks[idx]}; // snapshot antes de modificar (para comparar en notifs)
      const now = new Date().toISOString();
      if (d.status && d.status!==tasks[idx].status) {
        // ── Cadena: dependencia del paso anterior al INICIAR una subtarea ──
        if (d.status==='in_progress' && tasks[idx].parentId && tasks[idx].dependsOnPrev) {
          const sibs = tasks.filter(x => x.parentId===tasks[idx].parentId);
          const prev = sibs.find(x => (x.subIndex||0) === ((tasks[idx].subIndex||0) - 1));
          if (prev && !['completed','validated'].includes(prev.status)) {
            res.writeHead(409,{'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:false,error:`No puedes iniciar este paso hasta completar el anterior: "${prev.title}"`}));
            return;
          }
        }
        // ── Cierre de la madre bloqueado si quedan subtareas abiertas ──
        if ((d.status==='completed'||d.status==='validated') && !tasks[idx].parentId) {
          const children = tasks.filter(x => x.parentId===tasks[idx].id);
          const abiertas = children.filter(c => !['completed','validated'].includes(c.status));
          if (abiertas.length>0) {
            res.writeHead(409,{'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:false,error:`Faltan ${abiertas.length} subtarea(s) por completar en la cadena antes de cerrar.`}));
            return;
          }
        }
        // Validar evidencias de artículos antes de completar/validar
        if (d.status==='completed'||d.status==='validated') {
          const selItems=(tasks[idx].items||[]).filter(it=>it.selected);
          const missing=selItems.filter(it=>!it.evidence_images||it.evidence_images.length===0);
          if (missing.length>0) {
            res.writeHead(422,{'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:false,error:'Faltan evidencias para: '+missing.map(it=>it.product_name).join(', ')}));
            return;
          }
          const sinConfirmarItems=selItems.filter(it=>!it.confirmado);
          if (sinConfirmarItems.length>0) {
            res.writeHead(422,{'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:false,error:`Faltan confirmar ${sinConfirmarItems.length} artículo(s) antes de completar`}));
            return;
          }
        }
        tasks[idx].status=d.status;
        tasks[idx].statusHistory.push({ status:d.status, date:now, by:d.by||'', note:d.note||'' });
        // Audit log para estados críticos
        if (d.status==='validated'||d.status==='in_progress') {
          appendAuditLog('task_status_change', { taskId:tasks[idx].id, taskTitle:tasks[idx].title, prevStatus:oldTask.status, newStatus:d.status, by:jp.userId, note:d.note||'' });
        }
      }
      if (d.assignedTo!==undefined) tasks[idx].assignedTo=d.assignedTo;
      if (d.managerId!==undefined) tasks[idx].managerId=d.managerId;
      if (d.managerName!==undefined) tasks[idx].managerName=d.managerName;
      // Auto-transición a 'assigned' si se asigna encargado y la tarea sigue pendiente
      // (sin que el cliente haya enviado un status explícito). Mantiene consistencia con POST.
      if (!d.status && tasks[idx].status==='pending' && !tasks[idx].parentId &&
          (d.assignedTo || d.managerId)) {
        tasks[idx].status='assigned';
        tasks[idx].statusHistory.push({ status:'assigned', date:now, by:d.by||'', note:d.note||'' });
      }
      if (d.dependsOnPrev!==undefined && tasks[idx].parentId) tasks[idx].dependsOnPrev=!!d.dependsOnPrev;
      if (d.executors!==undefined) tasks[idx].executors=Array.isArray(d.executors)?d.executors:[];
      // auxiliaryAssignees: auth user IDs de auxiliares (enviados por el frontend cuando role=manager asigna)
      if (d.auxiliaryAssignees!==undefined) tasks[idx].assignees=Array.isArray(d.auxiliaryAssignees)?d.auxiliaryAssignees:[];
      else if (d.assignees!==undefined) tasks[idx].assignees=Array.isArray(d.assignees)?d.assignees:[];
      if (d.title!==undefined) tasks[idx].title=d.title.trim();
      if (d.description!==undefined) tasks[idx].description=d.description;
      if (d.priority!==undefined) tasks[idx].priority=d.priority;
      if (d.odooRef!==undefined) tasks[idx].odooRef=d.odooRef;
      if (d.client!==undefined) tasks[idx].client=d.client;
      if (d.salesperson!==undefined) tasks[idx].salesperson=d.salesperson;
      if (d.deliveryAddress!==undefined) tasks[idx].deliveryAddress=d.deliveryAddress;
      if (d.phone!==undefined) tasks[idx].phone=d.phone;
      if (d.location!==undefined) tasks[idx].location=d.location;
      if (d.dueDate!==undefined) tasks[idx].dueDate=d.dueDate;
      if (d.actionNote!==undefined) tasks[idx].actionNote=d.actionNote;
      tasks[idx].updatedAt=now;
      // ── Auto-completar tarea padre si todas las subtareas están done ──────
      const parentId = tasks[idx].parentId;
      if (parentId && (d.status==='completed'||d.status==='validated')) {
        const pIdx = tasks.findIndex(t=>t.id===parentId);
        if (pIdx!==-1 && tasks[pIdx].status!=='completed' && tasks[pIdx].status!=='validated') {
          const siblings = tasks.filter(t=>t.parentId===parentId);
          const allDone = siblings.every(t=>t.status==='completed'||t.status==='validated');
          if (allDone) {
            tasks[pIdx].status='completed';
            tasks[pIdx].updatedAt=now;
            tasks[pIdx].statusHistory.push({ status:'completed', date:now, by:'system', note:'Todas las subtareas completadas' });
          }
        }
      }
      saveWwpTasks(tasks);
      // ── Notificaciones en actualización de tarea ─────────────────────
      try {
        const t2 = tasks[idx];
        const byName = d.by || 'Sistema';
        // Cambio de managerId → notificar nuevo manager
        if (d.managerId !== undefined && d.managerId && d.managerId !== (oldTask?.managerId)) {
          createNotification(d.managerId, {
            type:'task_assigned', title:'📋 Tarea asignada',
            message:`"${t2.title}"${t2.dueDate?' · Vence: '+t2.dueDate:''}`,
            relatedTaskId:t2.id, priority:t2.priority, dueDate:t2.dueDate, by:byName
          });
        }
        // Cambio de assignedTo → notificar nuevo asignado
        if (d.assignedTo !== undefined && d.assignedTo && d.assignedTo !== oldTask?.assignedTo) {
          const uid = odooStrToAuthId(d.assignedTo);
          if (uid) createNotification(uid, {
            type:'task_assigned', title:'📋 Tarea asignada',
            message:`"${t2.title}"${t2.dueDate?' · Vence: '+t2.dueDate:''}`,
            relatedTaskId:t2.id, priority:t2.priority, dueDate:t2.dueDate, by:byName
          });
        }
        // Cambio de assignees → notificar a los nuevos asignados
        if (d.assignees !== undefined && Array.isArray(d.assignees)) {
          const oldAssignees = oldTask?.assignees || [];
          d.assignees.filter(uid => uid && !oldAssignees.includes(uid)).forEach(uid => {
            createNotification(uid, {
              type:'task_assigned', title:'📋 Tarea asignada',
              message:`"${t2.title}"${t2.dueDate?' · Vence: '+t2.dueDate:''}`,
              relatedTaskId:t2.id, priority:t2.priority, dueDate:t2.dueDate, by:byName
            });
          });
        }
        // Cambio de estado
        if (d.status && d.status !== oldTask?.status) {
          const recipients = [...new Set([t2.managerId, odooStrToAuthId(t2.assignedTo),
            ...(t2.executors||[]).map(e=>odooStrToAuthId(e)),
            ...(t2.assignees||[])].filter(Boolean))];
          const STATUS_MSG = {
            assigned    :['task_assigned','✅ Tarea asignada','Ha sido asignada'],
            in_progress :['status_changed','▶️ Tarea iniciada','Cambió a En Progreso'],
            completed   :['task_completed','✅ Tarea completada','Está lista para validar'],
            validated   :['task_validated','🎉 Tarea validada','Ha sido validada'],
            pending     :['task_rejected','↩️ Tarea devuelta','Fue devuelta a Pendiente'],
          };
          const [type,prefix,suffix] = STATUS_MSG[d.status]||['status_changed','🔄 Estado actualizado',''];
          recipients.forEach(uid => {
            // No notificar al que hizo el cambio
            if (uid === d.byUserId) return;
            createNotification(uid, {
              type, title:prefix,
              message:`"${t2.title}" — ${suffix}`,
              relatedTaskId:t2.id, priority:t2.priority, dueDate:t2.dueDate, by:byName
            });
          });
        }
      } catch(ne) { console.error('Notif PATCH error:', ne.message); }
      // Devolver también la tarea padre actualizada si cambió
      const parentTask = parentId ? tasks.find(t=>t.id===parentId)||null : null;
      broadcastWwpTasks('task_updated', tasks[idx], { parentTask, changed: Object.keys(d||{}) });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,task:tasks[idx],parentTask}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // DELETE /api/wwp/tasks/:id  (también elimina subtareas si es tarea padre) [admin|manager]
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+$/) && req.method === 'DELETE') {
    const _jpDel = requireJwt(req, res); if (!_jpDel) return;
    if (!requireRole(_jpDel, res, ROLE_PERMISSIONS.delete_task)) return;
    const id = reqPath.split('/')[4];
    let tasks = loadWwpTasks();
    const before = tasks.length;
    // Eliminar la tarea y todas sus subtareas
    tasks = tasks.filter(t=>t.id!==id && t.parentId!==id);
    if (tasks.length===before) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
    saveWwpTasks(tasks);
    broadcastWwpTasks('task_deleted', null, { taskId:id });
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true}));
    return;
  }

  // POST /api/wwp/tasks/:id/evidence — subir evidencia (base64) [cualquier rol]
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/evidence$/) && req.method === 'POST') {
    const _jpEv = requireJwt(req, res); if (!_jpEv) return;
    const id = reqPath.split('/')[4];
    try {
      const d = await readBody(req); // {fotos:[{data,ext,caption}]}
      const tasks = loadWwpTasks();
      const idx = tasks.findIndex(t=>t.id===id);
      if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
      if (!tasks[idx].evidence) tasks[idx].evidence=[];
      const saved=[];
      (d.fotos||[]).forEach((f,fi)=>{
        const { b64, ext } = validatePhoto(f);
        const fname=`${id}_${Date.now()}_${fi}.${ext}`;
        const fpath=path.join(WWP_FOTOS_DIR,fname);
        fs.writeFileSync(fpath,Buffer.from(b64,'base64'));
        const entry={url:`/wwp-fotos/${fname}`,caption:f.caption||'',date:new Date().toISOString(),by:d.by||''};
        tasks[idx].evidence.push(entry);
        saved.push(entry);
      });
      tasks[idx].updatedAt=new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('evidence_created', tasks[idx], { taskId:id, evidence:saved });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,evidence:saved,total:tasks[idx].evidence.length}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // DELETE /api/wwp/tasks/:id/evidence/:fname [admin|manager]
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/evidence\/.+$/) && req.method === 'DELETE') {
    const _jpEvDel = requireJwt(req, res); if (!_jpEvDel) return;
    if (!requireRole(_jpEvDel, res, ROLE_PERMISSIONS.edit_task)) return;
    const parts=reqPath.split('/');
    const id=parts[4], fname=parts[6];
    const tasks=loadWwpTasks();
    const idx=tasks.findIndex(t=>t.id===id);
    if (idx===-1){ res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
    tasks[idx].evidence=(tasks[idx].evidence||[]).filter(e=>!e.url.endsWith(fname));
    const fpath=path.join(WWP_FOTOS_DIR,fname);
    if(fs.existsSync(fpath)) try{fs.unlinkSync(fpath);}catch(e){}
    tasks[idx].updatedAt=new Date().toISOString();
    saveWwpTasks(tasks);
    broadcastWwpTasks('evidence_deleted', tasks[idx], { taskId:id, file:fname });
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true}));
    return;
  }

  // GET /api/wwp/lunch/breaks — reporte almuerzos [admin, con filtros ?date=&userId=]
  if (reqPath === '/api/wwp/lunch/breaks' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireRole(jp, res, ROLE_PERMISSIONS.dashboard)) return;
    const qp = parsed.query || {};
    const filterDate   = (qp.date   || '').trim() || new Date().toISOString().slice(0,10);
    const filterUserId = (qp.userId || '').trim();
    const users = loadAuthUsers();
    let breaks = loadLunchBreaks().filter(b => b.date === filterDate);
    if (filterUserId) breaks = breaks.filter(b => b.userId === filterUserId);
    // Enriquecer registros abiertos con duración actual
    const nowMs = Date.now();
    const enriched = breaks.map(b => {
      const current = b.endTime ? b.totalMinutes : Math.round((nowMs - new Date(b.startTime).getTime()) / 60000);
      const exceeded = b.endTime ? b.exceededMinutes : Math.max(0, current - b.allowedMinutes);
      return { ...b, currentMinutes: current, currentExceeded: exceeded, isOpen: !b.endTime };
    });
    // Métricas agregadas
    const closed = enriched.filter(b => !b.isOpen);
    const avgMinutes = closed.length ? Math.round(closed.reduce((s,b)=>s+b.totalMinutes,0)/closed.length) : 0;
    const exceeded = enriched.filter(b => b.currentExceeded > 0).length;
    const compliant = closed.filter(b => b.compliant).length;
    // Incluir todos los usuarios activos del día como contexto
    const usersToday = users.filter(u => u.active).map(u => ({
      id:u.id, name:u.name, role:u.role, lunchTimeAllowed:u.lunchTimeAllowed||60,
      presenceStatus:u.presenceStatus||'active',
    }));
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, date:filterDate, breaks:enriched, metrics:{avgMinutes,exceeded,compliant,total:enriched.length}, users:usersToday}));
    return;
  }

  // GET /api/wwp/lunch/today — breaks del propio usuario en el día de hoy
  if (reqPath === '/api/wwp/lunch/today' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    const today = new Date().toISOString().slice(0,10);
    const breaks = loadLunchBreaks().filter(b => b.userId === jp.userId && b.date === today);
    const users = loadAuthUsers();
    const user = users.find(u => u.id === jp.userId);
    const nowMs = Date.now();
    const enriched = breaks.map(b => {
      const current = b.endTime ? b.totalMinutes : Math.round((nowMs - new Date(b.startTime).getTime()) / 60000);
      return { ...b, currentMinutes: current, isOpen: !b.endTime };
    });
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, breaks:enriched, lunchTimeAllowed:user?.lunchTimeAllowed||60, totalMinutesToday:enriched.reduce((s,b)=>s+(b.totalMinutes||0),0)}));
    return;
  }

  // GET /api/wwp/dashboard — KPIs (solo admin)
  if (reqPath === '/api/wwp/dashboard' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireRole(jp, res, ROLE_PERMISSIONS.dashboard)) return;
    const tasks = loadWwpTasks();
    const users = loadAuthUsers();
    const byStatus = {};
    const byType   = {};
    const byUser   = {};
    let totalMs=0, countCompleted=0;
    const STATUSES=['pending','assigned','in_progress','completed','validated'];
    const TYPES=['packing','furniture_movement','project_work'];
    STATUSES.forEach(s=>byStatus[s]=0);
    TYPES.forEach(t=>byType[t]=0);
    tasks.forEach(t=>{
      if (byStatus[t.status]!==undefined) byStatus[t.status]++;
      if (byType[t.type]!==undefined) byType[t.type]++;
      if (t.assignedTo) byUser[t.assignedTo]=(byUser[t.assignedTo]||0)+1;
      if (t.status==='completed'||t.status==='validated') {
        const start=new Date(t.createdAt).getTime();
        const end=new Date(t.updatedAt).getTime();
        totalMs+=(end-start); countCompleted++;
      }
    });
    const avgHours = countCompleted>0 ? Math.round(totalMs/countCompleted/3600000*10)/10 : 0;
    const recent = tasks.slice().sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt)).slice(0,10);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ byStatus, byType, byUser, avgHours, total:tasks.length, recent }));
    return;
  }

  // GET /api/wwp/inspections — listar inspecciones (admin, filtros ?date=&plate=)
  if (reqPath === '/api/wwp/inspections' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireRole(jp, res, ROLE_PERMISSIONS.dashboard)) return;
    const qp = parsed.query || {};
    let data = loadInspections();
    if (qp.date)  data = data.filter(i => i.fecha && i.fecha.startsWith(qp.date));
    if (qp.plate) data = data.filter(i => i.placa && i.placa.toLowerCase().includes(qp.plate.toLowerCase()));
    data = data.slice().sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, inspections: data}));
    return;
  }

  // POST /api/wwp/inspections — crear inspección (cualquier usuario autenticado)
  if (reqPath === '/api/wwp/inspections' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'JSON inválido'})); return; }
    const required = ['placa','conductor','momento'];
    for (const f of required) {
      if (!payload[f]) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:`Campo requerido: ${f}`})); return; }
    }
    const now = new Date().toISOString();
    const insp = {
      id: 'insp_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      placa:       (payload.placa||'').trim().toUpperCase(),
      modelo:      (payload.modelo||'').trim(),
      conductor:   (payload.conductor||'').trim(),
      momento:     payload.momento,
      odometro:    payload.odometro || null,
      combustible: payload.combustible || null,
      checklist:   payload.checklist  || {},
      observaciones: (payload.observaciones||'').trim(),
      fotos:       Array.isArray(payload.fotos) ? payload.fotos : [],
      fecha:       now.slice(0,10),
      createdAt:   now,
      createdBy:   jp.userId,
      createdByName: (loadAuthUsers().find(u=>u.id===jp.userId)||{}).name || jp.userId,
    };
    const all = loadInspections();
    all.push(insp);
    saveInspections(all);
    res.writeHead(201, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, inspection: insp}));
    return;
  }

  // DELETE /api/wwp/inspections/:id — eliminar (admin)
  if (reqPath.match(/^\/api\/wwp\/inspections\/[^/]+$/) && req.method === 'DELETE') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireRole(jp, res, ROLE_PERMISSIONS.dashboard)) return;
    const id = reqPath.split('/')[4];
    let all = loadInspections();
    const idx = all.findIndex(i => i.id === id);
    if (idx < 0) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'No encontrada'})); return; }
    all.splice(idx, 1);
    saveInspections(all);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true}));
    return;
  }

  // ── Alias frontend: /api/vehiculos/* ─────────────────────────────────────
  // El formulario HTML llama a estas rutas; internamente usan wwp-inspecciones.json

  // GET /api/vehiculos/inspecciones — listar (filtro ?vehiculo=)
  if (reqPath === '/api/vehiculos/inspecciones' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    const qp = parsed.query || {};
    let data = loadInspections();
    if (qp.vehiculo) data = data.filter(i => i.vehiculo && i.vehiculo.toLowerCase().includes(qp.vehiculo.toLowerCase()));
    data = data.slice().sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(data));
    return;
  }

  // POST /api/vehiculos/inspeccion — guardar inspección
  if (reqPath === '/api/vehiculos/inspeccion' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    let payload;
    try { payload = await readBody(req); } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'JSON inválido: '+e.message})); return; }
    if (!payload.vehiculo && !payload.placa) {
      res.writeHead(400,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Campo requerido: vehiculo o placa'}));
      return;
    }
    const now = new Date().toISOString();
    const insp = Object.assign({}, payload, {
      id:          'insp_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      createdAt:   now,
      createdBy:   jp.userId,
      createdByName: (loadAuthUsers().find(u=>u.id===jp.userId)||{}).name || jp.userId,
    });
    const all = loadInspections();
    all.push(insp);
    saveInspections(all);
    res.writeHead(201, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, id: insp.id}));
    return;
  }

  // DELETE /api/vehiculos/inspeccion/:id — eliminar
  if (reqPath.match(/^\/api\/vehiculos\/inspeccion\/[^/]+$/) && req.method === 'DELETE') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireRole(jp, res, ROLE_PERMISSIONS.dashboard)) return;
    const id = reqPath.split('/')[4];
    let all = loadInspections();
    const idx = all.findIndex(i => i.id === id);
    if (idx < 0) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'No encontrada'})); return; }
    all.splice(idx, 1);
    saveInspections(all);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true}));
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  // GET /api/wwp/odoo/orders?q= — buscar órdenes Odoo para asociar a tarea
  if (reqPath === '/api/wwp/odoo/orders' && req.method === 'GET') {
    const q = ((parsed.query||{}).q||'').trim();
    if (!q) { res.writeHead(200,{'Content-Type':'application/json'}); res.end('[]'); return; }
    try {
      const domain=[['name','ilike',q],['state','in',['sale','done']]];
      const orders = await odooCall('sale.order','search_read',[domain],{fields:['name','partner_id','state','date_order'],limit:10,order:'date_order desc'});
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(orders||[]));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // GET /api/wwp/odoo-order/:ref — artículos de orden, transferencia o artículo Odoo
  if (reqPath.match(/^\/api\/wwp\/odoo-order\/[^/]+$/) && req.method === 'GET') {
    const ref = decodeURIComponent(reqPath.split('/')[4]).trim();

    // Helper: obtener stock por ubicación para un array de productIds
    async function fetchStockMap(productIds) {
      const stockMap = {};
      if (!productIds.length) return stockMap;
      try {
        const quants = await odooCall('stock.quant','search_read',
          [[['product_id','in',productIds],['location_id.usage','=','internal'],['quantity','>',0]]],
          {fields:['product_id','location_id','quantity','reserved_quantity'],limit:2000});
        const locIds=[...new Set(quants.map(q=>q.location_id[0]))];
        const locs = locIds.length ? await odooCall('stock.location','read',[locIds],{fields:['id','complete_name','name']}) : [];
        const locMap={}; locs.forEach(l=>{ locMap[l.id]=l; });
        quants.forEach(q=>{
          const pid=q.product_id[0];
          if(!stockMap[pid]) stockMap[pid]=[];
          const loc=locMap[q.location_id[0]]||{};
          const avail=Math.max(0,(q.quantity||0)-(q.reserved_quantity||0));
          if(avail>0) stockMap[pid].push({
            location_id:q.location_id[0],
            location_name:loc.complete_name||loc.name||q.location_id[1]||'Desconocida',
            available:avail, total:q.quantity||0,
          });
        });
        Object.keys(stockMap).forEach(pid=>{ stockMap[pid].sort((a,b)=>b.available-a.available); });
      } catch(e) { /* stock info es opcional */ }
      return stockMap;
    }

    // Helper: construir items desde productIds + lines
    // Cantidad (unidades) desde la DEMANDA de Odoo con cadena de respaldo:
    //   product_uom_qty (Demanda — fiable en todo estado/tipo)
    //   → quantity_done (lo ya hecho)  → reserved_availability  → 1
    // Reservado/Hecho NO son fiables solos: caen a 0 en picks con existencia cero o ya completados.
    function resolveDemandQty(l) {
      const q = l.product_uom_qty || l.quantity_done || l.qty_done || l.reserved_availability || l.quantity || 1;
      return Math.max(1, Math.round(q));
    }
    function buildItems(lines, prodMap, stockMap) {
      return lines.filter(l=>l.product_id).map(l=>{
        const prod=prodMap[l.product_id[0]]||{};
        const locations=stockMap[l.product_id[0]]||[];
        const units = resolveDemandQty(l);
        return { item_id:'oi_'+l.id, odoo_line_id:l.id, odoo_product_id:l.product_id[0],
          sku:prod.barcode||prod.default_code||'', barcode:prod.barcode||'',  // barcode explícito para escaneo
          product_name:l.product_id[1]||l.name||'',
          quantity:units, units,                 // units = unidades de la Demanda (editable)
          image:prod.image_128?'data:image/png;base64,'+prod.image_128:null,
          locations, selected_location:locations.length===1?0:null,
          selected:false, evidence_images:[], comments:'', status:'pending' };
      });
    }

    try {
      // ── 1. Intentar como ORDEN DE VENTA ────────────────────────────
      const orders = await odooCall('sale.order','search_read',
        [[['name','ilike',ref]]],{fields:['id','name','order_line','partner_id','partner_shipping_id','user_id'],limit:1});
      if (orders && orders.length) {
        const order=orders[0];
        const salesperson = order.user_id ? order.user_id[1] : '';
        // Dirección de entrega + teléfono del destinatario (partner de envío, o cliente)
        let deliveryAddress='', phone='';
        try {
          const shipId = (order.partner_shipping_id && order.partner_shipping_id[0]) || (order.partner_id && order.partner_id[0]);
          if (shipId) {
            const ps = await odooCall('res.partner','read',[[shipId]],{fields:['contact_address','street','street2','city','phone','mobile']});
            if (ps && ps.length) {
              const p=ps[0];
              deliveryAddress = (p.contact_address || [p.street,p.street2,p.city].filter(Boolean).join(', ') || '').replace(/\n+/g,', ').replace(/, ,/g,',').trim();
              phone = p.phone || p.mobile || '';
            }
          }
        } catch(e) { /* dirección es opcional */ }
        const baseResp = {ok:true,type:'order',ref:order.name,client:order.partner_id?order.partner_id[1]:'',salesperson,deliveryAddress,phone};
        // Ubicación desde el PICK preparado (assigned). Si no hay pick → fallback a líneas de la orden.
        const pickRes = await buildItemsFromPicks(order.name);
        if (!pickRes.noPick) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({...baseResp, noPick:false, pickNames:pickRes.pickNames, items:pickRes.items}));
          return;
        }
        // Sin pick preparado → devolver artículos de la orden (Demanda) marcando noPick
        const lineIds=order.order_line||[];
        if (!lineIds.length) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({...baseResp,noPick:true,items:[]})); return; }
        const lines = await odooCall('sale.order.line','read',[lineIds],{fields:['product_id','product_uom_qty','name']});
        const productIds=[...new Set(lines.filter(l=>l.product_id).map(l=>l.product_id[0]))];
        const products = productIds.length ? await odooCall('product.product','read',[productIds],{fields:['id','barcode','default_code','image_128']}) : [];
        const prodMap={}; products.forEach(p=>{ prodMap[p.id]=p; });
        const stockMap = await fetchStockMap(productIds);
        const items = buildItems(lines, prodMap, stockMap);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({...baseResp,noPick:true,items}));
        return;
      }

      // ── 2. Intentar como TRANSFERENCIA (stock.picking) ──────────────
      const picks = await odooCall('stock.picking','search_read',
        [[['name','ilike',ref]]],{fields:['id','name','partner_id','origin','picking_type_id','location_id','location_dest_id'],limit:1});
      if (picks && picks.length) {
        const pick=picks[0];
        const moves = await odooCall('stock.move','search_read',
          [[['picking_id','=',pick.id],['state','!=','cancel']]],
          {fields:['product_id','product_uom_qty','quantity_done','reserved_availability','name'],limit:100});
        const productIds=[...new Set(moves.filter(m=>m.product_id).map(m=>m.product_id[0]))];
        const products = productIds.length ? await odooCall('product.product','read',[productIds],{fields:['id','barcode','default_code','image_128']}) : [];
        const prodMap={}; products.forEach(p=>{ prodMap[p.id]=p; });
        const stockMap = await fetchStockMap(productIds);
        const items = buildItems(moves, prodMap, stockMap);
        const client = pick.partner_id?pick.partner_id[1]:(pick.origin||pick.name);
        const typeName = pick.picking_type_id?pick.picking_type_id[1]:'';
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,type:'transfer',ref:pick.name,client,transferType:typeName,origin:pick.origin||'',items}));
        return;
      }

      // ── 3. Intentar como ARTÍCULO (product.product por ref/código/nombre) ──
      const prods = await odooCall('product.product','search_read',
        [['|','|','|',['default_code','=',ref],['default_code','ilike',ref],['barcode','=',ref],['name','ilike',ref]]],
        {fields:['id','name','default_code','barcode','image_128'],limit:5});
      if (prods && prods.length) {
        const p=prods[0];
        const stockMap = await fetchStockMap([p.id]);
        const locations = stockMap[p.id]||[];
        const item = {
          item_id:'art_'+p.id, odoo_line_id:null, odoo_product_id:p.id,
          sku:p.default_code||p.barcode||'', product_name:p.name||'',
          quantity:1, image:p.image_128?'data:image/png;base64,'+p.image_128:null,
          locations, selected_location:locations.length===1?0:null,
          selected:true, evidence_images:[], comments:'', status:'pending'
        };
        const totalStock=locations.reduce((s,l)=>s+l.available,0);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,type:'article',needsTransfer:true,ref:p.default_code||p.name,client:p.name+(totalStock?' · '+totalStock+' en stock':''),items:[item]}));
        return;
      }

      // ── 4. No encontrado en ningún modelo ───────────────────────────
      res.writeHead(404,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'No encontrado en Odoo (orden, transferencia ni artículo)'}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // PUT /api/wwp/tasks/:id/items — guardar artículos seleccionados en tarea [admin|manager]
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/items$/) && req.method === 'PUT') {
    const _jpItems = requireJwt(req, res); if (!_jpItems) return;
    if (!requireRole(_jpItems, res, ROLE_PERMISSIONS.edit_task)) return;
    const id=reqPath.split('/')[4];
    try {
      const d=await readBody(req);
      const tasks=loadWwpTasks();
      const idx=tasks.findIndex(t=>t.id===id);
      if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
      const existMap={}; (tasks[idx].items||[]).forEach(e=>{ existMap[e.item_id]=e; });
      tasks[idx].items=(d.items||[]).map(item=>{
        const prev=existMap[item.item_id]||{};
        const selLocIdx = typeof item.selected_location==='number' ? item.selected_location : null;
        const selLocObj = (selLocIdx!==null && Array.isArray(item.locations)) ? (item.locations[selLocIdx]||null) : null;
        return { item_id:item.item_id, odoo_line_id:item.odoo_line_id||null, odoo_product_id:item.odoo_product_id||null,
          sku:item.sku||'', barcode:item.barcode||prev.barcode||'', product_name:item.product_name||'', quantity:item.quantity||0,
          image:item.image||prev.image||'',   // persistir foto del artículo (Odoo image_128)
          // Campos de unidad: una línea por unidad. group_ref agrupa las unidades del mismo artículo.
          units:item.units||1, unit_index:item.unit_index||null, unit_total:item.unit_total||null,
          group_ref:item.group_ref||item.item_id,
          // Ubicación desde el pick (bin por unidad). fromPick = ubicación fija del pick.
          fromPick: !!item.fromPick, pickName: item.pickName||prev.pickName||'',
          // Info de kit (componente de un set). kitInstance agrupa unidades del mismo kit armado.
          kitId: item.kitId||prev.kitId||null, kitRef: item.kitRef||prev.kitRef||'',
          kitName: item.kitName||prev.kitName||'', kitImage: item.kitImage||prev.kitImage||'',
          // Tarjeta-kit sintética (cuando el kit está armado)
          ...(item.isKit||prev.isKit ? { isKit:true, armado:!!(item.armado??prev.armado), kitInstance:item.kitInstance||prev.kitInstance||1 } : {}),
          selected:!!item.selected,
          locations:item.locations||[],
          selected_location:selLocIdx,
          // bin explícito del pick tiene prioridad; si no, el seleccionado de locations
          selected_location_name: item.selected_location_name || selLocObj?.location_name || null,
          // Condición del artículo: 'good' (buen estado) | 'damaged' (avería) + tipo de avería
          condition: item.condition||prev.condition||'good', damageType: item.damageType||prev.damageType||'',
          evidence_images:prev.evidence_images||[], comments:item.comments||prev.comments||'',
          confirmado:prev.confirmado||false, status:prev.status||'pending' };
      });
      tasks[idx].updatedAt=new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('items_updated', tasks[idx], { taskId:id, items:tasks[idx].items });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,items:tasks[idx].items}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // GET /api/wwp/tasks/:id/pick-diff — compara items de la tarea vs el pick actual de Odoo
  // Devuelve un resumen de cambios + la lista fusionada (preservando evidencias).
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/pick-diff$/) && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    const id = reqPath.split('/')[4];
    try {
      const t = loadWwpTasks().find(x => x.id === id);
      if (!t) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
      if (!t.odooRef) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,hasChanges:false,reason:'sin orden'})); return; }
      const pr = await buildItemsFromPicks(t.odooRef);
      if (pr.noPick) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,hasChanges:false,noPick:true})); return; }
      const sBin = b => (b||'').replace(/^ALVEN\/Stock\//i,'').replace(/^WH\/Stock\//i,'');
      // Unidades objetivo del pick agrupadas por producto
      const targByPid = {};
      pr.items.forEach(it => { (it.unitBins||[]).forEach(bin => {
        (targByPid[it.odoo_product_id] = targByPid[it.odoo_product_id] || []).push(
          { pid:it.odoo_product_id, bin:sBin(bin), sku:it.sku, barcode:it.barcode, name:it.product_name, image:it.image,
            kitId:it.kitId||null, kitRef:it.kitRef||'', kitName:it.kitName||'', kitImage:it.kitImage||'' });
      }); });
      // Kits ARMADOS actuales: se preservan tal cual (con su foto/condición). Sus
      // componentes quedan ocultos (selected:false) bajo el kit.
      const armadoKitItems = (t.items||[]).filter(i => i.isKit && i.selected);
      const armadoSet = new Set(armadoKitItems.map(k => (k.kitId||'')+'#'+(k.kitInstance||1)));
      // Unidades actuales (selected) por producto (excluye tarjetas-kit sintéticas)
      const current = (t.items||[]).filter(i => i.selected && !i.isKit);
      const curByPid = {};
      current.forEach(i => { (curByPid[i.odoo_product_id] = curByPid[i.odoo_product_id] || []).push(i); });
      const merged = []; let added=0, kept=0, relocated=0, retagged=0; const usedIds = new Set();
      Object.keys(targByPid).forEach(pidKey => {
        const arr = targByPid[pidKey]; const n = arr.length;
        const pool = (curByPid[pidKey] || []).slice(); // candidatos a reutilizar (mismo producto)
        arr.forEach((u, i) => {
          // Fase 1: match exacto producto+bin; Fase 2: mismo producto (cambió bin) → preserva foto
          let ri = pool.findIndex(c => (c.selected_location_name||'') === u.bin && !usedIds.has(c.item_id));
          if (ri < 0) ri = pool.findIndex(c => !usedIds.has(c.item_id));
          const reuse = ri >= 0 ? pool[ri] : null;
          const row = { item_id: n===1 ? ('oi_'+pidKey) : ('oi_'+pidKey+'_u'+(i+1)),
            odoo_product_id:Number(pidKey), odoo_line_id:null,
            sku:u.sku, barcode:u.barcode, product_name:u.name, image:u.image,
            quantity:1, units:n, unit_index:i+1, unit_total:n, group_ref:'oi_'+pidKey,
            fromPick:true, pickName:(pr.pickNames[0]||''),
            kitId:u.kitId||null, kitRef:u.kitRef||'', kitName:u.kitName||'', kitImage:u.kitImage||'',
            selected:true, locations:[], selected_location:null, selected_location_name:u.bin };
          if (reuse) {
            row.evidence_images=reuse.evidence_images||[]; row.confirmado=reuse.confirmado||false; row.status=reuse.status||'pending';
            usedIds.add(reuse.item_id); kept++;
            if ((reuse.selected_location_name||'') !== u.bin) relocated++; // cambió de bin
            if ((reuse.kitId||'') !== (u.kitId||'')) retagged++;            // info de kit faltante/cambiada
          }
          else { row.evidence_images=[]; row.confirmado=false; row.status='pending'; added++; }
          // Si la instancia del kit está armada, el componente queda oculto bajo la tarjeta-kit
          if (row.kitId && armadoSet.has(row.kitId+'#'+row.unit_index)) row.selected = false;
          merged.push(row);
        });
      });
      // Conservar las tarjetas-kit armadas tal cual (foto/condición intactas)
      armadoKitItems.forEach(k => { merged.push(k); usedIds.add(k.item_id); });
      const removed = current.filter(i => !usedIds.has(i.item_id));
      const removedWithPhotos = removed.filter(i => (i.evidence_images||[]).length>0).length;
      const hasChanges = added>0 || removed.length>0 || relocated>0 || retagged>0;
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, hasChanges, pickNames:pr.pickNames,
        summary:{ added, removed:removed.length, removedWithPhotos, kept, relocated, retagged },
        removedItems: removed.map(i=>({name:i.product_name, bin:i.selected_location_name, hasPhoto:(i.evidence_images||[]).length>0})),
        merged }));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // PATCH /api/wwp/tasks/:id/kit-toggle — armar/desarmar un kit (instancia) [cualquier rol participante]
  // Armado: oculta las piezas (selected:false) y activa una tarjeta-kit (1 foto del conjunto).
  // Desarmado: reactiva las piezas (selected:true) y desactiva la tarjeta-kit.
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/kit-toggle$/) && req.method === 'PATCH') {
    const _jpK = requireJwt(req, res); if (!_jpK) return;
    const id = reqPath.split('/')[4];
    try {
      const d = await readBody(req);
      const { kitId, instance, armado } = d;
      if (!kitId || !instance) throw new Error('Faltan kitId/instance');
      const tasks = loadWwpTasks();
      const idx = tasks.findIndex(t=>t.id===id);
      if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
      const items = tasks[idx].items||[];
      const comps = items.filter(it => it.kitId===kitId && (it.unit_index||1)===Number(instance) && !it.isKit);
      if (!comps.length) throw new Error('Kit/instancia sin componentes');
      const kf = comps[0];
      const kitItemId = 'kit_'+kitId.replace(/[^A-Za-z0-9_]/g,'')+'_'+instance;
      let kitItem = items.find(it => it.item_id===kitItemId);
      if (armado) {
        comps.forEach(c => { c.selected = false; });
        if (!kitItem) {
          kitItem = { item_id:kitItemId, isKit:true, kitId, kitInstance:Number(instance),
            product_name:(kf.kitName||kf.kitRef||'Kit')+' (armado)', sku:kf.kitRef||'', barcode:'',
            image:kf.kitImage||'', quantity:1, units:1, unit_index:Number(instance), unit_total:1, group_ref:kitItemId,
            selected:true, armado:true, evidence_images:[], condition:'good', damageType:'', confirmado:false, status:'pending', locations:[] };
          items.push(kitItem);
        } else { kitItem.selected=true; kitItem.armado=true; }
      } else {
        comps.forEach(c => { c.selected = true; });
        if (kitItem) { kitItem.selected=false; kitItem.armado=false; }
      }
      tasks[idx].items = items;
      tasks[idx].updatedAt = new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('items_updated', tasks[idx], { taskId:id });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, armado:!!armado}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // PATCH /api/wwp/tasks/:id/items/:itemId/condition — condición del artículo [cualquier rol participante]
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/items\/[A-Za-z0-9_]+\/condition$/) && req.method === 'PATCH') {
    const _jpC = requireJwt(req, res); if (!_jpC) return;
    const parts=reqPath.split('/'); const taskId=parts[4], itemId=parts[6];
    try {
      const d=await readBody(req);
      const VALID_DMG = ['Rayado','Con golpe','Desperfecto de pintura','Defecto de fábrica'];
      const condition = d.condition==='damaged' ? 'damaged' : 'good';
      const damageType = condition==='damaged' ? (VALID_DMG.includes(d.damageType)?d.damageType:(d.damageType||'')) : '';
      const tasks=loadWwpTasks();
      const idx=tasks.findIndex(t=>t.id===taskId);
      if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tarea no encontrada'})); return; }
      const itemIdx=(tasks[idx].items||[]).findIndex(it=>it.item_id===itemId);
      if (itemIdx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Artículo no encontrado'})); return; }
      tasks[idx].items[itemIdx].condition = condition;
      tasks[idx].items[itemIdx].damageType = damageType;
      tasks[idx].updatedAt=new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('items_updated', tasks[idx], { taskId, itemId });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, condition, damageType}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // POST /api/wwp/tasks/:id/items/:itemId/evidence — evidencia por artículo [cualquier rol]
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/items\/[A-Za-z0-9_]+\/evidence$/) && req.method === 'POST') {
    const _jpItemEv = requireJwt(req, res); if (!_jpItemEv) return;
    const parts=reqPath.split('/');
    const taskId=parts[4], itemId=parts[6];
    try {
      const d=await readBody(req);
      const tasks=loadWwpTasks();
      const idx=tasks.findIndex(t=>t.id===taskId);
      if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tarea no encontrada'})); return; }
      const itemIdx=(tasks[idx].items||[]).findIndex(it=>it.item_id===itemId);
      if (itemIdx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Artículo no encontrado'})); return; }
      if (!tasks[idx].items[itemIdx].evidence_images) tasks[idx].items[itemIdx].evidence_images=[];
      // ── Anti-duplicado: hashes de TODAS las evidencias de la tarea (todos los items)
      // Evita que se suba la misma foto a varias unidades para simular evidencias.
      const existingHashes = new Set();
      (tasks[idx].items||[]).forEach(it => (it.evidence_images||[]).forEach(e => { if (e.hash) existingHashes.add(e.hash); }));
      const saved=[];
      (d.fotos||[]).forEach((f,fi)=>{
        const { b64, ext } = validatePhoto(f);
        const hash = crypto.createHash('sha256').update(Buffer.from(b64,'base64')).digest('hex');
        if (existingHashes.has(hash)) {
          throw new Error('Esta foto ya fue subida en esta tarea. Toma una foto distinta para cada unidad.');
        }
        existingHashes.add(hash); // bloquea duplicados dentro del mismo lote
        const ts=Date.now();
        const fname=`${taskId}_${itemId}_${ts}_${fi}.${ext}`;
        const fpath=path.join(WWP_FOTOS_DIR,fname);
        fs.writeFileSync(fpath,Buffer.from(b64,'base64'));
        const entry={id:`ev_${ts}_${fi}`,url:`/wwp-fotos/${fname}`,hash,caption:f.caption||'',uploaded_by:d.by||'',uploaded_at:new Date().toISOString()};
        tasks[idx].items[itemIdx].evidence_images.push(entry); saved.push(entry);
      });
      if (tasks[idx].items[itemIdx].evidence_images.length>0) tasks[idx].items[itemIdx].status='evidenced';
      tasks[idx].updatedAt=new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('item_evidence_created', tasks[idx], { taskId, itemId, evidence:saved });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,evidence:saved}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // DELETE /api/wwp/tasks/:id/items/:itemId/evidence/:evId [admin|manager]
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/items\/[A-Za-z0-9_]+\/evidence\/.+$/) && req.method === 'DELETE') {
    const _jpItemEvDel = requireJwt(req, res); if (!_jpItemEvDel) return;
    if (!requireRole(_jpItemEvDel, res, ROLE_PERMISSIONS.edit_task)) return;
    const parts=reqPath.split('/');
    const taskId=parts[4], itemId=parts[6], evId=parts[8];
    const tasks=loadWwpTasks();
    const idx=tasks.findIndex(t=>t.id===taskId);
    if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false})); return; }
    const itemIdx=(tasks[idx].items||[]).findIndex(it=>it.item_id===itemId);
    if (itemIdx!==-1) {
      const evArr=tasks[idx].items[itemIdx].evidence_images||[];
      const evEntry=evArr.find(e=>e.id===evId||e.url.endsWith('/'+evId));
      if (evEntry) { try{fs.unlinkSync(path.join(WWP_FOTOS_DIR,path.basename(evEntry.url)));}catch(e){} }
      tasks[idx].items[itemIdx].evidence_images=evArr.filter(e=>e.id!==evId&&!e.url.endsWith('/'+evId));
      if (!tasks[idx].items[itemIdx].evidence_images.length) tasks[idx].items[itemIdx].status='pending';
    }
    tasks[idx].updatedAt=new Date().toISOString();
    saveWwpTasks(tasks);
    broadcastWwpTasks('item_evidence_deleted', tasks[idx], { taskId, itemId, evidenceId:evId });
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true}));
    return;
  }

  // PATCH /api/wwp/tasks/:id/items/:itemId/confirmar — confirmar artículo procesado
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/items\/[A-Za-z0-9_]+\/confirmar$/) && req.method === 'PATCH') {
    const _jpItemConf = requireJwt(req, res); if (!_jpItemConf) return;
    try {
      const parts = reqPath.split('/');
      const taskId = parts[4]; const itemId = parts[6];
      const d = await readBody(req);
      const tasks = loadWwpTasks();
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tarea no encontrada'})); return; }
      const itemIdx = (tasks[idx].items||[]).findIndex(it => it.item_id === itemId);
      if (itemIdx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Artículo no encontrado'})); return; }
      tasks[idx].items[itemIdx].confirmado = !!d.confirmado;
      tasks[idx].items[itemIdx].confirmado_by = d.confirmado ? (d.by||_jpItemConf.name||'') : null;
      tasks[idx].items[itemIdx].confirmado_at = d.confirmado ? new Date().toISOString() : null;
      tasks[idx].updatedAt = new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('item_confirmado', tasks[idx], { taskId, itemId, confirmado: !!d.confirmado });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, confirmado: !!d.confirmado}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── POST /api/wwp/tasks/:id/fotos-guia — subir fotos de guía visual ──────────
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/fotos-guia$/) && req.method === 'POST') {
    const _jpFg = requireJwt(req, res); if (!_jpFg) return;
    const taskId = reqPath.split('/')[4];
    try {
      const d = await readBody(req);
      const tasks = loadWwpTasks();
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tarea no encontrada'})); return; }
      if (!tasks[idx].fotos_guia) tasks[idx].fotos_guia = [];
      const saved = [];
      (d.fotos||[]).forEach((f, fi) => {
        const { b64, ext } = validatePhoto(f);
        const ts = Date.now();
        const fotoId = `fg_${ts}_${fi}`;
        const fname = `${taskId}_${fotoId}.${ext}`;
        fs.writeFileSync(path.join(WWP_FOTOS_DIR, fname), Buffer.from(b64, 'base64'));
        const entry = { id: fotoId, url: `/wwp-fotos/${fname}`, instruccion: f.instruccion||'', confirmado: false, evidencias: [], creado_by: d.by||'', creado_at: new Date().toISOString() };
        tasks[idx].fotos_guia.push(entry);
        saved.push(entry);
      });
      tasks[idx].updatedAt = new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('fotos_guia_created', tasks[idx], { taskId, fotos: saved });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, fotos: saved}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── DELETE /api/wwp/tasks/:id/fotos-guia/:fname — eliminar foto de guía ──────
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/fotos-guia\/[^/]+$/) && req.method === 'DELETE') {
    const _jpFgDel = requireJwt(req, res); if (!_jpFgDel) return;
    if (!requireRole(_jpFgDel, res, ROLE_PERMISSIONS.edit_task)) return;
    const parts = reqPath.split('/');
    const taskId = parts[4], fname = decodeURIComponent(parts[6]);
    const tasks = loadWwpTasks();
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false})); return; }
    const fgArr = tasks[idx].fotos_guia || [];
    const fgEntry = fgArr.find(f => f.url.endsWith('/'+fname) || f.id === fname);
    // ── Verificar propiedad de la foto ────────────────────────────────────
    if (fgEntry && _jpFgDel.role !== 'admin') {
      const authUsers   = loadAuthUsers();
      const deleter     = authUsers.find(u => u.id === _jpFgDel.id);
      const deleterName = deleter ? deleter.name : '';
      const uploaderName = fgEntry.creado_by || '';
      const isOwn = uploaderName === deleterName;
      if (!isOwn) {
        if (_jpFgDel.role === 'manager') {
          // Encargado solo puede borrar fotos de auxiliares
          const uploader = authUsers.find(u => u.name === uploaderName);
          if (uploader && uploader.role !== 'assistant') {
            res.writeHead(403,{'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:false,error:'Sin permiso para eliminar esta foto'}));
            return;
          }
        } else {
          res.writeHead(403,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Solo puedes eliminar tus propias fotos'}));
          return;
        }
      }
    }
    if (fgEntry) {
      try { fs.unlinkSync(path.join(WWP_FOTOS_DIR, path.basename(fgEntry.url))); } catch(e) {}
      // eliminar evidencias asociadas
      (fgEntry.evidencias||[]).forEach(ev => { try { fs.unlinkSync(path.join(WWP_FOTOS_DIR, path.basename(ev.url))); } catch(e) {} });
    }
    tasks[idx].fotos_guia = fgArr.filter(f => !f.url.endsWith('/'+fname) && f.id !== fname);
    tasks[idx].updatedAt = new Date().toISOString();
    saveWwpTasks(tasks);
    broadcastWwpTasks('fotos_guia_deleted', tasks[idx], { taskId, fname });
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true}));
    return;
  }

  // ── PATCH /api/wwp/tasks/:id/fotos-guia/:fotoId/confirmar ────────────────────
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/fotos-guia\/[^/]+\/confirmar$/) && req.method === 'PATCH') {
    const _jpFgConf = requireJwt(req, res); if (!_jpFgConf) return;
    const parts = reqPath.split('/');
    const taskId = parts[4], fotoId = decodeURIComponent(parts[6]);
    try {
      const d = await readBody(req);
      const tasks = loadWwpTasks();
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tarea no encontrada'})); return; }
      const fgIdx = (tasks[idx].fotos_guia||[]).findIndex(f => f.id === fotoId);
      if (fgIdx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Foto no encontrada'})); return; }
      tasks[idx].fotos_guia[fgIdx].confirmado = !!d.confirmado;
      tasks[idx].fotos_guia[fgIdx].confirmado_by = d.confirmado ? (d.by||_jpFgConf.name||'') : null;
      tasks[idx].fotos_guia[fgIdx].confirmado_at = d.confirmado ? new Date().toISOString() : null;
      tasks[idx].updatedAt = new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('fotos_guia_confirmado', tasks[idx], { taskId, fotoId, confirmado: !!d.confirmado });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, confirmado: !!d.confirmado}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── POST /api/wwp/tasks/:id/fotos-guia/:fotoId/evidencia — agregar evidencia ─
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/fotos-guia\/[^/]+\/evidencia$/) && req.method === 'POST') {
    const _jpFgEv = requireJwt(req, res); if (!_jpFgEv) return;
    const parts = reqPath.split('/');
    const taskId = parts[4], fotoId = decodeURIComponent(parts[6]);
    try {
      const d = await readBody(req);
      const tasks = loadWwpTasks();
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tarea no encontrada'})); return; }
      const fgIdx = (tasks[idx].fotos_guia||[]).findIndex(f => f.id === fotoId);
      if (fgIdx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Foto de guía no encontrada'})); return; }
      if (!tasks[idx].fotos_guia[fgIdx].evidencias) tasks[idx].fotos_guia[fgIdx].evidencias = [];
      const saved = [];
      (d.fotos||[]).forEach((f, fi) => {
        const { b64, ext } = validatePhoto(f);
        const ts = Date.now();
        const fname = `${taskId}_${fotoId}_ev_${ts}_${fi}.${ext}`;
        fs.writeFileSync(path.join(WWP_FOTOS_DIR, fname), Buffer.from(b64, 'base64'));
        const entry = { id: `fgev_${ts}_${fi}`, url: `/wwp-fotos/${fname}`, uploaded_by: d.by||'', uploaded_at: new Date().toISOString() };
        tasks[idx].fotos_guia[fgIdx].evidencias.push(entry);
        saved.push(entry);
      });
      tasks[idx].updatedAt = new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('fotos_guia_evidencia_created', tasks[idx], { taskId, fotoId, evidencia: saved });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, evidencia: saved}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── DELETE /api/wwp/tasks/:id/fotos-guia/:fotoId/evidencia/:fname ────────────
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/fotos-guia\/[^/]+\/evidencia\/.+$/) && req.method === 'DELETE') {
    const _jpFgEvDel = requireJwt(req, res); if (!_jpFgEvDel) return;
    const parts = reqPath.split('/');
    const taskId = parts[4], fotoId = decodeURIComponent(parts[6]), evFname = decodeURIComponent(parts[8]);
    const tasks = loadWwpTasks();
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false})); return; }
    const fgIdx = (tasks[idx].fotos_guia||[]).findIndex(f => f.id === fotoId);
    if (fgIdx !== -1) {
      const evArr = tasks[idx].fotos_guia[fgIdx].evidencias || [];
      const evEntry = evArr.find(e => e.url.endsWith('/'+evFname) || e.id === evFname);
      if (evEntry) { try { fs.unlinkSync(path.join(WWP_FOTOS_DIR, path.basename(evEntry.url))); } catch(e) {} }
      tasks[idx].fotos_guia[fgIdx].evidencias = evArr.filter(e => !e.url.endsWith('/'+evFname) && e.id !== evFname);
    }
    tasks[idx].updatedAt = new Date().toISOString();
    saveWwpTasks(tasks);
    broadcastWwpTasks('fotos_guia_evidencia_deleted', tasks[idx], { taskId, fotoId, fname: evFname });
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true}));
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EMPAQUE — catálogo de materiales, reglas por categoría, resolución
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/empaque/materiales
  if (reqPath === '/api/empaque/materiales' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, materiales: loadEmpMateriales() }));
    return;
  }

  // POST /api/empaque/materiales
  if (reqPath === '/api/empaque/materiales' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const d = await readBody(req);
      if (!d.nombre) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Nombre requerido'})); return; }
      const mats = loadEmpMateriales();
      const mat = { id: 'em_' + Date.now(), nombre: d.nombre.trim(), descripcion: (d.descripcion||'').trim(), foto_url: d.foto_url||null };
      mats.push(mat);
      saveEmpMateriales(mats);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, material: mat }));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // PATCH /api/empaque/materiales/:id
  if (reqPath.match(/^\/api\/empaque\/materiales\/em_[a-z0-9_]+$/) && req.method === 'PATCH') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const id = reqPath.split('/').pop();
      const d  = await readBody(req);
      const mats = loadEmpMateriales();
      const idx  = mats.findIndex(m => m.id === id);
      if (idx < 0) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
      if (d.nombre !== undefined) mats[idx].nombre = d.nombre.trim();
      if (d.descripcion !== undefined) mats[idx].descripcion = d.descripcion.trim();
      if (d.foto_url !== undefined) mats[idx].foto_url = d.foto_url;
      saveEmpMateriales(mats);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, material: mats[idx] }));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // POST /api/empaque/materiales/:id/foto
  if (reqPath.match(/^\/api\/empaque\/materiales\/em_[a-z0-9_]+\/foto$/) && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const id = reqPath.split('/')[4];
      const d  = await readBody(req);
      if (!d.data) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Imagen requerida'})); return; }
      const buf  = Buffer.from(d.data, 'base64');
      const ext  = (d.ext || 'jpg').replace(/[^a-z]/g, '');
      const fname = id + '_' + Date.now() + '.' + ext;
      const fpath = path.join(EMP_FOTOS_DIR, fname);
      fs.writeFileSync(fpath, buf);
      const url = '/api/empaque/foto/' + fname;
      const mats = loadEmpMateriales();
      const idx  = mats.findIndex(m => m.id === id);
      if (idx >= 0) { mats[idx].foto_url = url; saveEmpMateriales(mats); }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, url }));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // GET /api/empaque/foto/:fname — serve foto material
  if (reqPath.match(/^\/api\/empaque\/foto\/.+$/) && req.method === 'GET') {
    const fname = path.basename(reqPath);
    const fpath = path.join(EMP_FOTOS_DIR, fname);
    if (!fs.existsSync(fpath)) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(fname).slice(1).toLowerCase();
    const mime = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'}[ext]||'image/jpeg';
    res.writeHead(200,{'Content-Type':mime,'Cache-Control':'public,max-age=31536000'});
    fs.createReadStream(fpath).pipe(res);
    return;
  }

  // DELETE /api/empaque/materiales/:id
  if (reqPath.match(/^\/api\/empaque\/materiales\/em_[a-z0-9_]+$/) && req.method === 'DELETE') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const id = reqPath.split('/').pop();
      let mats = loadEmpMateriales();
      mats = mats.filter(m => m.id !== id);
      saveEmpMateriales(mats);
      // Limpiar referencias en reglas
      let reglas = loadEmpReglas();
      reglas = reglas.map(r => ({ ...r, materiales: (r.materiales||[]).filter(m => m.materialId !== id) })).filter(r => (r.materiales||[]).length > 0);
      saveEmpReglas(reglas);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // GET /api/empaque/reglas
  if (reqPath === '/api/empaque/reglas' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, reglas: loadEmpReglas() }));
    return;
  }

  // POST /api/empaque/reglas — upsert (crea o reemplaza por categ_id)
  if (reqPath === '/api/empaque/reglas' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const d = await readBody(req);
      if (!d.categ_id) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'categ_id requerido'})); return; }
      let reglas = loadEmpReglas();
      const idx  = reglas.findIndex(r => r.categ_id === d.categ_id);
      const regla = {
        id: idx >= 0 ? reglas[idx].id : ('er_' + Date.now()),
        categ_id: d.categ_id,
        categ_nombre: d.categ_nombre || '',
        materiales: (d.materiales || []).map((m, i) => ({ materialId: m.materialId, orden: m.orden ?? (i+1) }))
      };
      if (idx >= 0) reglas[idx] = regla; else reglas.push(regla);
      saveEmpReglas(reglas);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, regla }));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // DELETE /api/empaque/reglas/:id
  if (reqPath.match(/^\/api\/empaque\/reglas\/er_[a-z0-9_]+$/) && req.method === 'DELETE') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const id = reqPath.split('/').pop();
      let reglas = loadEmpReglas();
      reglas = reglas.filter(r => r.id !== id);
      saveEmpReglas(reglas);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // GET /api/empaque/categorias — categorías Odoo (con caché 30min)
  if (reqPath === '/api/empaque/categorias' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const now = Date.now();
      if (_empCategCache && (now - _empCategCacheAt) < EMP_CATEG_TTL) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, categorias: _empCategCache }));
        return;
      }
      await authenticate();
      const cats = await odooCall('product.category', 'search_read',
        [[]], { fields: ['id','name','parent_id','complete_name'], limit: 500 });
      _empCategCache   = cats || [];
      _empCategCacheAt = now;
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, categorias: _empCategCache }));
    } catch(e) {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, categorias: _empCategCache || [] }));
    }
    return;
  }

  // GET /api/empaque/resolve?categ_ids=1,2,3
  // Devuelve { ok, result: { "<categ_id>": { materiales: [...] } } }
  // Los materiales están ordenados por 'orden' según las reglas configuradas
  if (reqPath === '/api/empaque/resolve' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const qs      = url.parse(req.url, true).query;
      const ids     = (qs.categ_ids || '').split(',').map(s => parseInt(s, 10)).filter(Boolean);
      const reglas  = loadEmpReglas();
      const mats    = loadEmpMateriales();
      const result  = {};
      ids.forEach(cid => {
        const regla = reglas.find(r => r.categ_id === cid);
        if (!regla) { result[cid] = { materiales: [] }; return; }
        const sorted = (regla.materiales || [])
          .slice()
          .sort((a, b) => (a.orden || 0) - (b.orden || 0))
          .map(rm => mats.find(m => m.id === rm.materialId))
          .filter(Boolean);
        result[cid] = { materiales: sorted };
      });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, result }));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // ── Mapa de almacén (concepto) ────────────────────────────────────────────
  if (reqPath === '/almacen-mapa' || reqPath === '/almacen-mapa.html') {
    const f = path.join(__dirname, 'almacen-mapa.html');
    if (fs.existsSync(f)) {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(fs.readFileSync(f));
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── Redirect raíz → historial ─────────────────────────────────────────────
  if (reqPath === '/') {
    res.writeHead(302, { 'Location': '/historial.html' });
    res.end();
    return;
  }

  // ── Redirect wwp.html → historial.html (versión standalone deprecada) ───────
  if (reqPath === '/wwp.html' || reqPath === '/wwp') {
    res.writeHead(302, { 'Location': '/historial.html' });
    res.end();
    return;
  }

  // ── POST /api/sin-adjuntos/enviar-correos — notificar usuarios con pendientes ─
  if (reqPath === '/api/sin-adjuntos/enviar-correos' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireRole(jp, res, ['admin', 'manager'])) return;
    try {
      const { pickings, dateFrom, dateTo } = await readBody(req);
      if (!Array.isArray(pickings) || pickings.length === 0) {
        return sendJson(res, 400, { ok: false, error: 'No hay transferencias para notificar' });
      }

      // ── 1. Agrupar por usuario Odoo (preferir write_uid, ignorar OdooBot) ──
      // ── 1. Agrupar pickings por usuario Odoo ─────────────────────────────
      // Estructura: odooId → { odooId, odooName, pickings[], supervisorName, _supOdooUserId }
      const byUser = new Map();
      pickings.forEach(p => {
        const wU = p.write_uid, uU = p.user_id;
        let odooId, odooName;
        if (wU && wU[0] && wU[1] && wU[1].toLowerCase() !== 'odoobot') {
          odooId = wU[0]; odooName = wU[1];
        } else if (uU && uU[0] && uU[1] && uU[1].toLowerCase() !== 'odoobot') {
          odooId = uU[0]; odooName = uU[1];
        }
        if (!odooId) return;
        if (!byUser.has(odooId)) byUser.set(odooId, { odooId, odooName, pickings: [], supervisorName: null, _supOdooUserId: null });
        byUser.get(odooId).pickings.push(p);
      });

      if (byUser.size === 0) {
        return sendJson(res, 400, { ok: false, error: 'No se pudieron identificar usuarios en los despachos' });
      }

      const allOdooIds = [...byUser.keys()];

      // ── 2. Resolver supervisor desde hr.employee (organigrama) ───────────
      try {
        const employees = await odooCall('hr.employee', 'search_read',
          [[['user_id', 'in', allOdooIds], ['active', 'in', [true, false]]]],
          { fields: ['id', 'user_id', 'parent_id'], limit: 200 }
        );
        const supervisorEmpIds = [];
        const empByUserId = new Map();
        employees.forEach(emp => {
          if (!emp.user_id) return;
          empByUserId.set(emp.user_id[0], emp);
          if (emp.parent_id && emp.parent_id[0]) supervisorEmpIds.push(emp.parent_id[0]);
        });
        if (supervisorEmpIds.length) {
          const supEmps = await odooCall('hr.employee', 'search_read',
            [[['id', 'in', supervisorEmpIds], ['active', 'in', [true, false]]]],
            { fields: ['id', 'name', 'user_id'], limit: 200 }
          );
          const supEmpById = new Map();
          supEmps.forEach(s => supEmpById.set(s.id, s));
          byUser.forEach((group, odooId) => {
            const emp = empByUserId.get(odooId);
            if (!emp || !emp.parent_id || !emp.parent_id[0]) return;
            const supEmp = supEmpById.get(emp.parent_id[0]);
            if (!supEmp) return;
            group.supervisorName = supEmp.name || emp.parent_id[1] || null;
            group._supOdooUserId = supEmp.user_id ? supEmp.user_id[0] : null;
          });
        }
      } catch(e) { console.warn('[sinAdj] hr.employee lookup failed:', e.message); }

      // ── 3. Obtener partner_id de empleados y supervisores (res.users) ─────
      const periodStr = (dateFrom && dateTo)
        ? `${dateFrom} al ${dateTo}`
        : (dateFrom ? `desde ${dateFrom}` : dateTo ? `hasta ${dateTo}` : 'período consultado');

      const supOdooIds = [...new Set([...byUser.values()].map(g => g._supOdooUserId).filter(Boolean))];
      const allUserIds = [...new Set([...allOdooIds, ...supOdooIds])];

      const partnerByOdooId = new Map(); // odooUserId → partnerId
      try {
        // Usar read() en lugar de search_read — bypasea filtros de acceso/active
        const usersInfo = await odooCall('res.users', 'read',
          [allUserIds, ['id', 'partner_id']]
        );
        usersInfo.forEach(u => { if (u && u.partner_id) partnerByOdooId.set(u.id, u.partner_id[0]); });
      } catch(e) {
        return sendJson(res, 503, { ok: false, error: 'No se pudo consultar res.users en Odoo: ' + e.message });
      }

      // ── 4. Crear mail.message por usuario en Odoo Discuss (Inbox) ─────────
      const results = { sent: [], noPartner: [], errors: [] };

      for (const [, group] of byUser) {
        const partnerId = partnerByOdooId.get(group.odooId);
        if (!partnerId) {
          results.noPartner.push({ name: group.odooName, odooId: group.odooId });
          continue;
        }

        // Destinatarios: empleado + supervisor (si tiene usuario Odoo y es distinto)
        const msgPartnerIds = [partnerId];
        if (group._supOdooUserId) {
          const supPartnerId = partnerByOdooId.get(group._supOdooUserId);
          if (supPartnerId && supPartnerId !== partnerId) msgPartnerIds.push(supPartnerId);
        }

        const body = buildSinAdjOdooMsg(group.odooName, group.pickings, periodStr, group.supervisorName);
        try {
          const mainMsgId = await odooCall('mail.message', 'create', [{
            message_type: 'user_notification',
            model: 'res.partner',
            res_id: partnerId,
            body,
            subject: `${group.pickings.length} despacho${group.pickings.length !== 1 ? 's' : ''} pendiente${group.pickings.length !== 1 ? 's' : ''} de comprobante — ${periodStr}`,
          }]);
          // Crear mail.notification por cada destinatario (fuerza inbox sin importar preferencias)
          for (const pid of msgPartnerIds) {
            try {
              await odooCall('mail.notification', 'create', [{
                mail_message_id: mainMsgId,
                res_partner_id: pid,
                notification_type: 'inbox',
                is_read: false,
                notification_status: 'sent',
              }]);
            } catch(en) { console.warn('[sinAdj] notif create failed for partner', pid, en.message); }
          }
          results.sent.push({
            name: group.odooName, odooId: group.odooId, count: group.pickings.length,
            supervisor: group.supervisorName || null
          });
        } catch(e) {
          results.errors.push({ name: group.odooName, odooId: group.odooId, error: e.message });
        }
      }

      appendAuditLog('sinAdj_odoo_notif_sent', {
        by: jp.name, role: jp.role,
        sent: results.sent.length, noPartner: results.noPartner.length, errors: results.errors.length,
        dateFrom, dateTo
      });
      sendJson(res, 200, { ok: true, ...results });
    } catch(e) {
      sendJson(res, 500, { ok: false, error: safeError(e) });
    }
    return;
  }

  // ── Servir archivos estáticos ─────────────────────────────────────────────
  let filePath = path.join(__dirname, reqPath);
  if (reqPath === '/historial') filePath = path.join(__dirname, 'historial.html');
  if (reqPath.startsWith('/av-fotos/'))  filePath = path.join(AV_FOTOS_DIR,  path.basename(reqPath));
  if (reqPath.startsWith('/wwp-fotos/')) filePath = path.join(WWP_FOTOS_DIR, path.basename(reqPath));

  // ── Protección: path traversal + archivos sensibles ──────────────────────
  const _realPath = path.resolve(filePath);
  const _basePath = path.resolve(__dirname);
  const _dataPath = path.resolve(DATA_DIR);
  // Permitir archivos bajo __dirname O bajo DATA_DIR (fotos persistentes en Render /data)
  if (!_realPath.startsWith(_basePath) && !_realPath.startsWith(_dataPath)) {
    res.writeHead(403, {'Content-Type': 'text/plain'}); res.end('Forbidden'); return;
  }
  const _FORBIDDEN = new Set([
    '.env.txt', '.env', '.env.local', '.env.production', '.jwt-secret',
    'wwp-users-auth.json', 'wwp-sessions.json', 'wwp-audit.json',
    'wwp-roles.json', 'wwp-tasks.json', 'wwp-lunch-breaks.json',
    'wwp-inspecciones.json', 'averias.json', 'package.json',
    'package-lock.json', '.gitignore'
  ]);
  const _ALLOWED_EXT = new Set([
    '.html', '.css', '.js', '.json', '.ico', '.png', '.jpg',
    '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.ttf',
    '.eot', '.map', '.csv'
  ]);
  const _fname = path.basename(_realPath);
  const _fext  = path.extname(_realPath).toLowerCase();
  if (_FORBIDDEN.has(_fname)) {
    res.writeHead(403, {'Content-Type': 'text/plain'}); res.end('Forbidden'); return;
  }
  if (_fext && !_ALLOWED_EXT.has(_fext)) {
    res.writeHead(403, {'Content-Type': 'text/plain'}); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not Found');
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    const headers = {'Content-Type': mime};
    if (ext === '.html' || filePath.endsWith('manifest.json')) {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers['Pragma'] = 'no-cache';
    } else if (['.png','.svg'].includes(ext) && /icon|apple-touch|favicon/.test(path.basename(filePath))) {
      // Íconos PWA: caché corta para que los cambios se propaguen
      headers['Cache-Control'] = 'public, max-age=3600';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/ws/wwp') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));

  wwpWsClients.add(socket);
  wsSend(socket, {
    scope: 'wwp',
    event: 'hello',
    version: wwpStateVersion,
    at: new Date().toISOString(),
    tasks: loadWwpTasks()
  });

  socket.on('data', buf => {
    if (!buf.length) return;
    const opcode = buf[0] & 0x0f;
    if (opcode === 0x8) {
      try { socket.write(Buffer.from([0x88, 0x00])); } catch {}
      socket.end();
    }
    if (opcode === 0x9) {
      try { socket.write(Buffer.from([0x8a, 0x00])); } catch {}
    }
  });
  socket.on('close', () => wwpWsClients.delete(socket));
  socket.on('error', () => wwpWsClients.delete(socket));
});

// ── Timeouts anti-Slowloris ───────────────────────────────────────────────────
server.requestTimeout  = 30000;  // 30s máx para recibir request completo
server.headersTimeout  = 15000;  // 15s máx para headers
server.keepAliveTimeout = 65000; // 65s keep-alive (mayor que load balancers)

// ── Arrancar ─────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`   Dashboard:  http://localhost:${PORT}/index.html`);
  console.log(`   Historial:  http://localhost:${PORT}/historial.html`);
  console.log(`   Odoo:       ${ODOO_URL}\n`);
  seedAuthUsers();
  recoverOpenLunchBreaks();
  try {
    await authenticate();
  } catch (e) {
    console.warn(`⚠️  Advertencia: no se pudo autenticar con Odoo al arrancar: ${e.message}`);
    console.warn('   El proxy funcionará pero las llamadas a /api/odoo fallarán hasta corregir credenciales.\n');
  }
});
