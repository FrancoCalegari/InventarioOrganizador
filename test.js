// Self-check: node test.js  (usa una carpeta temporal, no toca data/ ni storage/)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './lib/db.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-test-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.BUCKET_DIR = path.join(tmp, 'storage');

// 1. Base "vieja" (esquema v1 sin versionar, con foto_key) para probar la migración sin pérdida
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.BUCKET_DIR, '1'), { recursive: true });
fs.writeFileSync(path.join(process.env.BUCKET_DIR, '1/legacy.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
const legacy = new DatabaseSync(path.join(process.env.DATA_DIR, 'inventory.db'));
MIGRATIONS[0](legacy);
legacy.exec(`
  INSERT INTO users (id, email, password_hash, role) VALUES (1, 'legacy@test.com', 'x:y', 'user');
  INSERT INTO items (user_id, foto_key, nombre, fecha_obtenido) VALUES (1, '1/legacy.jpg', 'Objeto viejo', '2024-01-01');
`);
legacy.close();

const { server, db, bucket } = await import('./server.js');
const { claimJob, processJob, recoverJobs } = await import('./lib/jobs.js');

try {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  const migrated = db.prepare(`SELECT * FROM item_media WHERE storage_key = '1/legacy.jpg'`).get();
  assert.ok(migrated, 'la foto vieja debe pasar a item_media');
  assert.ok(!db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'foto_key'));
  assert.equal(db.prepare(`SELECT moneda, cantidad FROM items WHERE nombre = 'Objeto viejo'`).get().moneda, 'ARS');

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'francocalegari55@gmail.com', password: '137546321' })
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).role, 'admin');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (p, method = 'GET', body) =>
    fetch(`${base}${p}`, {
      method,
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });

  // 2. Campos nuevos + moneda por defecto ARS + categorías
  const neceser = await (await api('/api/items', 'POST', { nombre: 'Neceser', categoria: 'Accesorios', marca: 'Samsonite', precio: 25000, guardado_en: 'Placard' })).json();
  assert.equal(neceser.moneda, 'ARS');
  assert.equal(neceser.categoria, 'Accesorios');
  assert.equal(neceser.cantidad, 1);
  const cepillo = await (await api('/api/items', 'POST', { nombre: 'Cepillo', categoria: 'Hogar', modelo: 'Pro 3', cantidad: 3, precio: 10, moneda: 'USD' })).json();
  assert.equal(cepillo.moneda, 'USD');
  assert.equal(cepillo.categoria, 'Hogar');
  const catsRes = await (await api('/api/categorias')).json();
  assert.ok(catsRes.categorias.some((c) => c.categoria === 'Accesorios'));
  const filteredByCat = await (await api('/api/items?categoria=Accesorios')).json();
  assert.equal(filteredByCat.length, 1);
  assert.equal(filteredByCat[0].id, neceser.id);
  const limited = await (await api('/api/items?limit=1')).json();
  assert.equal(limited.length, 1);
  assert.equal((await api('/api/items', 'POST', { nombre: 'X', moneda: 'EUR' })).status, 400);
  assert.equal((await api('/api/items', 'POST', { nombre: 'X', cantidad: 0 })).status, 400);

  // 3. Relaciones: neceser contiene 2 cepillos; ciclo y objeto de otro usuario rechazados
  const rel = await api(`/api/items/${neceser.id}`, 'PATCH', { relaciones: [{ child_id: cepillo.id, cantidad: 2 }] });
  assert.equal(rel.status, 200);
  assert.deepEqual((await rel.json()).contiene.map((c) => [c.id, c.cantidad]), [[cepillo.id, 2]]);
  assert.equal((await api(`/api/items/${cepillo.id}`, 'PATCH', { relaciones: [{ child_id: neceser.id }] })).status, 400);
  assert.equal((await api(`/api/items/${neceser.id}`, 'PATCH', { relaciones: [{ child_id: migrated.item_id }] })).status, 400);
  assert.equal((await api(`/api/items/${neceser.id}`, 'PATCH', { relaciones: [{ child_id: neceser.id }] })).status, 400);
  const detCepillo = await (await api(`/api/items/${cepillo.id}`)).json();
  assert.equal(detCepillo.contenido_en[0].id, neceser.id);
  const list = await (await api('/api/items')).json();
  assert.equal(list.find((i) => i.id === neceser.id).contiene[0].cantidad, 2);
  assert.equal(neceser.marca, 'Samsonite');

  // 4. Imagen: subida por streaming + acceso protegido
  const imgRes = await fetch(`${base}/api/items/${neceser.id}/media`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'image/jpeg' },
    body: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  });
  assert.equal(imgRes.status, 201);
  const img = await imgRes.json();
  assert.equal((await api(img.url)).status, 200);
  assert.equal((await fetch(`${base}${img.url}`)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/items/${neceser.id}/media`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/pdf' },
      body: 'x'
    })).status,
    415
  );

  // 5. Video: cola de compresión con ffmpeg
  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  if (hasFfmpeg) {
    const raw = path.join(tmp, 'in.mp4');
    const gen = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=1920x1080:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'mpeg4', '-q:v', '1', '-c:a', 'aac', '-shortest', raw
    ]);
    assert.equal(gen.status, 0, gen.stderr?.toString());
    const rawSize = fs.statSync(raw).size;

    const vidRes = await fetch(`${base}/api/items/${neceser.id}/media`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'video/mp4' },
      body: fs.readFileSync(raw)
    });
    assert.equal(vidRes.status, 202);
    const vid = await vidRes.json();
    assert.equal(vid.estado, 'pendiente');

    // Recuperación: una tarea "procesando" huérfana vuelve a pendiente
    const job = claimJob(db);
    assert.ok(job);
    recoverJobs(db);
    assert.equal(db.prepare('SELECT estado FROM media_jobs WHERE id = ?').get(job.id).estado, 'pendiente');

    const job2 = claimJob(db);
    const result = await processJob(db, bucket, job2);
    assert.ok(result.ok, result.error);
    const done = (await (await api(`/api/items/${neceser.id}`)).json()).media.find((x) => x.id === vid.id);
    assert.equal(done.estado, 'listo');
    assert.ok(done.bytes < rawSize, 'el video comprimido debe pesar menos');
    assert.ok(done.poster_url);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_jobs WHERE estado = ?').get('listo').n, 1);
    assert.equal(fs.readdirSync(path.join(process.env.BUCKET_DIR, '_originales')).length, 0, 'original borrado');

    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', bucket.resolve(done.url.slice(9))]);
    assert.equal(probe.stdout.toString().trim(), '1280,720');

    const ranged = await fetch(`${base}${done.url}`, { headers: { Cookie: cookie, Range: 'bytes=0-99' } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);

    const jobs = await (await api('/api/jobs')).json();
    assert.equal(jobs.resumen.listo, 1);
  } else {
    console.warn('⚠️  ffmpeg no instalado: se omite la prueba de video');
  }

  // 6. Baja en cascada opcional
  const baja = await api(`/api/items/${neceser.id}/baja`, 'PATCH', { motivo_baja: 'vendido', incluir_contenido: true });
  assert.equal(baja.status, 200);
  assert.equal((await (await api(`/api/items/${cepillo.id}`)).json()).motivo_baja, 'vendido');

  // 7. Borrar objeto elimina sus archivos
  const files = (await (await api(`/api/items/${neceser.id}`)).json()).media.flatMap((x) => [x.url, x.poster_url]).filter(Boolean);
  assert.equal((await api(`/api/items/${neceser.id}`, 'DELETE')).status, 200);
  for (const f of files) assert.ok(!fs.existsSync(bucket.resolve(f.slice(9))), `${f} debe borrarse`);
  assert.equal((await (await api(`/api/items/${cepillo.id}`)).json()).contenido_en.length, 0);

  console.log('✅ Self-check completado: migración v2, campos, relaciones, multimedia y cola de video verificados.');
} finally {
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

