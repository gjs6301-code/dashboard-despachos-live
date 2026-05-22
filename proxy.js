/**
 * proxy.js — Servidor local para Dashboard Despachos
 * Sirve archivos estáticos + hace de proxy a Odoo JSON-RPC (resuelve CORS)
 */
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

// ── Helpers de persistencia JSON ─────────────────────────────────────────────
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback !== undefined ? fallback : []; }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Leer credenciales desde .env.txt (opcional en producción) ───────────────
function loadEnv(filename) {
  const candidates = [filename, path.join(__dirname, filename)];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      const lines = fs.readFileSync(f, 'utf-8').split('\n');
      const env = {};
      lines.forEach(line => {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
        if (m) env[m[1]] = m[2].trim();
      });
      return env;
    }
  }
  // En producción (Render) no hay .env.txt — las vars vienen de process.env
  return {};
}

// ── Archivo de persistencia de averías ───────────────────────────────────────
const AVERIAS_FILE  = path.join(__dirname, 'averias.json');
const AV_FOTOS_DIR  = path.join(__dirname, 'av-fotos');
if (!fs.existsSync(AV_FOTOS_DIR)) fs.mkdirSync(AV_FOTOS_DIR, { recursive: true });

function loadAverias() { return loadJson(AVERIAS_FILE, []); }
function saveAverias(list) { saveJson(AVERIAS_FILE, list); }

// ── WWP (Warehouse Workforce Platform) — persistencia ────────────────────────
const WWP_TASKS_FILE  = path.join(__dirname, 'wwp-tasks.json');
const WWP_ROLES_FILE  = path.join(__dirname, 'wwp-roles.json'); // { "oe_95": "admin", ... }
const WWP_FOTOS_DIR   = path.join(__dirname, 'wwp-fotos');
const WWP_LUNCH_FILE        = path.join(__dirname, 'wwp-lunch-breaks.json');
const WWP_INSPECTIONS_FILE  = path.join(__dirname, 'wwp-inspecciones.json');
if (!fs.existsSync(WWP_FOTOS_DIR)) fs.mkdirSync(WWP_FOTOS_DIR, { recursive: true });

function loadLunchBreaks() { return loadJson(WWP_LUNCH_FILE, []); }
function saveLunchBreaks(b) { saveJson(WWP_LUNCH_FILE, b); }

function loadInspections() { return loadJson(WWP_INSPECTIONS_FILE, []); }
function saveInspections(d) { saveJson(WWP_INSPECTIONS_FILE, d); }

function loadWwpTasks() { return loadJson(WWP_TASKS_FILE, []); }
function saveWwpTasks(list) { saveJson(WWP_TASKS_FILE, list); }
// roles: objeto { "oe_<id>": "admin"|"manager"|"assistant" }
function loadWwpRoles() { return loadJson(WWP_ROLES_FILE, {}); }
function saveWwpRoles(obj) { saveJson(WWP_ROLES_FILE, obj); }
function wwpId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}

// ── WWP Auth — sin dependencias externas ────────────────────────────────────
const WWP_AUTH_FILE     = path.join(__dirname, 'wwp-users-auth.json');
const WWP_SESSIONS_FILE = path.join(__dirname, 'wwp-sessions.json');

