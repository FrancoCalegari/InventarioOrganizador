import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './lib/db.js';
import { createBucket, IMAGE_TYPES, VIDEO_TYPES, MIME_BY_EXT } from './lib/storage.js';
import { compressImageInBucket, optimizeExistingImages } from './lib/jobs.js';

const ROOT_DIR = import.meta.dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const BUCKET_DIR = process.env.BUCKET_DIR || path.join(ROOT_DIR, 'storage/buckets/items');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SESSION_SECRET = process.env.SESSION_SECRET || 'inv-local-secret-key-2026';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // las imágenes llegan ya comprimidas desde el cliente
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MONEDAS = ['ARS', 'USD'];
const MOTIVOS = ['vendido', 'desechado', 'roto'];

export const db = openDb(DATA_DIR);
export const bucket = createBucket(BUCKET_DIR);

// ---------------------------------------------------------------------------
// 1. Contraseñas y sesión (node:crypto)
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
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

// Cuenta admin inicial
const ADMIN_EMAIL = 'francocalegari55@gmail.com';
if (!db.prepare(`SELECT id FROM users WHERE email = ?`).get(ADMIN_EMAIL)) {
  db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')`).run(
    ADMIN_EMAIL,
    hashPassword('137546321')
  );
}

// ---------------------------------------------------------------------------
// 2. Helpers HTTP, validación y serialización
// ---------------------------------------------------------------------------
const httpError = (status, message) => Object.assign(new Error(message), { status });

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
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw httpError(413, 'Cuerpo de la petición demasiado grande.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, 'JSON inválido.');
  }
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const str = (v) => String(v ?? '').trim() || null;

function parseOptionalPrice(val) {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const num = Number(String(val).replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) throw httpError(400, 'El precio debe ser un número mayor o igual a 0.');
  return Math.round(num * 100) / 100;
}

function parseCantidad(val, label = 'La cantidad') {
  const n = Number(val ?? 1);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, `${label} debe ser un número entero mayor o igual a 1.`);
  return n;
}

// Valida los campos editables del objeto; en edición completa con los valores actuales
function parseItemFields(body, current = {}) {
  const pick = (k) => (k in body ? body[k] : current[k]);
  const nombre = str(pick('nombre'));
  if (!nombre) throw httpError(400, 'El nombre del objeto es obligatorio.');
  const moneda = String(pick('moneda') || 'ARS').toUpperCase();
  if (!MONEDAS.includes(moneda)) throw httpError(400, 'La moneda debe ser ARS o USD.');
  const fecha = str(pick('fecha_obtenido')) || todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw httpError(400, 'Fecha obtenido inválida (AAAA-MM-DD).');
  return {
    nombre,
    descripcion: str(pick('descripcion')),
    detalles: str(pick('detalles')),
    marca: str(pick('marca')),
    modelo: str(pick('modelo')),
    guardado_en: str(pick('guardado_en')),
    cantidad: parseCantidad(pick('cantidad')),
    precio: parseOptionalPrice(pick('precio')),
    moneda,
    fecha_obtenido: fecha
  };
}

const mediaUrl = (key) => (key ? `/storage/${key}` : null);

function formatMedia(m) {
  return {
    id: m.id,
    tipo: m.tipo,
    estado: m.estado,
    orden: m.orden,
    bytes: m.bytes,
    duracion_seg: m.duracion_seg,
    url: mediaUrl(m.storage_key),
    poster_url: mediaUrl(m.poster_key)
  };
}

function getItemDetail(id) {
  const item = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id);
  if (!item) return null;
  item.media = db
    .prepare(`SELECT * FROM item_media WHERE item_id = ? ORDER BY orden, id`)
    .all(id)
    .map(formatMedia);
  item.contiene = db.prepare(`
    SELECT c.id, c.nombre, c.marca, c.modelo, c.fecha_baja, r.cantidad
    FROM item_relations r JOIN items c ON c.id = r.child_id
    WHERE r.parent_id = ? ORDER BY c.nombre
  `).all(id);
  item.contenido_en = db.prepare(`
    SELECT p.id, p.nombre, r.cantidad
    FROM item_relations r JOIN items p ON p.id = r.parent_id
    WHERE r.child_id = ? ORDER BY p.nombre
  `).all(id);
  return item;
}

