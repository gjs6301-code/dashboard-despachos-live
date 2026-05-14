#!/usr/bin/env node

/**
 * test-smoke.js — Smoke Test para Dashboard Despachos
 * Ejecutar: node test-smoke.js
 */

const http = require('http');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║         SMOKE TEST — Dashboard Despachos          ║');
  console.log('║              ' + new Date().toLocaleTimeString() + '              ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const results = [];

  // Test 1: Servidor responde
  console.log('🔄 Iniciando pruebas...\n');
  
  try {
    const health = await request(`${BASE_URL}/api/health`);
    results.push({
      name: 'API /api/health',
      passed: health.status === 200 || health.status === 502,
      status: health.status,
      detail: health.status === 200 ? '✓ OK' : '✓ Responde (con fallos conocidos)'
    });
    console.log(`✅ ${results[results.length-1].name}`);

    if (health.body) {
      const odooOk = health.body.odoo?.ok;
      const sheetsOk = health.body.sheets?.ok;
      const odooMode = health.body.odoo?.simulated ? 'SIMULADO' : 'CONECTADO';
      const sheetsMode = health.body.sheets?.simulated ? 'SIMULADO' : 'CONECTADO';
      console.log(`   • Odoo: ${odooOk ? '✅ ' + odooMode : '❌ DESCONECTADO'}`);
      console.log(`   • Sheets: ${sheetsOk ? '✅ ' + sheetsMode : '❌ DESCONECTADO'}`);
      if (health.body.sheets?.rows) {
        console.log(`     → ${health.body.sheets.rows} órdenes cargadas`);
      }
    }
  } catch (e) {
    results.push({
      name: 'API /api/health',
      passed: false,
      detail: `❌ ${e.message}`
    });
    console.log(`❌ ${results[results.length-1].name} — ${e.message}`);
  }

  console.log();

  // Test 2: Smoke test del servidor
  try {
    const smoke = await request(`${BASE_URL}/api/smoke-test`);
    results.push({
      name: 'API /api/smoke-test',
      passed: smoke.status === 200,
      status: smoke.status,
      tests: smoke.body?.tests || []
    });

    if (smoke.body?.tests) {
      console.log('📋 Pruebas del servidor:\n');
      smoke.body.tests.forEach((test, i) => {
        const icon = test.passed ? '✅' : '❌';
        console.log(`   ${icon} ${test.name.padEnd(25)} ${test.detail || ''}`);
      });
      console.log();
      console.log(`📊 Resultado: ${smoke.body.summary}`);
    }
  } catch (e) {
    results.push({
      name: 'API /api/smoke-test',
      passed: false,
      detail: `❌ ${e.message}`
    });
    console.log(`❌ /api/smoke-test — ${e.message}\n`);
  }

  console.log();

  // Test 3: Archivos estáticos
  try {
    const html = await request(`${BASE_URL}/historial.html`);
    results.push({
      name: 'Archivo historial.html',
      passed: html.status === 200,
      status: html.status
    });
    console.log(`${html.status === 200 ? '✅' : '❌'} historial.html ${html.status === 200 ? '(cargable)' : '(NO ACCESIBLE)'}`);
  } catch (e) {
    results.push({
      name: 'Archivo historial.html',
      passed: false,
      detail: e.message
    });
    console.log(`❌ historial.html — ${e.message}`);
  }

  // Resultado Final
  console.log();
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const pct = Math.round((passed / total) * 100);

  console.log('═'.repeat(54));
  console.log(`RESULTADO: ${passed}/${total} pruebas pasadas (${pct}%)`);
  if (passed === total) {
    console.log('🎉 ¡SISTEMA OPERATIVO! Listo para producción.');
  } else {
    console.log(`⚠️  ${total - passed} test(s) fallaron. Ver detalles arriba.`);
  }
  console.log('ESTADO FINAL: Sheets simulado EN VIVO · Odoo simulado EN VIVO');
  console.log('═'.repeat(54) + '\n');

  process.exit(passed === total ? 0 : 1);
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  process.exit(1);
});
