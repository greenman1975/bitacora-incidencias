const express = require('express');
const sqlite3 = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const qr = require('qrcode');
const nodemailer = require('nodemailer');
const app = express();
const PORT = 3000;

// Security
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'");
  next();
});

// Rate limiter (in-memory)
const rateLimitStore = {};
setInterval(() => {
  const now = Date.now();
  for (const key in rateLimitStore) {
    if (now - rateLimitStore[key].reset > 60000) delete rateLimitStore[key];
  }
}, 30000);

function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = req.path + ':' + ip;
    const now = Date.now();
    if (!rateLimitStore[key] || now - rateLimitStore[key].reset > windowMs) {
      rateLimitStore[key] = { count: 1, reset: now + windowMs };
      return next();
    }
    rateLimitStore[key].count++;
    if (rateLimitStore[key].count > max) {
      return res.status(429).json({ error: 'Demasiadas solicitudes. Intente más tarde.' });
    }
    next();
  };
}

// Brute force protection
const loginAttempts = {};
setInterval(() => {
  const now = Date.now();
  for (const ip in loginAttempts) {
    if (now - loginAttempts[ip].lockUntil > 0) delete loginAttempts[ip];
  }
}, 60000);

function checkBruteForce(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  if (loginAttempts[ip] && now < loginAttempts[ip].lockUntil) {
    const remaining = Math.ceil((loginAttempts[ip].lockUntil - now) / 1000);
    return res.status(429).json({ error: `Demasiados intentos. Espere ${remaining}s.` });
  }
  next();
}

function recordFailedAttempt(ip) {
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, lockUntil: 0 };
  loginAttempts[ip].count++;
  if (loginAttempts[ip].count >= 5) {
    loginAttempts[ip].lockUntil = Date.now() + 15 * 60 * 1000;
    loginAttempts[ip].count = 0;
  }
}

// Input sanitization helper
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>&"']/g, function(m) {
    return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[m];
  });
}

const DISCOVERY_PORT = 45678;
function getLanIp() {
  const ifaces = os.networkInterfaces();
  let ip = '127.0.0.1';
  Object.keys(ifaces).forEach(ifname => {
    ifaces[ifname].forEach(iface => {
      if (iface.family === 'IPv4' && !iface.internal) ip = iface.address;
    });
  });
  return ip;
}
const udpServer = dgram.createSocket('udp4');
udpServer.on('message', (msg, rinfo) => {
  if (msg.toString().trim() === 'BITACORA_DISCOVER') {
    const response = JSON.stringify({ ip: getLanIp(), port: PORT });
    udpServer.send(response, rinfo.port, rinfo.address, () => {});
  }
});
udpServer.bind(DISCOVERY_PORT, () => {
  udpServer.setBroadcast(true);
  console.log(`Discovery UDP en puerto ${DISCOVERY_PORT}`);
});

app.use(express.json({ limit: '50mb' }));

const BACKUP_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
app.get('/', (req, res) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (/mobile|android|iphone|ipad|phone|tablet|webos|blackberry|iemobile|opera mini/i.test(ua)) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  }
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

const db = new sqlite3(path.join(__dirname, 'incidencias.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS incidencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alumno TEXT NOT NULL,
    grupo TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    gravedad TEXT NOT NULL DEFAULT 'Baja',
    categoria TEXT NOT NULL DEFAULT 'Conducta',
    maestro TEXT NOT NULL DEFAULT '',
    foto TEXT DEFAULT '',
    fecha TEXT NOT NULL DEFAULT (datetime('now','-3 hours')),
    resuelta INTEGER NOT NULL DEFAULT 0,
    ubicacion TEXT DEFAULT '',
    personas_involucradas TEXT DEFAULT '',
    acciones_realizadas TEXT DEFAULT '',
    seguimiento TEXT DEFAULT '',
    firma_digital TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS comentarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incidencia_id INTEGER NOT NULL,
    autor TEXT NOT NULL DEFAULT 'Subdirector',
    texto TEXT NOT NULL,
    fecha TEXT NOT NULL DEFAULT (datetime('now','-3 hours')),
    FOREIGN KEY (incidencia_id) REFERENCES incidencias(id)
  );
  CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE
  );
`);
try { db.exec("INSERT OR IGNORE INTO categorias (nombre) VALUES ('Conducta'),('Académico'),('Asistencia'),('Material'),('Salud'),('Otro')"); } catch(e) {}
try { db.exec("ALTER TABLE incidencias ADD COLUMN categoria TEXT NOT NULL DEFAULT 'Conducta'"); } catch(e) {}
try { db.exec("ALTER TABLE incidencias ADD COLUMN maestro TEXT NOT NULL DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE incidencias ADD COLUMN foto TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE incidencias ADD COLUMN ubicacion TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE incidencias ADD COLUMN personas_involucradas TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE incidencias ADD COLUMN acciones_realizadas TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE incidencias ADD COLUMN seguimiento TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE incidencias ADD COLUMN firma_digital TEXT DEFAULT ''"); } catch(e) {}
try { db.exec(`
  CREATE TABLE IF NOT EXISTS actividad_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    accion TEXT NOT NULL,
    detalle TEXT DEFAULT '',
    usuario TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    fecha TEXT NOT NULL DEFAULT (datetime('now','-3 hours'))
  )
