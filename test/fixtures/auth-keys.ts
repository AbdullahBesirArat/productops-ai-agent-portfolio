import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { loadVerificationKeys } from '../../src/auth/jwt.js';
import { loadSigningKey } from '../../src/auth/signing.js';
import { buildAuthService } from '../../src/auth-server.js';
import type { Pool } from 'pg';

export function testKeys(kid = 'synthetic') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const env = { PRODUCTOPS_JWT_PUBLIC_KEYS: JSON.stringify([{ kid, pem }]),
    PRODUCTOPS_REQUEST_DIGEST_SECRET: randomBytes(32).toString('hex') };
  return { env, pem, privatePem, signing: loadSigningKey(kid, privatePem), keys: loadVerificationKeys(env.PRODUCTOPS_JWT_PUBLIC_KEYS) };
}

export async function authFixture(keys = testKeys(), pool?: Pool) {
  if (pool) {
    const app = buildAuthService(pool, keys.signing);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    return { pid: undefined, origin, env: { ...keys.env, PRODUCTOPS_AUTH_PORT: new URL(origin).port }, close: () => app.close() };
  }
  const url = process.env.PRODUCTOPS_AUTH_TEST_DB_URL;
  if (!url) throw new Error('PRODUCTOPS_AUTH_TEST_DB_URL is required');
  const service = await serviceFixture('auth-server', {
    PRODUCTOPS_AUTH_DB_URL: url, PRODUCTOPS_JWT_PRIVATE_KEY: keys.privatePem,
    PRODUCTOPS_JWT_KID: keys.signing.kid, PRODUCTOPS_AUTH_PORT: '0',
  });
  return { ...service, env: { ...keys.env, PRODUCTOPS_AUTH_PORT: new URL(service.origin).port } };
}

export async function serviceFixture(entry: 'auth-server' | 'server', env: NodeJS.ProcessEnv) {
  const child = fork(fileURLToPath(new URL('../../src/' + entry + '.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...env },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const done = once(child, 'exit');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const message = await Promise.race([
      once(child, 'message').then(([value]) => value as unknown),
      done.then(() => { throw new Error('Test auth child exited before readiness'); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Test auth child readiness timed out')), 10000); }),
    ]) as { port?: number };
    if (!Number.isInteger(message.port) || !message.port) throw new Error('Invalid test auth port');
    return { pid: child.pid, origin: 'http://127.0.0.1:' + message.port, async close() { child.kill(); await done; } };
  } catch (error) { child.kill(); await done; throw error; }
  finally { clearTimeout(timer); }
}
