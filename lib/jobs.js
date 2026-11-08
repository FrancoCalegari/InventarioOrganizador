import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tx } from './db.js';

export const MAX_ATTEMPTS = 3;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 15 * 60 * 1000;

// Ejecuta un comando y devuelve stdout; en error incluye el final de stderr.
function run(cmd, args, { lowPriority = false } = {}) {
  const [bin, argv] = lowPriority ? ['nice', ['-n', '10', cmd, ...args]] : [cmd, args];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { timeout: JOB_TIMEOUT_MS, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} falló (${signal || code}): ${stderr.trim() || 'sin salida'}`));
    });
  });
}

// Comprime una imagen en disco a WebP (máx. 1280px, calidad 78).
// Si el archivo de entrada es un stub de test o ffmpeg no puede decodificarlo, conserva el original.
export async function compressImageInBucket(bucket, userId, currentKey) {
  const srcPath = bucket.resolve(currentKey);
  const srcStat = await fsp.stat(srcPath).catch(() => null);
  if (!srcStat?.isFile()) return { key: currentKey, bytes: 0 };

  const webpKey = `${Number(userId)}/${crypto.randomUUID()}.webp`;
  const dstPath = bucket.resolve(webpKey);
  await fsp.mkdir(path.dirname(dstPath), { recursive: true });

  try {
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', srcPath,
      '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease",
      '-c:v', 'libwebp', '-quality', '78', '-compression_level', '6',
      dstPath
    ]);
    const dstStat = await fsp.stat(dstPath);
    if (dstStat.size > 0 && dstStat.size < srcStat.size) {
      await bucket.remove(currentKey);
      return { key: webpKey, bytes: dstStat.size };
    }
    // Si ya estaba muy comprimida y WebP no ahorra espacio, si aún no era .webp o si queremos conservar la menor:
    if (dstStat.size > 0 && !currentKey.endsWith('.webp')) {
      await bucket.remove(currentKey);
      return { key: webpKey, bytes: dstStat.size };
    }
    await bucket.remove(webpKey);
    return { key: currentKey, bytes: srcStat.size };
  } catch {
    await bucket.remove(webpKey);
    return { key: currentKey, bytes: srcStat.size };
  }
}

// Revisa y comprime todas las imágenes existentes en item_media que aún no tengan bytes o no estén en .webp
export async function optimizeExistingImages(db, bucket) {
  const rows = db.prepare(`
    SELECT m.id, m.storage_key, m.bytes, i.user_id
    FROM item_media m
    JOIN items i ON i.id = m.item_id
    WHERE m.tipo = 'imagen' AND m.storage_key IS NOT NULL
      AND (m.bytes IS NULL OR m.storage_key NOT LIKE '%.webp')
  `).all();

  let optimized = 0;
  let savedBytes = 0;

  for (const row of rows) {
    const srcPath = bucket.resolve(row.storage_key);
    if (!fs.existsSync(srcPath)) continue;
    const beforeBytes = fs.statSync(srcPath).size;
    const { key, bytes } = await compressImageInBucket(bucket, row.user_id, row.storage_key);
    db.prepare(`UPDATE item_media SET storage_key = ?, bytes = ? WHERE id = ?`).run(key, bytes, row.id);
    if (key !== row.storage_key || row.bytes === null) {
      optimized++;
      savedBytes += Math.max(0, beforeBytes - bytes);
    }
  }

  return { optimized, savedBytes };
}

// ponytail: asume un único worker; con varios workers usar un timeout de locked_at
export function recoverJobs(db) {
  tx(db, () => {
    db.prepare(`
      UPDATE media_jobs
      SET estado = CASE WHEN intentos >= ${MAX_ATTEMPTS} THEN 'error' ELSE 'pendiente' END,
          error = COALESCE(error, 'Interrumpido por reinicio del worker'),
          locked_at = NULL
      WHERE estado = 'procesando'
    `).run();
    db.prepare(`
      UPDATE item_media
      SET estado = (SELECT j.estado FROM media_jobs j WHERE j.media_id = item_media.id ORDER BY j.id DESC LIMIT 1)
      WHERE estado = 'procesando'
    `).run();
  });
}

// Toma atómicamente la tarea pendiente más antigua
export function claimJob(db) {
  return tx(db, () => {
    const job = db.prepare(`
      UPDATE media_jobs
      SET estado = 'procesando', locked_at = datetime('now'), intentos = intentos + 1
      WHERE id = (
        SELECT id FROM media_jobs
        WHERE estado = 'pendiente' AND intentos < ${MAX_ATTEMPTS}
        ORDER BY id LIMIT 1
      )
      RETURNING *
    `).all()[0];
    if (job) db.prepare(`UPDATE item_media SET estado = 'procesando' WHERE id = ?`).run(job.media_id);
    return job || null;
  });
}

export async function processJob(db, bucket, job) {
  const media = db.prepare(`
    SELECT m.id, i.user_id FROM item_media m JOIN items i ON i.id = m.item_id WHERE m.id = ?
  `).get(job.media_id);
  if (!media) return { ok: false, error: 'El archivo fue eliminado' };

  const base = `${media.user_id}/${crypto.randomUUID()}`;
  const outKey = `${base}.mp4`;
  const posterKey = `${base}.webp`;
  const input = bucket.resolve(job.input_key);
  const out = bucket.resolve(outKey);
  const poster = bucket.resolve(posterKey);
  await fsp.mkdir(path.dirname(out), { recursive: true });

  try {
    // H.264 720p máx. (lado mayor 1280, sin agrandar), AAC 96k, faststart para streaming
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      '-threads', '2',
      out
    ], { lowPriority: true });

    const duracion = Number(await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out
    ])) || 0;

    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(Math.min(1, duracion / 2)), '-i', out,
      '-frames:v', '1', '-vf', "scale='min(640,iw)':-2",
      '-c:v', 'libwebp', '-quality', '75',
      poster
    ], { lowPriority: true });

    const { size } = await fsp.stat(out);
    const saved = tx(db, () => {
      const res = db.prepare(`
        UPDATE item_media
        SET storage_key = ?, poster_key = ?, estado = 'listo', bytes = ?, duracion_seg = ?
        WHERE id = ?
      `).run(outKey, posterKey, size, duracion, media.id);
      db.prepare(`
        UPDATE media_jobs SET estado = 'listo', error = NULL, locked_at = NULL, finished_at = datetime('now')
        WHERE id = ?
      `).run(job.id);
      return res.changes > 0;
    });

    if (saved) await bucket.remove(job.input_key);
    else await bucket.remove(outKey, posterKey);
    return { ok: saved, bytes: size };
  } catch (err) {
    await bucket.remove(outKey, posterKey);
    const estado = job.intentos >= MAX_ATTEMPTS ? 'error' : 'pendiente';
    tx(db, () => {
      db.prepare(`UPDATE media_jobs SET estado = ?, error = ?, locked_at = NULL WHERE id = ?`)
        .run(estado, err.message.slice(0, 2000), job.id);
      db.prepare(`UPDATE item_media SET estado = ? WHERE id = ?`).run(estado, media.id);
    });
    return { ok: false, error: err.message };
  }
}