// Secreto JWT persistente
const JWT_SECRET = (() => {
  const secretFile = path.join(__dirname, '.jwt-secret');
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
const WWP_AUDIT_FILE = path.join(__dirname, 'wwp-audit.json');
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
  const key   = (email || '').toLowerCase().trim();
  const now   = Date.now();
  const entry = _loginAttempts.get(key);
  if (!entry || entry.resetAt < now) return false; // no hay bloqueo
  return entry.count >= LOGIN_MAX_ATTEMPTS;
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
  validate_task:['admin','manager'],
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

const ENV        = loadEnv('.env.txt');
// process.env tiene prioridad (Render), luego .env.txt (desarrollo local)
const ODOO_URL   = process.env.ODOO_URL   || ENV.ODOO_URL   || '';
const ODOO_DB    = process.env.ODOO_DB    || ENV.ODOO_DB    || '';
const ODOO_USER  = process.env.ODOO_USER  || ENV.ODOO_USER  || '';
const ODOO_KEY   = process.env.ODOO_API_KEY || ENV.ODOO_API_KEY || '';
const PORT       = parseInt(process.env.PORT || '3000', 10);
const odooOrigin = ODOO_URL ? new url.URL(ODOO_URL).origin : ''; // vacío si no está configurado

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

const WWP_NOTIF_FILE = path.join(__dirname, 'wwp-notifications.json');
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
const CONT_SHEETS_ID  = ENV.CONT_SHEETS_ID  || '';
const CONT_SHEETS_GID = ENV.CONT_SHEETS_GID || '0';
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

  // 2️⃣  Archivo local contenedores.csv (worktree)
  if (!csv && fs.existsSync(LOCAL_CSV)) {
    csv    = fs.readFileSync(LOCAL_CSV, 'utf-8');
    source = 'contenedores.csv (local)';
  }

  // 3️⃣  Fallback: contenedores.csv en la carpeta raíz del proyecto
  if (!csv && fs.existsSync(LOCAL_CSV_PROYECTO)) {
    csv    = fs.readFileSync(LOCAL_CSV_PROYECTO, 'utf-8');
    source = 'contenedores.csv (proyecto)';
  }

  if (!csv) {
    throw new Error(
      'No hay fuente de datos configurada. ' +
      'Opciones: (A) agrega CONT_SHEETS_ID en .env.txt, ' +
      'o (B) coloca contenedores.csv en la carpeta del servidor.'
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

  // ── /api/odoo/auth — verificar conexión (solo admin autenticado) ────────────
  if (reqPath === '/api/odoo/auth' && req.method === 'GET') {
    const _jpOdoo = requireJwt(req, res); if (!_jpOdoo) return;
    if (!requireRole(_jpOdoo, res, ['admin'])) return;
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

    res.writeHead(health.allOk ? 200 : 502, {'Content-Type': 'application/json'});
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

      // Step 2: stock.move DONE hacia esa ubicación para esos productos
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

      // Step 3: comparar
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
        user:{id:user.id,name:user.name,email:user.email,role:user.role,odooId:user.odooId,presenceStatus:user.presenceStatus||'active'}}));
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
      res.end(JSON.stringify({ok:true, accessToken, user:{id:user.id,name:user.name,email:user.email,role:user.role,odooId:user.odooId,presenceStatus:user.presenceStatus||'active'}}));
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
        const resetUrl = `http://localhost:3000/wwp.html?reset=${user.resetToken}`;
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
    const users = loadAuthUsers().map(u => ({id:u.id,name:u.name,email:u.email,role:u.role,odooId:u.odooId,active:u.active,lastLogin:u.lastLogin,createdAt:u.createdAt,presenceStatus:u.presenceStatus||'active',presenceAt:u.presenceAt||null,lunchTimeAllowed:u.lunchTimeAllowed||60}));
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(users));
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
      res.end(JSON.stringify({ok:true,user:{id:users[idx].id,name:users[idx].name,email:users[idx].email,role:users[idx].role,active:users[idx].active,lunchTimeAllowed:users[idx].lunchTimeAllowed||60}}));
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
      tasks = tasks.filter(t =>
        t.managerId   === uid ||
        t.createdBy   === uid ||
        odooStrToAuthId(t.assignedTo) === uid ||
        (t.executors||[]).some(e => odooStrToAuthId(e) === uid) ||
        (t.assignees||[]).includes(uid)
      );
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
    if (!d.text||!d.text.trim()) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Mensaje vacío'})); return; }
    const msg = {
      id: wwpId('msg'),
      fromId: jp.userId,
      fromName: jp.name,
      text: d.text.trim(),
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
      message: `${jp.name}: "${msg.text.length>60?msg.text.slice(0,57)+'…':msg.text}"`,
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
        location: d.location||'',
        dueDate: d.dueDate||null,
        evidence: [],
        statusHistory: [{ status:'pending', date:now, by:d.createdBy||'', note:'' }],
        createdBy: d.createdBy||'',
        createdAt: now,
        updatedAt: now
      };
      // Si es tarea principal y viene con assignedTo → asignar encargado
      if (!isSubtask && task.assignedTo) {
        task.status='assigned';
        task.statusHistory.push({ status:'assigned', date:now, by:d.createdBy||'', note:d.note||'' });
      }
      // Si es subtarea con ejecutores → pasar a in_progress directamente
      if (isSubtask && task.executors.length > 0) {
        task.status='in_progress';
        task.statusHistory.push({ status:'in_progress', date:now, by:d.createdBy||'', note:'' });
      }
      const tasks = loadWwpTasks();
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
                              (task.executors||[]).some(e => e === myOdooStr || e === myAuthId);
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
      if (d.executors!==undefined) tasks[idx].executors=Array.isArray(d.executors)?d.executors:[];
      if (d.assignees!==undefined) tasks[idx].assignees=Array.isArray(d.assignees)?d.assignees:[];
      if (d.title!==undefined) tasks[idx].title=d.title.trim();
      if (d.description!==undefined) tasks[idx].description=d.description;
      if (d.priority!==undefined) tasks[idx].priority=d.priority;
      if (d.odooRef!==undefined) tasks[idx].odooRef=d.odooRef;
      if (d.location!==undefined) tasks[idx].location=d.location;
      if (d.dueDate!==undefined) tasks[idx].dueDate=d.dueDate;
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
    function buildItems(lines, prodMap, stockMap) {
      return lines.filter(l=>l.product_id).map(l=>{
        const prod=prodMap[l.product_id[0]]||{};
        const locations=stockMap[l.product_id[0]]||[];
        return { item_id:'oi_'+l.id, odoo_line_id:l.id, odoo_product_id:l.product_id[0],
          sku:prod.barcode||prod.default_code||'', product_name:l.product_id[1]||l.name||'',
          quantity:l.product_uom_qty||l.qty_done||l.quantity||1,
          image:prod.image_128?'data:image/png;base64,'+prod.image_128:null,
          locations, selected_location:locations.length===1?0:null,
          selected:false, evidence_images:[], comments:'', status:'pending' };
      });
    }

    try {
      // ── 1. Intentar como ORDEN DE VENTA ────────────────────────────
      const orders = await odooCall('sale.order','search_read',
        [[['name','ilike',ref]]],{fields:['id','name','order_line','partner_id'],limit:1});
      if (orders && orders.length) {
        const order=orders[0];
        const lineIds=order.order_line||[];
        if (!lineIds.length) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,type:'order',ref:order.name,client:order.partner_id?order.partner_id[1]:'',items:[]})); return; }
        const lines = await odooCall('sale.order.line','read',[lineIds],{fields:['product_id','product_uom_qty','name']});
        const productIds=[...new Set(lines.filter(l=>l.product_id).map(l=>l.product_id[0]))];
        const products = productIds.length ? await odooCall('product.product','read',[productIds],{fields:['id','barcode','default_code','image_128']}) : [];
        const prodMap={}; products.forEach(p=>{ prodMap[p.id]=p; });
        const stockMap = await fetchStockMap(productIds);
        const items = buildItems(lines, prodMap, stockMap);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,type:'order',ref:order.name,client:order.partner_id?order.partner_id[1]:'',items}));
        return;
      }

      // ── 2. Intentar como TRANSFERENCIA (stock.picking) ──────────────
      const picks = await odooCall('stock.picking','search_read',
        [[['name','ilike',ref]]],{fields:['id','name','partner_id','origin','picking_type_id','location_id','location_dest_id'],limit:1});
      if (picks && picks.length) {
        const pick=picks[0];
        const moves = await odooCall('stock.move','search_read',
          [[['picking_id','=',pick.id],['state','!=','cancel']]],
          {fields:['product_id','product_uom_qty','quantity_done','name'],limit:100});
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
        res.end(JSON.stringify({ok:true,type:'article',ref:p.default_code||p.name,client:p.name+(totalStock?' · '+totalStock+' en stock':''),items:[item]}));
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
          sku:item.sku||'', product_name:item.product_name||'', quantity:item.quantity||0,
          selected:!!item.selected,
          locations:item.locations||[],
          selected_location:selLocIdx,
          selected_location_name:selLocObj?.location_name||null,
          evidence_images:prev.evidence_images||[], comments:item.comments||prev.comments||'', status:prev.status||'pending' };
      });
      tasks[idx].updatedAt=new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('items_updated', tasks[idx], { taskId:id, items:tasks[idx].items });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,items:tasks[idx].items}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // POST /api/wwp/tasks/:id/items/:itemId/evidence — evidencia por artículo [cualquier rol]
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/items\/oi_\d+\/evidence$/) && req.method === 'POST') {
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
      const saved=[];
      (d.fotos||[]).forEach((f,fi)=>{
        const { b64, ext } = validatePhoto(f);
        const ts=Date.now();
        const fname=`${taskId}_${itemId}_${ts}_${fi}.${ext}`;
        const fpath=path.join(WWP_FOTOS_DIR,fname);
        fs.writeFileSync(fpath,Buffer.from(b64,'base64'));
        const entry={id:`ev_${ts}_${fi}`,url:`/wwp-fotos/${fname}`,caption:f.caption||'',uploaded_by:d.by||'',uploaded_at:new Date().toISOString()};
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
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/items\/oi_\d+\/evidence\/.+$/) && req.method === 'DELETE') {
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
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/items\/oi_\d+\/confirmar$/) && req.method === 'PATCH') {
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

  // ── Servir archivos estáticos ─────────────────────────────────────────────
  let filePath = path.join(__dirname, reqPath === '/' ? 'index.html' : reqPath);
  if (reqPath === '/historial') filePath = path.join(__dirname, 'historial.html');
  if (reqPath.startsWith('/av-fotos/'))  filePath = path.join(AV_FOTOS_DIR,  path.basename(reqPath));
  if (reqPath.startsWith('/wwp-fotos/')) filePath = path.join(WWP_FOTOS_DIR, path.basename(reqPath));

  // ── Protección: path traversal + archivos sensibles ──────────────────────
  const _realPath = path.resolve(filePath);
  const _basePath = path.resolve(__dirname);
  if (!_realPath.startsWith(_basePath)) {
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
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers['Pragma'] = 'no-cache';
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
