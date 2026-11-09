import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Migraciones versionadas con PRAGMA user_version. Nunca borran datos:
// solo agregan tablas/columnas o mueven datos. Agregar nuevas al final del array.
export const MIGRATIONS = [
  // v1: esquema base con autenticación (equivale al esquema previo sin versionar)
  (db) => {
    const userCols = db.prepare(`PRAGMA table_info(users)`).all();
    if (userCols.length > 0 && !userCols.some((c) => c.name === 'email')) {
      // Esquema anterior sin login: se archiva en vez de borrarse
      db.exec(`ALTER TABLE users RENAME TO legacy_users_v0;`);
      db.exec(`ALTER TABLE items RENAME TO legacy_items_v0;`);
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
  },

  // v2: campos nuevos, relaciones "contiene", multimedia y cola de compresión
  (db) => {
    db.exec(`
      ALTER TABLE items ADD COLUMN guardado_en TEXT;
      ALTER TABLE items ADD COLUMN marca TEXT;
      ALTER TABLE items ADD COLUMN modelo TEXT;
      ALTER TABLE items ADD COLUMN cantidad INTEGER NOT NULL DEFAULT 1 CHECK (cantidad >= 1);
      ALTER TABLE items ADD COLUMN moneda TEXT NOT NULL DEFAULT 'ARS' CHECK (moneda IN ('ARS', 'USD'));

      CREATE TABLE item_relations (
        parent_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        child_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        cantidad INTEGER NOT NULL DEFAULT 1 CHECK (cantidad >= 1),
        PRIMARY KEY (parent_id, child_id),
        CHECK (parent_id <> child_id)
      );
      CREATE INDEX idx_rel_child ON item_relations(child_id);

      CREATE TABLE item_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        tipo TEXT NOT NULL CHECK (tipo IN ('imagen', 'video')),
        storage_key TEXT,
        poster_key TEXT,
        estado TEXT NOT NULL DEFAULT 'listo'
          CHECK (estado IN ('pendiente', 'procesando', 'listo', 'error')),
        orden INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER,
        duracion_seg REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_media_item ON item_media(item_id, orden);

      CREATE TABLE media_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id INTEGER NOT NULL REFERENCES item_media(id) ON DELETE CASCADE,
        input_key TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pendiente'
          CHECK (estado IN ('pendiente', 'procesando', 'listo', 'error')),
        intentos INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        locked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );
      CREATE INDEX idx_jobs_estado ON media_jobs(estado, id);

      INSERT INTO item_media (item_id, tipo, storage_key, estado, orden)
        SELECT id, 'imagen', foto_key, 'listo', 0 FROM items;

      ALTER TABLE items DROP COLUMN foto_key;
    `);
  },

  // v3: sistema de categorías por objeto
  (db) => {
    db.exec(`
      ALTER TABLE items ADD COLUMN categoria TEXT NOT NULL DEFAULT 'General' CHECK (length(trim(categoria)) > 0);
      CREATE INDEX IF NOT EXISTS idx_items_user_cat ON items(user_id, categoria);

      UPDATE items SET categoria = 'Cables y Adaptadores'
        WHERE categoria = 'General' AND (nombre LIKE '%Cable%' OR nombre LIKE '%Adaptador%');
      UPDATE items SET categoria = 'Insumos PC'
        WHERE categoria = 'General' AND nombre LIKE '%Pasta térmica%';
      UPDATE items SET categoria = 'Tecnología'
        WHERE categoria = 'General' AND (nombre LIKE '%Tablet%' OR nombre LIKE '%Teclado%' OR nombre LIKE '%Capturadora%');
    `);
  }
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'inventory.db'));
  db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

  // BEGIN IMMEDIATE: web y worker pueden arrancar a la vez sin migrar dos veces
  MIGRATIONS.forEach((migrate, i) => {
    tx(db, () => {
      if (db.prepare(`PRAGMA user_version`).get().user_version < i + 1) {
        migrate(db);
        db.exec(`PRAGMA user_version = ${i + 1}`);
      }
    });
  });
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