`); } catch(e) {}

function logActividad(accion, detalle = '', usuario = '', ip = '') {
  try {
    db.prepare('INSERT INTO actividad_log (accion, detalle, usuario, ip) VALUES (?,?,?,?)')
      .run(accion, detalle, usuario, ip);
  } catch(e) {}
}

const getPin = () => db.prepare("SELECT value FROM config WHERE key='pin'").pluck().get() || '1234';
const setPin = (pin) => db.prepare("INSERT OR REPLACE INTO config (key,value) VALUES (?,?)").run('pin', pin);

// Session-based auth
const sessions = {};
const SESSION_EXPIRY = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const t in sessions) {
    if (now - sessions[t] > SESSION_EXPIRY) delete sessions[t];
  }
}, 3600000);

app.post('/api/login', rateLimit(10, 60000), checkBruteForce, (req, res) => {
  const { username, password, pin } = req.body;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  let ok = false;

  // Try username+password first
  if (username && password) {
    const storedUser = db.prepare("SELECT value FROM config WHERE key='login_username'").pluck().get();
    const storedHash = db.prepare("SELECT value FROM config WHERE key='login_hash'").pluck().get();
    if (storedUser && storedHash) {
      const [salt, hash] = storedHash.split(':');
      if (username === storedUser) {
        const check = crypto.scryptSync(password, salt, 64).toString('hex');
        if (check === hash) ok = true;
      }
    }
  }

  // Fallback to PIN
  if (!ok && pin && pin === getPin()) ok = true;

  if (!ok) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  delete loginAttempts[ip];
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = Date.now();
  logActividad('login', username ? 'Usuario: ' + username : 'PIN', '', ip);
  res.json({ ok: true, token });
});

app.get('/api/login/config', (req, res) => {
  const storedUser = db.prepare("SELECT value FROM config WHERE key='login_username'").pluck().get();
  res.json({ hasCredentials: !!storedUser, username: storedUser || null });
});

app.post('/api/set-credentials', requireSession, requireAuth, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.status(400).json({ error: 'Usuario mínimo 3 caracteres, contraseña mínimo 4' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('login_username',?)").run(username);
    db.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('login_hash',?)").run(salt + ':' + hash);
  })();
  logActividad('credenciales', 'Usuario cambiado a: ' + username);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const auth = req.headers['authorization'];
  if (auth) delete sessions[auth.replace('Bearer ', '')];
  res.json({ ok: true });
});

app.get('/api/verify', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth ? auth.replace('Bearer ', '') : '';
  res.json({ ok: !!token && !!sessions[token] });
});

function requireSession(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth ? auth.replace('Bearer ', '') : req.query.token;
  if (!token || !sessions[token]) return res.status(401).json({ error: 'Acceso denegado' });
  sessions[token] = Date.now();
  next();
}

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

const clients = [];
function broadcast(data) {
  clients.forEach(c => { try { c.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} });
}

app.get('/api/server-info', (req, res) => {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  let ip = 'localhost';
  Object.keys(ifaces).forEach(ifname => {
    ifaces[ifname].forEach(iface => {
      if (iface.family === 'IPv4' && !iface.internal) ip = iface.address;
    });
  });
  res.json({ ip, port: PORT });
});

app.get('/api/qr', (req, res) => {
  const ip = getLanIp();
  const url = `http://${ip}:${PORT}`;
  qr.toDataURL(url, { width: 300, margin: 1, color: { dark: '#00D4FF', light: '#08080E' } }, (err, dataUrl) => {
    if (err) return res.status(500).json({ error: 'QR error' });
    res.json({ url, qr: dataUrl });
  });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  clients.push(res);
  req.on('close', () => { const i = clients.indexOf(res); if (i >= 0) clients.splice(i, 1); });
});
setInterval(() => {
  clients.forEach(c => { try { c.write(':keepalive\n\n'); } catch(e) {} });
}, 10000);

const onlineMaestros = {};
function limpiarOffline() {
  const ahora = Date.now();
  for (const m in onlineMaestros) {
    if (ahora - onlineMaestros[m] > 30000) delete onlineMaestros[m];
  }
}
setInterval(limpiarOffline, 10000);

