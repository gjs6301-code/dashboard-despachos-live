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

  // Buscar todos los pickings ligados a esta orden: PICK + RET (assigned)
  const picksAll = await odooCall('stock.picking','search_read',
    [[['origin','=',realName],['state','in',['assigned','done']]]],
    {fields:['id','name','picking_type_id','state'],limit:50});

  const pickList = (picksAll||[]).filter(p => /\/PICK\//i.test(p.name));
  const retList  = (picksAll||[]).filter(p => /\/RET\//i.test(p.name)
    || /return|devoluci/i.test((p.picking_type_id&&p.picking_type_id[1])||''));

  if (!pickList.length && !retList.length) return { noPick:true, items:[], picks:[], pickNames:[] };

  // Agrupar move lines por (pickId × productId) para mantener picks separados
  const allIds = [...pickList, ...retList].map(p=>p.id);
  const pickInfoById = {}; [...pickList,...retList].forEach(p=>{ pickInfoById[p.id]=p; });

  const mls = await odooCall('stock.move.line','search_read',
    [[['picking_id','in',allIds]]],
    {fields:['product_id','location_id','product_uom_qty','qty_done','picking_id'],limit:3000});

  // Clave única: pickId_productId → permite el mismo producto en picks distintos
  const byKey = {};
  mls.forEach(ml=>{
    if(!ml.product_id) return;
    const qty = Math.max(0, Math.round(ml.product_uom_qty||ml.qty_done||0));
    if(qty<=0) return;
    const pid    = ml.product_id[0];
    const pickId = ml.picking_id && ml.picking_id[0];
    const pickName = (pickInfoById[pickId]||{}).name||'';
    const isRet    = /\/RET\//i.test(pickName);
    const bin  = ml.location_id ? ml.location_id[1] : '';
    const key  = `${pickId}_${pid}`;
    if(!byKey[key]) byKey[key]={ pid, name:ml.product_id[1], pickName, isRet, unitBins:[] };
    for(let i=0;i<qty;i++) byKey[key].unitBins.push(bin);
  });

  const pids = [...new Set(Object.values(byKey).map(g=>g.pid))];
  const picks = [
    ...pickList.map(p=>({ name:p.name, type:'pick', state:p.state })),
    ...retList.map(p=>({ name:p.name, type:'return', state:p.state }))
  ];
  if(!pids.length) return { noPick:false, items:[], picks, pickNames:pickList.map(p=>p.name) };

  const prods  = await odooCall('product.product','read',[pids],{fields:['id','barcode','default_code','image_128']});
  const pm={}; prods.forEach(p=>{ pm[p.id]=p; });
  const kitMap = await resolveKitInfo(prods);

  const items = Object.values(byKey).map(g=>{
    const prod=pm[g.pid]||{}, units=g.unitBins.length, kit=kitMap[g.pid];
    // item_id incluye el pick para que el mismo producto en dos picks sea item distinto
    const pickSuffix = g.pickName.replace(/[^A-Za-z0-9]/g,'_');
    return { item_id:'oi_'+g.pid+'_'+pickSuffix, odoo_product_id:g.pid, odoo_line_id:null,
      sku:prod.barcode||prod.default_code||'', barcode:prod.barcode||'',
      product_name:g.name||'', quantity:units, units,
      image:prod.image_128?'data:image/png;base64,'+prod.image_128:null,
      unitBins:g.unitBins, pickName:g.pickName, isRet:g.isRet||false, fromPick:true,
      ...(kit ? { kitId:kit.kitId, kitRef:kit.kitRef, kitName:kit.kitName, kitImage:kit.kitImage } : {}),
      locations:[], selected_location:null,
      selected:false, evidence_images:[], comments:'', status:'pending' };
  });

  return { noPick:false, items, picks, pickNames:pickList.map(p=>p.name) };
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

// Propaga la configuración de kits (armado/desarmado) de un empaque a sus subtareas
// de despacho/almacén. Si un kit está armado en el empaque → la subtarea muestra la
// tarjeta-kit (1 unidad); si está desarmado → muestra los componentes. No destructivo:
// preserva los datos de entrega ya registrados en la subtarea. Devuelve true si cambió algo.
function syncKitStructureToChildren(parentTask, tasks) {
  const children = tasks.filter(t => t.parentId === parentTask.id &&
    ['dispatch_order','warehouse_move'].includes(t.type) && t.status !== 'cancelled');
  if (!children.length) return false;
  const pItems = parentTask.items || [];
  if (!pItems.some(i => i.kitId)) return false; // sin kits, nada que sincronizar
  // Kits armados en el padre: 'kitId#inst' -> tarjeta-kit del padre
  const kitArmado = {};
  pItems.forEach(i => { if (i.isKit && i.selected) kitArmado[(i.kitId||'')+'#'+(i.kitInstance||1)] = i; });
  let changed = false;
  children.forEach(child => {
    const items = (child.items||[]).slice();
    const byId = {}; items.forEach(i => { byId[i.item_id] = i; });
    // 1) Componentes: ocultar si su kit-instancia está armada; mostrar si no
    items.forEach(i => {
      if (i.kitId && !i.isKit) {
        const key = (i.kitId||'')+'#'+(i.unit_index||1);
        const should = !kitArmado[key];
        if (i.selected !== should) { i.selected = should; changed = true; }
      }
    });
    // 2) Tarjetas-kit: crear/activar las armadas, desactivar las desarmadas
    Object.entries(kitArmado).forEach(([key, pkit]) => {
      const ex = byId[pkit.item_id];
      if (ex) { if (!ex.selected) { ex.selected = true; ex.isKit = true; changed = true; } }
      else {
        items.push({ ...pkit, evidence_images:[], deliveryStatus:'', deliveryDamageType:'',
          delivered:undefined, delivery_by:'', delivery_at:'', confirmado:false, condition:'', status:'pending' });
        changed = true;
      }
    });
    items.forEach(i => {
      if (i.isKit) {
        const key = (i.kitId||'')+'#'+(i.kitInstance||1);
        if (!kitArmado[key] && i.selected) { i.selected = false; changed = true; }
      }
    });
    if (changed) { child.items = items; child.updatedAt = new Date().toISOString(); }
  });
  return changed;
}

// ── Claude API (Anthropic) — cerebro de los agentes de IA ────────────────────
// Carga opcional: si el SDK o la key no están, los agentes caen a modo heurístico.
let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { /* SDK no instalado */ }
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const anthropicClient = (Anthropic && ANTHROPIC_KEY) ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// ── OpenAI / Codex — cerebro del Agente Auditor de Procesos ──────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CODEX_AUDITOR_MODEL = process.env.CODEX_AUDITOR_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini';

// Cache del parte del día (evita llamar a Claude en cada carga del dashboard).
// Se invalida cuando cambian los datos (hash) o al pasar el TTL.
let _opsBriefCache = { hash: '', brief: null, generatedAt: 0 };
const OPS_BRIEF_TTL = 30 * 60 * 1000; // 30 min
let _processAuditorAiCache = { hash: '', brief: null, generatedAt: 0 };
const PROCESS_AUDITOR_AI_TTL = 30 * 60 * 1000; // 30 min

// Reporte heurístico del Gerente de Operaciones (compartido por /ops-agent y /ops-agent/brief)
function computeOpsAgentReport() {
  const tasks = enrichOverdueTasks(loadWwpTasks(), { persist: true });
  const users = loadAuthUsers();
  const userById = {};
  users.forEach(u => { userById[u.id] = u; });

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const closedStatuses = new Set(['completed', 'validated', 'cancelled']);
  const active = tasks.filter(t => !closedStatuses.has(t.status));
  const parents = active.filter(t => !t.parentId);
  const subtasks = active.filter(t => t.parentId);
  const done = tasks.filter(t => t.status === 'completed' || t.status === 'validated');

  const hoursSince = (value) => {
    const ms = value ? now - new Date(value).getTime() : 0;
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 36e5) : 0;
  };
  const taskOwner = (t) => {
    if (t.managerId && userById[t.managerId]) return userById[t.managerId].name;
    if (t.managerName) return t.managerName;
    if (t.assignedTo && String(t.assignedTo).startsWith('oe_')) {
      const odooId = String(t.assignedTo).slice(3);
      const u = users.find(x => String(x.odooId || '') === odooId);
      if (u) return u.name;
    }
    return 'Sin responsable';
  };
  const taskUrl = (t) => ({
    id: t.id,
    seq: t.seq || null,
    title: t.title || t.odooRef || t.id,
    type: t.type || 'general',
    status: t.status,
    owner: taskOwner(t),
    dueDate: t.dueDate || null,
    updatedHoursAgo: hoursSince(t.updatedAt || t.createdAt),
    overdue: !!t.overdue,
    overdueDays: t.overdueDays || 0,
    escalation: t.escalation || null
  });
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const decisions = [];
  const pushDecision = (severity, title, action, task = null, reason = '') => {
    decisions.push({ severity, title, action, reason, task: task ? taskUrl(task) : null });
  };

  const overdue = active.filter(t => t.dueDate && t.dueDate < today);
  overdue.forEach(t => {
    const esc = t.escalation || {};
    const suggestion = esc.suggestedUserName
      ? `Reasignar a ${esc.suggestedUserName} o exigir ETA de cierre hoy.`
      : 'Escalar al gerente y exigir ETA de cierre hoy.';
    pushDecision('critical', 'Tarea overdue', suggestion, t, `Vencio el ${t.dueDate}${t.overdueDays ? ` (${t.overdueDays}d)` : ''}.`);
  });

  const staleInProgress = active.filter(t => t.status === 'in_progress' && hoursSince(t.updatedAt || t.createdAt) >= 8);
  staleInProgress.forEach(t => pushDecision('high', 'Tarea en progreso sin avance reciente', 'Pedir actualizacion, evidencia o desbloqueo operativo.', t, `${hoursSince(t.updatedAt || t.createdAt)}h sin actualizacion.`));

  const waitingAssignment = active.filter(t => ['pending', 'assigned'].includes(t.status) && hoursSince(t.createdAt) >= 24);
  waitingAssignment.forEach(t => pushDecision('medium', 'Tarea esperando ejecucion', 'Confirmar responsable, prioridad y hora de inicio.', t, `${hoursSince(t.createdAt)}h desde creacion.`));

  const noOwner = parents.filter(t => !t.managerId && !t.assignedTo);
  noOwner.forEach(t => pushDecision('high', 'Tarea sin responsable claro', 'Asignar encargado antes de crear mas subtareas.', t, 'No tiene managerId ni assignedTo.'));

  const missingEvidence = active.filter(t => {
    const selected = (t.items || []).filter(i => i.selected);
    if (!selected.length) return false;
    return selected.some(i => !(i.evidence_images || []).length);
  });
  missingEvidence.slice(0, 12).forEach(t => pushDecision('medium', 'Evidencia pendiente', 'Solicitar foto/evidencia para poder cerrar la tarea.', t, 'Hay articulos seleccionados sin evidencia.'));

  const readyToValidate = tasks.filter(t => t.status === 'completed');
  readyToValidate.forEach(t => pushDecision('high', 'Pendiente de validacion', 'Validar, devolver o documentar causa de espera.', t, 'La tarea ya fue marcada completada.'));

  const byOwner = {};
  active.forEach(t => {
    const owner = taskOwner(t);
    if (!byOwner[owner]) byOwner[owner] = { owner, total: 0, overdue: 0, inProgress: 0, assigned: 0, stale: 0 };
    byOwner[owner].total++;
    if (t.dueDate && t.dueDate < today) byOwner[owner].overdue++;
    if (t.status === 'in_progress') byOwner[owner].inProgress++;
    if (t.status === 'assigned') byOwner[owner].assigned++;
    if (hoursSince(t.updatedAt || t.createdAt) >= 8 && !closedStatuses.has(t.status)) byOwner[owner].stale++;
  });
  const workload = Object.values(byOwner).sort((a, b) => (b.overdue - a.overdue) || (b.total - a.total) || a.owner.localeCompare(b.owner));

  const byType = {};
  active.forEach(t => { byType[t.type || 'general'] = (byType[t.type || 'general'] || 0) + 1; });
  const avgCloseHours = done.length
    ? Math.round(done.reduce((s, t) => s + Math.max(0, new Date(t.updatedAt || t.createdAt).getTime() - new Date(t.createdAt).getTime()), 0) / done.length / 36e5 * 10) / 10
    : 0;

  decisions.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  const summary = {
    active: active.length,
    parentTasks: parents.length,
    subtasks: subtasks.length,
    overdue: overdue.length,
    stale: staleInProgress.length,
    waitingAssignment: waitingAssignment.length,
    noOwner: noOwner.length,
    missingEvidence: missingEvidence.length,
    readyToValidate: readyToValidate.length,
    avgCloseHours,
    byType
  };
  const nextActions = [
    overdue.length ? `Resolver ${overdue.length} vencida(s) antes de crear trabajo nuevo.` : 'No hay tareas vencidas activas.',
    readyToValidate.length ? `Validar o devolver ${readyToValidate.length} tarea(s) completada(s).` : 'No hay validaciones acumuladas.',
    noOwner.length ? `Asignar responsable a ${noOwner.length} tarea(s) sin dueño.` : 'Todas las tareas principales activas tienen responsable o asignacion.',
    missingEvidence.length ? `Pedir evidencia en ${missingEvidence.length} tarea(s) antes del cierre.` : 'No hay evidencia pendiente detectada en tareas activas.'
  ];

  return { summary, decisions: decisions.slice(0, 30), workload, nextActions };
}

// Normaliza una referencia de orden a su número (S06031 / 6031 / 06031 → "6031")
function normRef(ref){ const m=(ref||'').match(/\d+/); return m?String(parseInt(m[0],10)):''; }
// Artículos (productos) ya reclamados por tareas ACTIVAS de la misma orden, fuera de la
// cadena indicada. Permite que artículos distintos del mismo pick vayan a tareas distintas,
// pero impide asignar el MISMO artículo a dos cadenas a la vez.
// Devuelve, por producto, las UNIDADES (unit_index) ya reclamadas por tareas activas de la
// misma orden fuera de la cadena indicada. Permite repartir unidades de un mismo artículo
// entre encargados distintos (ej. 2 unidades a uno y 1 a otro).
function getOrderClaims(orderRef, excludeRootId) {
  const key = normRef(orderRef);
  if (!key) return {};
  const tasks = loadWwpTasks();
  const byId = {}; tasks.forEach(t=>{ byId[t.id]=t; });
  const rootOf = t => t.parentId || t.id;
  const claims = {}; // pid → { idxs:{idx:{seq,title,taskId}}, productName }
  tasks.forEach(t => {
    if (['cancelled','validated'].includes(t.status)) return;
    if (normRef(t.odooRef) !== key) return;
    const root = rootOf(t);
    if (excludeRootId && root === excludeRootId) return; // misma cadena → no bloquea
    const rt = byId[root] || t;
    (t.items||[]).filter(i=>i.selected && i.odoo_product_id && !i.isKit).forEach(i => {
      const pid = i.odoo_product_id;
      if (!claims[pid]) claims[pid] = { idxs:{}, productName:i.product_name||'' };
      claims[pid].idxs[i.unit_index||1] = { seq:rt.seq||null, title:rt.title||t.title, taskId:t.id };
    });
  });
  // Resumen: lista de índices reclamados + un ejemplo de tarea (para el mensaje)
  Object.values(claims).forEach(c => {
    c.idxList = Object.keys(c.idxs).map(Number).sort((a,b)=>a-b);
    c.count = c.idxList.length;
    const first = c.idxs[c.idxList[0]] || {};
    c.seq = first.seq; c.title = first.title; c.taskId = first.taskId;
  });
  return claims;
}

// Secuencia incremental de tareas (alto agua persistente; no se reutiliza al borrar)
const WWP_SEQ_FILE = path.join(DATA_DIR, 'wwp-task-seq.json');
function nextTaskSeq() {
  let meta = loadJson(WWP_SEQ_FILE, { seq: 0 });
  // Defensa: si el contador quedó por debajo del máximo existente, lo sube
  try {
    const tasks = enrichOverdueTasks(loadWwpTasks(), { persist: true });
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
  { id:'assistant', name:'Auxiliar',  isBuiltin:true, sectionPerms:{ 'wwp.rastreo_gps': true } },
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

const PROCESS_AUDITOR_FILE = path.join(DATA_DIR, 'wwp-process-auditor.json');
const AGENT_OWNER_EMAIL = 'gsanchez@altritempi.com.do';
function loadProcessAuditorState() {
  const state = loadJson(PROCESS_AUDITOR_FILE, { recommendations: {}, chat: [], opsChats: { manager: [], assistant: [] } });
  return ensureAgentGroupState(state);
}
function saveProcessAuditorState(state) {
  saveJson(PROCESS_AUDITOR_FILE, ensureAgentGroupState(state || { recommendations: {}, chat: [], opsChats: { manager: [], assistant: [] } }));
}
function getAuthUser(jp) {
  return loadAuthUsers().find(u => u.id === jp.userId) || null;
}
function isAgentOwner(jp) {
  const user = getAuthUser(jp);
  return !!(user && String(user.email || '').toLowerCase().trim() === AGENT_OWNER_EMAIL);
}
function requireAgentOwner(jp, res) {
  if (isAgentOwner(jp)) return true;
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok:false, error:'Este agente esta reservado para gsanchez@altritempi.com.do' }));
  return false;
}

const AGENT_COMPANY_CONTEXT_TTL = 10 * 60_000;
let _agentCompanyContextCache = { at: 0, value: null };

