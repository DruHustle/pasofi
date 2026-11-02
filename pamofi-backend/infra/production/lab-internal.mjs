// Piped to `docker compose exec -T SERVICE node --input-type=module`; no service
// source is imported and no credential value is printed.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

const service = process.env.PAMOFI_SERVICE, short = service === 'prepaid-access' ? 'prepaid' : service;
assert.notEqual(process.getuid(), 0);
assert.equal(process.env.DATABASE_URL, undefined);
const url = new URL((await readFile(process.env.DATABASE_URL_FILE, 'utf8')).trim());
assert.match(url.username, /_runtime$/);
for (const [name, path] of Object.entries(process.env)) if (name.endsWith('_FILE')) assert.ok((await readFile(path)).length > 0);
await assert.rejects(stat(`/run/secrets/${short}_migrate_url`), { code: 'ENOENT' });
await assert.rejects(stat('/run/secrets/postgres_password'), { code: 'ENOENT' });
const sign = (secret, audience, scope) => {
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'HS256' })}.${encode({ iss: 'prepaid-access', sub: 'prepaid-access', aud: audience, iat: now, exp: now + 15, scope })}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
};
async function get(url, authorization) { return fetch(url, { headers: authorization ? { authorization: `Bearer ${authorization}` } : {}, signal: AbortSignal.timeout(5000), redirect: 'error' }); }
if (service === 'identity') {
  const secret = (await readFile(process.env.INTERNAL_IDENTITY_SECRET_FILE, 'utf8')).trim();
  let result = await get('https://identity.internal/internal/v1/session'); assert.equal(result.status, 401);
  result = await get('https://identity.internal/internal/v1/session', sign(secret, 'identity', 'identity:resolve')); assert.equal(result.status, 401); assert.equal((await result.json()).error, 'not_authenticated');
  result = await get('https://identity.internal/internal/v1/session', sign(secret, 'identity', 'staff:resolve')); assert.equal(result.status, 403);
  result = await get('https://identity.internal/internal/v1/staff/users/00000000-0000-0000-0000-000000000000', sign(secret, 'identity', 'staff:read')); assert.equal(result.status, 404); assert.equal((await result.json()).error, 'staff_not_found');
  for (const target of ['https://identity.internal/v1/session', 'https://identity.internal/internal/v1/session/extra', 'https://prepaid.internal/v1/bundles', 'https://notification.internal/v1/session', 'https://network.internal/v1/sites']) assert.equal((await get(target)).status, 404);
}
if (service === 'prepaid-access') {
  const secret = (await readFile(process.env.INTERNAL_DELIVERY_SECRET_FILE, 'utf8')).trim();
  const target = 'https://notification.internal/internal/v1/delivery/capabilities';
  assert.equal((await get(target)).status, 401);
  assert.equal((await get(target, sign(secret, 'notification', 'delivery:resend'))).status, 403);
  const response = await get(target, sign(secret, 'notification', 'delivery:status'));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { enabled: false, mode: 'disabled', simulation: false });
}
console.log(`Non-root secret mounts and private TLS checks passed for ${service}.`);
