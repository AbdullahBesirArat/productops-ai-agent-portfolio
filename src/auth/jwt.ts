import { createPublicKey, type KeyObject } from 'node:crypto';
import { jwtVerify } from 'jose';

export class AuthError extends Error {
  constructor() { super('Unauthorized'); }
}
export interface Identity { sub: string; org: string }
export const JWT_ALGORITHM = 'EdDSA';
export const JWT_ISSUER = 'productops-local';
export const JWT_AUDIENCE = 'productops-api';
export const ACCESS_TOKEN_SECONDS = 900;
export type VerificationKeys = ReadonlyMap<string, KeyObject>;
export const validKid = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
export const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);

export function loadVerificationKeys(raw: string): VerificationKeys {
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) throw new Error();
    const keys = new Map<string, KeyObject>();
    for (const entry of entries) {
      if (!entry || !validKid(entry.kid) || keys.has(entry.kid) ||
          typeof entry.pem !== 'string' || !/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/]+={0,2}\r?\n)+-----END PUBLIC KEY-----\r?\n?$/u.test(entry.pem)) throw new Error();
      const key = createPublicKey(entry.pem);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error();
      keys.set(entry.kid, key);
    }
    return keys;
  } catch { throw new Error('Invalid JWT verification keys'); }
}

export async function verifyAccessToken(token: string, keys: VerificationKeys): Promise<Identity> {
  try {
    if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) throw new AuthError();
    const { payload } = await jwtVerify(token, header => {
      const key = validKid(header.kid) ? keys.get(header.kid) : undefined;
      if (header.alg !== JWT_ALGORITHM || !key) throw new AuthError();
      return key;
    }, {
      algorithms: [JWT_ALGORITHM], issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
      requiredClaims: ['sub', 'org', 'exp', 'iat'], clockTolerance: 2,
    });
    if (!uuid(payload.sub) || !uuid(payload.org) || !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) || payload.aud !== JWT_AUDIENCE ||
        typeof payload.exp !== 'number' || typeof payload.iat !== 'number' ||
        payload.iat > Math.floor(Date.now() / 1000) + 2 ||
        payload.exp <= payload.iat || payload.exp - payload.iat > ACCESS_TOKEN_SECONDS ||
        (payload.jti !== undefined && typeof payload.jti !== 'string')) throw new AuthError();
    return { sub: payload.sub, org: payload.org };
  } catch { throw new AuthError(); }
}
