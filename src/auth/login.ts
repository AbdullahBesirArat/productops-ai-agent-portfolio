import type { Pool } from 'pg';
import { DUMMY_HASH, verifyPassword } from './password.js';
import { issueAccessToken, type SigningKey } from './signing.js';
import type { LoginLimiter } from './rate-limit.js';
export class InvalidCredentials extends Error {
  constructor() { super('Invalid credentials'); }
}
export async function login(pool: Pool, signing: SigningKey, input: unknown, limiter: { limiter: LoginLimiter; ip: string }): Promise<string> {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const slug = typeof body.org_slug === 'string' ? body.org_slug : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  limiter.limiter.consume(limiter.ip, slug, email);
  const valid = /^[a-z0-9-]{3,40}$/u.test(slug) && email.length <= 254 && !/[\u0000-\u001f\u007f]/u.test(email) && /^[^@\s]+@[^@\s]+$/u.test(email) && password.length >= 1 && password.length <= 256;
  const row = valid ? (await pool.query<{ user_id: string; org_id: string; password_hash: string }>(
    'SELECT user_id, org_id, password_hash FROM public.auth_login_lookup($1,$2)', [slug, email])).rows[0] : undefined;
  const verified = await verifyPassword(row?.password_hash ?? DUMMY_HASH, password);
  if (!valid || !row || !verified) throw new InvalidCredentials();
  const membership = await pool.query<{ active: boolean }>(
    'SELECT public.auth_membership_exists($1,$2) AS active', [row.org_id, row.user_id]);
  if (membership.rows[0]?.active !== true) throw new InvalidCredentials();
  return issueAccessToken({ sub: row.user_id, org: row.org_id }, signing);
}