function autoBackup() {
  try {
    const interval = parseInt(db.prepare("SELECT value FROM config WHERE key='backup_interval'").pluck().get()) || 0;
    if (interval <= 0) return;
    const last = db.prepare("SELECT value FROM config WHERE key='backup_last'").pluck().get();
    const lastTime = last ? parseInt(last) : 0;
    if (Date.now() - lastTime < interval * 3600000) return;
    const name = `incidencias-backup-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.db`;
    fs.copyFileSync(path.join(__dirname, 'incidencias.db'), path.join(BACKUP_DIR, name));
    db.prepare("INSERT OR REPLACE INTO config (key,value) VALUES (?,?)").run('backup_last', String(Date.now()));
    broadcast({ type: 'backup', name });
  } catch(e) { console.error('Backup error:', e); }
}
setInterval(autoBackup, 3600000);

function checkReminders() {
  try {
    const days = parseInt(db.prepare("SELECT value FROM config WHERE key='reminder_days'").pluck().get()) || 2;
    const rows = db.prepare("SELECT id, alumno, descripcion, fecha FROM incidencias WHERE resuelta=0 AND datetime(fecha) < datetime('now','-'+?||' hours','-3 hours')").all(days * 24);
    if (rows.length > 0) {
      broadcast({ type: 'recordatorios', data: rows });
    }
  } catch(e) {}
}
setInterval(checkReminders, 1800000);
checkReminders();