function getAgentCompanyKnowledgeBase() {
  return {
    company: {
      name: 'Altri Tempi',
      country: 'Republica Dominicana',
      business: 'Operacion comercial y logistica de muebles, decoracion, almacen, empaque, despachos y servicio postventa.',
      operatingPrinciple: 'La empresa necesita trazabilidad clara por orden, articulo, responsable, evidencia, ubicacion y cierre operativo.',
      communicationStyle: 'Respuestas claras, honestas, enfocadas en la solicitud, utiles para ventas, operaciones y gerencia.'
    },
    currentScope: {
      platform: 'Workforce Platform / Historial',
      allowedActions: [
        'Analizar tareas y seguimiento operativo dentro de Workforce Platform.',
        'Leer contexto de Odoo para entender ordenes, clientes, picks, inventario y flujo de empresa.',
        'Redactar documentos, manuales, recomendaciones, mensajes y planes de accion.',
        'Proponer cambios de plataforma con comando exacto para Codex cuando Gabriel apruebe.'
      ],
      restrictions: [
        'No escribir, confirmar, cancelar ni modificar registros de Odoo desde los agentes.',
        'No ejecutar cambios en la plataforma sin aprobacion explicita de Gabriel.',
        'No exponer llaves, tokens, contrasenas ni variables de entorno.',
        'No actuar fuera de Workforce Platform hasta que se habilite una fase futura.'
      ],
      futureExpansion: 'Los agentes estan preparados para crecer hacia todo Historial, pero hoy su actuacion automatica queda limitada a Workforce Platform.'
    },
    systems: [
      { name: 'Odoo', role: 'ERP de ventas, clientes, inventario, picks, entregas y documentos operativos.', access: 'solo lectura para contexto de agentes' },
      { name: 'Workforce Platform', role: 'Gestion de tareas, chat, evidencias, validaciones, dashboard, auditoria y mejora continua.', access: 'analisis y recomendaciones; acciones controladas por permisos' },
      { name: 'Historial', role: 'Consulta y trazabilidad ampliada de ordenes, solicitudes, contenedores, reposicion, pendientes y reportes.', access: 'contexto futuro' },
      { name: 'Documentos operativos', role: 'Manuales, flujos, matrices RACI, KPIs, permisos, entrenamiento y screenshots requeridos.', access: 'lectura, generacion y actualizacion documental propuesta' }
    ],
    associatedDocuments: [
      'Manual completo del flujo de tareas operativas',
      'Manual completo de empaque y almacenamiento',
      'Manual completo de despacho y entrega',
      'Manual completo de gerencia, auditoria y mejora continua',
      'Descripcion de puesto por posicion',
      'Matriz RACI por posicion',
      'KPIs/SLA por rol y proceso',
      'Manual de entrenamiento y permisos por posicion',
      'Mapa funcional de pantallas, botones, datos, permisos y screenshots requeridos'
    ],
    businessGlossary: {
      orden: 'Orden de venta o referencia comercial en Odoo, usualmente formato S#####.',
      pick: 'Movimiento/preparacion en Odoo que confirma disponibilidad o preparacion de articulos antes de despacho.',
      picking: 'Transferencia de inventario en Odoo: recepcion, pick, despacho o traslado interno.',
      ubicacion: 'Localidad fisica o logica del inventario en Odoo/almacen.',
      obsoleto: 'Ubicacion o clasificacion de inventario que puede requerir venta especial, liquidacion o revision comercial.',
      familia: 'Categoria comercial o categoria de producto usada para agrupar articulos.',
      disponible: 'Cantidad fisica menos reservas visibles cuando el dato esta disponible.',
      evidencia: 'Foto, documento o comentario que permite validar que una tarea fue ejecutada correctamente.',
      cierre: 'Estado final validado de una tarea o proceso.'
    },
    dataSources: [
      {
        name: 'Odoo',
        useFor: ['ordenes de venta', 'clientes', 'productos', 'familias/categorias', 'ubicaciones', 'stock', 'picks', 'pickings', 'inventario disponible'],
        rule: 'Consultar en solo lectura y presentar datos en formato de negocio. No modificar registros.'
      },
      {
        name: 'Workforce Platform',
        useFor: ['tareas', 'responsables', 'estados', 'fechas limite', 'evidencias', 'chat operativo', 'validaciones'],
        rule: 'Usar solo si la solicitud trata de ejecucion operativa, tareas o seguimiento.'
      },
      {
        name: 'Google Sheets / Historial',
        useFor: ['ordenes historicas', 'contenedores', 'reposicion', 'solicitudes', 'pendientes', 'reportes'],
        rule: 'Usar como apoyo cuando el usuario pida trazabilidad historica o reportes de Historial.'
      }
    ],
    responsePlaybook: [
      'Identificar primero la intencion exacta del usuario: reporte, consulta, decision, documento, seguimiento o mejora.',
      'Consultar la fuente correcta antes de responder cuando el usuario lo pida explicitamente.',
      'No mezclar temas: si el usuario pide Odoo/ventas, no responder con dashboard de tareas; si pide tareas, no responder con ventas.',
      'Si falta informacion, explicar la limitante exacta y pedir solo el dato necesario.',
      'Entregar primero el resultado terminado; dejar notas y limitantes al final.',
      'Usar lenguaje profesional, simple y listo para compartir.'
    ],
    reportFormats: [
      {
        name: 'Reporte para ventas',
        structure: ['Resumen ejecutivo', 'Tabla por familia/categoria', 'Detalle por articulo', 'Totales', 'Texto corto para enviar'],
        columns: ['Familia', 'Codigo', 'Articulo', 'Cantidad disponible', 'Ubicacion', 'Comentario comercial si aplica'],
        tone: 'Simple, comercial, sin tecnicismos de base de datos.'
      },
      {
        name: 'Tabla tipo Excel',
        structure: ['Tabla Markdown o CSV', 'encabezados claros', 'numeros con 2 decimales cuando aplique', 'totales al final'],
        columns: ['Categoria', 'Referencia', 'Descripcion', 'Cantidad', 'Estado', 'Observacion'],
        tone: 'Ordenado y facil de copiar/pegar.'
      },
      {
        name: 'Reporte gerencial',
        structure: ['Resumen de 3-5 lineas', 'hallazgos clave', 'riesgos', 'decision recomendada', 'siguientes pasos'],
        columns: ['Tema', 'Hallazgo', 'Impacto', 'Accion recomendada', 'Responsable sugerido'],
        tone: 'Directo, accionable y sin relleno.'
      },
      {
        name: 'Manual o procedimiento',
        structure: ['Objetivo', 'Alcance', 'roles', 'prerequisitos', 'paso a paso', 'excepciones', 'evidencias', 'criterios de cierre', 'KPIs', 'screenshots requeridos'],
        columns: ['Paso', 'Responsable', 'Pantalla', 'Accion', 'Resultado esperado'],
        tone: 'Completo, operativo y entendible para usuarios reales.'
      },
      {
        name: 'Mensaje de seguimiento',
        structure: ['Saludo humano', 'motivo concreto', 'dato solicitado', 'hora/ETA requerida', 'cierre amable'],
        columns: [],
        tone: 'Conversacional, respetuoso y claro.'
      }
    ],
    answerQualityChecklist: [
      'La respuesta contesta exactamente lo que pidio Gabriel.',
      'Los datos estan presentados como reporte, no como JSON/base de datos.',
      'Hay tabla, totales o agrupacion cuando la solicitud contiene datos.',
      'No hay informacion operativa no solicitada.',
      'Las limitantes estan al final y son concretas.',
      'El resultado se puede copiar a Excel, correo, WhatsApp o presentar a gerencia/ventas.'
    ],
    examples: [
      {
        request: 'Consulta en Odoo articulos en ubicacion obsoleto por familia para ventas.',
        goodAnswer: 'Entregar resumen ejecutivo, tabla por familia, detalle por articulo y texto corto para ventas.',
        badAnswer: 'Responder con tareas vencidas, picks abiertos o contexto operativo no solicitado.'
      },
      {
        request: 'Prepara un manual del flujo de empaque.',
        goodAnswer: 'Entregar documento completo con objetivo, alcance, roles, pasos, evidencias, excepciones, cierre y screenshots.',
        badAnswer: 'Dar una lista breve o pedir que el usuario explique todo otra vez.'
      },
      {
        request: 'Dime que decision tomar hoy en operaciones.',
        goodAnswer: 'Usar tareas, vencidas, responsables, evidencias y dar una decision priorizada.',
        badAnswer: 'Irse a Odoo ventas si no fue pedido.'
      }
    ],
    agentBehavior: [
      'Ser sinceros, responsables y concretos.',
      'Separar hechos confirmados de inferencias.',
      'Pedir informacion solo cuando sea necesaria; si falta, entregar una version base util.',
      'Cuidar la operacion: prioridad en vencidas, bloqueos, evidencias, validaciones, responsable claro y cliente.',
      'Aprender de correcciones de Gabriel y aplicarlas en la siguiente respuesta.',
      'Preparar entregables con acabado profesional, no borradores a medias.'
    ]
  };
}

async function getOdooCompanySnapshot() {
  const snapshot = {
    ok: false,
    access: 'read_only',
    generatedAt: new Date().toISOString(),
    saleOrders: [],
    openPickings: [],
    stockSamples: [],
    error: null
  };
  try {
    snapshot.saleOrders = await odooCall('sale.order', 'search_read', [[['state', 'in', ['sale', 'done']]]], {
      fields: ['name', 'partner_id', 'date_order', 'state', 'amount_total'],
      limit: 6,
      order: 'date_order desc'
    });
  } catch (e) {
    snapshot.error = `sale.order: ${safeError(e)}`;
  }
  try {
    snapshot.openPickings = await odooCall('stock.picking', 'search_read', [[['state', 'not in', ['done', 'cancel']]]], {
      fields: ['name', 'origin', 'state', 'scheduled_date', 'picking_type_id', 'partner_id'],
      limit: 8,
      order: 'scheduled_date asc'
    });
  } catch (e) {
    snapshot.error = snapshot.error || `stock.picking: ${safeError(e)}`;
  }
  try {
    snapshot.stockSamples = await odooCall('stock.quant', 'search_read', [[['quantity', '>', 0]]], {
      fields: ['product_id', 'location_id', 'quantity', 'reserved_quantity'],
      limit: 8
    });
  } catch (e) {
    snapshot.error = snapshot.error || `stock.quant: ${safeError(e)}`;
  }
  snapshot.ok = !!(snapshot.saleOrders.length || snapshot.openPickings.length || snapshot.stockSamples.length);
  return snapshot;
}

function needsObsoleteStockReport(text) {
  const q = String(text || '').toLowerCase();
  return q.includes('obsoleto') && (q.includes('ubicacion') || q.includes('ubicación') || q.includes('stock') || q.includes('articulo') || q.includes('artículo'));
}

async function getOdooObsoleteStockReport() {
  const report = {
    ok: false,
    title: 'Articulos disponibles en ubicacion obsoleto',
    generatedAt: new Date().toISOString(),
    locationQuery: 'obsoleto',
    locations: [],
    rows: [],
    byFamily: [],
    errors: []
  };
  try {
    let locations = await odooCall('stock.location', 'search_read', [[['complete_name', 'ilike', 'obsoleto']]], {
      fields: ['name', 'complete_name', 'usage'],
      limit: 50
    });
    if (!locations.length) {
      locations = await odooCall('stock.location', 'search_read', [[['name', 'ilike', 'obsoleto']]], {
        fields: ['name', 'complete_name', 'usage'],
        limit: 50
      });
    }
    report.locations = locations.map(l => ({ id: l.id, name: l.name, completeName: l.complete_name || l.name, usage: l.usage || null }));
    const locationIds = locations.map(l => l.id).filter(Boolean);
    if (!locationIds.length) {
      report.errors.push('No encontre una ubicacion de Odoo que contenga "obsoleto".');
      return report;
    }

    const quants = await odooCall('stock.quant', 'search_read', [[['location_id', 'in', locationIds], ['quantity', '>', 0]]], {
      fields: ['product_id', 'location_id', 'quantity', 'reserved_quantity'],
      limit: 2000
    });
    const productIds = [...new Set(quants.map(q => Array.isArray(q.product_id) ? q.product_id[0] : q.product_id).filter(Boolean))];
    const products = productIds.length
      ? await odooCall('product.product', 'read', [productIds], { fields: ['display_name', 'default_code', 'categ_id'] })
      : [];
    const productMap = new Map(products.map(p => [p.id, p]));
    const rowMap = new Map();
    quants.forEach(q => {
      const productId = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
      const product = productMap.get(productId) || {};
      const family = Array.isArray(product.categ_id) ? product.categ_id[1] : 'Sin familia visible';
      const code = product.default_code || '';
      const name = product.display_name || (Array.isArray(q.product_id) ? q.product_id[1] : String(productId || 'Producto'));
      const location = Array.isArray(q.location_id) ? q.location_id[1] : '';
      const key = `${family}|${code}|${name}`;
      const existing = rowMap.get(key) || { family, code, product: name, quantity: 0, reserved: 0, available: 0, locations: new Set() };
      existing.quantity += Number(q.quantity || 0);
      existing.reserved += Number(q.reserved_quantity || 0);
      existing.available += Math.max(0, Number(q.quantity || 0) - Number(q.reserved_quantity || 0));
      if (location) existing.locations.add(location);
      rowMap.set(key, existing);
    });
    report.rows = Array.from(rowMap.values())
      .map(r => ({ ...r, locations: Array.from(r.locations).join(' / ') }))
      .sort((a, b) => String(a.family).localeCompare(String(b.family)) || String(a.product).localeCompare(String(b.product)));
    const familyMap = new Map();
    report.rows.forEach(r => {
      const f = familyMap.get(r.family) || { family: r.family, items: 0, quantity: 0, reserved: 0, available: 0 };
      f.items += 1;
      f.quantity += r.quantity;
      f.reserved += r.reserved;
      f.available += r.available;
      familyMap.set(r.family, f);
    });
    report.byFamily = Array.from(familyMap.values()).sort((a, b) => String(a.family).localeCompare(String(b.family)));
    report.ok = true;
    return report;
  } catch (e) {
    report.errors.push(safeError(e));
    return report;
  }
}

async function getAgentCompanyContext({ includeOdoo = true } = {}) {
  const now = Date.now();
  if (includeOdoo && _agentCompanyContextCache.value && now - _agentCompanyContextCache.at < AGENT_COMPANY_CONTEXT_TTL) {
    return _agentCompanyContextCache.value;
  }
  const context = {
    generatedAt: new Date().toISOString(),
    knowledgeBase: getAgentCompanyKnowledgeBase(),
    odoo: includeOdoo ? await getOdooCompanySnapshot() : { ok: false, access: 'not_requested' }
  };
  if (includeOdoo) _agentCompanyContextCache = { at: now, value: context };
  return context;
}

function getDefaultAgentRoster() {
  return [
    {
      id: 'coordinator',
      avatar: '🧭',
      name: 'Coordinador de Agentes',
      specialty: 'Moderacion, delegacion y respuesta final',
      description: 'Discierne que agente debe participar, divide la solicitud y entrega la respuesta terminada.'
    },
    {
      id: 'ops_manager',
      avatar: '🏛️',
      name: 'Gerente de Operaciones',
      specialty: 'Decisiones operativas, prioridades, riesgos y avance',
      description: 'Analiza tareas, atrasos, carga de trabajo, evidencias, validaciones y escalamiento.'
    },
    {
      id: 'ops_assistant',
      avatar: '✦',
      name: 'Asistente de Operaciones',
      specialty: 'Seguimiento humano y comunicacion con responsables',
      description: 'Redacta mensajes conversacionales, pide updates y ayuda a destrabar actividades.'
    },
    {
      id: 'process_auditor',
      avatar: '⚖️',
      name: 'Auditor Codex de Procesos',
      specialty: 'Auditoria, manuales, flujos y mejoras de plataforma',
      description: 'Crea documentos terminados, audita pantallas, botones, permisos, evidencias y cambios.'
    },
    {
      id: 'warehouse_specialist',
      avatar: '◈',
      name: 'Especialista de Almacen y Empaque',
      specialty: 'Almacenamiento, empaque, ubicaciones y evidencias',
      description: 'Se enfoca en condicion de articulos, fotos, ubicacion destino, materiales y cierre correcto.'
    },
    {
      id: 'odoo_analyst',
      avatar: '🛰️',
      name: 'Analista Odoo / Historial',
      specialty: 'Contexto de ordenes, picks, inventario y trazabilidad',
      description: 'Usa Odoo en solo lectura para explicar contexto empresarial y relacionarlo con Workforce Platform.'
    },
    {
      id: 'documenter',
      avatar: '📜',
      name: 'Documentador de Plataforma',
      specialty: 'Documentos acabados, puestos, RACI, KPIs y entrenamiento',
      description: 'Convierte hallazgos en manuales, procedimientos, matrices y documentos listos para usuarios reales.'
    }
  ];
}

function ensureAgentGroupState(state) {
  state = state || {};
  if (!state.recommendations) state.recommendations = {};
  if (!Array.isArray(state.chat)) state.chat = [];
  if (!state.opsChats) state.opsChats = { manager: [], assistant: [] };
  if (!state.agentGroup || typeof state.agentGroup !== 'object') state.agentGroup = {};
  const defaults = getDefaultAgentRoster();
  const existing = Array.isArray(state.agentGroup.agents) ? state.agentGroup.agents : [];
  const byId = new Map([...defaults, ...existing].map(a => [a.id, a]));
  state.agentGroup.agents = Array.from(byId.values());
  if (!Array.isArray(state.agentGroup.chat)) state.agentGroup.chat = [];
  if (!Array.isArray(state.agentGroup.preferences)) state.agentGroup.preferences = [
    'Responder 100% la solicitud exacta de Gabriel.',
    'No agregar dashboard, tareas vencidas, auditoria ni recomendaciones operativas si no fueron solicitadas.',
    'Si falta un dato, consultar la fuente disponible o pedir solo la limitante exacta.',
    'Entregar el resultado final listo para usar, sin mostrar instrucciones internas de delegacion.',
    'Presentar datos como informacion de negocio, no como base de datos cruda: usar tablas limpias, resumen ejecutivo, totales, agrupaciones y formatos listos para copiar a Excel, CSV, WhatsApp o correo.',
    'Cuando el usuario pida reportes para ventas, gerencia u operaciones, entregar primero una version presentable y sencilla; solo incluir detalle tecnico si lo pide.'
  ];
  state.agentGroup.knowledgePack = {
    name: 'Paquete operativo para respuestas excelentes',
    version: '2026-06-10',
    purpose: 'Alinear a todos los agentes para responder con enfoque, contexto empresarial y formatos profesionales.',
    rules: [
      'Responder exactamente la solicitud de Gabriel.',
      'Elegir la fuente correcta: Odoo, Workforce, Historial/Sheets o documentos.',
      'Convertir datos en reportes presentables.',
      'Separar hechos, inferencias y limitantes.',
      'Pedir solo el dato faltante si no se puede completar.',
      'Mantener Odoo en solo lectura.',
      'No asignar rutinas/tareas periodicas hasta que Gabriel lo apruebe.'
    ],
    outputFormats: [
      'Resumen ejecutivo',
      'Tabla tipo Excel',
      'CSV cuando se pida exportable',
      'Detalle por articulo/orden/responsable',
      'Agrupacion por familia/categoria/estado',
      'Texto corto listo para ventas/correo/WhatsApp',
      'Documento operativo completo'
    ],
    templateLibrary: [
      {
        id: 'sales_report',
        name: 'Reporte para ventas',
        sections: ['Titulo claro', 'Resumen ejecutivo', 'Tabla resumen', 'Detalle para Excel', 'Texto corto para enviar'],
        bestFor: ['ventas', 'inventario comercial', 'obsoletos', 'liquidacion', 'disponibilidad']
      },
      {
        id: 'excel_table',
        name: 'Tabla tipo Excel',
        sections: ['Encabezados limpios', 'filas ordenadas', 'totales', 'notas al final'],
        bestFor: ['listados', 'cantidades', 'productos', 'ubicaciones', 'familias']
      },
      {
        id: 'executive_brief',
        name: 'Resumen gerencial',
        sections: ['Situacion', 'hallazgos', 'impacto', 'decision recomendada', 'proximos pasos'],
        bestFor: ['gerencia', 'operaciones', 'riesgos', 'prioridades']
      },
      {
        id: 'process_document',
        name: 'Documento operativo completo',
        sections: ['Objetivo', 'alcance', 'roles', 'prerequisitos', 'paso a paso', 'excepciones', 'evidencias', 'criterios de cierre', 'KPIs'],
        bestFor: ['manuales', 'flujos', 'entrenamiento', 'puestos']
      },
      {
        id: 'follow_up_message',
        name: 'Mensaje de seguimiento',
        sections: ['Saludo', 'motivo', 'dato solicitado', 'ETA', 'cierre amable'],
        bestFor: ['chat de tareas', 'actualizaciones', 'bloqueos']
      }
    ]
  };
  if (!Array.isArray(state.agentGroup.dailyAssignments)) state.agentGroup.dailyAssignments = [];
  state.agentGroup.routines = mergeAgentRoutines(state.agentGroup.routines);
  return state;
}

function getDefaultAgentRoutines() {
  return [
    {
      id: 'daily_ops_brief',
      name: 'Parte diario de operaciones',
      agentId: 'ops_manager',
      avatar: '🏛️',
      enabled: false,
      schedule: { type: 'daily', time: '08:00' },
      prompt: 'Prepara un parte diario de operaciones con tareas activas, vencidas, sin avance, evidencias pendientes, decisiones urgentes y proximas acciones.',
      outputFormat: 'Resumen gerencial',
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: 'pendiente'
    },
    {
      id: 'overdue_followup',
      name: 'Seguimiento a tareas vencidas',
      agentId: 'ops_assistant',
      avatar: '✦',
      enabled: false,
      schedule: { type: 'interval', minutes: 60 },
      prompt: 'Revisa tareas vencidas o sin avance y prepara mensajes humanos de seguimiento para responsables. No envies mensajes automaticamente; deja recomendacion lista.',
      outputFormat: 'Mensaje de seguimiento',
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: 'pendiente'
    },
    {
      id: 'weekly_obsolete_stock',
      name: 'Reporte semanal de obsoletos para ventas',
      agentId: 'odoo_analyst',
      avatar: '🛰️',
      enabled: false,
      schedule: { type: 'weekly', weekday: 1, time: '08:30' },
      prompt: 'Consulta en Odoo los articulos en ubicacion obsoleto, agrupados por familia, cantidades disponibles y formato listo para ventas.',
      outputFormat: 'Reporte para ventas',
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: 'pendiente'
    },
    {
      id: 'nightly_process_review',
      name: 'Revision nocturna de procesos',
      agentId: 'process_auditor',
      avatar: '⚖️',
      enabled: false,
      schedule: { type: 'daily', time: '19:00' },
      prompt: 'Revisa cambios, brechas de procesos, documentos pendientes y mejoras recomendadas. Entrega solo hallazgos accionables.',
      outputFormat: 'Reporte gerencial',
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: 'pendiente'
    }
  ];
}

