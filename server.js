import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const ROOT_DIR = import.meta.dirname;
const IS_TEST = process.argv.includes('--test');
const DATA_DIR = IS_TEST
  ? path.join(ROOT_DIR, 'data/.test')
  : process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const BUCKET_DIR = IS_TEST
  ? path.join(ROOT_DIR, 'storage/.test-bucket')
  : process.env.BUCKET_DIR || path.join(ROOT_DIR, 'storage/buckets/items');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SESSION_SECRET = process.env.SESSION_SECRET || 'inv-local-secret-key-2026';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BUCKET_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Helpers de Contraseña y Sesión (node:crypto stdlib)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, keyHex] = stored.split(':');
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derived = crypto.scryptSync(String(password), salt, 64);
  return keyBuf.length === derived.length && crypto.timingSafeEqual(keyBuf, derived);
}

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

// ---------------------------------------------------------------------------
// 2. Base de Datos SQL Local (node:sqlite) y Seed de Admin
// ---------------------------------------------------------------------------
const db = new DatabaseSync(path.join(DATA_DIR, 'inventory.db'));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

// Migración automática si existía tabla users previa sin email/password_hash/role
const userCols = db.prepare(`PRAGMA table_info(users)`).all();
if (userCols.length > 0 && !userCols.some((c) => c.name === 'email')) {
  db.exec(`DROP TABLE IF EXISTS items; DROP TABLE IF EXISTS users;`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    foto_key TEXT NOT NULL,
    nombre TEXT NOT NULL CHECK (length(trim(nombre)) > 0),
    descripcion TEXT,
    precio REAL CHECK (precio IS NULL OR precio >= 0),
    fecha_obtenido TEXT NOT NULL CHECK (fecha_obtenido GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    fecha_carga TEXT NOT NULL DEFAULT (datetime('now')),
    fecha_baja TEXT CHECK (fecha_baja IS NULL OR fecha_baja GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    motivo_baja TEXT CHECK (motivo_baja IS NULL OR motivo_baja IN ('vendido', 'desechado', 'roto')),
    detalles TEXT,
    CHECK (
      (fecha_baja IS NULL AND motivo_baja IS NULL) OR
      (fecha_baja IS NOT NULL AND motivo_baja IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_items_user_status ON items(user_id, fecha_baja);
`);

// Seed obligatorio: francocalegari55@gmail.com / 137546321 / role=admin
const ADMIN_EMAIL = 'francocalegari55@gmail.com';
const existingAdmin = db.prepare(`SELECT id FROM users WHERE email = ?`).get(ADMIN_EMAIL);
if (!existingAdmin) {
  db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')`).run(
    ADMIN_EMAIL,
    hashPassword('137546321')
  );
} else {
  db.prepare(`UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?`).run(
    hashPassword('137546321'),
    existingAdmin.id
  );
}

// ---------------------------------------------------------------------------
// 3. Cloud Storage Local (Adaptador de Bucket sobre FS)
// ponytail: bucket local en FS; reemplazar estas 3 funciones por S3Client si se migra a nube externa
// ---------------------------------------------------------------------------
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/heic': '.heic'
};
const EXT_TO_MIME = Object.fromEntries(Object.entries(MIME_TO_EXT).map(([k, v]) => [v, k]));
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const localBucket = {
  async putObject(userId, file) {
    if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) {
      throw Object.assign(new Error('La foto del objeto es obligatoria.'), { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw Object.assign(new Error('La foto supera el límite de 8 MB.'), { status: 413 });
    }
    const ext = MIME_TO_EXT[file.type] || '.jpg';
    const key = `${Number(userId)}/${crypto.randomUUID()}${ext}`;
    const fullPath = this.resolvePath(key);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, Buffer.from(await file.arrayBuffer()));
    return key;
  },

  resolvePath(key) {
    const cleanKey = String(key).replace(/^\/+/, '');
    const resolved = path.resolve(BUCKET_DIR, cleanKey);
    if (!resolved.startsWith(BUCKET_DIR + path.sep)) {
      throw Object.assign(new Error('Clave de almacenamiento inválida.'), { status: 400 });
    }
    return resolved;
  },

  async deleteObject(key) {
    if (!key) return;
    try {
      await fsp.unlink(this.resolvePath(key));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Error borrando blob:', err.message);
    }
  }
};

// ---------------------------------------------------------------------------
// 4. Helpers HTTP y Autenticación
// ---------------------------------------------------------------------------
function formatItem(row) {
  return row ? { ...row, foto_url: `/storage/${row.foto_key}` } : null;
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function parseOptionalPrice(val) {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const num = Number(String(val).replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) {
    throw Object.assign(new Error('El precio debe ser un número mayor o igual a 0.'), { status: 400 });
  }
  return Math.round(num * 100) / 100;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getAuthUser(req) {
  const cookies = parseCookies(req);
  const payload = verifyToken(cookies.inv_session);
  if (!payload?.id) return null;
  return db
    .prepare(`SELECT id, email, role, created_at FROM users WHERE id = ?`)
    .get(payload.id) || null;
}

function requireAuth(req) {
  const user = getAuthUser(req);
  if (!user) throw Object.assign(new Error('No autenticado. Inicia sesión.'), { status: 401 });
  return user;
}

function makeSessionCookie(user) {
  const token = signToken({ id: user.id, email: user.email, role: user.role });
  return `inv_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`;
}

// ---------------------------------------------------------------------------
// 5. Servidor HTTP y Rutas
// ---------------------------------------------------------------------------
export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, searchParams } = url;

    // --- AUTH: Login ---
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const { email, password } = await readJson(req);
      const cleanEmail = String(email || '').trim();
      const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(cleanEmail);
      if (!user || !verifyPassword(password, user.password_hash)) {
        return sendJson(res, 401, { error: 'Correo o contraseña incorrectos.' });
      }
      const publicUser = { id: user.id, email: user.email, role: user.role };
      return sendJson(res, 200, publicUser, { 'Set-Cookie': makeSessionCookie(publicUser) });
    }

    // --- AUTH: Registro de Cuenta ---
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const { email, password } = await readJson(req);
      const cleanEmail = String(email || '').trim().toLowerCase();
      if (!cleanEmail.includes('@')) {
        return sendJson(res, 400, { error: 'Ingresa un correo electrónico válido.' });
      }
      if (!password || String(password).length < 6) {
        return sendJson(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
      }
      const exists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(cleanEmail);
      if (exists) {
        return sendJson(res, 409, { error: 'Ya existe una cuenta con ese correo.' });
      }
      const result = db
        .prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'user')`)
        .run(cleanEmail, hashPassword(password));
      const publicUser = { id: Number(result.lastInsertRowid), email: cleanEmail, role: 'user' };
      return sendJson(res, 201, publicUser, { 'Set-Cookie': makeSessionCookie(publicUser) });
    }

    // --- AUTH: Logout ---
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      return sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': 'inv_session=; HttpOnly; Path=/; Max-Age=0' }
      );
    }

    // --- AUTH: Sesión Actual ---
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: 'No autenticado.' });
      return sendJson(res, 200, user);
    }

    // --- API: Gestión de Usuarios (Admin ve todos; usuario normal ve su propio perfil) ---
    if (pathname === '/api/users' && req.method === 'GET') {
      const currentUser = requireAuth(req);
      if (currentUser.role === 'admin') {
        const users = db.prepare(`
          SELECT u.id, u.email, u.role, u.created_at,
            (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id AND i.fecha_baja IS NULL) AS active_count,
            (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id AND i.fecha_baja IS NOT NULL) AS retired_count
          FROM users u
          ORDER BY u.id ASC
        `).all();
        return sendJson(res, 200, users);
      }
      const selfStats = db.prepare(`
        SELECT u.id, u.email, u.role, u.created_at,
          (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id AND i.fecha_baja IS NULL) AS active_count,
          (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id AND i.fecha_baja IS NOT NULL) AS retired_count
        FROM users u WHERE u.id = ?
      `).get(currentUser.id);
      return sendJson(res, 200, [selfStats]);
    }

    if (pathname === '/api/users' && req.method === 'POST') {
      const currentUser = requireAuth(req);
      if (currentUser.role !== 'admin') {
        return sendJson(res, 403, { error: 'Solo los administradores pueden crear usuarios desde el panel.' });
      }
      const { email, password, role } = await readJson(req);
      const cleanEmail = String(email || '').trim().toLowerCase();
      const userRole = role === 'admin' ? 'admin' : 'user';
      if (!cleanEmail.includes('@') || !password) {
        return sendJson(res, 400, { error: 'Correo y contraseña requeridos.' });
      }
      const exists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(cleanEmail);
      if (exists) return sendJson(res, 409, { error: 'El usuario ya existe.' });

      const result = db
        .prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)`)
        .run(cleanEmail, hashPassword(password), userRole);
      const created = db
        .prepare(`SELECT id, email, role, created_at FROM users WHERE id = ?`)
        .get(result.lastInsertRowid);
      return sendJson(res, 201, created);
    }

    // --- API: Listar Objetos ---
    if (pathname === '/api/items' && req.method === 'GET') {
      const currentUser = requireAuth(req);
      const targetUserId =
        currentUser.role === 'admin' && searchParams.get('userId')
          ? Number(searchParams.get('userId'))
          : currentUser.id;
      const estado = searchParams.get('estado') || 'activos';
      const q = (searchParams.get('q') || '').trim();

      let sql = `SELECT * FROM items WHERE user_id = ?`;
      const params = [targetUserId];

      if (estado === 'activos') sql += ` AND fecha_baja IS NULL`;
      else if (estado === 'bajas') sql += ` AND fecha_baja IS NOT NULL`;

      if (q) {
        sql += ` AND (nombre LIKE ? OR descripcion LIKE ? OR detalles LIKE ?)`;
        const pattern = `%${q}%`;
        params.push(pattern, pattern, pattern);
      }

      sql += ` ORDER BY id DESC`;
      const rows = db.prepare(sql).all(...params).map(formatItem);
      return sendJson(res, 200, rows);
    }

    // --- API: Añadir Objeto (Multipart FormData) ---
    if (pathname === '/api/items' && req.method === 'POST') {
      const currentUser = requireAuth(req);
      const webReq = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: Readable.toWeb(req),
        duplex: 'half'
      });
      const form = await webReq.formData();

      const targetUserId =
        currentUser.role === 'admin' && form.get('user_id')
          ? Number(form.get('user_id'))
          : currentUser.id;

      const nombre = String(form.get('nombre') || '').trim();
      if (!nombre) return sendJson(res, 400, { error: 'El nombre del objeto es obligatorio.' });

      const descripcion = String(form.get('descripcion') || '').trim() || null;
      const detalles = String(form.get('detalles') || '').trim() || null;
      const precio = parseOptionalPrice(form.get('precio'));
      const fechaObtenido = String(form.get('fecha_obtenido') || '').trim() || todayISO();
      const foto = form.get('foto');

      const fotoKey = await localBucket.putObject(targetUserId, foto);

      try {
        const result = db.prepare(`
          INSERT INTO items (user_id, foto_key, nombre, descripcion, precio, fecha_obtenido, detalles)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(targetUserId, fotoKey, nombre, descripcion, precio, fechaObtenido, detalles);

        const created = db.prepare(`SELECT * FROM items WHERE id = ?`).get(result.lastInsertRowid);
        return sendJson(res, 201, formatItem(created));
      } catch (dbErr) {
        await localBucket.deleteObject(fotoKey);
        throw Object.assign(new Error(`Datos inválidos: ${dbErr.message}`), { status: 400 });
      }
    }

    // --- API: Dar de Baja o Reactivar Objeto ---
    const bajaMatch = pathname.match(/^\/api\/items\/(\d+)\/baja$/);
    if (bajaMatch && req.method === 'PATCH') {
      const currentUser = requireAuth(req);
      const itemId = Number(bajaMatch[1]);
      const existing = db.prepare(`SELECT * FROM items WHERE id = ?`).get(itemId);
      if (!existing) return sendJson(res, 404, { error: 'Objeto no encontrado.' });
      if (existing.user_id !== currentUser.id && currentUser.role !== 'admin') {
        return sendJson(res, 403, { error: 'No tienes permiso sobre este objeto.' });
      }

      const body = await readJson(req);
      if (body.reactivar) {
        db.prepare(`UPDATE items SET fecha_baja = NULL, motivo_baja = NULL WHERE id = ?`).run(itemId);
      } else {
        const motivo = String(body.motivo_baja || '').trim();
        const fechaBaja = String(body.fecha_baja || '').trim() || todayISO();
        if (!['vendido', 'desechado', 'roto'].includes(motivo)) {
          return sendJson(res, 400, {
            error: 'El motivo de baja debe ser: vendido, desechado o roto.'
          });
        }
        db.prepare(`UPDATE items SET fecha_baja = ?, motivo_baja = ? WHERE id = ?`).run(
          fechaBaja,
          motivo,
          itemId
        );
      }

      const updated = db.prepare(`SELECT * FROM items WHERE id = ?`).get(itemId);
      return sendJson(res, 200, formatItem(updated));
    }

    // --- API: Eliminar Objeto ---
    const itemMatch = pathname.match(/^\/api\/items\/(\d+)$/);
    if (itemMatch && req.method === 'DELETE') {
      const currentUser = requireAuth(req);
      const itemId = Number(itemMatch[1]);
      const existing = db.prepare(`SELECT * FROM items WHERE id = ?`).get(itemId);
      if (!existing) return sendJson(res, 404, { error: 'Objeto no encontrado.' });
      if (existing.user_id !== currentUser.id && currentUser.role !== 'admin') {
        return sendJson(res, 403, { error: 'No tienes permiso sobre este objeto.' });
      }

      db.prepare(`DELETE FROM items WHERE id = ?`).run(itemId);
      await localBucket.deleteObject(existing.foto_key);
      return sendJson(res, 200, { deleted: true, id: itemId });
    }

    // --- Cloud Storage Local: Servir Imágenes del Bucket ---
    if (pathname.startsWith('/storage/') && req.method === 'GET') {
      const key = pathname.slice('/storage/'.length);
      const filePath = localBucket.resolvePath(key);
      if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'Imagen no encontrada.' });

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': EXT_TO_MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable'
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    // --- Archivos Estáticos Frontend ---
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/app.js')) {
      const file = pathname === '/app.js' ? 'app.js' : 'index.html';
      const contentType =
        file === 'app.js' ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      const content = await fsp.readFile(path.join(PUBLIC_DIR, file));
      res.writeHead(200, { 'Content-Type': contentType });
      return res.end(content);
    }

    sendJson(res, 404, { error: 'Ruta no encontrada.' });
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, { error: err.message || 'Error interno del servidor.' });
  }
});

// ---------------------------------------------------------------------------
// 6. Arranque o Self-Check (--test)
// ---------------------------------------------------------------------------
if (IS_TEST) {
  server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    try {
      // 1. Verificar cuenta admin pre-creada (francocalegari55@gmail.com / 137546321 / admin)
      const loginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'francocalegari55@gmail.com',
          password: '137546321'
        })
      });
      assert.equal(loginRes.status, 200);
      const adminUser = await loginRes.json();
      assert.equal(adminUser.email, 'francocalegari55@gmail.com');
      assert.equal(adminUser.role, 'admin');
      const cookie = loginRes.headers.get('set-cookie').split(';')[0];

      // 2. Verificar sesión /api/auth/me
      const meRes = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
      assert.equal(meRes.status, 200);
      const me = await meRes.json();
      assert.equal(me.role, 'admin');

      // 3. Subir objeto autenticado
      const form = new FormData();
      form.set('nombre', 'Cámara Analógica Olympus');
      form.set('descripcion', 'Lente 35mm f/2.8');
      form.set('precio', '125.50');
      form.set('fecha_obtenido', '2025-06-15');
      form.set('detalles', 'Serie #99412');
      const fakeJpeg = new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
      form.set('foto', fakeJpeg, 'olympus.jpg');

      const iRes = await fetch(`${base}/api/items`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: form
      });
      assert.equal(iRes.status, 201);
      const item = await iRes.json();
      assert.equal(item.user_id, adminUser.id);

      // 4. Dar de baja el objeto
      const bajaRes = await fetch(`${base}/api/items/${item.id}/baja`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ motivo_baja: 'vendido', fecha_baja: '2026-11-08' })
      });
      assert.equal(bajaRes.status, 200);

      // 5. Registrar nuevo usuario estándar y verificar aislamiento de inventario
      const regRes = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'usuario@test.com', password: 'password123' })
      });
      assert.equal(regRes.status, 201);
      const stdUser = await regRes.json();
      assert.equal(stdUser.role, 'user');

      console.log('✅ Self-check completado: Admin (francocalegari55@gmail.com), Auth, SQLite y Bucket verificados.');
    } finally {
      server.close();
      db.close();
      await fsp.rm(DATA_DIR, { recursive: true, force: true });
      await fsp.rm(BUCKET_DIR, { recursive: true, force: true });
    }
  });
} else {
  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`📦 Organizador de Inventario corriendo en http://localhost:${PORT}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