async function sendDailyReport() {
  try {
    const config = {};
    const rows = db.prepare("SELECT * FROM config WHERE key LIKE 'smtp_%' OR key = 'report_email'").all();
    rows.forEach(r => { config[r.key] = r.value; });
    
    if (!config.report_email || !config.smtp_host) return;

    const stats = db.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM incidencias WHERE date(fecha) = date('now', '-3 hours')) as hoy,
        (SELECT COUNT(*) FROM incidencias WHERE resuelta=0) as pendientes
    `).get();

    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: parseInt(config.smtp_port) || 587,
      secure: config.smtp_secure === 'true',
      auth: { user: config.smtp_user, pass: config.smtp_pass }
    });

    const now = new Date().toLocaleDateString('es-MX');
    await transporter.sendMail({
      from: `"Bitácora de Incidencias" <${config.smtp_user}>`,
      to: config.report_email,
      subject: `Resumen Diario - ${now}`,
      html: `
        <div style="font-family:sans-serif; max-width:600px; margin:0 auto; padding:20px; border:1px solid #eee; border-radius:10px;">
          <h2 style="color:#2563eb;">Resumen de la Bitácora</h2>
          <p>Hoy se registraron <strong>${stats.hoy}</strong> nuevas incidencias.</p>
          <p>Hay un total de <strong>${stats.pendientes}</strong> incidencias pendientes por resolver.</p>
          <hr style="border:0; border-top:1px solid #eee; margin:20px 0;">
          <p style="font-size:12px; color:#666;">Reporte generado automáticamente por el sistema.</p>
        </div>
      `
    });
    console.log('Reporte diario enviado con éxito.');
  } catch(e) { console.error('Error al enviar reporte diario:', e); }
}

// Tarea diaria a las 19:00 (7 PM)
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 19 && now.getMinutes() === 0) {
    sendDailyReport();
  }
}, 60000);



app.post('/api/heartbeat', (req, res) => {
  const { maestro } = req.body;
  if (maestro && maestro.trim()) {
    onlineMaestros[maestro.trim()] = Date.now();
    broadcast({ type: 'heartbeat', maestro: maestro.trim() });
  }
  res.json({ ok: true });
});

app.get('/api/online', requireSession, (req, res) => {
  const ahora = Date.now();
  const enLinea = Object.entries(onlineMaestros)
    .filter(([_, t]) => ahora - t < 20000)
    .map(([m]) => m);
  res.json(enLinea);
});

function requireAuth(req, res, next) {
  const pin = req.headers['x-auth-pin'];
  if (!pin || pin !== getPin()) return res.status(401).json({ error: 'PIN incorrecto' });
  next();
}

app.post('/api/auth', (req, res) => {
  const { pin } = req.body;
  res.json({ ok: pin === getPin() });
});

app.post('/api/pin', requireSession, requireAuth, (req, res) => {
  const { oldPin, newPin } = req.body;
  if (oldPin !== getPin()) return res.status(400).json({ error: 'PIN actual incorrecto' });
  if (!newPin || newPin.length < 4) return res.status(400).json({ error: 'Mínimo 4 dígitos' });
  setPin(newPin);
  res.json({ ok: true });
});

app.post('/api/incidencias', rateLimit(30, 60000), (req, res) => {
  let { alumno, grupo, descripcion, gravedad, categoria, maestro, foto, ubicacion, personas_involucradas, acciones_realizadas, seguimiento, firma_digital } = req.body;
  alumno = (sanitize(alumno) || '').trim();
  grupo = (sanitize(grupo) || '').trim();
  descripcion = (sanitize(descripcion) || '').trim();
  maestro = (sanitize(maestro) || '').trim();
  categoria = (sanitize(categoria) || 'Conducta').trim();
  gravedad = (sanitize(gravedad) || 'Baja').trim();
  ubicacion = (sanitize(ubicacion) || '').trim();
  personas_involucradas = (sanitize(personas_involucradas) || '').trim();
  acciones_realizadas = (sanitize(acciones_realizadas) || '').trim();
  seguimiento = (sanitize(seguimiento) || '').trim();
  firma_digital = (sanitize(firma_digital) || '').trim();
  const VALID_GRAVEDAD = ['Baja', 'Media', 'Alta'];
  if (!alumno || !grupo || !descripcion) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }
  if (!VALID_GRAVEDAD.includes(gravedad)) gravedad = 'Baja';
  const stmt = db.prepare('INSERT INTO incidencias (alumno,grupo,descripcion,gravedad,categoria,maestro,foto,ubicacion,personas_involucradas,acciones_realizadas,seguimiento,firma_digital) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const result = stmt.run(alumno, grupo, descripcion, gravedad, categoria, maestro, foto || '', ubicacion, personas_involucradas, acciones_realizadas, seguimiento, firma_digital);
  const row = db.prepare('SELECT * FROM incidencias WHERE id = ?').get(result.lastInsertRowid);
  broadcast({ type: 'nueva', data: row });
  res.json(row);
});

app.get('/api/incidencias', requireSession, (req, res) => {
  let sql = 'SELECT * FROM incidencias WHERE 1=1';
  const params = [];
  if (req.query.maestro) { sql += ' AND maestro LIKE ?'; params.push(`%${req.query.maestro}%`); }
  if (req.query.grupo) { sql += ' AND grupo LIKE ?'; params.push(`%${req.query.grupo}%`); }
  if (req.query.alumno) { sql += ' AND alumno LIKE ?'; params.push(`%${req.query.alumno}%`); }
  if (req.query.categoria) { sql += ' AND categoria = ?'; params.push(req.query.categoria); }
  if (req.query.gravedad) { sql += ' AND gravedad = ?'; params.push(req.query.gravedad); }
  if (req.query.resuelta !== undefined) { sql += ' AND resuelta = ?'; params.push(req.query.resuelta ? 1 : 0); }
  sql += ' ORDER BY fecha DESC';
  if (req.query.limit) { sql += ' LIMIT ?'; params.push(parseInt(req.query.limit)); }
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

app.put('/api/incidencias/:id', requireSession, requireAuth, (req, res) => {
  const { alumno, grupo, descripcion, gravedad, categoria, resuelta, ubicacion, personas_involucradas, acciones_realizadas, seguimiento, firma_digital } = req.body;
  db.prepare('UPDATE incidencias SET alumno=?, grupo=?, descripcion=?, gravedad=?, categoria=?, resuelta=?, ubicacion=?, personas_involucradas=?, acciones_realizadas=?, seguimiento=?, firma_digital=? WHERE id=?')
    .run(alumno, grupo, descripcion, gravedad, categoria, resuelta ? 1 : 0, ubicacion || '', personas_involucradas || '', acciones_realizadas || '', seguimiento || '', firma_digital || '', req.params.id);
  const row = db.prepare('SELECT * FROM incidencias WHERE id = ?').get(req.params.id);
  broadcast({ type: 'editada', data: row });
  logActividad('editar', 'Incidencia #' + req.params.id + ': ' + (row?.alumno || ''));
  res.json(row);
});

app.patch('/api/incidencias/:id', requireSession, (req, res) => {
  const { resuelta } = req.body;
  db.prepare('UPDATE incidencias SET resuelta = ? WHERE id = ?').run(resuelta ? 1 : 0, req.params.id);
  broadcast({ type: 'resuelta', id: parseInt(req.params.id), resuelta: !!resuelta });
  logActividad(resuelta ? 'resolver' : 'reabrir', 'Incidencia #' + req.params.id);
  res.json({ ok: true });
});

app.delete('/api/incidencias/:id', requireSession, requireAuth, (req, res) => {
  const old = db.prepare('SELECT alumno FROM incidencias WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM comentarios WHERE incidencia_id = ?').run(req.params.id);
  db.prepare('DELETE FROM incidencias WHERE id = ?').run(req.params.id);
  broadcast({ type: 'eliminada', id: parseInt(req.params.id) });
  logActividad('eliminar', 'Incidencia #' + req.params.id + ': ' + (old?.alumno || ''));
  res.json({ ok: true });
});

app.get('/api/stats', requireSession, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM incidencias').get().c;
  const pendientes = db.prepare('SELECT COUNT(*) as c FROM incidencias WHERE resuelta=0').get().c;
  const resueltas = db.prepare('SELECT COUNT(*) as c FROM incidencias WHERE resuelta=1').get().c;
  const porGravedad = db.prepare('SELECT gravedad, COUNT(*) as c FROM incidencias GROUP BY gravedad').all();
  const porCategoria = db.prepare('SELECT categoria, COUNT(*) as c FROM incidencias GROUP BY categoria').all();
  const porGrupo = db.prepare('SELECT grupo, COUNT(*) as c FROM incidencias GROUP BY grupo ORDER BY c DESC LIMIT 5').all();
  const porMaestro = db.prepare('SELECT maestro, COUNT(*) as c FROM incidencias GROUP BY maestro ORDER BY c DESC LIMIT 5').all();
  const ultimas = db.prepare('SELECT * FROM incidencias ORDER BY fecha DESC LIMIT 5').all();
  res.json({ total, pendientes, resueltas, porGravedad, porCategoria, porGrupo, porMaestro, ultimas });
});

app.get('/api/stats/weekly', requireSession, (req, res) => {
  const monday = (d) => {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    date.setDate(diff);
    date.setHours(0,0,0,0);
    return date.toISOString().slice(0,19).replace('T', ' ');
  };
  const thisMon = monday(new Date());
  const lastMon = new Date(thisMon);
  lastMon.setDate(lastMon.getDate() - 7);
  const lastMonStr = lastMon.toISOString().slice(0,19).replace('T', ' ');
  const nextMon = new Date(thisMon);
  nextMon.setDate(nextMon.getDate() + 7);
  const nextMonStr = nextMon.toISOString().slice(0,19).replace('T', ' ');
  const thisWeek = db.prepare("SELECT COUNT(*) as c FROM incidencias WHERE fecha >= ? AND fecha < ?").get(thisMon, nextMonStr).c;
  const lastWeek = db.prepare("SELECT COUNT(*) as c FROM incidencias WHERE fecha >= ? AND fecha < ?").get(lastMonStr, thisMon).c;
  const byDay = db.prepare("SELECT strftime('%w',fecha) as d, COUNT(*) as c FROM incidencias WHERE fecha >= ? AND fecha < ? GROUP BY d ORDER BY d").all(thisMon, nextMonStr);
  const trend = thisWeek > lastWeek ? 'up' : thisWeek < lastWeek ? 'down' : 'same';
  res.json({ thisWeek, lastWeek, trend, byDay });
});

app.get('/api/backup/config', requireSession, (req, res) => {
  const interval = parseInt(db.prepare("SELECT value FROM config WHERE key='backup_interval'").pluck().get()) || 0;
  const last = db.prepare("SELECT value FROM config WHERE key='backup_last'").pluck().get();
  res.json({ interval, last: last ? parseInt(last) : 0 });
});

app.put('/api/backup/config', requireSession, requireAuth, (req, res) => {
  const { interval } = req.body;
  db.prepare("INSERT OR REPLACE INTO config (key,value) VALUES (?,?)").run('backup_interval', String(interval || 0));
  res.json({ ok: true });
});

app.post('/api/backup/now', requireSession, (req, res) => {
  try {
    const name = `incidencias-backup-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.db`;
    fs.copyFileSync(path.join(__dirname, 'incidencias.db'), path.join(BACKUP_DIR, name));
    db.prepare("INSERT OR REPLACE INTO config (key,value) VALUES (?,?)").run('backup_last', String(Date.now()));
    broadcast({ type: 'backup', name });
    res.json({ ok: true, name });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/backup/list', requireSession, (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
    res.json(files);
  } catch(e) { res.json([]); }
});

app.get('/api/backup', requireSession, (req, res) => {
  const dbPath = path.join(__dirname, 'incidencias.db');
  res.download(dbPath, `bitacora-backup-${new Date().toISOString().slice(0,10)}.db`);
});

app.get('/api/export/csv', requireSession, (req, res) => {
  const rows = db.prepare('SELECT * FROM incidencias ORDER BY fecha DESC').all();
  const header = 'id,alumno,grupo,descripcion,gravedad,categoria,maestro,ubicacion,personas,acciones,seguimiento,firma,fecha,resuelta\n';
  const csv = header + rows.map(r =>
    `${r.id},"${r.alumno}","${r.grupo}","${(r.descripcion||'').replace(/"/g,'""')}","${r.gravedad}","${r.categoria}","${r.maestro}","${r.ubicacion||''}","${(r.personas_involucradas||'').replace(/"/g,'""')}","${(r.acciones_realizadas||'').replace(/"/g,'""')}","${(r.seguimiento||'').replace(/"/g,'""')}","${r.firma_digital||''}","${r.fecha}",${r.resuelta}`
  ).join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline');
  res.send(csv);
});

app.get('/api/export/html', requireSession, (req, res) => {
  const rows = db.prepare('SELECT * FROM incidencias ORDER BY fecha DESC').all();
  const total = rows.length;
  const pendientes = rows.filter(r => !r.resuelta).length;
  const resueltas = rows.filter(r => r.resuelta).length;
  const rowsHtml = rows.map(r => {
    const badge = r.resuelta ? 'resuelta' : 'pendiente';
    const badgeColor = r.resuelta ? '#10b981' : '#f59e0b';
    const gravedadColor = r.gravedad === 'Alta' ? '#ef4444' : r.gravedad === 'Media' ? '#f97316' : '#22c55e';
    return `<tr${r.resuelta ? ' class="resuelta"' : ''}>
      <td>${r.fecha?.slice(0,10) || ''}</td>
      <td>${r.maestro || '—'}</td>
      <td><strong>${r.alumno}</strong> <span class="grupo">${r.grupo}</span></td>
      <td>${r.categoria}</td>
      <td><span class="gravedad" style="color:${gravedadColor}">●</span> ${r.gravedad}</td>
      <td>${r.descripcion}</td>
      <td>${r.ubicacion || '—'}</td>
      <td><span class="badge" style="background:${badgeColor}">${badge}</span></td>
    </tr>`;
  }).join('');
  const now = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day:'2-digit', month:'long', year:'numeric' });
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Reporte Ejecutivo - Bitácora de Incidencias</title>
<style>
  @page { margin: 2cm 1.5cm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif; font-size: 10pt; color: #1e293b; background: #f8fafc; }
  .page { max-width: 1100px; margin: 0 auto; background: #fff; min-height: 100vh; padding: 2rem 2.5rem; box-shadow: 0 4px 24px rgba(0,0,0,.06); }
  .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; padding-bottom: 1.2rem; border-bottom: 2px solid #e2e8f0; }
  .brand { display: flex; align-items: center; gap: 1rem; }
  .brand-icon { width: 44px; height: 44px; background: linear-gradient(135deg, #2563eb, #1d4ed8); border-radius: 12px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 18pt; font-weight: 700; box-shadow: 0 4px 12px rgba(37,99,235,.3); }
  .brand-text h1 { font-size: 16pt; font-weight: 700; color: #0f172a; letter-spacing: -.02em; }
  .brand-text .sub { font-size: 8pt; color: #64748b; margin-top: 2px; }
  .meta { text-align: right; font-size: 8pt; color: #64748b; line-height: 1.6; }
  .meta strong { color: #1e293b; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 1.8rem; }
  .card { padding: 1.2rem; border-radius: 12px; color: #fff; text-align: center; }
  .card.total { background: linear-gradient(135deg, #2563eb, #1d4ed8); }
  .card.pendientes { background: linear-gradient(135deg, #f59e0b, #d97706); }
  .card.resueltas { background: linear-gradient(135deg, #10b981, #059669); }
  .card .num { font-size: 26pt; font-weight: 800; letter-spacing: -.03em; }
  .card .label { font-size: 8pt; text-transform: uppercase; letter-spacing: .1em; opacity: .85; margin-top: 4px; }
  .section-title { font-size: 10pt; font-weight: 700; color: #0f172a; margin-bottom: .8rem; display: flex; align-items: center; gap: .5rem; }
  .section-title::after { content: ''; flex: 1; height: 1px; background: #e2e8f0; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  thead th { background: #f1f5f9; color: #475569; padding: 10px 8px; text-align: left; font-weight: 600; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .06em; border-bottom: 2px solid #e2e8f0; }
  tbody td { padding: 10px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
  tbody tr:hover { background: #f8fafc; }
  tbody tr.resuelta { opacity: .55; }
  tbody tr.resuelta td { text-decoration: line-through; }
  .grupo { font-size: 7.5pt; color: #94a3b8; margin-left: 4px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 20px; color: #fff; font-size: 7pt; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .gravedad { font-weight: 600; }
  .footer { margin-top: 1.5rem; padding-top: 1rem; border-top: 2px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 7.5pt; color: #94a3b8; }
  .no-print { text-align: center; margin-top: 1.5rem; display: flex; gap: 10px; justify-content: center; }
  .no-print button { padding: 10px 28px; border: none; border-radius: 8px; font-size: 10pt; cursor: pointer; font-weight: 500; transition: all .15s; }
  .btn-print { background: #2563eb; color: #fff; }
  .btn-print:hover { background: #1d4ed8; }
  .btn-back { background: #f1f5f9; color: #475569; }
  .btn-back:hover { background: #e2e8f0; }
  @media print {
    body { background: #fff; }
    .page { box-shadow: none; padding: 0; max-width: 100%; }
    .no-print { display: none !important; }
    tbody tr.resuelta { opacity: .35; }
    .cards { break-inside: avoid; }
    table { break-inside: auto; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
  }
</style>
</head>
<body>
  <div class="page">
    <div class="top-bar">
      <div class="brand">
        <div class="brand-icon">B</div>
        <div class="brand-text">
          <h1>Bitácora de Incidencias</h1>
          <div class="sub">Reporte Ejecutivo — Sistema de Gestión Escolar</div>
        </div>
      </div>
      <div class="meta">
        <strong>${now}</strong><br>
        <span>${total} incidencias registradas</span>
      </div>
    </div>

    <div class="cards">
      <div class="card total">
        <div class="num">${total}</div>
        <div class="label">Total</div>
      </div>
      <div class="card pendientes">
        <div class="num">${pendientes}</div>
        <div class="label">Pendientes</div>
      </div>
      <div class="card resueltas">
        <div class="num">${resueltas}</div>
        <div class="label">Resueltas</div>
      </div>
    </div>

    <div class="section-title">Detalle de Incidencias</div>
    <table>
      <thead><tr>
        <th>Fecha</th><th>Docente</th><th>Alumno</th><th>Categoría</th><th>Alerta</th><th>Descripción</th><th>Ubicación</th><th>Estado</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <div class="footer">
      <span>Bitácora de Incidencias — Reporte generado automáticamente</span>
      <span>Página 1</span>
    </div>

    <div class="no-print">
      <button class="btn-print" onclick="window.print()">📄 Guardar como PDF</button>
      <button class="btn-back" onclick="window.history.back()">← Volver</button>
    </div>
  </div>
</body>
</html>`);
});