// ---------------------------------------------------------------------------
// 3. Autenticación y permisos
// ---------------------------------------------------------------------------
function getAuthUser(req) {
  const payload = verifyToken(parseCookies(req).inv_session);
  if (!payload?.id) return null;
  return db.prepare(`SELECT id, email, role, created_at FROM users WHERE id = ?`).get(payload.id) || null;
}

function requireAuth(req) {
  const user = getAuthUser(req);
  if (!user) throw httpError(401, 'No autenticado. Inicia sesión.');
  return user;
}

function requireAdmin(req) {
  const user = requireAuth(req);
  if (user.role !== 'admin') throw httpError(403, 'Solo para administradores.');
  return user;
}

function getOwnedItem(user, id) {
  const item = db.prepare(`SELECT * FROM items WHERE id = ?`).get(Number(id));
  if (!item) throw httpError(404, 'Objeto no encontrado.');
  if (item.user_id !== user.id && user.role !== 'admin') throw httpError(403, 'No tienes permiso sobre este objeto.');
  return item;
}

function getOwnedMedia(user, mediaId) {
  const media = db.prepare(`SELECT * FROM item_media WHERE id = ?`).get(Number(mediaId));
  if (!media) throw httpError(404, 'Archivo no encontrado.');
  getOwnedItem(user, media.item_id);
  return media;
}

function makeSessionCookie(user) {
  const token = signToken({ id: user.id, email: user.email, role: user.role });
  return `inv_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`;
}

// Usuario cuyo inventario se consulta (admin puede ver otros)
function targetUserId(user, requested) {
  return user.role === 'admin' && requested ? Number(requested) : user.id;
}

// ---------------------------------------------------------------------------
// 4. Relaciones "contiene" (se llama dentro de una transacción)
// ---------------------------------------------------------------------------
const containsStmt = () =>
  db.prepare(`
    WITH RECURSIVE descendientes(id) AS (
      SELECT child_id FROM item_relations WHERE parent_id = ?
      UNION
      SELECT r.child_id FROM item_relations r JOIN descendientes d ON r.parent_id = d.id
    )
    SELECT 1 AS hit FROM descendientes WHERE id = ? LIMIT 1
  `);

function setRelations(item, relaciones) {
  if (!Array.isArray(relaciones)) throw httpError(400, 'relaciones debe ser una lista.');
  const unique = new Map();
  for (const rel of relaciones) {
    const childId = Number(rel?.child_id);
    if (!Number.isInteger(childId)) throw httpError(400, 'Objeto relacionado inválido.');
    unique.set(childId, parseCantidad(rel.cantidad, 'La cantidad del objeto contenido'));
  }

  db.prepare(`DELETE FROM item_relations WHERE parent_id = ?`).run(item.id);
  const isDescendant = containsStmt();
  const insert = db.prepare(`INSERT INTO item_relations (parent_id, child_id, cantidad) VALUES (?, ?, ?)`);

  for (const [childId, cantidad] of unique) {
    if (childId === item.id) throw httpError(400, 'Un objeto no puede contenerse a sí mismo.');
    const child = db.prepare(`SELECT id, nombre, user_id FROM items WHERE id = ?`).get(childId);
    if (!child || child.user_id !== item.user_id) {
      throw httpError(400, 'Los objetos relacionados deben existir en el inventario del mismo usuario.');
    }
    if (isDescendant.get(childId, item.id)) {
      throw httpError(400, `"${child.nombre}" ya contiene a este objeto (se formaría un ciclo).`);
    }
    insert.run(item.id, childId, cantidad);
  }
}

