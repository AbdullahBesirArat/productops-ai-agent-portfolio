import type { VerificationKeys } from './jwt.js';
import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant.js';
import { AuthError, verifyAccessToken, type Identity } from './jwt.js';
import { can, isRole, type Permission, type Role } from './permissions.js';
export interface AuthDeps { pool: Pool; verificationKeys: VerificationKeys }
export class Forbidden extends Error { constructor() { super('Forbidden'); } }
export async function authenticate(request: FastifyRequest, verificationKeys: VerificationKeys): Promise<Identity> {
  const raw = request.raw.rawHeaders;
  if (raw.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length !== 1) throw new AuthError();
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)) throw new AuthError();
  return verifyAccessToken(value.slice(7), verificationKeys);
}
export async function withAuthorizedTenant<T>(deps: AuthDeps, request: FastifyRequest, permission: Permission | undefined,
  fn: (context: Identity & { client: PoolClient; role: Role }) => Promise<T>): Promise<T> {
  const identity = await authenticate(request, deps.verificationKeys);
  return withTenant(deps.pool, identity.org, async client => {
    const result = await client.query<{ role: unknown }>('SELECT role FROM memberships WHERE user_id=$1', [identity.sub]);
    const role = result.rows[0]?.role;
    if (!isRole(role) || (permission !== undefined && !can(role, permission))) throw new Forbidden();
    return fn({ ...identity, client, role });
  });
}
