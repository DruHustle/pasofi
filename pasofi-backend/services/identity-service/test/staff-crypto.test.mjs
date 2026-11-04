import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword, encryptMfa, decryptMfa, acceptedTotpCounter, totp } from '../dist/staff-crypto.js';
import { Secret, TOTP } from 'otpauth';

test('password hashing is salted, memory-hard and verifies neither a wrong password nor a missing account', async () => {
  const password = 'test-only long passphrase 481';
  const first = await hashPassword(password), second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$32768\$8\$3\$/);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('wrong test-only passphrase', first), false);
  assert.equal(await verifyPassword(password), false);
});

test('MFA encryption authenticates the key, ciphertext and staff identity', () => {
  const secret = new Secret({ size: 20 }).base32, key = randomBytes(32), staffId = randomUUID();
  const encrypted = encryptMfa(secret, key, staffId);
  assert.equal(encrypted.includes(secret), false);
  assert.equal(decryptMfa(encrypted, key, staffId), secret);
  assert.throws(() => decryptMfa(encrypted, randomBytes(32), staffId));
  assert.throws(() => decryptMfa(encrypted, key, randomUUID()));
  const pieces = encrypted.split('.');
  const changed = Buffer.from(pieces[3], 'base64url');
  changed[0] ^= 1; pieces[3] = changed.toString('base64url');
  assert.throws(() => decryptMfa(pieces.join('.'), key, staffId));
});

test('TOTP agrees with the RFC6238 SHA1 vector and enforces bounded clock drift and counter replay prevention', () => {
  const secret = Secret.fromUTF8('12345678901234567890');
  assert.equal(new TOTP({ secret, digits: 8, algorithm: 'SHA1', period: 30 }).generate({ timestamp: 59000 }), '94287082');
  const now = 1700000000000, otp = totp(secret.base32), current = Math.floor(now / 30000);
  const code = otp.generate({ timestamp: now });
  assert.equal(acceptedTotpCounter(secret.base32, code, current - 1, now), current);
  assert.equal(acceptedTotpCounter(secret.base32, code, current, now), null);
  assert.equal(acceptedTotpCounter(secret.base32, otp.generate({ timestamp: now - 120000 }), -1, now), null);
  assert.equal(acceptedTotpCounter(secret.base32, '123', -1, now), null);
});
