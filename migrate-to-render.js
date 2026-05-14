// Script para migrar datos locales a Render
// Uso: node migrate-to-render.js

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const RENDER_URL = 'https://bitacora-incidencias.onrender.com';
const PIN = '1234';

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(RENDER_URL + urlPath);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

    const req = (url.protocol === 'https:' ? https : http).request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('1. Leyendo base de datos local...');
  const sqlite3 = require('better-sqlite3');
  const dbPath = path.join(__dirname, 'incidencias.db');
  if (!fs.existsSync(dbPath)) {
    console.error('No se encuentra incidencias.db');
    process.exit(1);
  }
  const db = new sqlite3(dbPath);

  const incidencias = db.prepare('SELECT * FROM incidencias ORDER BY id ASC').all();
  const comentarios = db.prepare('SELECT * FROM comentarios ORDER BY id ASC').all();
  const categorias = db.prepare('SELECT * FROM categorias ORDER BY id ASC').all();
  const config = db.prepare('SELECT * FROM config').all();
  db.close();

  console.log(`   ${incidencias.length} incidencias, ${comentarios.length} comentarios, ${categorias.length} categorías`);

  console.log('2. Haciendo login en Render...');
  let res = await request('POST', '/api/login', JSON.stringify({ pin: PIN }));
  if (!res.data || !res.data.ok) {
    console.error('Error de login:', res.data);
    process.exit(1);
  }
  const token = res.data.token;
  console.log('   Login OK');

  console.log('3. Importando datos...');
  res = await request('POST', '/api/import', JSON.stringify({ incidencias, comentarios, categorias, config }), token);
  if (res.status === 200 && res.data.ok) {
    console.log(`   ✅ ${res.data.imported} incidencias importadas correctamente`);
  } else {
    console.error('   Error:', res.data);
    process.exit(1);
  }

  console.log('4. Verificando...');
  res = await request('GET', '/api/stats', null, token);
  if (res.data) {
    console.log(`   Total en Render: ${res.data.total} incidencias`);
  }

  console.log('\n✅ Migración completada');
}

main().catch(console.error);
