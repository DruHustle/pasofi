import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

// This deployment serves PasoFi only. Other products need their own reviewed
// sender, credential and payload contract before adding another audience.
export const invoiceRelayPath = '/v1/products/pasofi/invoice-email';
export const invoiceRelaySender = 'PasoFi <notifications-pasofi@onesa.eu>';
export const relayUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const issuer = 'pasofi-notification', audience = 'onesa-email-relay:pasofi';

export function validRelaySecret(secret: string) {
  return Buffer.byteLength(secret) >= 32 && Buffer.byteLength(secret) <= 512 && !/[\r\n\0]/.test(secret) && !secret.startsWith('DEMO_ONLY_');
}
export function isRelaySender(from: string) {
  return from === invoiceRelaySender || from === 'notifications-pasofi@onesa.eu';
}
export function relayScope(method: string, path: string) {
  if (method === 'POST' && path === invoiceRelayPath) return 'email:send';
  if (method === 'GET' && path === `${invoiceRelayPath}/capabilities`) return 'email:status';
  if (method === 'GET' && path.startsWith(`${invoiceRelayPath}/`) && relayUuid.test(path.slice(invoiceRelayPath.length + 1))) return 'email:read';
  return null;
}
export const relayBodyHash = (body: unknown) => createHash('sha256').update(body === undefined ? '' : JSON.stringify(body)).digest('hex');

export async function relayAuthorization(secret: string, method: string, path: string, body?: unknown) {
  const scope = relayScope(method, path);
  if (!validRelaySecret(secret) || !scope) throw Error('invalid_email_relay_request');
  return new SignJWT({ product: 'pasofi', scope, method, path, bodySha256: relayBodyHash(body) })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setSubject('pasofi').setAudience(audience)
    .setJti(randomUUID()).setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
}

export async function verifyRelayAuthorization(secret: string, token: string, method: string, path: string) {
  if (!validRelaySecret(secret) || token.length > 4096) throw Error('invalid_email_relay_authorization');
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'], issuer, subject: 'pasofi', audience,
    requiredClaims: ['exp', 'iat', 'jti', 'sub'], maxTokenAge: '30s', clockTolerance: 2,
  });
  if (payload.product !== 'pasofi' || payload.scope !== relayScope(method, path) || payload.method !== method || payload.path !== path
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 30
    || !relayUuid.test(String(payload.jti)) || typeof payload.bodySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.bodySha256)) throw Error('invalid_email_relay_authorization');
  return payload.bodySha256;
}

export function matchesRelayBody(expected: string, body: unknown) {
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(relayBodyHash(body), 'hex'));
}