app.get('/api/categorias', (req, res) => {
  const rows = db.prepare('SELECT * FROM categorias ORDER BY nombre ASC').all();
  res.json(rows);
});

app.post('/api/categorias', requireSession, requireAuth, (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const result = db.prepare('INSERT INTO categorias (nombre) VALUES (?)').run(nombre.trim());
    res.json({ id: result.lastInsertRowid, nombre: nombre.trim() });
  } catch(e) {
    res.status(400).json({ error: 'Ya existe esa categoría' });
  }
});

app.delete('/api/categorias/:id', requireSession, requireAuth, (req, res) => {
  const cat = db.prepare('SELECT nombre FROM categorias WHERE id=?').get(req.params.id);
  if (!cat) return res.status(404).json({ error: 'No existe' });
  db.prepare('DELETE FROM categorias WHERE id=?').run(req.params.id);
  broadcast({ type: 'categoria_eliminada', nombre: cat.nombre });
  res.json({ ok: true });
});

app.get('/api/reminder/config', requireSession, (req, res) => {
  const days = parseInt(db.prepare("SELECT value FROM config WHERE key='reminder_days'").pluck().get()) || 2;
  res.json({ days });
});

app.put('/api/reminder/config', requireSession, requireAuth, (req, res) => {
  const { days } = req.body;
  db.prepare("INSERT OR REPLACE INTO config (key,value) VALUES (?,?)").run('reminder_days', String(days || 2));
  res.json({ ok: true });
});

