import type { Pool, PoolClient } from 'pg';

// No nested calls on the same client. orgId and actorId must come from verified identity.
// RLS guards against missing predicates and confused-deputy bugs. A compromised runtime
// can set both context values itself.
// Never expose raw SQL to untrusted input.
export interface TenantOptions { readOnly?: boolean; statementTimeoutMs?: number; actorId?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export async function withTenant<T>(pool: Pool, orgId: unknown, fn: (client: PoolClient) => Promise<T>, options: TenantOptions = {}): Promise<T> {
  if (typeof orgId !== 'string' || !UUID.test(orgId)) {
    throw new Error('Invalid tenant identifier');
  }
  const { actorId } = options;
  if (actorId !== undefined && (typeof actorId !== 'string' || !UUID.test(actorId))) {
    throw new Error('Invalid actor identifier');
  }
  if (options.statementTimeoutMs !== undefined && (!Number.isInteger(options.statementTimeoutMs) || options.statementTimeoutMs < 1 || options.statementTimeoutMs > 10000)) {
    throw new Error('Invalid statement timeout');
  }
  const client = await pool.connect();
  let discard = false;
  try {
    if (options.readOnly) await client.query('BEGIN READ ONLY');
    else await client.query('BEGIN');
    if (options.statementTimeoutMs !== undefined) await client.query("SELECT set_config('statement_timeout', $1, true)", [String(options.statementTimeoutMs)]);
    await client.query("SELECT set_config('productops.org_id', $1, true)", [orgId]);
    if (actorId !== undefined) await client.query("SELECT set_config('productops.actor_id', $1, true)", [actorId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}
