import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDatabaseConfig, type DatabaseConfig } from '../config.js';
import { createPool } from './pool.js';

export async function runMigrations(config: DatabaseConfig): Promise<void> {
  if (config.username !== 'productops_migrator') throw new Error('Invalid migration role');
  const directory = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
  const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name)).sort();
  const pool = createPool(config);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(78423101)');
      await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now()
      )`);
      await client.query('REVOKE ALL ON public.schema_migrations FROM productops_app, PUBLIC');
      for (const version of files) {
        const sql = await readFile(resolve(directory, version), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const applied = await client.query<{ checksum: string }>('SELECT checksum FROM public.schema_migrations WHERE version = $1', [version]);
        if (applied.rows[0]) {
          if (applied.rows[0].checksum !== checksum) throw new Error('Applied migration checksum mismatch');
          continue;
        }
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)', [version, checksum]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}

async function main() {
  try { await runMigrations(loadDatabaseConfig(process.env.PRODUCTOPS_MIGRATOR_DB_URL, 'productops_migrator')); }
  catch {
    process.stderr.write('ProductOps migration failed; check local database configuration and migrations.\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
