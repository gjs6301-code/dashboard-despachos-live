#!/usr/bin/env node
/**
 * stress-test.js — Ops AT · Altritempi
 * ──────────────────────────────────────────────────────────────────────────
 * Stress test completo contra el API de Ops AT.
 * Ejecutar: node stress-test.js
 *
 * Requiere Node 18+ (fetch nativo). Sin dependencias externas.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ══════════════════════════════════════════════════════════════
//  CONFIGURACIÓN — ajusta antes de correr
// ══════════════════════════════════════════════════════════════
const BASE_URL  = 'https://dashboard-despachos-live.onrender.com'; // URL de Render
const EMAIL     = 'gsanchez@altritempi.com.do';  // credenciales reales
const PASSWORD  = process.env.STRESS_PASSWORD || '';  // pasar con: STRESS_PASSWORD=xxx node stress-test.js

// Rampas de concurrencia (usuarios virtuales simultáneos)
const WAVES = [
  { label: 'Calentamiento',  concurrent: 5,   totalReqs: 20  },
  { label: 'Carga media',    concurrent: 20,  totalReqs: 80  },
  { label: 'Carga alta',     concurrent: 50,  totalReqs: 200 },
  { label: 'Pico máximo',    concurrent: 100, totalReqs: 400 },
];

// Pausa entre olas (ms)
const WAVE_PAUSE_MS = 3000;

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
const clr = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m', blue: '\x1b[34m', magenta: '\x1b[35m',
};
const c = (color, text) => `${clr[color]}${text}${clr.reset}`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function p95(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)];
}
function avg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}
function bar(pct, width = 20) {
  const filled = Math.round(pct / 100 * width);
  return c('green', '█'.repeat(filled)) + c('gray', '░'.repeat(width - filled));
}

// ══════════════════════════════════════════════════════════════
//  COLECTOR DE MÉTRICAS
// ══════════════════════════════════════════════════════════════
class Metrics {
  constructor(name) {
    this.name     = name;
    this.latencies = [];
    this.statuses  = {};
    this.errors    = 0;
    this.startedAt = Date.now();
  }
  record(ms, status) {
    this.latencies.push(ms);
    this.statuses[status] = (this.statuses[status] || 0) + 1;
    if (status >= 400) this.errors++;
  }
  recordError() { this.errors++; this.statuses['NET'] = (this.statuses['NET'] || 0) + 1; }

  get total()     { return this.latencies.length + (this.statuses['NET'] || 0); }
  get ok()        { return (this.statuses[200] || 0) + (this.statuses[201] || 0); }
  get ratelimit() { return this.statuses[429] || 0; }
  get errRate()   { return this.total ? (this.errors / this.total * 100).toFixed(1) : '0.0'; }
  get elapsed()   { return ((Date.now() - this.startedAt) / 1000).toFixed(2); }
  get rps()       { return this.elapsed > 0 ? (this.total / this.elapsed).toFixed(1) : '—'; }
  get min()       { return this.latencies.length ? Math.min(...this.latencies) : 0; }
  get avgMs()     { return avg(this.latencies); }
  get max()       { return this.latencies.length ? Math.max(...this.latencies) : 0; }
  get p95Ms()     { return p95(this.latencies); }
}

// ══════════════════════════════════════════════════════════════
//  FUNCIÓN DE REQUEST
// ══════════════════════════════════════════════════════════════
async function request(method, path, token, body) {
  const t0 = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    return { ms: Date.now() - t0, status: res.status, ok: res.ok };
  } catch (e) {
    return { ms: Date.now() - t0, status: 0, ok: false, error: e.message };
  }
}

// ══════════════════════════════════════════════════════════════
//  LOGIN — obtener token una sola vez
// ══════════════════════════════════════════════════════════════
async function doLogin() {
  if (!PASSWORD) {
    console.error(c('red', '\n✗ Falta la contraseña. Ejecuta con: STRESS_PASSWORD=xxx node stress-test.js\n'));
    process.exit(1);
  }
  process.stdout.write('  Autenticando… ');
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/wwp/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!res.ok || !data.accessToken) {
      console.error(c('red', `\n✗ Login fallido: ${data.error || res.status}`));
      process.exit(1);
    }
    console.log(c('green', `✓ OK`) + c('gray', ` (${Date.now() - t0}ms)`));
    return data.accessToken;
  } catch (e) {
    console.error(c('red', `\n✗ Error de red: ${e.message}`));
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════
//  ENDPOINTS A ESTRESAR
// ══════════════════════════════════════════════════════════════
function buildScenarios(token) {
  // Payload de tarea de prueba (se limpia al final)
  const testTask = {
    title:    '[STRESS-TEST] Tarea de prueba — eliminar',
    type:     'general',
    status:   'pending',
    priority: 'low',
  };
  // Payload de inspección de prueba
  const testInsp = {
    vehiculo:  'Prueba stress',
    placa:     'TEST-00',
    conductor: 'Stress Test Bot',
    fecha:     new Date().toISOString().slice(0, 10),
    hora:      '00:00',
    km:        0,
    items:     {},
    apto:      null,
    observacionesGenerales: 'Test automatizado — ignorar',
    firmaConductor: '',
  };

  return [
    { name: 'GET /tasks',      fn: () => request('GET',  '/api/wwp/tasks',               token) },
    { name: 'GET /dashboard',  fn: () => request('GET',  '/api/wwp/dashboard',           token) },
    { name: 'GET /users',      fn: () => request('GET',  '/api/wwp/auth/users',          token) },
    { name: 'GET /inspecciones', fn: () => request('GET','/api/vehiculos/inspecciones',  token) },
    { name: 'POST /tarea',     fn: () => request('POST', '/api/wwp/tasks',               token, testTask) },
    { name: 'POST /inspeccion',fn: () => request('POST', '/api/vehiculos/inspeccion',    token, testInsp) },
  ];
}

// ══════════════════════════════════════════════════════════════
//  EJECUTAR UNA OLA DE CARGA
// ══════════════════════════════════════════════════════════════
async function runWave(scenarios, concurrent, totalReqs) {
  const metrics = {};
  scenarios.forEach(s => { metrics[s.name] = new Metrics(s.name); });

  let completed = 0;
  const queue   = [];

  // Llenar cola con peticiones
  for (let i = 0; i < totalReqs; i++) {
    const s = scenarios[i % scenarios.length];
    queue.push(s);
  }

  // Ejecutar con concurrencia controlada
  async function worker() {
    while (queue.length > 0) {
      const scenario = queue.shift();
      if (!scenario) break;
      const r = await scenario.fn();
      const m = metrics[scenario.name];
      if (r.status === 0) { m.recordError(); }
      else                { m.record(r.ms, r.status); }
      completed++;
    }
  }

  const waveStart = Date.now();
  const workers   = Array.from({ length: concurrent }, worker);
  await Promise.all(workers);
  const elapsed   = Date.now() - waveStart;

  return { metrics, elapsed, total: completed };
}

// ══════════════════════════════════════════════════════════════
//  IMPRIMIR RESULTADOS DE UNA OLA
// ══════════════════════════════════════════════════════════════
function printWaveResults(waveLabel, concurrent, result) {
  const { metrics, elapsed, total } = result;
  const overallRps = (total / (elapsed / 1000)).toFixed(1);

  console.log(`\n  ${c('bold', pad('Endpoint', 22))}  ${c('gray','Min')}   ${c('cyan','Avg')}   ${c('gray','Max')}   ${c('yellow','p95')}   ${c('green','OK')}   ${c('red','Err')}   ${c('magenta','429')}   ${c('gray','req/s')}`);
  console.log('  ' + '─'.repeat(88));

  let allLatencies = [];
  let allOk = 0, allErr = 0, allRL = 0, allTotal = 0;

  Object.values(metrics).forEach(m => {
    if (!m.total) return;
    allLatencies = allLatencies.concat(m.latencies);
    allOk    += m.ok;
    allErr   += m.errors;
    allRL    += m.ratelimit;
    allTotal += m.total;

    const okColor  = m.ok / m.total > 0.9 ? 'green' : m.ok / m.total > 0.5 ? 'yellow' : 'red';
    const errColor = m.errors > 0 ? 'red' : 'gray';
    const rlColor  = m.ratelimit > 0 ? 'magenta' : 'gray';

    console.log(
      `  ${pad(m.name, 22)}` +
      `  ${c('gray', lpad(m.min+'ms', 6))}` +
      `  ${c('cyan', lpad(m.avgMs+'ms', 6))}` +
      `  ${c('gray', lpad(m.max+'ms', 6))}` +
      `  ${c('yellow', lpad(m.p95Ms+'ms', 6))}` +
      `  ${c(okColor,  lpad(m.ok,  5))}` +
      `  ${c(errColor, lpad(m.errors, 5))}` +
      `  ${c(rlColor,  lpad(m.ratelimit, 5))}` +
      `  ${c('gray',   lpad(m.rps, 6))}`
    );
  });

  const errRate = allTotal ? (allErr / allTotal * 100).toFixed(1) : '0.0';
  const rlRate  = allTotal ? (allRL  / allTotal * 100).toFixed(1) : '0.0';
  const okRate  = allTotal ? (allOk  / allTotal * 100).toFixed(1) : '0.0';
  const overallP95 = p95(allLatencies);
  const overallAvg = avg(allLatencies);

  const okColor = parseFloat(okRate) > 90 ? 'green' : parseFloat(okRate) > 70 ? 'yellow' : 'red';

  console.log('  ' + '─'.repeat(88));
  console.log(
    `  ${c('bold', pad('TOTAL', 22))}` +
    `  ${c('gray', lpad(Math.min(...allLatencies)+'ms', 6))}` +
    `  ${c('cyan', lpad(overallAvg+'ms', 6))}` +
    `  ${c('gray', lpad(Math.max(...allLatencies)+'ms', 6))}` +
    `  ${c('yellow', lpad(overallP95+'ms', 6))}` +
    `  ${c(okColor, lpad(allOk, 5))}` +
    `  ${c('red',   lpad(allErr, 5))}` +
    `  ${c('magenta', lpad(allRL, 5))}` +
    `  ${c('gray', lpad(overallRps, 6))}`
  );

  console.log(`\n  ${bar(parseFloat(okRate))} ${c(okColor, okRate + '% OK')}` +
    (allRL  ? `  ${c('magenta', rlRate  + '% rate-limited (429)')}` : '') +
    (allErr && allErr !== allRL ? `  ${c('red', errColor + '% errores')}` : '') +
    `  ${c('gray', `· ${elapsed}ms total · ${overallRps} req/s globales`)}`
  );
}

// ══════════════════════════════════════════════════════════════
//  LIMPIEZA — eliminar tareas e inspecciones de prueba
// ══════════════════════════════════════════════════════════════
async function cleanup(token) {
  process.stdout.write('\n  Limpiando datos de prueba… ');
  try {
    // Obtener tareas y eliminar las de stress test
    const r = await fetch(`${BASE_URL}/api/wwp/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const tasks = await r.json();
      const testTasks = tasks.filter(t => t.title && t.title.startsWith('[STRESS-TEST]'));
      let deleted = 0;
      await Promise.all(testTasks.map(async t => {
        const d = await fetch(`${BASE_URL}/api/wwp/tasks/${t.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (d.ok) deleted++;
      }));
      console.log(c('green', `✓ ${deleted} tarea(s) de prueba eliminada(s)`));
    } else {
      console.log(c('yellow', 'Omitido (no se pudo listar tareas)'));
    }
  } catch (e) {
    console.log(c('yellow', `Omitido: ${e.message}`));
  }
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log('\n' + c('bold', '╔══════════════════════════════════════════════════════╗'));
  console.log(c('bold', '║   OPS AT — STRESS TEST                               ║'));
  console.log(c('bold', '╚══════════════════════════════════════════════════════╝'));
  console.log(`  ${c('gray', 'Target:')}  ${BASE_URL}`);
  console.log(`  ${c('gray', 'Usuario:')} ${EMAIL}`);
  console.log(`  ${c('gray', 'Olas:')}    ${WAVES.length} (${WAVES.map(w => w.concurrent + ' vus').join(' → ')})\n`);

  // 1. Login
  console.log(c('cyan', '▶ Fase 1 — Autenticación'));
  const token = await doLogin();

  // 2. Verificar servidor
  console.log(c('cyan', '\n▶ Fase 2 — Verificación de conectividad'));
  const scenarios = buildScenarios(token);
  let serverOk = true;
  for (const s of scenarios.slice(0, 3)) {
    process.stdout.write(`  ${pad(s.name, 22)} → `);
    const r = await s.fn();
    if (r.status >= 200 && r.status < 400) {
      console.log(c('green', `${r.status} OK`) + c('gray', ` (${r.ms}ms)`));
    } else {
      console.log(c('red', `${r.status || 'NET ERR'} ${r.error || ''}`));
      if (r.status === 401 || r.status === 403) { serverOk = false; break; }
    }
  }
  if (!serverOk) { console.error(c('red', '\n✗ El servidor no responde correctamente. Abortando.')); process.exit(1); }

  // 3. Olas de carga
  console.log(c('cyan', '\n▶ Fase 3 — Olas de carga\n'));
  const summary = [];

  for (let i = 0; i < WAVES.length; i++) {
    const wave = WAVES[i];
    console.log(
      c('bold', `  ┌─ Ola ${i + 1}/${WAVES.length}: ${wave.label} ─`) +
      c('gray',  ` ${wave.concurrent} usuarios simultáneos · ${wave.totalReqs} peticiones`)
    );
    const waveScenarios = buildScenarios(token); // fresh scenarios each wave
    const result = await runWave(waveScenarios, wave.concurrent, wave.totalReqs);
    printWaveResults(wave.label, wave.concurrent, result);

    // Guardar resumen
    const allLat = Object.values(result.metrics).flatMap(m => m.latencies);
    const allTot = Object.values(result.metrics).reduce((s, m) => s + m.total, 0);
    const allOk  = Object.values(result.metrics).reduce((s, m) => s + m.ok, 0);
    const allRL  = Object.values(result.metrics).reduce((s, m) => s + m.ratelimit, 0);
    summary.push({
      label:      wave.label,
      concurrent: wave.concurrent,
      total:      allTot,
      ok:         allOk,
      ratelimit:  allRL,
      okRate:     allTot ? (allOk / allTot * 100).toFixed(1) : '0.0',
      avgMs:      avg(allLat),
      p95Ms:      p95(allLat),
      rps:        (allTot / (result.elapsed / 1000)).toFixed(1),
      elapsedMs:  result.elapsed,
    });

    if (i < WAVES.length - 1) {
      process.stdout.write(c('gray', `\n  Pausa ${WAVE_PAUSE_MS / 1000}s antes de la siguiente ola…`));
      await new Promise(r => setTimeout(r, WAVE_PAUSE_MS));
      process.stdout.write('\r' + ' '.repeat(50) + '\r');
    }
  }

  // 4. Resumen ejecutivo
  console.log('\n\n' + c('bold', '╔══════════════════════════════════════════════════════╗'));
  console.log(c('bold',          '║   RESUMEN EJECUTIVO                                  ║'));
  console.log(c('bold',          '╚══════════════════════════════════════════════════════╝\n'));
  console.log(`  ${c('bold', pad('Ola', 18))}  ${c('gray','VUs')}  ${c('gray','Total')}  ${c('green','OK%')}   ${c('cyan','Avg')}   ${c('yellow','p95')}   ${c('gray','req/s')}  ${c('magenta','429')}`);
  console.log('  ' + '─'.repeat(72));
  summary.forEach(s => {
    const okCol = parseFloat(s.okRate) > 90 ? 'green' : parseFloat(s.okRate) > 70 ? 'yellow' : 'red';
    console.log(
      `  ${pad(s.label, 18)}` +
      `  ${c('gray',    lpad(s.concurrent, 4))}` +
      `  ${c('gray',    lpad(s.total, 5))}` +
      `  ${c(okCol,     lpad(s.okRate+'%', 6))}` +
      `  ${c('cyan',    lpad(s.avgMs+'ms', 7))}` +
      `  ${c('yellow',  lpad(s.p95Ms+'ms', 7))}` +
      `  ${c('gray',    lpad(s.rps, 6))}` +
      `  ${c('magenta', lpad(s.ratelimit, 4))}`
    );
  });

  // Diagnóstico automático
  console.log('\n' + c('bold', '  Diagnóstico:'));
  const last = summary[summary.length - 1];
  const first = summary[0];
  const latDeg = last.avgMs / (first.avgMs || 1);
  if (parseFloat(last.okRate) >= 95)
    console.log(c('green', '  ✓ El servidor mantuvo >95% de éxito en el pico máximo'));
  else if (parseFloat(last.okRate) >= 80)
    console.log(c('yellow', '  ⚠ Degradación bajo carga máxima — tasa de éxito entre 80-95%'));
  else
    console.log(c('red', '  ✗ Alta tasa de fallos bajo carga — se necesita optimización'));

  if (last.ratelimit > 0)
    console.log(c('magenta', `  ⚠ Rate limiter activado: ${last.ratelimit} peticiones bloqueadas (429) en el pico`));

  if (latDeg > 3)
    console.log(c('red', `  ✗ Latencia aumentó ${latDeg.toFixed(1)}x bajo carga (${first.avgMs}ms → ${last.avgMs}ms)`));
  else if (latDeg > 1.5)
    console.log(c('yellow', `  ⚠ Latencia aumentó ${latDeg.toFixed(1)}x bajo carga (${first.avgMs}ms → ${last.avgMs}ms)`));
  else
    console.log(c('green', `  ✓ Latencia estable bajo carga (${first.avgMs}ms → ${last.avgMs}ms)`));

  if (parseFloat(last.rps) > 20)
    console.log(c('green', `  ✓ Throughput sostenido: ${last.rps} req/s en el pico`));

  // 5. Limpieza
  await cleanup(token);

  console.log('\n' + c('gray', '  Stress test completado.\n'));
}

main().catch(e => { console.error(c('red', '\n✗ Error fatal: ' + e.message)); process.exit(1); });
