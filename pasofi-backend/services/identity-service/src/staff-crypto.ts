import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

export const opaqueHash = (token: string) => createHash('sha256').update(token).digest();
export const isOpaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
export const freshOpaque = () => randomBytes(32).toString('base64url');

// OWASP's 32 MiB scrypt profile. A bounded queue allows only one memory-hard
// calculation per process, including comparisons against the dummy hash.
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
let hashing = false;
const waiting: Array<() => void> = [];
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (hashing) {
    if (waiting.length >= 4) throw new Error('password_capacity');
    await new Promise<void>(resolve => waiting.push(resolve));
  } else hashing = true;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, SCRYPT, (error, key) => error ? reject(error) : resolve(key)));
  } finally {
    const next = waiting.shift();
    if (next) next(); else hashing = false;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$32768$8$3$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored?: string): Promise<boolean> {
  const parts = stored?.split('$');
  const valid = parts?.length === 6 && parts[0] === 'scrypt' && parts[1] === '32768' && parts[2] === '8' && parts[3] === '3' && /^[A-Za-z0-9_-]{22}$/.test(parts[4]) && /^[A-Za-z0-9_-]{43}$/.test(parts[5]);
  const salt = valid ? Buffer.from(parts![4], 'base64url') : Buffer.alloc(16, 0x7d);
  const expected = valid ? Buffer.from(parts![5], 'base64url') : Buffer.alloc(32);
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && !!valid;
}

export function mfaKey(demo: boolean): Buffer | null {
  const value = process.env.STAFF_MFA_ENCRYPTION_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) return null;
  const key = Buffer.from(value, 'hex');
  // Uniform bytes are reserved for isolated demo/test fixtures, never production.
  if (!demo && key.every(byte => byte === key[0])) return null;
  return key;
}

export function encryptMfa(secret: string, key: Buffer, staffId: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`pamofi-staff-mfa-v1:${staffId}`));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptMfa(envelope: string, key: Buffer, staffId: string): string {
  const [version, iv, tag, ciphertext, extra] = envelope.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext || extra !== undefined || Buffer.from(iv, 'base64url').length !== 12 || Buffer.from(tag, 'base64url').length !== 16) throw new Error('mfa_envelope_invalid');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(`pamofi-staff-mfa-v1:${staffId}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export const newTotpSecret = () => new Secret({ size: 20 }).base32;
export const totp = (secret: string, email = '') => new TOTP({ issuer: 'PasoFi staff', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });
export function acceptedTotpCounter(secret: string, code: string, lastCounter: string | number, timestamp = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totp(secret).validate({ token: code, timestamp, window: 1 });
  if (delta === null) return null;
  const counter = Math.floor(timestamp / 30000) + delta;
  return BigInt(counter) > BigInt(lastCounter) ? counter : null;
}
