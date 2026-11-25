import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const N = 32768, r = 8, p = 1;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}
function valid(password: string): boolean {
  return typeof password === 'string' && password.length >= 1 && password.length <= 256;
}
export async function hashPassword(password: string): Promise<string> {
  if (!valid(password)) throw new Error('Invalid password length');
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export const DUMMY_HASH = await hashPassword(randomBytes(32).toString('hex'));
export async function verifyPassword(stored: string, candidate: string): Promise<boolean> {
  try {
    const parts = typeof stored === 'string' ? stored.split('$') : [];
    const salt = Buffer.from(parts[4] ?? '', 'base64');
    const expected = Buffer.from(parts[5] ?? '', 'base64');
    const wellFormed = parts.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$32768$8$1' &&
      salt.length === 16 && expected.length === 64 && salt.toString('base64') === parts[4] &&
      expected.toString('base64') === parts[5];
    const actual = await derive(valid(candidate) ? candidate : '', wellFormed ? salt : Buffer.alloc(16));
    return timingSafeEqual(actual, wellFormed ? expected : Buffer.alloc(64)) && wellFormed && valid(candidate);
  } catch { return false; }
}
