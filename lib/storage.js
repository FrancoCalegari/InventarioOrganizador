import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif'
};

export const VIDEO_TYPES = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi'
};

export const MIME_BY_EXT = {
  ...Object.fromEntries(Object.entries(IMAGE_TYPES).map(([k, v]) => [v, k])),
  ...Object.fromEntries(Object.entries(VIDEO_TYPES).map(([k, v]) => [v, k]))
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Bucket local sobre el sistema de archivos. Claves: "<userId>/<uuid>.<ext>" y "_originales/<uuid>.<ext>".
// ponytail: FS local; cambiar estas funciones por un cliente S3 si se migra a nube externa
export function createBucket(rootDir) {
  const root = path.resolve(rootDir);
  fs.mkdirSync(root, { recursive: true });

  function resolve(key) {
    const resolved = path.resolve(root, String(key).replace(/^\/+/, ''));
    if (!resolved.startsWith(root + path.sep)) throw httpError(400, 'Clave de almacenamiento inválida.');
    return resolved;
  }

  async function writeStream(key, readable, maxBytes) {
    const fullPath = resolve(key);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    let bytes = 0;
    const limit = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        cb(bytes > maxBytes ? httpError(413, 'El archivo supera el tamaño máximo permitido.') : null, chunk);
      }
    });
    try {
      await pipeline(readable, limit, fs.createWriteStream(fullPath));
    } catch (err) {
      await fsp.rm(fullPath, { force: true });
      throw err;
    }
    if (bytes === 0) {
      await fsp.rm(fullPath, { force: true });
      throw httpError(400, 'El archivo está vacío.');
    }
    return bytes;
  }

  async function remove(...keys) {
    for (const key of keys.filter(Boolean)) {
      await fsp.rm(resolve(key), { force: true });
    }
  }

  return { root, resolve, writeStream, remove };
}