function mergeAgentRoutines(existing) {
  const byId = new Map(getDefaultAgentRoutines().map(r => [r.id, r]));
  (Array.isArray(existing) ? existing : []).forEach(r => {
    if (!r || !r.id) return;
    byId.set(r.id, { ...(byId.get(r.id) || {}), ...r, schedule: { ...((byId.get(r.id) || {}).schedule || {}), ...(r.schedule || {}) } });
  });
  return Array.from(byId.values()).map(r => ({ ...r, nextRunAt: computeRoutineNextRun(r) }));
}

function routineLocalNow() {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santo_Domingo' }));
  return { now, local };
}

function parseRoutineTime(value) {
  const [h, m] = String(value || '08:00').split(':').map(n => parseInt(n, 10));
  return { h: Number.isFinite(h) ? h : 8, m: Number.isFinite(m) ? m : 0 };
}

function localRoutineDateToIso(localDate) {
  const offsetMs = Date.now() - new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santo_Domingo' })).getTime();
  return new Date(localDate.getTime() + offsetMs).toISOString();
}

function computeRoutineNextRun(routine) {
  if (!routine || !routine.enabled) return null;
  const { local } = routineLocalNow();
  const schedule = routine.schedule || {};
  if (schedule.type === 'interval') {
    const minutes = Math.max(5, Number(schedule.minutes || 60));
    const base = routine.lastRunAt ? new Date(routine.lastRunAt) : new Date();
    return new Date(base.getTime() + minutes * 60000).toISOString();
  }
  const { h, m } = parseRoutineTime(schedule.time);
  const next = new Date(local);
  next.setHours(h, m, 0, 0);
  if (schedule.type === 'weekly') {
    const target = Number.isFinite(Number(schedule.weekday)) ? Number(schedule.weekday) : 1;
    const day = next.getDay();
    let add = (target - day + 7) % 7;
    if (add === 0 && next <= local) add = 7;
    next.setDate(next.getDate() + add);
  } else if (next <= local) {
    next.setDate(next.getDate() + 1);
  }
  return localRoutineDateToIso(next);
}

function getRoutineDue(routine) {
  return !!(routine && routine.enabled && routine.nextRunAt && new Date(routine.nextRunAt).getTime() <= Date.now());
}

let _agentRoutineSchedulerBusy = false;
async function tickAgentRoutineScheduler() {
  if (_agentRoutineSchedulerBusy) return;
  _agentRoutineSchedulerBusy = true;
  try {
    const state = loadProcessAuditorState();
    const due = (state.agentGroup.routines || []).filter(getRoutineDue).slice(0, 2);
    for (const routine of due) {
      try {
        await runAgentRoutineById(routine.id);
      } catch (e) {
        const latest = loadProcessAuditorState();
        const idx = (latest.agentGroup.routines || []).findIndex(r => r.id === routine.id);
        if (idx >= 0) {
          latest.agentGroup.routines[idx].lastRunAt = new Date().toISOString();
          latest.agentGroup.routines[idx].lastStatus = 'error: ' + safeError(e);
          latest.agentGroup.routines = mergeAgentRoutines(latest.agentGroup.routines);
          saveProcessAuditorState(latest);
        }
        console.warn('[agent-routine]', routine.id, e.message);
      }
    }
  } finally {
    _agentRoutineSchedulerBusy = false;
  }
}

setInterval(() => { tickAgentRoutineScheduler().catch(e => console.warn('[agent-routine-tick]', e.message)); }, 60_000);

function pickAgentParticipants(text, agents) {
  const q = String(text || '').toLowerCase();
  const ids = new Set(['coordinator']);
  const hasAny = (words) => words.some(w => q.includes(w));
  const asksOdooStock = hasAny(['odoo', 'orden', 'pick', 'inventario', 'cliente', 'historial', 'venta', 'stock', 'ubicacion', 'ubicación', 'familia', 'producto', 'articulo', 'artículo', 'obsoleto']);
  if (hasAny(['tarea', 'avance', 'vencid', 'overdue', 'operacion', 'responsable', 'prioridad', 'dashboard', 'riesgo']) && !asksOdooStock) ids.add('ops_manager');
  if (hasAny(['mensaje', 'chat', 'seguimiento', 'actualizacion', 'humano', 'conversacion', 'pedir'])) ids.add('ops_assistant');
  if (hasAny(['auditor', 'proceso', 'flujo', 'manual', 'documento', 'raci', 'kpi', 'permiso', 'puesto', 'pantalla', 'boton', 'mejora'])) ids.add('process_auditor');
  if (hasAny(['empaque', 'almacen', 'almacenamiento', 'ubicacion', 'foto', 'evidencia', 'material', 'condicion'])) ids.add('warehouse_specialist');
  if (asksOdooStock) ids.add('odoo_analyst');
  if (hasAny(['plantilla', 'manual', 'documento', 'entrenamiento', 'capacitacion', 'procedimiento', 'paso a paso'])) ids.add('documenter');
  if (ids.size === 1) ids.add('ops_manager');
  const available = new Set((agents || []).map(a => a.id));
  return Array.from(ids).filter(id => available.has(id));
}

function formatObsoleteStockReport(report) {
  if (!report || !report.ok) {
    return [
      'No pude completar el reporte de articulos en ubicacion obsoleto.',
      '',
      'Limitante:',
      (report?.errors || ['No hay datos disponibles de esa ubicacion.']).map(e => `- ${e}`).join('\n')
    ].join('\n');
  }
  const lines = [
    'Reporte para Ventas - Articulos en ubicacion obsoleto',
    '',
    'Resumen ejecutivo:',
    `- Familias con disponibilidad: ${report.byFamily.length}`,
    `- Articulos disponibles: ${report.rows.length}`,
    `- Cantidad total disponible: ${report.byFamily.reduce((s, f) => s + Number(f.available || 0), 0).toFixed(2)}`,
    '',
    'Tabla resumen para Excel:',
    'Familia | Items | Cantidad disponible',
    '---|---:|---:'
  ];
  report.byFamily.forEach(f => lines.push(`${f.family} | ${f.items} | ${Number(f.available || 0).toFixed(2)}`));
  lines.push('', 'Detalle para Excel:', 'Familia | Codigo | Articulo | Disponible | Reservado | Ubicacion');
  lines.push('---|---|---|---:|---:|---');
  report.rows.forEach(r => lines.push(`${r.family} | ${r.code || ''} | ${r.product} | ${Number(r.available || 0).toFixed(2)} | ${Number(r.reserved || 0).toFixed(2)} | ${r.locations || ''}`));
  lines.push('', 'Texto corto para enviar a ventas:');
  lines.push(`Les comparto el reporte de articulos disponibles en ubicacion obsoleto, agrupado por familia. Total disponible: ${report.byFamily.reduce((s, f) => s + Number(f.available || 0), 0).toFixed(2)} unidades en ${report.rows.length} articulo(s).`);
  lines.push('', `Ubicaciones consultadas: ${(report.locations || []).map(l => l.completeName || l.name).join(' / ')}`);
  return lines.join('\n');
}

function detectAgentOutputFormat(text) {
  const body = String(text || '');
  const hasMarkdownTable = body.split('\n').some(line => /\|.+\|/.test(line)) && body.includes('---');
  const hasCsvLike = body.split('\n').some(line => (line.match(/,/g) || []).length >= 2);
  if (/whatsapp/i.test(body)) return 'whatsapp';
  if (/correo/i.test(body)) return 'email';
  if (hasMarkdownTable) return 'table';
  if (hasCsvLike) return 'csv';
  if (/objetivo|alcance|paso a paso|criterios de cierre/i.test(body)) return 'document';
  if (/resumen ejecutivo|hallazgos|recomendaci/i.test(body)) return 'executive';
  return 'text';
}

function evaluateAgentAnswerQuality(request, answer, context = {}) {
  const q = String(request || '').toLowerCase();
  const a = String(answer || '');
  const issues = [];
  const hasTable = detectAgentOutputFormat(a) === 'table' || /\|.+\|/.test(a);
  const asksReport = /reporte|excel|tabla|ventas|csv|listado|cantidad|familia|art[ií]culo|inventario/i.test(q);
  const asksOdoo = /odoo|stock|ubicaci[oó]n|orden|pick|inventario/i.test(q);
  const offTopicOps = /vencid|overdue|sin avance|sin evidencia|dashboard|tareas activas/i.test(a.toLowerCase()) && !/tarea|dashboard|operaci[oó]n|avance|vencid|evidencia/i.test(q);

  if (asksReport && !hasTable && !/no pude|limitante|no encontre/i.test(a)) issues.push('Falta tabla o formato copiable para el reporte solicitado.');
  if (asksOdoo && /tareas activas|dashboard|vencidas|sin evidencia/i.test(a.toLowerCase()) && !/tarea|dashboard/i.test(q)) issues.push('La respuesta se desvio a operacion interna cuando el pedido era de Odoo/datos.');
  if (offTopicOps) issues.push('Incluye informacion operativa no solicitada.');
  if (a.length < 80) issues.push('Respuesta demasiado corta para ser un entregable terminado.');
  if (/base de datos|json|raw/i.test(a) && asksReport) issues.push('El reporte suena tecnico; debe presentarse como informacion de negocio.');

  return {
    passed: issues.length === 0,
    score: Math.max(0, 100 - issues.length * 20),
    issues,
    format: detectAgentOutputFormat(a),
    suggestedActions: [
      ...(hasTable ? ['copy_table', 'download_csv'] : []),
      'copy_answer'
    ]
  };
}

async function runAgentRoutineById(routineId, { manualBy = null } = {}) {
  const state = loadProcessAuditorState();
  const routine = (state.agentGroup.routines || []).find(r => r.id === routineId);
  if (!routine) throw new Error('Rutina no encontrada');
  const agents = state.agentGroup.agents || getDefaultAgentRoster();
  const report = computeOpsAgentReport();
  const companyContext = await getAgentCompanyContext({ includeOdoo: true });
  const specialReports = {};
  if (needsObsoleteStockReport(routine.prompt)) {
    specialReports.obsoleteStock = await getOdooObsoleteStockReport();
  }
  const request = `[Rutina automatica] ${routine.name}: ${routine.prompt}`;
  let result = fallbackAgentGroupReply(request, agents, report, companyContext, specialReports);
  let ai = !!OPENAI_API_KEY;

  if (OPENAI_API_KEY) {
    try {
      const systemPrompt = [
        'Eres el Coordinador de Agentes de Altri Tempi ejecutando una rutina automatica aprobada por Gabriel.',
        'Responde solo el objetivo de la rutina. No agregues temas no solicitados.',
        'Entrega un resultado terminado y accionable con formato profesional.',
        'Si la rutina requiere datos, usa las fuentes del payload y presenta tablas limpias cuando aplique.',
        'Odoo es solo lectura.',
        'Devuelve JSON valido: {"participantIds":[],"consultations":[],"newAgents":[],"format":"","finalAnswer":""}.'
      ].join(' ');
      const payloadContext = {
        routine,
        agents,
        preferences: state.agentGroup.preferences,
        knowledgePack: state.agentGroup.knowledgePack,
        fullKnowledgeBase: getAgentCompanyKnowledgeBase(),
        companyContext,
        specialReports,
        opsSummary: Object.keys(specialReports).length ? null : report.summary,
        opsDecisions: Object.keys(specialReports).length ? [] : (report.decisions || []).slice(0, 12),
        currentDate: new Date().toISOString()
      };
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: CODEX_AUDITOR_MODEL,
          input: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payloadContext, null, 2).slice(0, 50000) }
          ],
          max_output_tokens: 4500
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || `OpenAI API error ${response.status}`);
      const out = payload.output_text
        || (payload.output || []).flatMap(o => o.content || []).map(c => c.text || '').join('\n').trim()
        || '';
      result = JSON.parse(out.replace(/^```json\s*/i, '').replace(/```$/,'').trim());
    } catch(e) {
      ai = false;
      result = fallbackAgentGroupReply(request, agents, report, companyContext, specialReports);
      result.finalAnswer += '\n\nNota: IA avanzada no disponible temporalmente; se ejecuto con coordinacion base.';
    }
  }

  const participantIds = Array.isArray(result.participantIds) && result.participantIds.length
    ? result.participantIds
    : pickAgentParticipants(request, agents);
  const finalAnswer = String(result.finalAnswer || '').trim() || fallbackAgentGroupReply(request, agents, report, companyContext, specialReports).finalAnswer;
  const quality = evaluateAgentAnswerQuality(request, finalAnswer, { specialReports });
  const msg = {
    id: wwpId('routine'),
    role: 'assistant',
    by: 'Coordinador de Agentes',
    agentId: 'coordinator',
    routineId,
    routineName: routine.name,
    participantIds,
    consultations: Array.isArray(result.consultations) ? result.consultations : [],
    newAgents: [],
    text: finalAnswer,
    format: result.format || quality.format,
    quality,
    ai,
    automated: !manualBy,
    createdAt: new Date().toISOString()
  };

  state.agentGroup.chat.push(msg);
  state.agentGroup.chat = state.agentGroup.chat.slice(-120);
  const idx = state.agentGroup.routines.findIndex(r => r.id === routineId);
  if (idx >= 0) {
    state.agentGroup.routines[idx] = {
      ...state.agentGroup.routines[idx],
      lastRunAt: msg.createdAt,
      lastStatus: 'ok',
      lastMessageId: msg.id,
      lastRunBy: manualBy || 'scheduler'
    };
  }
  state.agentGroup.routines = mergeAgentRoutines(state.agentGroup.routines);
  saveProcessAuditorState(state);
  appendAuditLog('agent_routine_run', { routineId, routineName: routine.name, by: manualBy || 'scheduler', messageId: msg.id });

  const owner = loadAuthUsers().find(u => String(u.email || '').toLowerCase().trim() === AGENT_OWNER_EMAIL);
  if (owner) createNotification(owner.id, {
    type: 'agent_routine',
    title: 'Rutina automatica ejecutada',
    message: routine.name,
    by: 'Mesa de Agentes'
  });
  return { routine: state.agentGroup.routines.find(r => r.id === routineId), message: msg, chat: state.agentGroup.chat.slice(-40) };
}

