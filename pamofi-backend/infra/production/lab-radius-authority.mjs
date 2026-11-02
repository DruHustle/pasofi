// Piped into an owned, profiled, non-root Node probe on radius_transport.
// It has only disposable client TLS material and no database/service secret.
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';

assert.equal(process.env.PAMOFI_PRODUCTION_AUTHORITY_SMOKE, 'disposable-fixture');
assert.notEqual(process.getuid(), 0);
const nas = process.env.PAMOFI_AUTHORITY_SMOKE_NAS;
assert.match(nas, /^lab_unregistered_[a-f0-9]{16}$/);
const ca = await readFile('/run/secrets/radius_ca');
const cert = await readFile('/run/secrets/radius_client_cert');
const key = await readFile('/run/secrets/radius_client_key');
const wrongCa = await readFile('/run/secrets/radius_probe_wrong_ca');
assert.equal(new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase(), process.env.PAMOFI_AUTHORITY_SMOKE_FINGERPRINT);
assert.ok(new X509Certificate(cert).verify(new X509Certificate(ca).publicKey));
async function request(path, { client = true, trusted = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request('https://radius-api:3443' + path, {
      method: 'POST', agent: false, ca: trusted ? ca : wrongCa, ...(client ? { cert, key } : {}),
      rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
      timeout: 5000, headers: { 'content-type': 'application/json', 'content-length': '2', 'x-pamofi-nas': nas },
    }, response => {
      const chunks = []; let length = 0;
      response.on('data', part => { length += part.length; if (length > 16384) response.destroy(Error('Unexpected large authority response')); else chunks.push(part); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(Error('Authority request timed out')));
    req.on('error', reject); req.end('{}');
  });
}
for (const path of ['/radius/authorize', '/radius/accounting']) {
  const response = await request(path);
  // The correct pinned client and valid-shaped NAS header reach the real
  // runtime-role registry SELECT. An unavailable database would return503.
  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'rejected' });
}
await assert.rejects(request('/radius/authorize', { client: false }), { code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED' });
const trustErrors = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN']);
await assert.rejects(request('/radius/authorize', { trusted: false }), error => trustErrors.has(error.code));
assert.equal((await request('/radius/authorize')).status, 401);
console.log('Actual production RADIUS authority passed: non-root image, verified mTLS, real runtime registry denial, missing-client/wrong-CA rejection; no NAS or credit activated.');
