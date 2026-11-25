import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDatabaseConfig, type DatabaseConfig } from '../config.js';
import { hashPassword } from '../auth/password.js';
import { createPool } from './pool.js';
import { SEED_TENANTS, SEED_TABLES } from './seed-data.js';

export async function populate(config: DatabaseConfig, password: string | undefined, business: boolean): Promise<Record<string, number>> {
  // Revalidate even programmatically supplied configs before opening a connection.
  if (config.username !== 'productops_bootstrap' || !['productops_dev', 'productops_test'].includes(config.database) ||
      !['localhost', '127.0.0.1'].includes(config.host)) throw new Error('Invalid bootstrap database');
  if (!password || password.length > 256) throw new Error('Invalid demo password');
  const hash = await hashPassword(password);
  const pool = createPool(config);
  try {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(78423102)');
      for (const t of business ? SEED_TENANTS : SEED_TENANTS.slice(0, 1)) {
        await c.query('INSERT INTO public.organizations(id,name,slug) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [t.id, t.name, t.slug]);
        for (const u of business ? t.users : t.users.slice(0, 1)) {
          await c.query('INSERT INTO public.users(id,email) VALUES($1,$2) ON CONFLICT DO NOTHING', [u.id, u.email]);
          await c.query('INSERT INTO public.memberships(org_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [t.id, u.id, u.role]);
          await c.query('INSERT INTO public.user_credentials(user_id,password_hash) VALUES($1,$2) ON CONFLICT DO NOTHING', [u.id, hash]);
        }
        if (!business) continue;
        for (const x of t.products) await c.query('INSERT INTO public.products(id,org_id,sku,name,stock,reorder_level) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [x.id, t.id, x.sku, x.name, x.stock, x.reorderLevel]);
        for (const x of t.orders) await c.query('INSERT INTO public.orders(id,org_id,order_code,customer_ref,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [x.id, t.id, x.code, x.customerRef, x.status]);
        for (const x of t.policies) await c.query('INSERT INTO public.policy_snippets(id,org_id,slug,title,body,topic,version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET topic = EXCLUDED.topic, version = EXCLUDED.version', [x.id, t.id, x.slug, x.title, x.body, x.topic, x.version]);
      }
      const counts: Record<string, number> = {};
      for (const table of SEED_TABLES) counts[table] = (await c.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;
      await c.query('COMMIT');
      return counts;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  } finally { await pool.end(); }
}
export const runBootstrap = (config: DatabaseConfig, password: string | undefined) => populate(config, password, false);
async function main() {
  try {
    console.log(await runBootstrap(loadDatabaseConfig(process.env.PRODUCTOPS_BOOTSTRAP_DB_URL, 'productops_bootstrap'), process.env.PRODUCTOPS_DEMO_PASSWORD));
  } catch { process.stderr.write('ProductOps bootstrap failed.\n'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