app.get('/api/stats/timeline', requireSession, (req, res) => {
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0,10);
    days.push(dateStr);
  }
  const rows = db.prepare("SELECT DATE(fecha) as dia, COUNT(*) as c FROM incidencias WHERE fecha >= DATE('now','-30 days','-3 hours') GROUP BY dia").all();
  const map = {};
  rows.forEach(r => { map[r.dia] = r.c; });
  const data = days.map(d => ({ dia: d.slice(5), count: map[d] || 0 }));
  res.json(data);
});

app.get('/api/incidencias/:id/comentarios', (req, res) => {
  const rows = db.prepare('SELECT * FROM comentarios WHERE incidencia_id = ? ORDER BY fecha ASC').all(req.params.id);
  res.json(rows);
});

app.post('/api/incidencias/:id/comentarios', requireSession, requireAuth, (req, res) => {
  const { texto } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ error: 'Texto requerido' });
  const stmt = db.prepare('INSERT INTO comentarios (incidencia_id, autor, texto) VALUES (?,?,?)');
  const result = stmt.run(req.params.id, 'Subdirector', texto.trim());
  const row = db.prepare('SELECT * FROM comentarios WHERE id = ?').get(result.lastInsertRowid);
  const inc = db.prepare('SELECT id, alumno, maestro FROM incidencias WHERE id = ?').get(req.params.id);
  broadcast({ type: 'comentario', incidencia_id: parseInt(req.params.id), maestro: inc?.maestro || '', alumno: inc?.alumno || '', data: row });
  res.json(row);
});

