import { createPrivateKey, randomUUID, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import { ACCESS_TOKEN_SECONDS, AuthError, JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER, uuid, validKid, type Identity } from './jwt.js';

export interface SigningKey { kid: string; key: KeyObject }

export function loadSigningKey(kid: unknown, pem: unknown): SigningKey {
  try {
    if (!validKid(kid) || typeof pem !== 'string' ||
        !/^-----BEGIN PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/]+={0,2}\r?\n)+-----END PRIVATE KEY-----\r?\n?$/u.test(pem)) throw new Error();
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
    return { kid, key };
  } catch { throw new Error('Invalid JWT signing key'); }
}

export async function issueAccessToken(identity: Identity, signing: SigningKey, expiresIn = ACCESS_TOKEN_SECONDS): Promise<string> {
  if (!uuid(identity.sub) || !uuid(identity.org) || !Number.isSafeInteger(expiresIn) ||
      !validKid(signing.kid) || signing.key.type !== 'private' || signing.key.asymmetricKeyType !== 'ed25519') throw new AuthError();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ org: identity.org }).setProtectedHeader({ alg: JWT_ALGORITHM, kid: signing.kid })
    .setSubject(identity.sub).setIssuer(JWT_ISSUER).setAudience(JWT_AUDIENCE)
    .setIssuedAt(now).setExpirationTime(now + expiresIn).setJti(randomUUID()).sign(signing.key);
}