async function deleteMediaFiles(mediaRows) {
  const ids = mediaRows.map((m) => m.id);
  const originals = ids.length
    ? db.prepare(`SELECT input_key FROM media_jobs WHERE media_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : [];
  return () =>
    bucket.remove(
      ...mediaRows.flatMap((m) => [m.storage_key, m.poster_key]),
      ...originals.map((o) => o.input_key)
    );
}

// ---------------------------------------------------------------------------
// 5. Servir archivos del bucket con sesión y soporte de Range (necesario para video en iOS)
// ---------------------------------------------------------------------------
async function serveStorage(req, res, key) {
  const user = requireAuth(req);
  const owner = key.split('/')[0];
  if (owner !== String(user.id) && user.role !== 'admin') throw httpError(403, 'Sin acceso a este archivo.');

  const filePath = bucket.resolve(key);
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw httpError(404, 'Archivo no encontrado.');

  const headers = {
    'Content-Type': MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes'
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// 6. Rutas
// ---------------------------------------------------------------------------
export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, searchParams } = url;
    const m = (re) => pathname.match(re);
    let match;

    // --- Auth ---
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const { email, password } = await readJson(req);
      const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(String(email || '').trim());
      if (!user || !verifyPassword(password, user.password_hash)) {
        return sendJson(res, 401, { error: 'Correo o contraseña incorrectos.' });
      }
      const publicUser = { id: user.id, email: user.email, role: user.role };
      return sendJson(res, 200, publicUser, { 'Set-Cookie': makeSessionCookie(publicUser) });
    }

    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const { email, password } = await readJson(req);
      const cleanEmail = String(email || '').trim().toLowerCase();
      if (!cleanEmail.includes('@')) return sendJson(res, 400, { error: 'Ingresa un correo electrónico válido.' });
      if (!password || String(password).length < 6) {
        return sendJson(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
      }
      if (db.prepare(`SELECT id FROM users WHERE email = ?`).get(cleanEmail)) {
        return sendJson(res, 409, { error: 'Ya existe una cuenta con ese correo.' });
      }
      const result = db
        .prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'user')`)
        .run(cleanEmail, hashPassword(password));
      const publicUser = { id: Number(result.lastInsertRowid), email: cleanEmail, role: 'user' };
      return sendJson(res, 201, publicUser, { 'Set-Cookie': makeSessionCookie(publicUser) });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'inv_session=; HttpOnly; Path=/; Max-Age=0' });
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: 'No autenticado.' });
      return sendJson(res, 200, user);
    }

    // --- Usuarios ---
    if (pathname === '/api/users' && req.method === 'GET') {
      const user = requireAuth(req);
      const sql = `
        SELECT u.id, u.email, u.role, u.created_at,
          (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id AND i.fecha_baja IS NULL) AS active_count,
          (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id AND i.fecha_baja IS NOT NULL) AS retired_count
        FROM users u`;
      const rows =
        user.role === 'admin'
          ? db.prepare(`${sql} ORDER BY u.id`).all()
          : db.prepare(`${sql} WHERE u.id = ?`).all(user.id);
      return sendJson(res, 200, rows);
    }

    if (pathname === '/api/users' && req.method === 'POST') {
      requireAdmin(req);
      const { email, password, role } = await readJson(req);
      const cleanEmail = String(email || '').trim().toLowerCase();
      if (!cleanEmail.includes('@') || !password) return sendJson(res, 400, { error: 'Correo y contraseña requeridos.' });
      if (db.prepare(`SELECT id FROM users WHERE email = ?`).get(cleanEmail)) {
        return sendJson(res, 409, { error: 'El usuario ya existe.' });
      }
      const result = db
        .prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)`)
        .run(cleanEmail, hashPassword(password), role === 'admin' ? 'admin' : 'user');
      return sendJson(
        res,
        201,
        db.prepare(`SELECT id, email, role, created_at FROM users WHERE id = ?`).get(result.lastInsertRowid)
      );
    }

    // --- Sugerencias de "Guardado en" ---
    if (pathname === '/api/guardado-en' && req.method === 'GET') {
      const user = requireAuth(req);
      const rows = db
        .prepare(`SELECT DISTINCT guardado_en FROM items WHERE user_id = ? AND guardado_en IS NOT NULL ORDER BY 1`)
        .all(targetUserId(user, searchParams.get('userId')));
      return sendJson(res, 200, rows.map((r) => r.guardado_en));
    }

    // --- Listado de objetos ---
    if (pathname === '/api/items' && req.method === 'GET') {
      const user = requireAuth(req);
      const estado = searchParams.get('estado') || 'activos';
      const q = (searchParams.get('q') || '').trim();

      let sql = `
        SELECT i.*,
          (SELECT COALESCE(md.poster_key, md.storage_key) FROM item_media md
            WHERE md.item_id = i.id AND COALESCE(md.poster_key, md.storage_key) IS NOT NULL
            ORDER BY md.orden, md.id LIMIT 1) AS portada_key,
          (SELECT COUNT(*) FROM item_media md WHERE md.item_id = i.id) AS media_count,
          (SELECT COUNT(*) FROM item_media md WHERE md.item_id = i.id AND md.estado IN ('pendiente','procesando')) AS media_pendientes,
          (SELECT json_group_array(json_object('id', c.id, 'nombre', c.nombre, 'cantidad', r.cantidad))
            FROM item_relations r JOIN items c ON c.id = r.child_id WHERE r.parent_id = i.id) AS contiene_json
        FROM items i WHERE i.user_id = ?`;
      const params = [targetUserId(user, searchParams.get('userId'))];

      if (estado === 'activos') sql += ` AND i.fecha_baja IS NULL`;
      else if (estado === 'bajas') sql += ` AND i.fecha_baja IS NOT NULL`;

      if (q) {
        sql += ` AND (i.nombre LIKE ? OR i.descripcion LIKE ? OR i.detalles LIKE ? OR i.marca LIKE ? OR i.modelo LIKE ? OR i.guardado_en LIKE ?)`;
        params.push(...Array(6).fill(`%${q}%`));
      }
      sql += ` ORDER BY i.id DESC`;

      const rows = db.prepare(sql).all(...params).map(({ portada_key, contiene_json, ...row }) => ({
        ...row,
        portada_url: mediaUrl(portada_key),
        contiene: JSON.parse(contiene_json || '[]')
      }));
      return sendJson(res, 200, rows);
    }

    // --- Crear objeto (JSON; la multimedia se sube después a /api/items/:id/media) ---
    if (pathname === '/api/items' && req.method === 'POST') {
      const user = requireAuth(req);
      const body = await readJson(req);
      const ownerId = targetUserId(user, body.user_id);
      if (!db.prepare(`SELECT id FROM users WHERE id = ?`).get(ownerId)) throw httpError(404, 'Usuario no encontrado.');
      const f = parseItemFields(body);

      const id = tx(db, () => {
        const result = db.prepare(`
          INSERT INTO items (user_id, nombre, descripcion, detalles, marca, modelo, guardado_en, cantidad, precio, moneda, fecha_obtenido)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(ownerId, f.nombre, f.descripcion, f.detalles, f.marca, f.modelo, f.guardado_en, f.cantidad, f.precio, f.moneda, f.fecha_obtenido);
        const newId = Number(result.lastInsertRowid);
        if (body.relaciones) setRelations({ id: newId, user_id: ownerId }, body.relaciones);
        return newId;
      });
      return sendJson(res, 201, getItemDetail(id));
    }

    // --- Detalle / edición / borrado de un objeto ---
    if ((match = m(/^\/api\/items\/(\d+)$/))) {
      const user = requireAuth(req);
      const item = getOwnedItem(user, match[1]);

      if (req.method === 'GET') return sendJson(res, 200, getItemDetail(item.id));

      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const f = parseItemFields(body, item);
        tx(db, () => {
          db.prepare(`
            UPDATE items SET nombre = ?, descripcion = ?, detalles = ?, marca = ?, modelo = ?, guardado_en = ?,
              cantidad = ?, precio = ?, moneda = ?, fecha_obtenido = ?
            WHERE id = ?
          `).run(f.nombre, f.descripcion, f.detalles, f.marca, f.modelo, f.guardado_en, f.cantidad, f.precio, f.moneda, f.fecha_obtenido, item.id);
          if ('relaciones' in body) setRelations(item, body.relaciones);
        });
        return sendJson(res, 200, getItemDetail(item.id));
      }

      if (req.method === 'DELETE') {
        const media = db.prepare(`SELECT * FROM item_media WHERE item_id = ?`).all(item.id);
        const removeFiles = await deleteMediaFiles(media);
        db.prepare(`DELETE FROM items WHERE id = ?`).run(item.id);
        await removeFiles();
        return sendJson(res, 200, { deleted: true, id: item.id });
      }
    }

    // --- Dar de baja (opcionalmente con su contenido) o reactivar ---
    if ((match = m(/^\/api\/items\/(\d+)\/baja$/)) && req.method === 'PATCH') {
      const user = requireAuth(req);
      const item = getOwnedItem(user, match[1]);
      const body = await readJson(req);

      if (body.reactivar) {
        db.prepare(`UPDATE items SET fecha_baja = NULL, motivo_baja = NULL WHERE id = ?`).run(item.id);
      } else {
        const motivo = String(body.motivo_baja || '').trim();
        const fechaBaja = str(body.fecha_baja) || todayISO();
        if (!MOTIVOS.includes(motivo)) {
          return sendJson(res, 400, { error: 'El motivo de baja debe ser: vendido, desechado o roto.' });
        }
        if (body.incluir_contenido) {
          db.prepare(`
            WITH RECURSIVE d(id) AS (
              SELECT child_id FROM item_relations WHERE parent_id = ?
              UNION
              SELECT r.child_id FROM item_relations r JOIN d ON r.parent_id = d.id
            )
            UPDATE items SET fecha_baja = ?, motivo_baja = ?
            WHERE (id = ? OR id IN (SELECT id FROM d)) AND fecha_baja IS NULL
          `).run(item.id, fechaBaja, motivo, item.id);
        } else {
          db.prepare(`UPDATE items SET fecha_baja = ?, motivo_baja = ? WHERE id = ?`).run(fechaBaja, motivo, item.id);
        }
      }
      return sendJson(res, 200, getItemDetail(item.id));
    }

    // --- Subir multimedia: un archivo por petición, cuerpo crudo por streaming ---
    if ((match = m(/^\/api\/items\/(\d+)\/media$/)) && req.method === 'POST') {
      const user = requireAuth(req);
      const item = getOwnedItem(user, match[1]);
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const declared = Number(req.headers['content-length'] || 0);
      const nextOrden = db
        .prepare(`SELECT COALESCE(MAX(orden) + 1, 0) AS n FROM item_media WHERE item_id = ?`)
        .get(item.id).n;

      if (IMAGE_TYPES[type]) {
        if (declared > MAX_IMAGE_BYTES) throw httpError(413, 'La imagen supera 3 MB (debe comprimirse antes de subir).');
        const rawKey = `${item.user_id}/${crypto.randomUUID()}${IMAGE_TYPES[type]}`;
        await bucket.writeStream(rawKey, req, MAX_IMAGE_BYTES);
        const { key, bytes } = await compressImageInBucket(bucket, item.user_id, rawKey);
        const result = db.prepare(`
          INSERT INTO item_media (item_id, tipo, storage_key, estado, orden, bytes) VALUES (?, 'imagen', ?, 'listo', ?, ?)
        `).run(item.id, key, nextOrden, bytes);
        const row = db.prepare(`SELECT * FROM item_media WHERE id = ?`).get(result.lastInsertRowid);
        return sendJson(res, 201, formatMedia(row));
      }

      if (type.startsWith('video/')) {
        if (declared > MAX_VIDEO_BYTES) throw httpError(413, 'El video supera el máximo de 500 MB.');
        const inputKey = `_originales/${crypto.randomUUID()}${VIDEO_TYPES[type] || '.bin'}`;
        const bytes = await bucket.writeStream(inputKey, req, MAX_VIDEO_BYTES);
        const mediaId = tx(db, () => {
          const result = db.prepare(`
            INSERT INTO item_media (item_id, tipo, estado, orden, bytes) VALUES (?, 'video', 'pendiente', ?, ?)
          `).run(item.id, nextOrden, bytes);
          db.prepare(`INSERT INTO media_jobs (media_id, input_key) VALUES (?, ?)`).run(result.lastInsertRowid, inputKey);
          return result.lastInsertRowid;
        });
        const row = db.prepare(`SELECT * FROM item_media WHERE id = ?`).get(mediaId);
        return sendJson(res, 202, formatMedia(row));
      }

      throw httpError(415, 'Formato no soportado: sube una imagen o un video.');
    }

    // --- Gestionar un archivo multimedia (portada / borrar) ---
    if ((match = m(/^\/api\/media\/(\d+)$/))) {
      const user = requireAuth(req);
      const media = getOwnedMedia(user, match[1]);

      if (req.method === 'PATCH') {
        const body = await readJson(req);
        if (body.portada) {
          tx(db, () => {
            db.prepare(`UPDATE item_media SET orden = orden + 1 WHERE item_id = ?`).run(media.item_id);
            db.prepare(`UPDATE item_media SET orden = 0 WHERE id = ?`).run(media.id);
          });
        }
        return sendJson(res, 200, formatMedia(db.prepare(`SELECT * FROM item_media WHERE id = ?`).get(media.id)));
      }

      if (req.method === 'DELETE') {
        const removeFiles = await deleteMediaFiles([media]);
        db.prepare(`DELETE FROM item_media WHERE id = ?`).run(media.id);
        await removeFiles();
        return sendJson(res, 200, { deleted: true, id: media.id });
      }
    }

    // --- Cola de compresión (admin) ---
    if (pathname === '/api/jobs' && req.method === 'GET') {
      requireAdmin(req);
      const jobs = db.prepare(`
        SELECT j.id, j.estado, j.intentos, j.error, j.created_at, j.locked_at, j.finished_at,
               md.item_id, md.bytes, i.nombre AS item_nombre, u.email AS usuario
        FROM media_jobs j
        JOIN item_media md ON md.id = j.media_id
        JOIN items i ON i.id = md.item_id
        JOIN users u ON u.id = i.user_id
        ORDER BY j.id DESC LIMIT 100
      `).all();
      const resumen = Object.fromEntries(
        db.prepare(`SELECT estado, COUNT(*) AS n FROM media_jobs GROUP BY estado`).all().map((r) => [r.estado, r.n])
      );
      return sendJson(res, 200, { resumen, jobs });
    }

    if ((match = m(/^\/api\/jobs\/(\d+)\/reintentar$/)) && req.method === 'POST') {
      requireAdmin(req);
      const job = db.prepare(`SELECT * FROM media_jobs WHERE id = ?`).get(Number(match[1]));
      if (!job) throw httpError(404, 'Tarea no encontrada.');
      if (job.estado !== 'error') throw httpError(409, 'Solo se pueden reintentar tareas con error.');
      tx(db, () => {
        db.prepare(`UPDATE media_jobs SET estado = 'pendiente', intentos = 0, error = NULL WHERE id = ?`).run(job.id);
        db.prepare(`UPDATE item_media SET estado = 'pendiente' WHERE id = ?`).run(job.media_id);
      });
      return sendJson(res, 200, { ok: true });
    }

    // --- Archivos del bucket ---
    if (pathname.startsWith('/storage/') && req.method === 'GET') {
      return await serveStorage(req, res, decodeURIComponent(pathname.slice('/storage/'.length)));
    }

    // --- Frontend ---
    if (req.method === 'GET' && ['/', '/index.html', '/app.js'].includes(pathname)) {
      const file = pathname === '/app.js' ? 'app.js' : 'index.html';
      const contentType = file === 'app.js' ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      return res.end(await fsp.readFile(path.join(PUBLIC_DIR, file)));
    }

    sendJson(res, 404, { error: 'Ruta no encontrada.' });
  } catch (err) {
    if (!err.status) console.error(err);
    if (res.headersSent) return res.destroy();
    // Si se rechaza una subida sin leer el cuerpo, se cierra la conexión para no recibir el resto
    sendJson(res, err.status || 500, { error: err.status ? err.message : 'Error interno del servidor.' }, req.complete ? {} : { Connection: 'close' });
  }
});

// ---------------------------------------------------------------------------
// 7. Arranque (solo si se ejecuta directamente: node server.js)
// ---------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.PORT) || 3000;
  server.requestTimeout = 0; // subidas de video largas en redes móviles
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`📦 Organizador de Inventario corriendo en http://localhost:${PORT}`);
    optimizeExistingImages(db, bucket)
      .then(({ optimized, savedBytes }) => {
        if (optimized > 0) {
          console.log(`🖼️  ${optimized} imágenes existentes comprimidas a WebP (ahorro: ${(savedBytes / 1024).toFixed(1)} KB)`);
        }
      })
      .catch((err) => console.error('Error optimizando imágenes existentes:', err.message));
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