app.get('/api/comentarios/maestro/:maestro', (req, res) => {
  const maestro = (req.params.maestro || '').replace(/\+/g, ' ');
  const rows = db.prepare(`
    SELECT c.*, i.alumno, i.maestro 
    FROM comentarios c 
    JOIN incidencias i ON c.incidencia_id = i.id 
    WHERE i.maestro = ? 
    ORDER BY c.fecha DESC 
    LIMIT 50
  `).all(maestro);
  res.json(rows);
});

app.get('/api/config/email', requireSession, (req, res) => {
  const rows = db.prepare("SELECT * FROM config WHERE key LIKE 'smtp_%' OR key = 'report_email'").all();
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  res.json(config);
});

app.put('/api/config/email', requireSession, requireAuth, (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, report_email } = req.body;
  const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
  db.transaction(() => {
    stmt.run('smtp_host', smtp_host || '');
    stmt.run('smtp_port', String(smtp_port || 587));
    stmt.run('smtp_user', smtp_user || '');
    if (smtp_pass) stmt.run('smtp_pass', smtp_pass);
    stmt.run('smtp_secure', String(smtp_secure || 'false'));
    stmt.run('report_email', report_email || '');
  })();
  res.json({ ok: true });
});

app.post('/api/config/email/test', requireSession, requireAuth, async (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, report_email } = req.body;
  try {
    const transporter = nodemailer.createTransport({
      host: smtp_host,
      port: parseInt(smtp_port),
      secure: smtp_secure === 'true',
      auth: { user: smtp_user, pass: smtp_pass }
    });
    await transporter.verify();
    await transporter.sendMail({
      from: `"Bitácora Test" <${smtp_user}>`,
      to: report_email,
      subject: 'Prueba de Conexión - Bitácora',
      text: 'Si recibes esto, la configuración es correcta.'
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/actividad', requireSession, (req, res) => {
  const rows = db.prepare('SELECT * FROM actividad_log ORDER BY fecha DESC LIMIT 100').all();
  res.json(rows);
});

app.get('/api/export/json', requireSession, (req, res) => {
  const incidencias = db.prepare('SELECT * FROM incidencias ORDER BY id ASC').all();
  const comentarios = db.prepare('SELECT * FROM comentarios ORDER BY id ASC').all();
  const categorias = db.prepare('SELECT * FROM categorias ORDER BY id ASC').all();
  const configRows = db.prepare('SELECT * FROM config').all();
  res.json({ incidencias, comentarios, categorias, config: configRows });
});

app.post('/api/import', requireSession, requireAuth, (req, res) => {
  const { incidencias, comentarios, categorias, config } = req.body;
  if (!incidencias || !Array.isArray(incidencias)) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }
  try {
    db.transaction(() => {
      // Clear existing data
      db.prepare('DELETE FROM comentarios').run();
      db.prepare('DELETE FROM incidencias').run();
      db.prepare('DELETE FROM categorias').run();
      // Insert categorias
      const insCat = db.prepare('INSERT OR IGNORE INTO categorias (id, nombre) VALUES (?, ?)');
      if (categorias) categorias.forEach(c => insCat.run(c.id, c.nombre));
      // Insert incidencias
      const insInc = db.prepare(`INSERT OR REPLACE INTO incidencias 
        (id, alumno, grupo, descripcion, gravedad, categoria, maestro, foto, fecha, resuelta, ubicacion, personas_involucradas, acciones_realizadas, seguimiento, firma_digital) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      incidencias.forEach(i => insInc.run(
        i.id, i.alumno, i.grupo, i.descripcion, i.gravedad, i.categoria, i.maestro,
        i.foto || '', i.fecha, i.resuelta ? 1 : 0, i.ubicacion || '',
        i.personas_involucradas || '', i.acciones_realizadas || '',
        i.seguimiento || '', i.firma_digital || ''
      ));
      // Insert comentarios
      const insCom = db.prepare('INSERT OR REPLACE INTO comentarios (id, incidencia_id, autor, texto, fecha) VALUES (?, ?, ?, ?, ?)');
      if (comentarios) comentarios.forEach(c => insCom.run(c.id, c.incidencia_id, c.autor, c.texto, c.fecha));
      // Restore config (except auth-related keys)
      if (config) {
        const skipKeys = ['login_username', 'login_hash'];
        const insCfg = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
        config.forEach(r => {
          if (!skipKeys.includes(r.key)) insCfg.run(r.key, r.value);
        });
      }
    })();
    res.json({ ok: true, imported: incidencias.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bitácora corriendo en http://0.0.0.0:${PORT}`);
  const os = require('os');
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`  Red local: http://${iface.address}:${PORT}`);
      }
    }
  }
});
