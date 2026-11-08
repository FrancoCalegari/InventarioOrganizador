import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from './lib/db.js';
import { createBucket } from './lib/storage.js';
import { recoverJobs, claimJob, processJob } from './lib/jobs.js';

const ROOT_DIR = import.meta.dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const BUCKET_DIR = process.env.BUCKET_DIR || path.join(ROOT_DIR, 'storage/buckets/items');
const POLL_MS = Number(process.env.WORKER_POLL_MS) || 3000;

const db = openDb(DATA_DIR);
const bucket = createBucket(BUCKET_DIR);

let stopping = false;
const stop = () => {
  stopping = true;
  console.log('🛑 Worker: terminando la tarea actual y saliendo...');
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

recoverJobs(db);
console.log('🎬 Worker de compresión de video listo (1 tarea a la vez).');

// Una tarea a la vez para no saturar CPU/RAM; la cola vive en SQLite (media_jobs)
while (!stopping) {
  const job = claimJob(db);
  if (!job) {
    await sleep(POLL_MS);
    continue;
  }
  const started = Date.now();
  console.log(`▶️  Tarea #${job.id} (intento ${job.intentos})`);
  const result = await processJob(db, bucket, job);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (result.ok) console.log(`✅ Tarea #${job.id} lista en ${secs}s (${(result.bytes / 1e6).toFixed(1)} MB)`);
  else console.error(`❌ Tarea #${job.id} falló en ${secs}s: ${result.error}`);
}

db.close();