function fallbackAgentGroupReply(text, agents, report, companyContext, specialReports = {}) {
  const participantIds = pickAgentParticipants(text, agents);
  const byId = Object.fromEntries((agents || []).map(a => [a.id, a]));
  const s = report.summary || {};
  if (specialReports.obsoleteStock) {
    return {
      participantIds,
      consultations: participantIds.filter(id => id !== 'coordinator').map(id => ({ agentId: id, message: 'Consultado para responder la solicitud exacta.' })),
      newAgents: [],
      finalAnswer: formatObsoleteStockReport(specialReports.obsoleteStock)
    };
  }
  const consultations = participantIds.filter(id => id !== 'coordinator').map(id => {
    const a = byId[id] || {};
    let msg = 'Reviso mi parte y la conecto con la solicitud.';
    if (id === 'ops_manager') msg = `Foto operativa: ${s.active || 0} activas, ${s.overdue || 0} vencidas, ${s.stale || 0} sin avance y ${s.readyToValidate || 0} por validar.`;
    if (id === 'ops_assistant') msg = 'Puedo convertir esto en mensajes humanos de seguimiento y solicitar updates con tono correcto segun urgencia.';
    if (id === 'process_auditor') msg = 'Lo convierto en flujo, riesgo, documento terminado o recomendacion aprobable si aplica.';
    if (id === 'warehouse_specialist') msg = 'Validare condicion, ubicacion, fotos y evidencia de empaque/almacenamiento antes de proponer cierre.';
    if (id === 'odoo_analyst') msg = companyContext?.odoo?.ok ? 'Odoo esta disponible en solo lectura para cruzar ordenes, picks e inventario.' : 'Usare el contexto de Workforce Platform; Odoo no devolvio muestra ahora mismo.';
    if (id === 'documenter') msg = 'Si esto requiere documentacion, entregare objetivo, alcance, roles, pasos, evidencias, KPIs y screenshots requeridos.';
    return { agentId: id, message: msg };
  });
  return {
    participantIds,
    consultations,
    newAgents: [],
    finalAnswer: [
      'Recibi tu solicitud y la mesa queda coordinada.',
      '',
      'Respuesta final base:',
      '- Me enfocare solo en lo que pediste.',
      '- Si requiere Odoo, consultare Odoo en solo lectura y si falta un campo te dire exactamente cual falta.',
      '- Si requiere documento, lo entregare en formato terminado.',
      '- No agregare estado de tareas, dashboard ni recomendaciones operativas salvo que lo pidas.',
      '',
      'Solicitud: ' + text
    ].join('\n')
  };
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

// Historial de ubicaciones GPS por acción (recorrido). Retención: últimos 7 días.
const WWP_LOCATIONS_FILE = path.join(DATA_DIR, 'wwp-locations.json');
function loadLocations()    { try { return JSON.parse(fs.readFileSync(WWP_LOCATIONS_FILE,'utf-8')); } catch { return []; } }
function saveLocations(arr) { try { fs.writeFileSync(WWP_LOCATIONS_FILE, JSON.stringify(arr)); } catch(e){} }

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

function taskResponsibleIds(t) {
  const ids = new Set();
  if (!t) return ids;
  if (t.managerId) ids.add(t.managerId);
  const assignedId = odooStrToAuthId(t.assignedTo);
  if (assignedId) ids.add(assignedId);
  (t.assignees || []).forEach(id => { if (id) ids.add(id); });
  (t.auxiliaryAssignees || []).forEach(id => { if (id) ids.add(id); });
  (t.executors || []).forEach(id => {
    const authId = String(id || '').startsWith('oe_') ? odooStrToAuthId(id) : id;
    if (authId) ids.add(authId);
  });
  return [...ids];
}

function enrichOverdueTasks(tasks, opts = {}) {
  const users = loadAuthUsers();
  const userById = {};
  users.forEach(u => { userById[u.id] = u; });
  const today = new Date().toISOString().slice(0, 10);
  const closed = new Set(['completed', 'validated', 'cancelled']);
  const active = tasks.filter(t => !closed.has(t.status));
  const workload = {};
  active.forEach(t => {
    taskResponsibleIds(t).forEach(uid => {
      workload[uid] = (workload[uid] || 0) + 1;
    });
  });
  const managerCandidates = users
    .filter(u => u.active !== false && ['admin', 'manager'].includes(u.role))
    .sort((a, b) => (workload[a.id] || 0) - (workload[b.id] || 0) || a.name.localeCompare(b.name));

  let changed = false;
  tasks.forEach(t => {
    const isOverdue = !!(t.dueDate && t.dueDate < today && !closed.has(t.status));
    if (!isOverdue) {
      if (t.overdue || t.overdueDays || t.escalation) {
        delete t.overdue;
        delete t.overdueDays;
        delete t.escalation;
        changed = true;
      }
      return;
    }
    const days = Math.max(1, Math.ceil((new Date(today + 'T00:00:00') - new Date(t.dueDate + 'T00:00:00')) / 864e5));
    const currentIds = new Set(taskResponsibleIds(t));
    const suggested = managerCandidates.find(u => !currentIds.has(u.id)) || null;
    const nextEscalation = {
      action: suggested ? 'reassign_or_escalate' : 'escalate',
      suggestedUserId: suggested ? suggested.id : null,
      suggestedUserName: suggested ? suggested.name : null,
      suggestedRole: suggested ? suggested.role : null,
      reason: suggested
        ? `Overdue ${days} dia(s). ${suggested.name} tiene ${workload[suggested.id] || 0} tarea(s) activa(s).`
        : `Overdue ${days} dia(s). No hay otro encargado activo disponible.`,
      message: suggested
        ? `Reasignar a ${suggested.name} o escalar si el responsable actual no confirma ETA.`
        : 'Escalar al gerente de operaciones para decision inmediata.',
      generatedAt: new Date().toISOString()
    };
    const snapshot = JSON.stringify({ overdue: t.overdue, overdueDays: t.overdueDays, escalation: t.escalation });
    t.overdue = true;
    t.overdueDays = days;
    t.escalation = nextEscalation;
    if (JSON.stringify({ overdue: t.overdue, overdueDays: t.overdueDays, escalation: t.escalation }) !== snapshot) changed = true;
  });
  if (changed && opts.persist) saveWwpTasks(tasks);
  return tasks;
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
  const tasks = enrichOverdueTasks(loadWwpTasks(), { persist: true });
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
    const recipients = taskResponsibleIds(t);
    const managerRecipients = loadAuthUsers()
      .filter(u => u.active !== false && ['admin','manager'].includes(u.role))
      .map(u => u.id);
    notifyMany([...new Set(recipients)], {
      type:'task_overdue',
      title:'⚠️ Tarea vencida',
      message:`"${t.title}" venció el ${t.dueDate}. Confirma ETA, bloqueo o cierre hoy.`,
      relatedTaskId:t.id, priority:t.priority, dueDate:t.dueDate
    });
    notifyMany([...new Set(managerRecipients.filter(uid => !recipients.includes(uid)))], {
      type:'task_overdue',
      title:'Escalamiento overdue',
      message:`"${t.title}" lleva ${t.overdueDays || 1} dia(s) overdue. ${t.escalation?.message || 'Revisar reasignacion o escalamiento.'}`,
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
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org; " +
    "font-src 'self' data:; " +
    "connect-src 'self' https://altritempi.odoo.com https://docs.google.com https://sheets.googleapis.com https://*.tile.openstreetmap.org; " +
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

  // DELETE /api/wwp/notifications/orphans — borrar notificaciones del usuario cuya tarea ya no existe
  if (reqPath === '/api/wwp/notifications/orphans' && req.method === 'DELETE') {
    const jp = requireJwt(req, res); if (!jp) return;
    const taskIds = new Set(loadWwpTasks().map(t => t.id));
    const all = loadNotifications();
    const kept = all.filter(n => !(n.userId===jp.userId && n.relatedTaskId && !taskIds.has(n.relatedTaskId)));
    const removed = all.length - kept.length;
    saveNotifications(kept);
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, removed}));
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

  // POST /api/wwp/auth/impersonate — un admin pasa a operar como otro usuario (sin login)
  if (reqPath === '/api/wwp/auth/impersonate' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const users = loadAuthUsers();
      // El admin real es el original (si ya está impersonando, su impersonatedBy)
      const adminId = jp.impersonatedBy || jp.userId;
      const admin = users.find(u => u.id === adminId);
      if (!admin || admin.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Solo administradores pueden cambiar de usuario'})); return; }
      const { targetUserId } = await readBody(req);
      const target = users.find(u => u.id === targetUserId && u.active !== false);
      if (!target) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Usuario no encontrado'})); return; }
      const accessToken = jwtSign({ userId:target.id, role:target.role, name:target.name, odooId:target.odooId, impersonatedBy:adminId, impersonatorName:admin.name }, 8*3600);
      appendAuditLog('impersonate_start', { adminId, adminName:admin.name, targetId:target.id, targetName:target.name, role:target.role });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, accessToken, impersonatedBy:adminId, impersonatorName:admin.name,
        user:{id:target.id,name:target.name,email:target.email,role:target.role,odooId:target.odooId,presenceStatus:target.presenceStatus||'active',sectionPerms:getRoleDefPerms(target.role)}}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // POST /api/wwp/auth/stop-impersonate — el admin vuelve a su propia cuenta
  if (reqPath === '/api/wwp/auth/stop-impersonate' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      if (!jp.impersonatedBy) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No estás impersonando'})); return; }
      const users = loadAuthUsers();
      const admin = users.find(u => u.id === jp.impersonatedBy && u.role === 'admin');
      if (!admin) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Admin original no válido'})); return; }
      const accessToken = jwtSign({ userId:admin.id, role:admin.role, name:admin.name, odooId:admin.odooId }, 8*3600);
      appendAuditLog('impersonate_stop', { adminId:admin.id, adminName:admin.name, fromUserId:jp.userId });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, accessToken, user:{id:admin.id,name:admin.name,email:admin.email,role:admin.role,odooId:admin.odooId,presenceStatus:admin.presenceStatus||'active',sectionPerms:getRoleDefPerms(admin.role)}}));
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
    const users = loadAuthUsers().map(u => ({id:u.id,name:u.name,email:u.email,role:u.role,odooId:u.odooId,active:u.active,lastLogin:u.lastLogin,createdAt:u.createdAt,presenceStatus:u.presenceStatus||'active',presenceAt:u.presenceAt||null,lunchTimeAllowed:u.lunchTimeAllowed||60,lastLocation:u.lastLocation||null,sectionPerms:getRoleDefPerms(u.role)}));
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(users));
    return;
  }

  // POST /api/wwp/auth/location — guarda la última ubicación GPS del usuario actual
  if (reqPath === '/api/wwp/auth/location' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    try {
      const d = await readBody(req);
      const lat = Number(d.lat), lng = Number(d.lng);
      if (!isFinite(lat) || !isFinite(lng)) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Coordenadas inválidas'})); return; }
      const users = loadAuthUsers();
      const idx = users.findIndex(u => u.id === jp.userId);
      if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false})); return; }
      const now = new Date().toISOString();
      const ctx = (d.context||'').slice(0,60);
      users[idx].lastLocation = { lat, lng, accuracy: d.accuracy!=null?Number(d.accuracy):null, at: now, context: ctx };
      saveAuthUsers(users);
      // Historial por acción (recorrido) — append + retención de 7 días, cap 5000 global
      try {
        const cutoff = Date.now() - 7*24*60*60*1000;
        let hist = loadLocations().filter(p => new Date(p.at).getTime() >= cutoff);
        hist.push({ userId: jp.userId, lat, lng, accuracy: d.accuracy!=null?Number(d.accuracy):null, at: now, context: ctx, taskId: d.taskId||null });
        if (hist.length > 5000) hist = hist.slice(hist.length - 5000);
        saveLocations(hist);
      } catch(e){}
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // GET /api/wwp/auth/locations — última ubicación de todos los usuarios [solo admin]
  if (reqPath === '/api/wwp/auth/locations' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (jp.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Solo admin'})); return; }
    // Solo usuarios cuyo rol tiene el rastreo GPS habilitado (por defecto: auxiliares)
    const users = loadAuthUsers().filter(u => u.active !== false && u.lastLocation && (getRoleDefPerms(u.role)||{})['wwp.rastreo_gps']);
    const out = users.map(u => ({ id:u.id, name:u.name, role:u.role, lastLocation:u.lastLocation }));
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, users: out }));
    return;
  }

  // GET /api/wwp/auth/users/:id/locations — recorrido (historial) de un usuario [solo admin]
  if (reqPath.match(/^\/api\/wwp\/auth\/users\/[A-Za-z0-9_]+\/locations$/) && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (jp.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Solo admin'})); return; }
    const uid = reqPath.split('/')[5];
    const points = loadLocations().filter(p => p.userId === uid).sort((a,b)=> new Date(a.at)-new Date(b.at));
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, points }));
    return;
  }

  // ── GET /api/wwp/auth/users/workload — tareas activas por usuario [admin|manager] ──
  if (reqPath === '/api/wwp/auth/users/workload' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!['admin','manager'].includes(jp.role)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Se requiere rol admin o manager'})); return; }
    const tasks = loadWwpTasks().filter(t => !['completed','validated','cancelled'].includes(t.status));
    const workload = {};
    const bump = id => { if (id) workload[id] = (workload[id]||0)+1; };
    tasks.forEach(t => {
      const ids = new Set();
      if (t.managerId) ids.add(t.managerId);
      const a = odooStrToAuthId(t.assignedTo); if (a) ids.add(a);
      (t.executors||[]).forEach(e => { const id = (e+'').startsWith('oe_') ? odooStrToAuthId(e) : e; if (id) ids.add(id); });
      (t.assignees||[]).forEach(id => { if (id) ids.add(id); });
      ids.forEach(bump);
    });
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, workload}));
    return;
  }

  // ── GET /api/wwp/order-claims/:ref — artículos ya asignados de una orden [admin|manager] ──
  if (reqPath.match(/^\/api\/wwp\/order-claims\/[^/]+$/) && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!['admin','manager'].includes(jp.role)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Rol no permitido'})); return; }
    const ref = decodeURIComponent(reqPath.split('/')[4]).trim();
    const excludeRoot = (parsed.query||{}).excludeRoot || null;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, claims:getOrderClaims(ref, excludeRoot)}));
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
    let tasks = enrichOverdueTasks(loadWwpTasks(), { persist: true });
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
      const _validTypes     = ['dispatch_order','packaging','item_pickup','truck_loading','warehouse_move','general','staffing'];
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
        // ── Solicitud de Personal (type staffing) ──
        requester: d.requester||'',           // solicitante (texto libre)
        staffStart: d.staffStart||null,       // fecha inicio (YYYY-MM-DD)
        staffEnd: d.staffEnd||null,           // fecha fin
        staffFrom: d.staffFrom||'',           // hora inicio (HH:MM)
        staffTo: d.staffTo||'',               // hora fin
        totalHours: (typeof d.totalHours==='number') ? d.totalHours : null,
        dependsOnPrev: isSubtask ? !!d.dependsOnPrev : false, // cadena: requiere paso anterior completado
        subIndex: null,                       // posición en la cadena (se asigna abajo)
        evidence: [],
        fotos_guia: [],
        statusHistory: [{ status:'pending', date:now, by:d.createdBy||'', note:'' }],
        createdBy: d.createdBy||'',
        createdAt: now,
        updatedAt: now
      };
      const tasks = enrichOverdueTasks(loadWwpTasks(), { persist: true });
      // Numeración de cadena: posición de la subtarea entre sus hermanas
      if (isSubtask) {
        task.subIndex = tasks.filter(x => x.parentId === task.parentId).length + 1;
      }
      // Con encargado (assignedTo/managerId) o auxiliares (executors/assignees) → marcar 'assigned'.
      // No saltamos a in_progress: el inicio es explícito (y puede depender del paso anterior).
      if (task.assignedTo || task.managerId || (isSubtask && task.executors.length > 0) || (task.type==='staffing' && task.assignees.length > 0)) {
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
        // Validar antes de completar/validar — distinto para despacho vs empaque/otros
        if (d.status==='completed'||d.status==='validated') {
          const selItems=(tasks[idx].items||[]).filter(it=>it.selected && !it.isKit);
          if (tasks[idx].type==='dispatch_order') {
            // DESPACHO: checklist (3 fotos) + entrega por artículo
            if (!(tasks[idx].fotos_recepcion||[]).length || !(tasks[idx].fotos_vehiculo||[]).length || !(tasks[idx].fotos_entrega||[]).length) {
              const faltan=[!(tasks[idx].fotos_recepcion||[]).length&&'recepción de documentos',!(tasks[idx].fotos_vehiculo||[]).length&&'foto del vehículo',!(tasks[idx].fotos_entrega||[]).length&&'documentos firmados'].filter(Boolean);
              res.writeHead(422,{'Content-Type':'application/json'});
              res.end(JSON.stringify({ok:false,error:'Checklist de despacho incompleto — falta: '+faltan.join(', ')}));
              return;
            }
            const sinEntrega=selItems.filter(it=>!it.deliveryStatus || (it.deliveryStatus!=='not_delivered' && (!it.evidence_images||!it.evidence_images.length)));
            if (sinEntrega.length>0) {
              res.writeHead(422,{'Content-Type':'application/json'});
              res.end(JSON.stringify({ok:false,error:`Faltan ${sinEntrega.length} artículo(s) por registrar entrega (estado + foto)`}));
              return;
            }
          } else {
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
            const sinCondicion=selItems.filter(it=>!it.condition);
            if (sinCondicion.length>0) {
              res.writeHead(422,{'Content-Type':'application/json'});
              res.end(JSON.stringify({ok:false,error:`Falta indicar la condición de ${sinCondicion.length} artículo(s)`}));
              return;
            }
          }
        }
        // Gate de inicio para despacho: el pick de Odoo debe estar realizado (done)
        if (d.status==='in_progress' && tasks[idx].type==='dispatch_order' && tasks[idx].odooRef) {
          try {
            let realName = tasks[idx].odooRef;
            const so = await odooCall('sale.order','search_read',[[['name','ilike',tasks[idx].odooRef]]],{fields:['name'],limit:1});
            if (so && so.length) realName = so[0].name;
            const picksAll = await odooCall('stock.picking','search_read',[[['origin','=',realName]]],{fields:['name','state'],limit:50});
            const pickList = (picksAll||[]).filter(p => /\/PICK\//i.test(p.name));
            if (pickList.length && !pickList.every(p=>p.state==='done')) {
              res.writeHead(409,{'Content-Type':'application/json'});
              res.end(JSON.stringify({ok:false,error:'El pick aún no está realizado en Odoo. El despacho no puede iniciar todavía.'}));
              return;
            }
          } catch(_) { /* si Odoo falla, no bloquear */ }
        }
        tasks[idx].status=d.status;
        tasks[idx].statusHistory.push({ status:d.status, date:now, by:d.by||'', note:d.note||'' });
        // Audit log para estados críticos
        if (d.status==='validated'||d.status==='in_progress'||d.status==='cancelled') {
          appendAuditLog('task_status_change', { taskId:tasks[idx].id, taskTitle:tasks[idx].title, prevStatus:oldTask.status, newStatus:d.status, by:jp.userId, note:d.note||'' });
        }
        // Cancelar en cascada: al cancelar la madre, cancelar subtareas no cerradas
        if (d.status==='cancelled' && !tasks[idx].parentId) {
          tasks.forEach(s => {
            if (s.parentId===tasks[idx].id && !['completed','validated','cancelled'].includes(s.status)) {
              s.status='cancelled';
              s.statusHistory = s.statusHistory||[];
              s.statusHistory.push({ status:'cancelled', date:now, by:d.by||'', note:'Cancelada con la tarea madre' });
              s.updatedAt=now;
            }
          });
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
      // Sincroniza ambos campos (assignees + auxiliaryAssignees) para que la lista sea consistente
      // y al liberar/reemplazar un auxiliar no quede residual en el campo crudo.
      if (d.auxiliaryAssignees!==undefined) {
        const _aux=Array.isArray(d.auxiliaryAssignees)?d.auxiliaryAssignees:[];
        tasks[idx].assignees=_aux;
        tasks[idx].auxiliaryAssignees=_aux;
      }
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
      // Si un encargado/admin editó campos de contenido (no solo status) → marca de modificación
      // para reactivar la tarea en la lista de auxiliares que ya marcaron terminado.
      if (isAdminOrMgr && (d.title!==undefined||d.description!==undefined||d.odooRef!==undefined||d.dueDate!==undefined||d.actionNote!==undefined||d.priority!==undefined)) {
        tasks[idx].itemsUpdatedAt=now;
      }
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

  // GET /api/wwp/ops-agent — agente gerente de operaciones (admin)
  if (reqPath === '/api/wwp/ops-agent' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    const report = computeOpsAgentReport();
    const companyContext = await getAgentCompanyContext({ includeOdoo: true });
    const state = loadProcessAuditorState();
    if (!state.opsChats) state.opsChats = { manager: [], assistant: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), aiEnabled: !!anthropicClient, companyContext, chats: state.opsChats, ...report }));
    return;
  }

  // GET /api/wwp/ops-agent/brief — parte del día redactado por Claude (admin)
  // Toma el reporte heurístico como insumo y genera un análisis en lenguaje natural.
  // Cache server-side: 30 min o hasta que cambien los datos. ?refresh=1 fuerza regeneración.
  if (reqPath === '/api/wwp/ops-agent/brief' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    if (!anthropicClient) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'no_api_key', message: 'Configura ANTHROPIC_API_KEY para activar el análisis con IA.' }));
      return;
    }
    try {
      const report = computeOpsAgentReport();
      const companyContext = await getAgentCompanyContext({ includeOdoo: true });
      const dataHash = crypto.createHash('sha256').update(JSON.stringify({ report, companyContext })).digest('hex');
      const forceRefresh = (parsed.query || {}).refresh === '1';
      const cacheValid = _opsBriefCache.brief && _opsBriefCache.hash === dataHash &&
        (Date.now() - _opsBriefCache.generatedAt) < OPS_BRIEF_TTL;
      if (cacheValid && !forceRefresh) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cached: true, generatedAt: new Date(_opsBriefCache.generatedAt).toISOString(), brief: _opsBriefCache.brief }));
        return;
      }

      const systemPrompt =
        'Eres "Marta", la Gerente de Operaciones IA de Altri Tempi (almacén y despachos de muebles en República Dominicana). ' +
        'Cada mañana recibes el reporte operativo en JSON (tareas activas, vencidas, sin avance, sin responsable, evidencias pendientes, validaciones acumuladas y carga por persona) y redactas el PARTE DEL DÍA para el administrador. ' +
        'Tambien tienes contexto de empresa, documentos asociados y una muestra de Odoo en solo lectura para entender ordenes, picks, inventario y flujo empresarial. No escribes ni modificas Odoo.\n\n' +
        'Reglas del parte:\n' +
        '- Escribe en español, tono directo y profesional, como una gerente experimentada hablando con su jefe.\n' +
        '- Estructura en Markdown: 1) "## Resumen del día" (2-3 frases con la foto general), 2) "## Lo urgente" (máx 4 puntos, lo que se debe atacar HOY, con nombres y números de tarea), 3) "## Equipo" (1-3 observaciones sobre carga de trabajo: quién está sobrecargado, quién libre, sugerencias de redistribución), 4) "## Recomendación" (1 decisión concreta que tomarías hoy).\n' +
        '- Usa los nombres de pila de las personas y los números de tarea (#0026) cuando existan.\n' +
        '- Sé concreto: cifras, horas sin avance, fechas. Nada de relleno ni frases genéricas.\n' +
        '- Si la operación está sana, dilo claramente y felicita en una línea.\n' +
        '- Máximo ~250 palabras en total.';

      const response = await anthropicClient.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: 'Contexto de empresa, Odoo y documentos:\n```json\n' + JSON.stringify(companyContext, null, 1).slice(0, 25000) + '\n```\n\nReporte operativo de hoy (' + new Date().toISOString().slice(0, 10) + '):\n```json\n' + JSON.stringify(report, null, 1) + '\n```\nRedacta el parte del día.'
        }]
      });

      const brief = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      _opsBriefCache = { hash: dataHash, brief, generatedAt: Date.now() };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cached: false, generatedAt: new Date().toISOString(), brief,
        usage: { input: response.usage.input_tokens, output: response.usage.output_tokens, cacheRead: response.usage.cache_read_input_tokens || 0 } }));
    } catch (e) {
      // Errores de la API (rate limit, overload, key inválida): degradar con gracia — el panel
      // heurístico sigue funcionando. Mensajes claros por tipo sin romper el dashboard.
      let reason = 'api_error', msg = e.message || 'Error llamando a Claude';
      if (Anthropic && e instanceof Anthropic.AuthenticationError) { reason = 'bad_api_key'; msg = 'La ANTHROPIC_API_KEY no es válida.'; }
      else if (Anthropic && e instanceof Anthropic.RateLimitError) { reason = 'rate_limited'; msg = 'Límite de uso alcanzado; intenta en unos minutos.'; }
      else if (Anthropic && e.status === 529) { reason = 'overloaded'; msg = 'Claude está saturado; intenta en unos minutos.'; }
      console.error('[ops-brief]', reason, e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason, message: msg }));
    }
    return;
  }

  // POST /api/wwp/ops-agent/follow-up — asistente del gerente solicita actualizaciones por chat
  if (reqPath === '/api/wwp/ops-agent/follow-up' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    try {
      const d = await readBody(req);
      const requestedIds = Array.isArray(d.taskIds) ? d.taskIds : [d.taskId];
      const taskIds = [...new Set(requestedIds.filter(Boolean).map(String))].slice(0, 20);
      if (!taskIds.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Selecciona al menos una tarea' }));
        return;
      }

      const mode = String(d.mode || 'general');
      const modeText = {
        critical: 'Hola, necesito tu ayuda con esta tarea porque esta en punto critico. Cuando puedas, dime por aqui que paso, que falta y a que hora realista la podemos cerrar hoy.',
        high: 'Hola, estoy dando seguimiento cercano a esta tarea. Por favor actualizame con el avance real, si hay algun bloqueo y que necesitas para terminar.',
        medium: 'Hola, paso a revisar esta tarea para mantener el flujo ordenado. Cuentame como va, que falta y si necesitas apoyo.',
        low: 'Hola, cuando tengas un momento dejame una actualizacion breve de esta tarea para mantener el tablero al dia.',
        overdue: 'Hola, esta tarea ya esta vencida y quiero ayudarte a destrabarla. Dime con sinceridad que la detiene, que falta y si conviene reasignar o escalar.',
        stale: 'Hola, veo que esta tarea no tiene avance reciente. Puede ser que estes trabajando en ella, pero necesito una actualizacion para no dejarla perderse.',
        evidence: 'Hola, parece que falta evidencia para poder cerrar bien esta tarea. Por favor sube las fotos o dime si hay algun problema para conseguirlas.',
        validation: 'Hola, esta tarea parece lista para revision. Por favor confirma si todo quedo completo o si falta algun detalle antes de validarla.',
        general: 'Hola, puedes darme una actualizacion honesta de esta tarea? Avance real, bloqueo si existe y proximo paso.'
      };
      const intro = modeText[mode] || modeText.general;
      const text = (d.text || '').trim() || intro;

      const tasks = loadWwpTasks();
      const sent = [];
      const missing = [];
      const nowIso = new Date().toISOString();

      taskIds.forEach(taskId => {
        const idx = tasks.findIndex(t => t.id === taskId);
        if (idx === -1) { missing.push(taskId); return; }
        const task = tasks[idx];
        const msg = {
          id: wwpId('msg'),
          fromId: 'ops_assistant',
          fromName: 'Asistente de Operaciones',
          text,
          createdAt: nowIso,
          system: true,
          source: 'ops-agent',
          requestedBy: jp.userId,
          requestedByName: jp.name,
          followUpType: mode
        };
        if (!task.messages) task.messages = [];
        task.messages.push(msg);
        task.updatedAt = nowIso;

        const assigneeId = odooStrToAuthId(task.assignedTo);
        const participants = new Set([task.managerId, assigneeId, task.createdBy].filter(Boolean));
        (task.assignees || []).forEach(uid => participants.add(uid));
        (task.executors || []).forEach(uid => participants.add(odooStrToAuthId(uid) || uid));
        participants.delete(jp.userId);
        participants.forEach(uid => createNotification(uid, {
          type: 'comment_new',
          title: 'Seguimiento operativo',
          message: `Asistente de Operaciones: "${text.length > 80 ? text.slice(0, 77) + '...' : text}"`,
          relatedTaskId: taskId,
          priority: task.priority || null,
          dueDate: task.dueDate || null,
          by: jp.name
        }));

        const sseData = `data: ${JSON.stringify({ event: 'chat_message', taskId, message: msg })}\n\n`;
        participants.add(jp.userId);
        participants.forEach(uid => {
          (sseClients.get(uid) || new Set()).forEach(r => { try { r.write(sseData); } catch {} });
        });
        broadcastWwpTasks('ops_follow_up_sent', task, { taskId, message: msg, mode });
        appendAuditLog('ops_follow_up_sent', { by: jp.userId, byName: jp.name, taskId, mode, text });
        sent.push({ taskId, message: msg });
      });

      saveWwpTasks(tasks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sent, missing }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /api/wwp/ops-agent/chat — chat privado del Gerente o Asistente de Operaciones
  if (reqPath === '/api/wwp/ops-agent/chat' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    try {
      const d = await readBody(req);
      const text = String(d.text || '').trim();
      const agent = String(d.agent || 'manager') === 'assistant' ? 'assistant' : 'manager';
      if (!text) {
        res.writeHead(400, { 'Content-Type':'application/json' });
        res.end(JSON.stringify({ ok:false, error:'Escribe una solicitud para el agente.' }));
        return;
      }
      const state = loadProcessAuditorState();
      if (!state.opsChats) state.opsChats = { manager: [], assistant: [] };
      if (!Array.isArray(state.opsChats[agent])) state.opsChats[agent] = [];
      const report = computeOpsAgentReport();
      const companyContext = await getAgentCompanyContext({ includeOdoo: true });
      const userMsg = {
        id: wwpId('opschat'),
        role: 'user',
        text,
        by: jp.name,
        createdAt: new Date().toISOString()
      };
      state.opsChats[agent].push(userMsg);

      const agentName = agent === 'assistant' ? 'Asistente de Operaciones' : 'Gerente de Operaciones';
      const systemPrompt = agent === 'assistant'
        ? 'Eres el Asistente de Operaciones de Altri Tempi. Eres humano en tono, responsable, honesto y calmado. Tu trabajo es dar seguimiento a tareas, pedir actualizaciones con tacto, redactar mensajes conversacionales para chats de tareas, detectar bloqueos y ayudar al gerente. Puedes mostrar urgencia, empatia o preocupacion segun la situacion, sin exagerar. Tienes contexto de empresa, documentos asociados y Odoo solo lectura; usalo para entender, no para modificar. Responde en español claro y accionable.'
        : 'Eres la Gerente de Operaciones de Altri Tempi. Eres directa, sincera, responsable y justa. Analizas tareas, carga del equipo, atrasos, vencidas, evidencia, validaciones y riesgos. Tienes contexto de empresa, documentos asociados y Odoo solo lectura; usalo para entender ordenes, picks, inventario y flujo empresarial, sin modificar Odoo. Das decisiones operativas claras y no maquillas problemas. Responde en español profesional, concreto y accionable.';

      let answer = '';
      let ai = !!anthropicClient;
      if (anthropicClient) {
        try {
          const response = await anthropicClient.messages.create({
            model: 'claude-opus-4-8',
            max_tokens: 2500,
            thinking: { type: 'adaptive' },
            system: systemPrompt,
            messages: [{
              role: 'user',
              content: 'Contexto de empresa, Odoo y documentos:\n```json\n' + JSON.stringify(companyContext, null, 1).slice(0, 25000) + '\n```\n\nContexto operativo actual:\n```json\n' + JSON.stringify(report, null, 1).slice(0, 35000) + '\n```\n\nSolicitud de Gabriel:\n' + text
            }]
          });
          answer = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        } catch(e) {
          ai = false;
          answer = `${agentName}: No pude consultar IA ahora mismo, pero revisando el contexto operativo debes priorizar vencidas, tareas sin avance, responsables sobrecargados y evidencias pendientes. Solicitud recibida: ${text}`;
        }
      } else {
        ai = false;
        const s = report.summary || {};
        answer = `${agentName}: IA no disponible. Foto operativa actual: ${s.active || 0} activas, ${s.overdue || 0} vencidas, ${s.stale || 0} sin avance, ${s.readyToValidate || 0} por validar. Solicitud recibida: ${text}`;
      }

      const assistantMsg = {
        id: wwpId('opschat'),
        role: 'assistant',
        text: answer,
        by: agentName,
        ai,
        createdAt: new Date().toISOString()
      };
      state.opsChats[agent].push(assistantMsg);
      state.opsChats[agent] = state.opsChats[agent].slice(-60);
      saveProcessAuditorState(state);
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:true, agent, message:assistantMsg, chat:state.opsChats[agent].slice(-20) }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }
    return;
  }

  // GET /api/wwp/agent-group — mesa unica de agentes (owner)
  if (reqPath === '/api/wwp/agent-group' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    try {
      const state = loadProcessAuditorState();
      const report = computeOpsAgentReport();
      const companyContext = await getAgentCompanyContext({ includeOdoo: true });
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({
        ok: true,
        generatedAt: new Date().toISOString(),
        owner: AGENT_OWNER_EMAIL,
        agents: state.agentGroup.agents,
        chat: state.agentGroup.chat.slice(-40),
        knowledgePack: state.agentGroup.knowledgePack,
        dailyAssignments: state.agentGroup.dailyAssignments || [],
        routines: state.agentGroup.routines || [],
        companyContext,
        summary: report.summary || {}
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }
    return;
  }

  // POST /api/wwp/agent-group/chat — group chat moderado por Coordinador de Agentes
  if (reqPath === '/api/wwp/agent-group/chat' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    try {
      const d = await readBody(req);
      const text = String(d.text || '').trim();
      if (!text) {
        res.writeHead(400, { 'Content-Type':'application/json' });
        res.end(JSON.stringify({ ok:false, error:'Escribe una solicitud para la Mesa de Agentes.' }));
        return;
      }
      const state = loadProcessAuditorState();
      const report = computeOpsAgentReport();
      const companyContext = await getAgentCompanyContext({ includeOdoo: true });
      const agents = state.agentGroup.agents || getDefaultAgentRoster();
      const userMsg = {
        id: wwpId('grpchat'),
        role: 'user',
        by: jp.name,
        text,
        createdAt: new Date().toISOString()
      };
      state.agentGroup.chat.push(userMsg);
      const recentUserContext = state.agentGroup.chat.slice(-8).map(m => `${m.role || ''}: ${m.text || ''}`).join('\n');
      const specialReports = {};
      if (needsObsoleteStockReport(`${recentUserContext}\n${text}`)) {
        specialReports.obsoleteStock = await getOdooObsoleteStockReport();
      }
      if (/enf[oó]cate|no se desvie|no te desvie|100%|solo lo que pido|consulta en odoo/i.test(text)) {
        const pref = 'Gabriel prefiere respuestas estrictamente enfocadas: consultar la fuente pedida, entregar el reporte solicitado y no agregar contexto operativo no pedido.';
        if (!state.agentGroup.preferences.includes(pref)) state.agentGroup.preferences.push(pref);
      }
      if (/excel|tabla|ventas|presentable|csv|correo|whatsapp|reporte/i.test(text)) {
        const pref = 'Gabriel prefiere reportes presentables: resumen ejecutivo, tablas limpias tipo Excel, totales, agrupaciones y texto listo para enviar; no formato de base de datos cruda.';
        if (!state.agentGroup.preferences.includes(pref)) state.agentGroup.preferences.push(pref);
      }
      state.agentGroup.routines = mergeAgentRoutines(state.agentGroup.routines);
      saveProcessAuditorState(state);

      let result = fallbackAgentGroupReply(text, agents, report, companyContext, specialReports);
      let ai = !!OPENAI_API_KEY;
      if (OPENAI_API_KEY) {
        try {
          const systemPrompt = [
            'Eres el Coordinador de Agentes de Altri Tempi. Moderas un group chat de agentes especializados.',
            'Tienes un knowledgePack y fullKnowledgeBase. Tratalos como manual interno obligatorio para todos los agentes.',
            'Tu regla principal: responde 100% la solicitud exacta de Gabriel. No agregues temas de dashboard, tareas vencidas, evidencias, auditoria o recomendaciones si Gabriel no los pidio.',
            'Si Gabriel corrige el enfoque en el chat, aprende esa preferencia y ajusta inmediatamente: menos contexto no solicitado, mas respuesta directa.',
            'Cuando presentes datos, no los entregues como base de datos cruda. Conviertelos a un formato de negocio: resumen ejecutivo, tabla limpia, totales, agrupaciones y texto listo para copiar.',
            'Formatos recomendados segun el caso: tabla Markdown compatible con Excel, CSV si el usuario pide archivo/listado, resumen por familia/categoria, top 10, detalle por articulo, version corta para WhatsApp/correo y conclusiones accionables.',
            'Si el destino es ventas, usa lenguaje simple, columnas claras, totales y evita campos tecnicos innecesarios.',
            'Antes de responder, aplica el answerQualityChecklist del fullKnowledgeBase.',
            'Tu trabajo es discernir que agente debe responder cada parte, consultar sus especialidades y presentar una respuesta final terminada.',
            'No respondas como todos a la vez si no hace falta. Evita ruido y duplicacion.',
            'Las consultas internas deben ser invisibles para Gabriel excepto la lista breve de agentes consultados. La respuesta final debe ser el entregable listo.',
            'Si hace falta un dato para responder, primero intenta consultar la fuente disponible. Si aun falta, declara la limitante exacta y pide solo ese dato.',
            'Si la solicitud dice "consulta en Odoo", usa el contexto o reportes Odoo entregados. No reemplaces la solicitud por un resumen operativo.',
            'Si detectas que falta una especialidad recurrente o necesaria, crea un agente nuevo con id, avatar elegante, nombre, especialidad y descripcion. Debe quedar especializado y permanente.',
            'Los agentes no desaparecen: se especializan. Las tareas diarias y rutinas periodicas estan vacias por ahora y no debes asignarlas todavia.',
            'Odoo es solo lectura. No prometas modificar Odoo ni ejecutar cambios de plataforma sin aprobacion explicita de Gabriel.',
            'Devuelve JSON valido con esta forma exacta: {"participantIds":[],"consultations":[{"agentId":"","message":""}],"newAgents":[{"id":"","avatar":"","name":"","specialty":"","description":""}],"format":"","finalAnswer":""}.',
            'Los participantIds deben incluir coordinator y los agentes consultados.'
          ].join(' ');
          const payloadContext = {
            request: text,
            agents,
            preferences: state.agentGroup.preferences,
            knowledgePack: state.agentGroup.knowledgePack,
            fullKnowledgeBase: getAgentCompanyKnowledgeBase(),
            recentChat: state.agentGroup.chat.slice(-8),
            companyContext,
            specialReports,
            opsSummary: Object.keys(specialReports).length ? null : report.summary,
            opsDecisions: Object.keys(specialReports).length ? [] : (report.decisions || []).slice(0, 12),
            currentDate: new Date().toISOString()
          };
          const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: CODEX_AUDITOR_MODEL,
              input: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: JSON.stringify(payloadContext, null, 2).slice(0, 50000) }
              ],
              max_output_tokens: 4500
            })
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error?.message || `OpenAI API error ${response.status}`);
          const out = payload.output_text
            || (payload.output || []).flatMap(o => o.content || []).map(c => c.text || '').join('\n').trim()
            || '';
          result = JSON.parse(out.replace(/^```json\s*/i, '').replace(/```$/,'').trim());
        } catch(e) {
          ai = false;
          result = fallbackAgentGroupReply(text, agents, report, companyContext, specialReports);
          result.finalAnswer += '\n\nNota: IA avanzada no disponible temporalmente; use coordinacion base con datos actuales.';
        }
      }

      const existingIds = new Set((state.agentGroup.agents || []).map(a => a.id));
      const newAgents = Array.isArray(result.newAgents) ? result.newAgents : [];
      newAgents.forEach(a => {
        const id = String(a.id || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
        if (!id || existingIds.has(id)) return;
        state.agentGroup.agents.push({
          id,
          avatar: String(a.avatar || '◇').slice(0, 4),
          name: String(a.name || 'Agente Especializado').slice(0, 80),
          specialty: String(a.specialty || 'Especialidad pendiente').slice(0, 140),
          description: String(a.description || 'Agente creado por el Coordinador para cubrir una necesidad especifica.').slice(0, 260),
          createdAt: new Date().toISOString(),
          createdBy: 'coordinator'
        });
        existingIds.add(id);
      });

      const participantIds = Array.isArray(result.participantIds) && result.participantIds.length
        ? result.participantIds
        : pickAgentParticipants(text, state.agentGroup.agents);
      let finalAnswer = String(result.finalAnswer || '').trim() || fallbackAgentGroupReply(text, state.agentGroup.agents, report, companyContext, specialReports).finalAnswer;
      let quality = evaluateAgentAnswerQuality(text, finalAnswer, { specialReports });
      if (!quality.passed && Object.keys(specialReports).length) {
        finalAnswer = fallbackAgentGroupReply(text, state.agentGroup.agents, report, companyContext, specialReports).finalAnswer;
        quality = evaluateAgentAnswerQuality(text, finalAnswer, { specialReports });
      }
      const assistantMsg = {
        id: wwpId('grpchat'),
        role: 'assistant',
        by: 'Coordinador de Agentes',
        agentId: 'coordinator',
        participantIds,
        consultations: Array.isArray(result.consultations) ? result.consultations : [],
        newAgents: newAgents.filter(a => a && a.id),
        text: finalAnswer,
        format: result.format || quality.format,
        quality,
        ai,
        createdAt: new Date().toISOString()
      };
      state.agentGroup.chat.push(assistantMsg);
      state.agentGroup.chat = state.agentGroup.chat.slice(-120);
      state.agentGroup.routines = mergeAgentRoutines(state.agentGroup.routines);
      saveProcessAuditorState(state);
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({
        ok:true,
        generatedAt: new Date().toISOString(),
        owner: AGENT_OWNER_EMAIL,
        agents: state.agentGroup.agents,
        chat: state.agentGroup.chat.slice(-40),
        knowledgePack: state.agentGroup.knowledgePack,
        message: assistantMsg,
        dailyAssignments: state.agentGroup.dailyAssignments || [],
        routines: state.agentGroup.routines || [],
        companyContext,
        summary: report.summary || {}
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }
    return;
  }

  // PATCH /api/wwp/agent-group/routines/:id — configurar rutina automatica
  if (reqPath.match(/^\/api\/wwp\/agent-group\/routines\/[^/]+$/) && req.method === 'PATCH') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    try {
      const routineId = decodeURIComponent(reqPath.split('/').pop());
      const d = await readBody(req);
      const state = loadProcessAuditorState();
      const idx = (state.agentGroup.routines || []).findIndex(r => r.id === routineId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type':'application/json' });
        res.end(JSON.stringify({ ok:false, error:'Rutina no encontrada' }));
        return;
      }
      const current = state.agentGroup.routines[idx];
      const schedule = {
        ...(current.schedule || {}),
        ...(d.schedule || {})
      };
      if (d.scheduleType) schedule.type = String(d.scheduleType);
      if (d.time) schedule.time = String(d.time).slice(0, 5);
      if (d.minutes) schedule.minutes = Math.max(5, Number(d.minutes || 60));
      if (d.weekday !== undefined) schedule.weekday = Math.max(0, Math.min(6, Number(d.weekday)));
      state.agentGroup.routines[idx] = {
        ...current,
        enabled: d.enabled === undefined ? current.enabled : !!d.enabled,
        prompt: typeof d.prompt === 'string' && d.prompt.trim() ? d.prompt.trim().slice(0, 1200) : current.prompt,
        outputFormat: typeof d.outputFormat === 'string' && d.outputFormat.trim() ? d.outputFormat.trim().slice(0, 80) : current.outputFormat,
        schedule,
        updatedAt: new Date().toISOString(),
        updatedBy: jp.userId
      };
      state.agentGroup.routines = mergeAgentRoutines(state.agentGroup.routines);
      saveProcessAuditorState(state);
      appendAuditLog('agent_routine_updated', { routineId, by: jp.userId, byName: jp.name, enabled: state.agentGroup.routines.find(r => r.id === routineId)?.enabled });
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:true, routines: state.agentGroup.routines, routine: state.agentGroup.routines.find(r => r.id === routineId) }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }
    return;
  }

  // POST /api/wwp/agent-group/routines/:id/run — ejecutar rutina manualmente
  if (reqPath.match(/^\/api\/wwp\/agent-group\/routines\/[^/]+\/run$/) && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    try {
      const parts = reqPath.split('/');
      const routineId = decodeURIComponent(parts[5]);
      const result = await runAgentRoutineById(routineId, { manualBy: jp.userId });
      const state = loadProcessAuditorState();
      const report = computeOpsAgentReport();
      const companyContext = await getAgentCompanyContext({ includeOdoo: true });
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({
        ok:true,
        generatedAt: new Date().toISOString(),
        owner: AGENT_OWNER_EMAIL,
        agents: state.agentGroup.agents,
        chat: state.agentGroup.chat.slice(-40),
        knowledgePack: state.agentGroup.knowledgePack,
        dailyAssignments: state.agentGroup.dailyAssignments || [],
        routines: state.agentGroup.routines || [],
        companyContext,
        summary: report.summary || {},
        ...result
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }
    return;
  }

  // GET /api/wwp/process-auditor — auditor de procesos y manuales por rol
  if (reqPath === '/api/wwp/process-auditor' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    try {
      const tasks = enrichOverdueTasks(loadWwpTasks(), { persist: true });
      const users = loadAuthUsers();
      const auditLogs = loadJson(WWP_AUDIT_FILE, []);
      const state = loadProcessAuditorState();
      const companyContext = await getAgentCompanyContext({ includeOdoo: true });
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);
      const closed = new Set(['completed', 'validated', 'cancelled']);
      const active = tasks.filter(t => !closed.has(t.status));
      const hoursSince = (value) => {
        const ms = value ? now - new Date(value).getTime() : 0;
        return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 36e5) : 0;
      };
      const selectedItems = (t) => (t.items || []).filter(i => i.selected);
      const selectedWithoutEvidence = (t) => selectedItems(t).filter(i => !(i.evidence_images || []).length);
      const recentChanges = auditLogs.slice(-80).reverse().map(l => ({
        at: l.timestamp || null,
        event: l.event || 'evento',
        summary: l.taskId ? `Tarea ${l.taskId}` : (l.email || l.byName || l.userId || 'Sistema'),
        detail: l.newStatus ? `${l.prevStatus || 'estado'} -> ${l.newStatus}` : (l.mode || l.reason || l.role || '')
      }));

      const baseRecs = [];
      const addRec = (id, priority, category, title, finding, recommendation, changeType, command, evidence) => {
        baseRecs.push({ id, priority, category, title, finding, recommendation, changeType, command, evidence });
      };

      const overdue = active.filter(t => t.dueDate && t.dueDate < today);
      const overdueTasks = overdue
        .sort((a, b) => (b.overdueDays || 0) - (a.overdueDays || 0) || String(a.dueDate || '').localeCompare(String(b.dueDate || '')))
        .slice(0, 12)
        .map(t => ({
          id: t.id,
          seq: t.seq || null,
          title: t.title || t.id,
          type: t.type || 'general',
          status: t.status,
          dueDate: t.dueDate,
          overdueDays: t.overdueDays || 1,
          managerId: t.managerId || null,
          managerName: t.managerName || null,
          escalation: t.escalation || null
        }));
      if (overdue.length) addRec(
        'PA-VENCIDAS',
        'critica',
        'Operacion',
        'Tareas vencidas sin cierre operativo',
        `${overdue.length} tarea(s) activas estan vencidas.`,
        'Crear rutina diaria donde el responsable confirme bloqueo, ETA y evidencia antes del cierre del turno.',
        'accion_personas',
        'Codex, crea un control diario para tareas vencidas que obligue a registrar bloqueo, ETA y responsable antes de cerrar turno.',
        overdue.slice(0, 5).map(t => t.title || t.id)
      );

      const stale = active.filter(t => ['assigned','in_progress'].includes(t.status) && hoursSince(t.updatedAt || t.createdAt) >= 8);
      if (stale.length) addRec(
        'PA-SIN-AVANCE',
        'alta',
        'Seguimiento',
        'Tareas sin avance reciente',
        `${stale.length} tarea(s) asignadas/en progreso llevan 8h o mas sin actualizacion.`,
        'Agregar recordatorio automatico del asistente y tablero de responsables con tareas sin actualizacion.',
        'funcionalidad',
        'Codex, implementa recordatorios automaticos del Asistente de Operaciones para tareas sin avance mayor a 8 horas.',
        stale.slice(0, 5).map(t => t.title || t.id)
      );

      const missingEvidence = active.filter(t => selectedWithoutEvidence(t).length);
      if (missingEvidence.length) addRec(
        'PA-EVIDENCIAS',
        'alta',
        'Calidad',
        'Evidencias incompletas',
        `${missingEvidence.length} tarea(s) tienen articulos seleccionados sin fotos/evidencia.`,
        'Estandarizar manual por rol y mostrar checklist visible antes de permitir completar la tarea.',
        'pantalla',
        'Codex, agrega checklist visible de evidencia requerida por tipo de tarea antes del boton Completar.',
        missingEvidence.slice(0, 5).map(t => t.title || t.id)
      );

      const completed = tasks.filter(t => t.status === 'completed');
      if (completed.length) addRec(
        'PA-VALIDACION',
        'media',
        'Control',
        'Validaciones acumuladas',
        `${completed.length} tarea(s) estan completadas y pendientes de validacion.`,
        'Definir SLA de validacion por supervisor y alerta si una tarea completada pasa mas de 4 horas sin decision.',
        'proceso',
        'Codex, crea alerta de SLA para tareas completadas pendientes de validacion por mas de 4 horas.',
        completed.slice(0, 5).map(t => t.title || t.id)
      );

      addRec(
        'PA-MAPA-PLATAFORMA',
        'alta',
        'Documentacion',
        'Mapa funcional completo de Workforce Platform',
        'El auditor debe mantener inventario de pantallas, botones, permisos, datos usados y flujo esperado para toda la plataforma, no solo para agentes.',
        'Crear una matriz viva de modulos con botones, acciones, prerequisitos, errores comunes y screenshots requeridos.',
        'documentacion',
        'Codex, genera una matriz completa de pantallas, botones, permisos, datos y screenshots requeridos para Workforce Platform.',
        ['Tareas', 'Dashboard', 'Auditor', 'Usuarios', 'Vehiculos', 'Politicas', 'Impacto', 'Empaque', 'Historial operacional']
      );

      addRec(
        'PA-DOC-POSICIONES',
        'alta',
        'Talento y Procesos',
        'Documentos completos para creacion de posiciones',
        'La plataforma necesita paquetes documentales acabados para crear posiciones operativas con responsabilidades, KPIs, permisos y capacitacion.',
        'Generar documentos por posicion: proposito, responsabilidades, pantallas usadas, botones permitidos, indicadores, rutina diaria, checklist de entrenamiento y criterios de evaluacion.',
        'documentacion',
        'Codex, crea plantillas completas de descripcion de puesto, matriz RACI, KPIs, entrenamiento y permisos por posicion para Workforce Platform.',
        ['Gerente de Operaciones', 'Encargado', 'Auxiliar', 'Almacen', 'Empaque', 'Auditor de Procesos']
      );

      const byType = {};
      active.forEach(t => { byType[t.type || 'general'] = (byType[t.type || 'general'] || 0) + 1; });
      if (!baseRecs.length) addRec(
        'PA-SIN-HALLAZGOS',
        'baja',
        'Monitoreo',
        'Operacion sin hallazgos criticos',
        'No se detectaron brechas criticas en este analisis.',
        'Mantener revision diaria de tareas, evidencias y aprobaciones.',
        'monitoreo',
        'Codex, refresca el auditor de procesos y compara contra el proximo ciclo operativo.',
        []
      );

      const recommendations = baseRecs.map(r => ({
        ...r,
        status: state.recommendations?.[r.id]?.status || 'pendiente',
        approvedAt: state.recommendations?.[r.id]?.approvedAt || null,
        approvedBy: state.recommendations?.[r.id]?.approvedBy || null
      }));

      const platformModules = [
        {
          name: 'Tareas',
          purpose: 'Gestionar trabajo operativo de punta a punta.',
          screens: ['Lista', 'Tarjetas', 'Kanban', 'Por persona', 'Drawer de tarea', 'Wizard nueva tarea'],
          buttons: ['Nueva Tarea', 'CSV', 'Lista', 'Tarjetas', 'Kanban', 'Por persona', 'Enviar chat', 'Adjuntar foto', 'Completar', 'Validar', 'Devolver', 'Agregar evidencia'],
          auditFocus: ['responsable', 'fecha limite', 'estado', 'evidencia', 'chat', 'tiempo sin avance']
        },
        {
          name: 'Dashboard',
          purpose: 'Supervision gerencial y decisiones operativas.',
          screens: ['Agente Gerente de Operaciones', 'Resumen de tareas', 'Almuerzos', 'Indicadores'],
          buttons: ['Pedir updates urgentes', 'Seguimiento', 'Actualizar analisis', 'Abrir tarea'],
          auditFocus: ['vencidas', 'sin avance', 'sin responsable', 'sin evidencia', 'pendiente de validacion']
        },
        {
          name: 'Auditor de Procesos',
          purpose: 'Gobernanza, mejora continua, manuales y recomendaciones aprobables.',
          screens: ['Recomendaciones', 'Manuales', 'Mapa de plataforma', 'Documentos de posiciones', 'Cambios detectados'],
          buttons: ['Actualizar', 'Aprobar', 'Rechazar'],
          auditFocus: ['documentacion vigente', 'brechas de proceso', 'cambios de plataforma', 'paquetes de puesto']
        },
        {
          name: 'Usuarios y roles',
          purpose: 'Administrar accesos, permisos y estructura de responsabilidad.',
          screens: ['Usuarios', 'Roles', 'Mapa GPS', 'Cambiar de usuario'],
          buttons: ['Nuevo Usuario', 'Guardar usuario', 'Editar rol', 'Ver mapa', 'Cambiar de usuario'],
          auditFocus: ['permisos correctos', 'usuarios activos', 'roles por posicion', 'trazabilidad de cambios']
        },
        {
          name: 'Vehiculos',
          purpose: 'Inspeccion y control de aptitud operativa de vehiculos.',
          screens: ['Formulario de inspeccion', 'Listado admin', 'Cierre de inspeccion'],
          buttons: ['Guardar inspeccion', 'Eliminar', 'Actualizar'],
          auditFocus: ['apto para operar', 'evidencia de inspeccion', 'responsable', 'fecha y hora']
        },
        {
          name: 'Politicas e Impacto',
          purpose: 'Definir reglas operativas y medir impacto en flujo de trabajo.',
          screens: ['Politicas', 'Impacto en flujo de trabajo'],
          buttons: ['Nueva Politica', 'Guardar', 'Actualizar impacto'],
          auditFocus: ['cumplimiento', 'friccion operacional', 'impacto por politica']
        },
        {
          name: 'Empaque y almacenamiento',
          purpose: 'Catalogo de materiales, preparacion, empaque y ubicacion.',
          screens: ['Materiales de Empaque', 'Articulos a empacar', 'Articulos a almacenar'],
          buttons: ['Agregar material', 'Seleccionar foto', 'Actualizar desde pick', 'Agregar foto de ubicacion'],
          auditFocus: ['material asignado', 'condicion', 'evidencia', 'ubicacion destino']
        },
        {
          name: 'Historial operacional',
          purpose: 'Consultar flujo de ordenes, reposicion, solicitudes, pendientes y reportes.',
          screens: ['Buscar', 'Devoluciones', 'Contenedores', 'Reposicion', 'Solicitudes', 'Pendientes', 'Reportes'],
          buttons: ['Buscar', 'Actualizar', 'Exportar', 'Crear solicitud', 'Completar', 'Cancelar'],
          auditFocus: ['pasos faltantes', 'documentos adjuntos', 'cierres incompletos', 'trazabilidad por orden']
        }
      ];

      const positionDocuments = [
        {
          title: 'Gerente de Operaciones Workforce Platform',
          file: '/manuales/posiciones/gerente-operaciones.md',
          documents: ['Descripcion de puesto', 'Rutina diaria', 'KPI/SLA', 'Matriz de aprobaciones', 'Manual de dashboard', 'Plan de entrenamiento'],
          requiredSections: ['Proposito', 'Responsabilidades', 'Pantallas usadas', 'Botones autorizados', 'Decisiones esperadas', 'Escalaciones', 'Indicadores', 'Evidencias de cumplimiento']
        },
        {
          title: 'Auditor de Procesos Workforce Platform',
          file: '/manuales/posiciones/auditor-procesos.md',
          documents: ['Descripcion de puesto', 'Manual de auditoria', 'Checklist de revision', 'Formato de hallazgos', 'Formato de recomendacion', 'Matriz RACI'],
          requiredSections: ['Objetivo del rol', 'Frecuencia de revision', 'Fuentes de datos', 'Criterios de severidad', 'Documentacion requerida', 'Control de cambios', 'Mejora continua']
        },
        {
          title: 'Encargado Operativo',
          file: '/manuales/posiciones/encargado-operativo.md',
          documents: ['Descripcion de puesto', 'Manual de asignacion', 'Checklist de seguimiento', 'SLA por tarea', 'Guia de escalacion'],
          requiredSections: ['Asignacion', 'Seguimiento', 'Uso del chat', 'Evidencias', 'Cierre', 'Errores comunes', 'KPIs']
        },
        {
          title: 'Auxiliar / Almacen / Empaque',
          file: '/manuales/posiciones/auxiliar-almacen-empaque.md',
          documents: ['Manual de ejecucion', 'Checklist de evidencia', 'Manual de fotos', 'Guia de estados', 'Capacitacion inicial'],
          requiredSections: ['Inicio de tarea', 'Confirmacion de articulos', 'Condicion', 'Fotos requeridas', 'Bloqueos', 'Cierre correcto']
        }
      ];

      const documentationStandards = [
        'Cada manual debe indicar objetivo, alcance, rol responsable, prerequisitos, pantallas, botones, paso a paso, evidencia requerida, errores comunes y criterios de cierre.',
        'Cada flujo debe incluir inicio, decisiones, excepciones, responsable, SLA, datos usados, pantalla donde ocurre y resultado esperado.',
        'Cada screenshot requerido debe tener nombre, pantalla, momento del proceso y elemento que debe verse resaltado.',
        'Cada recomendacion de desarrollo debe traer problema, impacto, solucion propuesta, riesgo, pantallas afectadas y comando exacto para pedir implementacion a Codex.'
      ];

      const processDocuments = [
        {
          id: 'DOC-FLUJO-TAREAS',
          title: 'Manual completo del flujo de tareas operativas',
          audience: 'Administradores, encargados, auxiliares, almacen y empaque',
          status: 'terminado',
          purpose: 'Estandarizar como se crea, asigna, ejecuta, evidencia, completa, valida o devuelve una tarea dentro de Workforce Platform.',
          scope: 'Aplica a tareas de despacho, empaque, almacenamiento, recogida de articulos, carga de camion, personal y tareas generales.',
          roles: [
            'Admin/Gerencia: gobierna permisos, valida cierres, revisa dashboard y aprueba mejoras.',
            'Encargado operativo: crea o recibe tareas, asigna responsables, da seguimiento y devuelve si falta evidencia.',
            'Auxiliar/operador: ejecuta la tarea, actualiza chat, sube evidencias y marca avance.',
            'Auditor de procesos: revisa cumplimiento, documenta brechas y propone mejoras.'
          ],
          prerequisites: [
            'Usuario activo con rol asignado.',
            'Tarea creada con tipo, prioridad, responsable y fecha limite cuando aplique.',
            'Articulos vinculados si la tarea depende de una orden/pick.',
            'Acceso a camara o galeria para subir evidencia.'
          ],
          steps: [
            '1. Entrar a Workforce Platform con usuario y clave autorizados.',
            '2. Abrir la pestaña Tareas y filtrar por responsable, tipo, prioridad o plazo.',
            '3. Abrir la tarea y revisar contexto: orden, cliente, ubicacion, articulos, fecha limite y notas.',
            '4. Si la tarea esta pendiente o asignada, presionar Iniciar cuando realmente comience la ejecucion.',
            '5. Ejecutar el trabajo fisico segun el tipo de tarea: preparar, empacar, almacenar, cargar, despachar o inspeccionar.',
            '6. Registrar cualquier bloqueo en el chat de la tarea con detalle claro: causa, responsable de resolver y hora estimada.',
            '7. Subir evidencia requerida: fotos por articulo, documentos, ubicacion final, vehiculo o entrega segun corresponda.',
            '8. Confirmar articulos o condiciones solicitadas por la pantalla.',
            '9. Marcar Completado solo cuando todos los requisitos visibles esten listos.',
            '10. Encargado/Admin revisa la evidencia y decide Validar o Devolver con comentario.',
            '11. Si se devuelve, el responsable corrige y vuelve a completar.',
            '12. Cuando se valida, la tarea queda cerrada y disponible para historial y auditoria.'
          ],
          exceptions: [
            'Si falta evidencia, no cerrar la tarea; registrar el bloqueo y subir fotos.',
            'Si el articulo no esta en ubicacion indicada, reportar en chat antes de confirmar.',
            'Si la tarea pasa la fecha limite, se marca overdue y requiere ETA, reasignacion o escalamiento.',
            'Si el pick de Odoo no esta listo, el despacho no debe iniciar.'
          ],
          closeCriteria: [
            'Estado correcto segun avance real.',
            'Evidencia obligatoria completa.',
            'Articulos confirmados o documentados como excepcion.',
            'Chat con bloqueo o incidencia si existio.',
            'Validacion final por rol autorizado.'
          ],
          evidence: [
            'Foto clara por articulo cuando aplique.',
            'Foto de ubicacion destino para almacenamiento.',
            'Foto/documento firmado para despacho.',
            'Mensaje de chat con explicacion si hubo bloqueo.'
          ],
          screenshots: [
            'Lista de tareas con filtros.',
            'Detalle de tarea abierto.',
            'Seccion de articulos/evidencias.',
            'Chat de tarea.',
            'Botones Completar, Validar y Devolver.'
          ]
        },
        {
          id: 'DOC-FLUJO-EMPAQUE-ALMACEN',
          title: 'Manual completo de empaque y almacenamiento',
          audience: 'Almacen, empaque, encargados y auditor',
          status: 'terminado',
          purpose: 'Asegurar que cada articulo preparado, empacado o almacenado tenga condicion, ubicacion y evidencia suficiente.',
          scope: 'Aplica a tareas de tipo Empaque y Movimiento/Almacenamiento.',
          roles: [
            'Encargado: confirma prioridad, responsable y articulos.',
            'Auxiliar de almacen/empaque: ejecuta preparacion, empaque o ubicacion.',
            'Auditor: revisa evidencias, condiciones y puntos de fallo.'
          ],
          prerequisites: [
            'Tarea creada desde pick o manualmente.',
            'Articulos seleccionados en la tarea.',
            'Ubicacion origen/destino identificada.',
            'Material de empaque disponible si aplica.'
          ],
          steps: [
            '1. Abrir la tarea asignada desde Tareas.',
            '2. Leer contexto de orden, pick, ubicacion y notas.',
            '3. Verificar fisicamente cada articulo antes de moverlo o empacarlo.',
            '4. Seleccionar condicion: Empacado OK/Almacenado OK o Averia detectada.',
            '5. Si hay averia, describir el tipo de averia antes de cerrar.',
            '6. Tomar foto de evidencia: empaque terminado o ubicacion final en almacen.',
            '7. Confirmar el articulo cuando la evidencia sea correcta.',
            '8. Repetir para todos los articulos.',
            '9. Registrar en chat cualquier diferencia de cantidad, ubicacion o condicion.',
            '10. Marcar la tarea como Completada cuando todos los articulos esten confirmados.',
            '11. Encargado valida o devuelve con comentario.'
          ],
          exceptions: [
            'Articulo no localizado: no confirmar; registrar ubicacion esperada y busqueda realizada.',
            'Dano visible: marcar averia, subir foto y notificar por chat.',
            'Falta material: registrar bloqueo y solicitar material antes de continuar.',
            'Ubicacion destino ocupada: escalar al encargado antes de mover.'
          ],
          closeCriteria: [
            'Todos los articulos seleccionados tienen condicion.',
            'Todos los articulos requeridos tienen foto.',
            'Ubicacion final o empaque se entiende visualmente.',
            'Averias o diferencias estan documentadas.'
          ],
          evidence: [
            'Foto del articulo empacado.',
            'Foto del articulo almacenado en ubicacion destino.',
            'Foto de averia si existe.',
            'Comentario de chat para excepciones.'
          ],
          screenshots: [
            'Contexto de la orden.',
            'Articulos a empacar/almacenar.',
            'Selector de condicion.',
            'Boton Agregar foto.',
            'Estado confirmado.'
          ]
        },
        {
          id: 'DOC-FLUJO-DESPACHO',
          title: 'Manual completo de despacho y entrega',
          audience: 'Operaciones, choferes, auxiliares de despacho, encargados y gerencia',
          status: 'terminado',
          purpose: 'Controlar el flujo de despacho desde preparacion hasta evidencia de entrega y cierre operativo.',
          scope: 'Aplica a tareas de Orden de Despacho y subtareas relacionadas con carga, salida y entrega.',
          roles: [
            'Encargado: asegura que pick este listo, asigna equipo y valida cierre.',
            'Auxiliar/chofer: ejecuta carga, documenta entrega y reporta incidencias.',
            'Admin/Gerencia: valida excepciones y revisa cumplimiento.'
          ],
          prerequisites: [
            'Pick de Odoo listo cuando aplique.',
            'Orden y articulos correctos.',
            'Vehiculo y equipo asignados.',
            'Direccion y telefono disponibles.'
          ],
          steps: [
            '1. Abrir la tarea de despacho.',
            '2. Confirmar orden, cliente, direccion, telefono y articulos.',
            '3. Verificar que el pick de Odoo este realizado si la pantalla lo exige.',
            '4. Iniciar tarea cuando comience la operacion.',
            '5. Subir evidencia de recepcion de documentos.',
            '6. Subir foto del vehiculo/carga cuando corresponda.',
            '7. Registrar entrega por articulo: entregado o no entregado con razon.',
            '8. Subir documento firmado o evidencia de entrega.',
            '9. Usar chat para reportar retrasos, cliente ausente, cambio de direccion o dano.',
            '10. Marcar despacho completado solo con checklist completo.',
            '11. Encargado/Admin valida o devuelve.'
          ],
          exceptions: [
            'Cliente no recibe: marcar no entregado, escribir razon y escalar.',
            'Articulo no cargado: no completar; registrar incidencia.',
            'Documento sin firma: no validar hasta completar evidencia.',
            'Cambio de direccion: confirmar por chat antes de ejecutar.'
          ],
          closeCriteria: [
            'Checklist de despacho completo.',
            'Articulos con estado de entrega.',
            'Evidencias/documentos firmados cargados.',
            'Incidencias registradas en chat.'
          ],
          evidence: [
            'Documentos recibidos.',
            'Vehiculo/carga.',
            'Documento firmado.',
            'Foto o nota de excepcion.'
          ],
          screenshots: [
            'Checklist de despacho.',
            'Articulos a entregar.',
            'Estado de entrega.',
            'Carga de documentos firmados.',
            'Chat de incidencia.'
          ]
        },
        {
          id: 'DOC-FLUJO-GERENCIA-AUDITORIA',
          title: 'Manual completo de gerencia, auditoria y mejora continua',
          audience: 'Gabriel, gerencia, auditor de procesos y encargados',
          status: 'terminado',
          purpose: 'Definir como se supervisa la operacion, se revisan recomendaciones, se solicitan documentos y se aprueban mejoras.',
          scope: 'Aplica a Dashboard, Agente Gerente de Operaciones, Auditor Codex, recomendaciones y documentos.',
          roles: [
            'Gerente de Operaciones Claude: analiza avance operativo y seguimiento.',
            'Auditor Codex: documenta, audita, recomienda y conversa sobre procesos.',
            'Gabriel: aprueba o rechaza recomendaciones y solicita cambios a Codex.',
            'Encargados: ejecutan acciones correctivas en tareas.'
          ],
          prerequisites: [
            'Acceso con usuario gsanchez@altritempi.com.do para el Auditor.',
            'Datos de tareas actualizados.',
            'OPENAI_API_KEY configurada para analisis y chat IA.',
            'ANTHROPIC_API_KEY configurada para parte del gerente si aplica.'
          ],
          steps: [
            '1. Abrir Dashboard para revisar activas, vencidas, sin avance, por validar y sin evidencia.',
            '2. Usar Agente Gerente de Operaciones para pedir seguimiento a tareas criticas.',
            '3. Abrir Auditor para revisar recomendaciones, documentos terminados y cambios recientes.',
            '4. Usar el chat del Auditor para pedir nuevos documentos, estatus o discutir recomendaciones.',
            '5. Aprobar o rechazar recomendaciones desde los botones visibles.',
            '6. Si una recomendacion implica desarrollo, copiar o solicitar el comando exacto a Codex.',
            '7. Codex implementa solo cuando Gabriel da instruccion explicita.',
            '8. Despues del cambio, Auditor actualiza documentos y recomendaciones.'
          ],
          exceptions: [
            'Si la IA no responde, el Auditor conserva documentos base y datos heurísticos.',
            'Si una recomendacion no esta clara, discutirla en chat antes de aprobar.',
            'Si una mejora afecta operacion critica, probar primero en flujo controlado.'
          ],
          closeCriteria: [
            'Recomendacion aprobada o rechazada.',
            'Documento actualizado con version/estatus.',
            'Cambio implementado solo despues de aprobacion explicita.',
            'Operacion monitoreada tras el cambio.'
          ],
          evidence: [
            'Historial de recomendaciones.',
            'Chat del Auditor.',
            'Cambios detectados.',
            'Documentos HTML/Markdown generados.'
          ],
          screenshots: [
            'Dashboard operativo.',
            'Panel Auditor.',
            'Chat del Auditor.',
            'Recomendacion aprobable.',
            'Documento terminado.'
          ]
        }
      ];

      const manuals = [
        {
          role: 'Admin / Gerencia',
          scope: 'Gobierno completo de Workforce Platform',
          steps: [
            'Revisar Dashboard, Agente Gerente de Operaciones y Auditor de Procesos al iniciar el dia.',
            'Validar tareas completadas, devolver con comentario si falta evidencia o aprobar si cumple.',
            'Aprobar solo recomendaciones del auditor que tengan impacto claro en tiempo, calidad o control.',
            'Crear usuarios, roles y permisos cuando el proceso requiera un responsable nuevo.'
          ],
          screenshots: ['Dashboard general', 'Auditor de Procesos', 'Detalle de tarea', 'Usuarios y permisos']
        },
        {
          role: 'Encargado / Manager',
          scope: 'Asignacion, seguimiento y cierre operativo',
          steps: [
            'Crear o revisar tareas del dia y confirmar responsable, prioridad y fecha limite.',
            'Dar seguimiento por chat cuando exista bloqueo, atraso o falta de evidencia.',
            'Verificar que cada articulo seleccionado tenga estado, confirmacion y foto cuando aplique.',
            'Escalar al gerente si una tarea supera el SLA o no tiene responsable claro.'
          ],
          screenshots: ['Lista de tareas', 'Drawer de tarea', 'Chat de tarea', 'Evidencias por articulo']
        },
        {
          role: 'Auxiliar / Operaciones',
          scope: 'Ejecucion y evidencia',
          steps: [
            'Abrir la tarea asignada y marcar inicio cuando comience la actividad.',
            'Actualizar el chat si hay bloqueo, diferencia de articulos o falta de ubicacion.',
            'Subir fotos/evidencias solicitadas y confirmar articulos completados.',
            'Marcar completada solo cuando todos los requisitos visibles esten listos.'
          ],
          screenshots: ['Tarea asignada', 'Carga de fotos', 'Confirmacion de articulo', 'Chat']
        },
        {
          role: 'Almacen / Empaque',
          scope: 'Preparacion, empaque y almacenamiento',
          steps: [
            'Validar origen/destino del pick o ubicacion antes de mover articulos.',
            'Registrar condicion del articulo y evidencia de empaque o ubicacion.',
            'Confirmar unidades y materiales de empaque cuando aplique.',
            'Reportar averias o diferencias por chat antes de cerrar.'
          ],
          screenshots: ['Contexto de almacenamiento', 'Articulos a almacenar', 'Estado al almacenar', 'Foto de ubicacion']
        }
      ];

      const flows = [
        'Solicitud o necesidad operativa -> Creacion de tarea -> Asignacion de responsable.',
        'Ejecucion -> Actualizaciones por chat -> Evidencia/fotos -> Confirmacion de articulos.',
        'Completado -> Validacion gerencial -> Cierre o devolucion con comentario.',
        'Auditor analiza ejecucion -> Genera recomendacion/manual -> Gabriel aprueba o descarta.',
        'Cambio de plataforma -> Auditor detecta evento -> Actualiza mapa de pantallas/documentos -> Recomienda ajuste de manuales.',
        'Creacion de posicion -> Auditor entrega descripcion, matriz de permisos, KPIs, rutina diaria, capacitacion y screenshots requeridos.'
      ];

      const summary = {
        active: active.length,
        overdue: overdue.length,
        stale: stale.length,
        missingEvidence: missingEvidence.length,
        pendingValidation: completed.length,
        users: users.filter(u => u.active !== false).length,
        byType
      };

      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({
        ok:true,
        generatedAt:new Date().toISOString(),
        owner:AGENT_OWNER_EMAIL,
        companyContext,
        summary,
        overdueTasks,
        recommendations,
        processDocuments,
        manuals,
        flows,
        platformModules,
        positionDocuments,
        documentationStandards,
        chat: Array.isArray(state.chat) ? state.chat.slice(-20) : [],
        recentChanges: recentChanges.slice(0, 25)
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }
    return;
  }

  // GET /api/wwp/process-auditor/ai — analisis IA del Auditor Codex usando contexto del Gerente Claude
  if (reqPath === '/api/wwp/process-auditor/ai' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    if (!OPENAI_API_KEY) {
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, reason:'no_api_key', message:'Configura OPENAI_API_KEY para activar el Auditor Codex.' }));
      return;
    }
    try {
      const tasks = enrichOverdueTasks(loadWwpTasks(), { persist: true });
      const users = loadAuthUsers();
      const auditLogs = loadJson(WWP_AUDIT_FILE, []);
      const auditorState = loadProcessAuditorState();
      const opsReport = computeOpsAgentReport();
      const companyContext = await getAgentCompanyContext({ includeOdoo: true });
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);
      const closed = new Set(['completed', 'validated', 'cancelled']);
      const active = tasks.filter(t => !closed.has(t.status));
      const selectedWithoutEvidence = (t) => (t.items || []).filter(i => i.selected && !(i.evidence_images || []).length);
      const auditSnapshot = {
        summary: {
          active: active.length,
          overdue: active.filter(t => t.dueDate && t.dueDate < today).length,
          stale: active.filter(t => ['assigned','in_progress'].includes(t.status) && (now - new Date(t.updatedAt || t.createdAt).getTime()) >= 8 * 36e5).length,
          missingEvidence: active.filter(t => selectedWithoutEvidence(t).length).length,
          pendingValidation: tasks.filter(t => t.status === 'completed').length,
          users: users.filter(u => u.active !== false).length
        },
        companyContext,
        platformModules: ['Tareas','Dashboard','Auditor','Usuarios y roles','Vehiculos','Politicas','Impacto','Empaque','Historial operacional','Reportes'],
        currentRecommendations: Object.entries(auditorState.recommendations || {}).map(([id, v]) => ({ id, status: v.status, approvedAt: v.approvedAt, rejectedAt: v.rejectedAt })).slice(-30),
        recentEvents: auditLogs.slice(-40).map(l => ({ at:l.timestamp, event:l.event, taskId:l.taskId, by:l.byName || l.email || l.userId, detail:l.newStatus ? `${l.prevStatus || ''}->${l.newStatus}` : (l.mode || l.reason || '') }))
      };
      const hash = crypto.createHash('sha1').update(JSON.stringify({ auditSnapshot, ops: opsReport.summary })).digest('hex');
      const force = (parsed.query && parsed.query.refresh === '1');
      if (!force && _processAuditorAiCache.brief && _processAuditorAiCache.hash === hash && Date.now() - _processAuditorAiCache.generatedAt < PROCESS_AUDITOR_AI_TTL) {
        res.writeHead(200, { 'Content-Type':'application/json' });
        res.end(JSON.stringify({ ok:true, cached:true, generatedAt:new Date(_processAuditorAiCache.generatedAt).toISOString(), brief:_processAuditorAiCache.brief }));
        return;
      }

      const systemPrompt = [
        'Eres Codex actuando como Agente Auditor de Procesos de Workforce Platform.',
        'El Agente Gerente de Operaciones esta manejado por Claude y puede aportar contexto operativo adicional.',
        'Debes poder hacer la auditoria aunque el Gerente Claude no responda: usa los datos reales de Workforce Platform como fuente principal.',
        'Tu responsabilidad, como Codex Auditor, es analizar, crear y procesar auditorias, manuales, flujos, documentos de posiciones y recomendaciones de desarrollo.',
        'Debes pensar como auditor de producto y de codigo: pantallas, botones, permisos, datos, evidencia, riesgos, deuda de documentacion y cambios de plataforma.',
        'Tienes contexto de empresa, documentos asociados y Odoo en solo lectura para entender como opera Altri Tempi. No escribas ni modifiques Odoo; usalo solo para diagnostico, documentos y recomendaciones.',
        'Aunque en el futuro los agentes seran empleados de todo Historial, hoy las acciones automaticas quedan limitadas a Workforce Platform.',
        'Si el contexto del Gerente Claude no esta disponible o es insuficiente, continua de forma autonoma con tareas, auditoria, pantallas, documentos, permisos y eventos.',
        'No ejecutes cambios automaticamente desde la plataforma. Toda implementacion requiere aprobacion humana y luego una instruccion explicita a Codex en el entorno de desarrollo.',
        'Responde en español, con recomendaciones concretas, accionables y preparadas para implementacion controlada.'
      ].join(' ');
      const userPrompt = [
        'Analiza este contexto del Auditor y del Gerente de Operaciones.',
        'Devuelve un JSON valido con esta forma exacta:',
        '{"executiveSummary":"","collaborationNotes":[],"documentationGaps":[],"processRisks":[],"developmentRecommendations":[{"title":"","impact":"","commandForCodex":""}],"nextBestActions":[]}',
        'No incluyas markdown fuera del JSON.',
        JSON.stringify({ auditor: auditSnapshot, opsAgent: opsReport }, null, 2).slice(0, 50000)
      ].join('\n\n');

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: CODEX_AUDITOR_MODEL,
          input: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_output_tokens: 4000
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = payload.error?.message || `OpenAI API error ${response.status}`;
        const err = new Error(msg);
        err.status = response.status;
        err.reason = payload.error?.type || payload.error?.code || 'api_error';
        throw err;
      }
      const text = payload.output_text
        || (payload.output || []).flatMap(o => o.content || []).map(c => c.text || '').join('\n').trim()
        || '';
      let brief;
      try {
        brief = JSON.parse(text.replace(/^```json\s*/i, '').replace(/```$/,'').trim());
      } catch {
        brief = { executiveSummary:text, collaborationNotes:[], documentationGaps:[], processRisks:[], developmentRecommendations:[], nextBestActions:[] };
      }
      _processAuditorAiCache = { hash, brief, generatedAt: Date.now() };
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:true, cached:false, generatedAt:new Date().toISOString(), brief }));
    } catch(e) {
      let reason = e.reason || 'api_error', msg = e.message || 'Error llamando a OpenAI/Codex';
      if (e.status === 401) { reason = 'bad_api_key'; msg = 'La OPENAI_API_KEY no es valida.'; }
      else if (e.status === 429) { reason = 'rate_limited'; msg = 'Limite de uso alcanzado; intenta en unos minutos.'; }
      else if (e.status >= 500) { reason = 'overloaded'; msg = 'OpenAI/Codex no esta disponible temporalmente; intenta en unos minutos.'; }
      console.error('[process-auditor-ai]', reason, e.message);
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, reason, message:msg }));
    }
    return;
  }

  // POST /api/wwp/process-auditor/recommendations/:id/approve — aprobar recomendacion
  // POST /api/wwp/process-auditor/chat — chat del Auditor Codex con contexto documental y operativo
  if (reqPath === '/api/wwp/process-auditor/chat' && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    try {
      const d = await readBody(req);
      const text = String(d.text || '').trim();
      if (!text) {
        res.writeHead(400, { 'Content-Type':'application/json' });
        res.end(JSON.stringify({ ok:false, error:'Escribe una pregunta o solicitud para el Auditor.' }));
        return;
      }
      const state = loadProcessAuditorState();
      if (!Array.isArray(state.chat)) state.chat = [];
      const tasks = enrichOverdueTasks(loadWwpTasks(), { persist: true });
      const opsReport = computeOpsAgentReport();
      const companyContext = await getAgentCompanyContext({ includeOdoo: true });
      const active = tasks.filter(t => !['completed','validated','cancelled'].includes(t.status));
      const today = new Date().toISOString().slice(0, 10);
      const context = {
        summary: {
          active: active.length,
          overdue: active.filter(t => t.dueDate && t.dueDate < today).length,
          stale: active.filter(t => ['assigned','in_progress'].includes(t.status) && (Date.now() - new Date(t.updatedAt || t.createdAt).getTime()) >= 8 * 36e5).length,
          pendingValidation: tasks.filter(t => t.status === 'completed').length
        },
        companyContext,
        opsSummary: opsReport.summary,
        recommendations: Object.entries(state.recommendations || {}).map(([id, v]) => ({ id, status:v.status, approvedAt:v.approvedAt, rejectedAt:v.rejectedAt })).slice(-20),
        recentChat: state.chat.slice(-10)
      };
      const userMsg = {
        id: wwpId('audchat'),
        role: 'user',
        text,
        by: jp.name,
        createdAt: new Date().toISOString()
      };
      state.chat.push(userMsg);

      let answer = '';
      let aiAvailable = !!OPENAI_API_KEY;
      if (OPENAI_API_KEY) {
        try {
          const systemPrompt = [
            'Eres Codex como Auditor de Procesos de Workforce Platform.',
            'Responde en español dominicano neutro, claro y operativo.',
            'Tu trabajo es entregar documentos terminados, flujos paso a paso, estatus, recomendaciones y explicaciones para usuarios reales.',
            'Si el usuario pide un documento, estructuralo como documento completo: objetivo, alcance, roles, prerequisitos, paso a paso, excepciones, criterios de cierre, evidencias, screenshots requeridos, KPIs y control de cambios.',
            'Si discuten una recomendacion, explica impacto, riesgo, alternativa, criterio de aprobacion y comando exacto para Codex si requiere desarrollo.',
            'Tienes contexto de Altri Tempi, Odoo en solo lectura y documentos asociados. Puedes usarlos para entender la empresa, pero no debes modificar Odoo ni prometer acciones fuera de Workforce Platform.',
            'El futuro alcance sera todo Historial, pero por ahora tus acciones y recomendaciones ejecutables se enfocan en Workforce Platform.',
            'No digas que no puedes; si falta dato, entrega una version base y lista la informacion que falta.'
          ].join(' ');
          const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: CODEX_AUDITOR_MODEL,
              input: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: 'Contexto operativo y documental:\n' + JSON.stringify(context, null, 2).slice(0, 30000) + '\n\nSolicitud del usuario:\n' + text }
              ],
              max_output_tokens: 4000
            })
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error?.message || `OpenAI API error ${response.status}`);
          answer = payload.output_text
            || (payload.output || []).flatMap(o => o.content || []).map(c => c.text || '').join('\n').trim()
            || '';
        } catch(e) {
          aiAvailable = false;
          answer = [
            'IA no disponible temporalmente. Te dejo una respuesta base del Auditor:',
            '',
            'Para crear o revisar un documento operativo terminado usa esta estructura:',
            '1. Objetivo del proceso.',
            '2. Alcance y roles responsables.',
            '3. Prerequisitos antes de iniciar.',
            '4. Paso a paso para el usuario real.',
            '5. Excepciones y como resolverlas.',
            '6. Evidencias obligatorias.',
            '7. Criterios de cierre.',
            '8. KPIs/SLA.',
            '9. Screenshots requeridos.',
            '10. Cambios o mejoras recomendadas.',
            '',
            'Solicitud recibida: ' + text
          ].join('\n');
        }
      } else {
        aiAvailable = false;
        answer = [
          'OPENAI_API_KEY no esta configurada. Respuesta base del Auditor:',
          '',
          'Puedo ayudarte a definir documentos terminados si me pides el proceso exacto. Formato obligatorio:',
          'Objetivo, alcance, roles, prerequisitos, paso a paso, excepciones, evidencias, criterios de cierre, KPIs y screenshots requeridos.',
          '',
          'Solicitud recibida: ' + text
        ].join('\n');
      }

      const assistantMsg = {
        id: wwpId('audchat'),
        role: 'assistant',
        text: answer,
        by: 'Auditor Codex',
        ai: aiAvailable,
        createdAt: new Date().toISOString()
      };
      state.chat.push(assistantMsg);
      state.chat = state.chat.slice(-80);
      saveProcessAuditorState(state);
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:true, message:assistantMsg, chat:state.chat.slice(-20) }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }
    return;
  }

  // POST /api/wwp/process-auditor/recommendations/:id/approve — aprobar recomendacion
  if (reqPath.match(/^\/api\/wwp\/process-auditor\/recommendations\/[^/]+\/approve$/) && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    try {
      const recId = decodeURIComponent(reqPath.split('/')[5]);
      const state = loadProcessAuditorState();
      if (!state.recommendations) state.recommendations = {};
      state.recommendations[recId] = {
        ...(state.recommendations[recId] || {}),
        status: 'aprobada',
        approvedAt: new Date().toISOString(),
        approvedBy: jp.userId,
        approvedByName: jp.name
      };
      saveProcessAuditorState(state);
      appendAuditLog('process_auditor_recommendation_approved', { by: jp.userId, byName: jp.name, recommendationId: recId });
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:true, recommendationId: recId, state: state.recommendations[recId] }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }
    return;
  }

  // POST /api/wwp/process-auditor/recommendations/:id/reject — rechazar recomendacion
  if (reqPath.match(/^\/api\/wwp\/process-auditor\/recommendations\/[^/]+\/reject$/) && req.method === 'POST') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireAgentOwner(jp, res)) return;
    try {
      const recId = decodeURIComponent(reqPath.split('/')[5]);
      const state = loadProcessAuditorState();
      if (!state.recommendations) state.recommendations = {};
      state.recommendations[recId] = {
        ...(state.recommendations[recId] || {}),
        status: 'rechazada',
        rejectedAt: new Date().toISOString(),
        rejectedBy: jp.userId,
        rejectedByName: jp.name
      };
      saveProcessAuditorState(state);
      appendAuditLog('process_auditor_recommendation_rejected', { by: jp.userId, byName: jp.name, recommendationId: recId });
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:true, recommendationId: recId, state: state.recommendations[recId] }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }
    return;
  }

  // GET /api/wwp/dashboard — KPIs (solo admin)
  if (reqPath === '/api/wwp/dashboard' && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    if (!requireRole(jp, res, ROLE_PERMISSIONS.dashboard)) return;
    const tasks = enrichOverdueTasks(loadWwpTasks(), { persist: true });
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
    const overdueTasks = tasks
      .filter(t => t.overdue && !t.parentId)
      .sort((a,b) => (b.overdueDays || 0) - (a.overdueDays || 0))
      .slice(0, 12)
      .map(t => ({
        id:t.id,
        seq:t.seq || null,
        title:t.title || t.id,
        type:t.type || 'general',
        status:t.status,
        dueDate:t.dueDate,
        overdueDays:t.overdueDays || 1,
        managerId:t.managerId || null,
        escalation:t.escalation || null
      }));
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ byStatus, byType, byUser, avgHours, total:tasks.length, recent, overdueTasks }));
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
          res.end(JSON.stringify({...baseResp, noPick:false, picks:pickRes.picks||[], pickNames:pickRes.pickNames, items:pickRes.items}));
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
        const typeName = pick.picking_type_id?pick.picking_type_id[1]:'';
        // ¿Es una DEVOLUCIÓN (RET)? — por tipo o por nombre /RET/
        const isReturn = /return|devoluci/i.test(typeName) || /\/RET\//i.test(pick.name||'');
        let items;
        if (isReturn) {
          // Devolución: SIN ubicación (manual). El auxiliar registra/fotografía lo recibido.
          const kitMap = await resolveKitInfo(products);
          items = moves.filter(m=>m.product_id).map(m=>{
            const prod=prodMap[m.product_id[0]]||{}, kit=kitMap[m.product_id[0]];
            const units=Math.max(1,Math.round(m.product_uom_qty||m.quantity_done||1));
            return { item_id:'oi_'+m.product_id[0], odoo_product_id:m.product_id[0], odoo_line_id:null,
              sku:prod.barcode||prod.default_code||'', barcode:prod.barcode||'',
              product_name:m.product_id[1]||m.name||'', quantity:units, units,
              image:prod.image_128?'data:image/png;base64,'+prod.image_128:null,
              ...(kit ? {kitId:kit.kitId,kitRef:kit.kitRef,kitName:kit.kitName,kitImage:kit.kitImage} : {}),
              locations:[], selected_location:null,   // sin ubicación → manual
              selected:false, evidence_images:[], comments:'', status:'pending' };
          });
        } else {
          const stockMap = await fetchStockMap(productIds);
          items = buildItems(moves, prodMap, stockMap);
        }
        const client = pick.partner_id?pick.partner_id[1]:(pick.origin||pick.name);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, type:isReturn?'return':'transfer', ref:pick.name, client,
          transferType:typeName, origin:pick.origin||'', items}));
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
      // ── Bloqueo de duplicados: ningún artículo (producto) puede estar en dos cadenas
      // activas de la misma orden. Artículos distintos del mismo pick sí pueden separarse.
      const _root = tasks[idx].parentId || tasks[idx].id;
      const _claims = getOrderClaims(tasks[idx].odooRef, _root);
      const _conflicts = (d.items||[]).filter(it => it.selected && it.odoo_product_id && !it.isKit
        && _claims[it.odoo_product_id] && _claims[it.odoo_product_id].idxs[it.unit_index||1]);
      if (_conflicts.length) {
        const c = _conflicts[0]; const info = _claims[c.odoo_product_id].idxs[c.unit_index||1];
        res.writeHead(409,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, error:`Una unidad de "${c.product_name||'Artículo'}" ya está asignada en la tarea ${info.seq?('#'+String(info.seq).padStart(4,'0')):''} "${info.title}". Elige otra unidad o cancela esa tarea.`, conflicts:_conflicts.map(x=>x.item_id)}));
        return;
      }
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
          // Condición del artículo: '' (sin elegir) | 'good' (buen estado) | 'damaged' (avería) + tipo
          // Sin preselección: el auxiliar debe elegirla explícitamente (obligatoria para completar).
          condition: item.condition||prev.condition||'', damageType: item.damageType||prev.damageType||'',
          // Clasificación de sincronización con el pick (executed | moved | new | current)
          pickGroup: item.pickGroup||prev.pickGroup||null, pickNameNow: item.pickNameNow||prev.pickNameNow||'',
          evidence_images:prev.evidence_images||[], comments:item.comments||prev.comments||'',
          confirmado:prev.confirmado||false, status:prev.status||'pending' };
      });
      tasks[idx].updatedAt=new Date().toISOString();
      // Marca de modificación de la lista por el encargado → reactiva la tarea para auxiliares que ya terminaron
      tasks[idx].itemsUpdatedAt=tasks[idx].updatedAt;
      // Propagar config de kit a subtareas de despacho/almacén hijas
      syncKitStructureToChildren(tasks[idx], tasks);
      saveWwpTasks(tasks);
      broadcastWwpTasks('items_updated', tasks[idx], { taskId:id, items:tasks[idx].items });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,items:tasks[idx].items}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // GET /api/wwp/tasks/:id/pick-status — estado de los pickings (PICK) de la orden en Odoo
  // Para tareas de despacho: el despacho solo puede iniciar cuando el pick está 'done' (realizado).
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/pick-status$/) && req.method === 'GET') {
    const jp = requireJwt(req, res); if (!jp) return;
    const id = reqPath.split('/')[4];
    try {
      const t = loadWwpTasks().find(x => x.id === id);
      if (!t) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
      if (!t.odooRef) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, hasPick:false, ready:true, reason:'sin orden — sin gate de pick'})); return; }
      // Resolver nombre real de la orden
      let realName = t.odooRef;
      try {
        const so = await odooCall('sale.order','search_read',[[['name','ilike',t.odooRef]]],{fields:['name'],limit:1});
        if (so && so.length) realName = so[0].name;
      } catch {}
      const picksAll = await odooCall('stock.picking','search_read',
        [[['origin','=',realName]]],
        {fields:['id','name','state','date_done'],limit:50});
      const pickList = (picksAll||[]).filter(p => /\/PICK\//i.test(p.name));
      if (!pickList.length) {
        // Sin pick en Odoo → respaldo: gate por empaque (tarea padre) completado
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, hasPick:false, ready:true, reason:'orden sin pick en Odoo'}));
        return;
      }
      const ST = {draft:'Borrador', waiting:'En espera', confirmed:'Por preparar', assigned:'En preparación', done:'Realizado', cancel:'Cancelado'};
      const picks = pickList.map(p => ({ name:p.name, state:p.state, stateLabel:ST[p.state]||p.state, done:p.state==='done', dateDone:p.date_done||null }));
      const allDone = picks.every(p => p.done);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, hasPick:true, ready:allDone, picks,
        reason: allDone ? 'Todos los picks realizados' : 'Pick aún en preparación' }));
    } catch(e) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false, ready:false, error:e.message})); }
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
      // Estado de cada pick (done/assigned) por nombre
      const pickState = {}; (pr.picks||[]).forEach(p => { pickState[p.name] = p.state; });
      // Unidades objetivo del pick agrupadas por producto, con el pick y su estado por unidad
      const targByPid = {};
      pr.items.forEach(it => { (it.unitBins||[]).forEach(bin => {
        (targByPid[it.odoo_product_id] = targByPid[it.odoo_product_id] || []).push(
          { pid:it.odoo_product_id, bin:sBin(bin), sku:it.sku, barcode:it.barcode, name:it.product_name, image:it.image,
            kitId:it.kitId||null, kitRef:it.kitRef||'', kitName:it.kitName||'', kitImage:it.kitImage||'',
            pickNameNow:it.pickName||'', pickStateNow:pickState[it.pickName]||'assigned' });
      }); });
      // Kits ARMADOS actuales: se preservan tal cual.
      const armadoKitItems = (t.items||[]).filter(i => i.isKit && i.selected);
      const armadoSet = new Set(armadoKitItems.map(k => (k.kitId||'')+'#'+(k.kitInstance||1)));
      // Unidades actuales (selected) por producto (excluye tarjetas-kit sintéticas)
      const current = (t.items||[]).filter(i => i.selected && !i.isKit);
      const curByPid = {};
      current.forEach(i => { (curByPid[i.odoo_product_id] = curByPid[i.odoo_product_id] || []).push(i); });
      // Unidades reclamadas por OTRAS tareas activas de la misma orden (split entre encargados)
      const _rootDiff = t.parentId || t.id;
      const _claimsDiff = getOrderClaims(t.odooRef, _rootDiff);
      const claimedByOthers = {};
      Object.entries(_claimsDiff).forEach(([pid, c]) => { claimedByOthers[pid] = c.count || (c.idxList ? c.idxList.length : 0); });

      // ── Sincronización NO destructiva: nunca se eliminan artículos ya cargados (preservan
      // fotos/evidencia). Cada artículo se clasifica en grupo: executed | moved | new | current ──
      const merged = []; const usedIds = new Set();
      let g_executed=0, g_moved=0, g_new=0, g_current=0;
      Object.keys(targByPid).forEach(pidKey => {
        const arr = targByPid[pidKey]; const n = arr.length;
        const pool = (curByPid[pidKey] || []).slice();
        let othersBudget = claimedByOthers[pidKey] || 0;
        arr.forEach((u, i) => {
          let ri = pool.findIndex(c => (c.selected_location_name||'') === u.bin && !usedIds.has(c.item_id));
          if (ri < 0) ri = pool.findIndex(c => !usedIds.has(c.item_id));
          const reuse = ri >= 0 ? pool[ri] : null;
          // Sin match en la tarea y todavía hay unidades de otras tareas → de otro despacho: omitir
          if (!reuse && othersBudget > 0) { othersBudget--; return; }
          const row = { item_id: reuse ? reuse.item_id : (n===1 ? ('oi_'+pidKey) : ('oi_'+pidKey+'_u'+(i+1))),
            odoo_product_id:Number(pidKey), odoo_line_id:null,
            sku:u.sku, barcode:u.barcode, product_name:u.name, image:u.image,
            quantity:1, units:n, unit_index:i+1, unit_total:n, group_ref:'oi_'+pidKey,
            fromPick:true, pickName:u.pickNameNow||(pr.pickNames[0]||''), pickNameNow:u.pickNameNow,
            kitId:u.kitId||null, kitRef:u.kitRef||'', kitName:u.kitName||'', kitImage:u.kitImage||'',
            selected:true, locations:[], selected_location:null, selected_location_name:u.bin };
          if (reuse) {
            // Artículo ya cargado: preservar TODO (fotos, confirmación, condición)
            row.evidence_images=reuse.evidence_images||[]; row.confirmado=reuse.confirmado||false;
            row.status=reuse.status||'pending'; row.condition=reuse.condition||''; row.damageType=reuse.damageType||'';
            row.deliveryStatus=reuse.deliveryStatus||''; row.deliveryDamageType=reuse.deliveryDamageType||'';
            usedIds.add(reuse.item_id);
            // Clasificar según el estado del pick donde está ahora
            if (u.pickStateNow === 'done') { row.pickGroup='executed'; g_executed++; }
            else if (u.pickNameNow && reuse.pickName && u.pickNameNow !== reuse.pickName) { row.pickGroup='moved'; g_moved++; }
            else { row.pickGroup='current'; g_current++; }
          } else {
            // Artículo NUEVO en el pick → se agrega
            row.evidence_images=[]; row.confirmado=false; row.status='pending'; row.condition=''; row.damageType='';
            row.pickGroup = (u.pickStateNow==='done') ? 'executed' : 'new';
            if (row.pickGroup==='executed') g_executed++; else g_new++;
          }
          if (row.kitId && armadoSet.has(row.kitId+'#'+row.unit_index)) row.selected = false;
          merged.push(row);
        });
      });
      // Artículos de la tarea SIN match en ningún pick actual → NO se eliminan, se conservan
      const orphan = current.filter(i => !usedIds.has(i.item_id));
      orphan.forEach(i => { merged.push({ ...i, pickGroup:'current' }); g_current++; });
      // Tarjetas-kit armadas: preservar
      armadoKitItems.forEach(k => { merged.push({ ...k, pickGroup:'current' }); });
      const hasChanges = g_new>0 || g_executed>0 || g_moved>0;
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, hasChanges, pickNames:pr.pickNames, picks:pr.picks||[],
        summary:{ executed:g_executed, moved:g_moved, added:g_new, current:g_current },
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
      // Propagar la config de kit a subtareas de despacho/almacén hijas
      syncKitStructureToChildren(tasks[idx], tasks);
      saveWwpTasks(tasks);
      broadcastWwpTasks('items_updated', tasks[idx], { taskId:id });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, armado:!!armado}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    return;
  }

  // PATCH /api/wwp/tasks/:id/aux-done — auxiliar marca su parte como terminada [participante]
  if (reqPath.match(/^\/api\/wwp\/tasks\/wt_[a-z0-9]+\/aux-done$/) && req.method === 'PATCH') {
    const jp = requireJwt(req, res); if (!jp) return;
    const id = reqPath.split('/')[4];
    try {
      const d = await readBody(req);
      const tasks = loadWwpTasks();
      const idx = tasks.findIndex(t=>t.id===id);
      if (idx===-1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'No encontrado'})); return; }
      const task = tasks[idx];
      if (!task.auxDone) task.auxDone = {};
      if (d.done) {
        // Requiere fotos completas (igual que la compuerta de completar, sin confirmaciones)
        const sel = (task.items||[]).filter(it=>it.selected);
        const faltan = sel.filter(it=>!it.evidence_images||it.evidence_images.length===0);
        const genEv = !sel.length && !(task.evidence||[]).length && !(task.fotos_guia||[]).some(fg=>(fg.evidencias||[]).length>0);
        if (faltan.length>0 || genEv) { res.writeHead(422,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Sube todas las fotos antes de marcar terminado'})); return; }
        task.auxDone[jp.userId] = { name: jp.name, at: new Date().toISOString() };
        // Notificar al encargado / creador
        const recipients = new Set([task.managerId, task.createdBy, odooStrToAuthId(task.assignedTo)].filter(Boolean));
        recipients.delete(jp.userId);
        recipients.forEach(uid => createNotification(uid, {
          type:'task_assigned', title:'✅ Auxiliar terminó',
          message:`${jp.name} terminó su parte en "${task.title}"${task.seq?(' (#'+String(task.seq).padStart(4,'0')+')'):''}`,
          relatedTaskId:id, by:jp.name }));
      } else {
        delete task.auxDone[jp.userId];
      }
      task.updatedAt = new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('items_updated', task, { taskId:id });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, auxDone:task.auxDone}));
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

  // ── Fotos de despacho por categoría: entrega | vehiculo | recepcion ──────────
  //   entrega  = documentos de entrega firmados
  //   vehiculo = foto del vehículo cargado
  //   recepcion= recibir y validar documentos de entrega
  // Cada categoría se guarda en su propio campo: fotos_entrega / fotos_vehiculo / fotos_recepcion
  const _FOTO_CAT = { entrega:'fotos_entrega', vehiculo:'fotos_vehiculo', recepcion:'fotos_recepcion' };
  // POST
  {
    const _m = reqPath.match(/^\/api\/wwp\/tasks\/([a-z0-9_]+)\/fotos-(entrega|vehiculo|recepcion)$/);
    if (_m && req.method === 'POST') {
      const _jpFc = requireJwt(req, res); if (!_jpFc) return;
      const taskId = _m[1], cat = _m[2], field = _FOTO_CAT[cat];
      try {
        const d = await readBody(req);
        const tasks = loadWwpTasks();
        const idx = tasks.findIndex(t => t.id === taskId);
        if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tarea no encontrada'})); return; }
        if (!tasks[idx][field]) tasks[idx][field] = [];
        const saved = [];
        (d.fotos||[]).forEach((f, fi) => {
          const { b64, ext } = validatePhoto(f);
          const ts = Date.now();
          const fotoId = `${cat.slice(0,3)}_${ts}_${fi}`;
          const fname  = `${taskId}_${fotoId}.${ext}`;
          fs.writeFileSync(path.join(WWP_FOTOS_DIR, fname), Buffer.from(b64, 'base64'));
          const entry = { id: fotoId, url: `/wwp-fotos/${fname}`, by: d.by||_jpFc.name||'', at: new Date().toISOString() };
          tasks[idx][field].push(entry);
          saved.push(entry);
        });
        tasks[idx].updatedAt = new Date().toISOString();
        saveWwpTasks(tasks);
        broadcastWwpTasks('fotos_'+cat+'_created', tasks[idx], { taskId, fotos: saved });
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, fotos: saved}));
      } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
      return;
    }
  }
  // DELETE
  {
    const _m = reqPath.match(/^\/api\/wwp\/tasks\/([a-z0-9_]+)\/fotos-(entrega|vehiculo|recepcion)\/([^/]+)$/);
    if (_m && req.method === 'DELETE') {
      const _jpFcDel = requireJwt(req, res); if (!_jpFcDel) return;
      const taskId = _m[1], cat = _m[2], field = _FOTO_CAT[cat], fname = decodeURIComponent(_m[3]);
      const tasks = loadWwpTasks();
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false})); return; }
      const fe = (tasks[idx][field]||[]).find(f => f.url.endsWith('/'+fname) || f.id === fname);
      if (fe) { try { fs.unlinkSync(path.join(WWP_FOTOS_DIR, path.basename(fe.url))); } catch(e) {} }
      tasks[idx][field] = (tasks[idx][field]||[]).filter(f => !f.url.endsWith('/'+fname) && f.id !== fname);
      tasks[idx].updatedAt = new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('fotos_'+cat+'_deleted', tasks[idx], { taskId, fname });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true}));
      return;
    }
  }

  // ── PATCH /api/wwp/tasks/:id/items/:itemId/entrega — entrega por artículo (despacho) ──
  // Marca entregado/no-entregado, condición de entrega y se apoya en evidence_images existentes.
  if (reqPath.match(/^\/api\/wwp\/tasks\/[a-z0-9_]+\/items\/[A-Za-z0-9_]+\/entrega$/) && req.method === 'PATCH') {
    const _jpEnt = requireJwt(req, res); if (!_jpEnt) return;
    try {
      const parts = reqPath.split('/');
      const taskId = parts[4], itemId = parts[6];
      const d = await readBody(req);
      const tasks = loadWwpTasks();
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Tarea no encontrada'})); return; }
      const itemIdx = (tasks[idx].items||[]).findIndex(it => it.item_id === itemId);
      if (itemIdx === -1) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Artículo no encontrado'})); return; }
      const it = tasks[idx].items[itemIdx];
      // delivered: true/false/null ; deliveryStatus: 'ok'|'damaged'|'not_delivered' ; damageType opcional
      if (d.delivered !== undefined)      it.delivered = d.delivered;
      if (d.deliveryStatus !== undefined) it.deliveryStatus = d.deliveryStatus;
      if (d.damageType !== undefined)     it.deliveryDamageType = d.damageType;
      it.delivery_by = d.by || _jpEnt.name || '';
      it.delivery_at = new Date().toISOString();
      tasks[idx].updatedAt = new Date().toISOString();
      saveWwpTasks(tasks);
      broadcastWwpTasks('item_entrega', tasks[idx], { taskId, itemId });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, item: it}));
    } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
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
