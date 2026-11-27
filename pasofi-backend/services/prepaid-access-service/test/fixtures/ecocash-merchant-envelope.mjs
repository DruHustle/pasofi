import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// This wire format and its ephemeral key exist only for the isolated fixture.
export function syntheticMerchantEnvelopes() {
  const secret = randomBytes(32);
  const replayWindowMs = 60_000;
  const timeHeader = 'x-pasofi-test-signed-at';
  const signatureHeader = 'x-pasofi-test-signature';
  const signature = (signedAt, body) => createHmac('sha256', secret).update(signedAt).update('.').update(body).digest();

  return {
    sign(observation, signedAtMs = Date.now()) {
      const rawBody = Buffer.from(JSON.stringify(observation));
      const signedAt = String(signedAtMs);
      return { rawBody, headers: { [timeHeader]: signedAt, [signatureHeader]: signature(signedAt, rawBody).toString('hex') } };
    },
    verifier: {
      replayWindowMs,
      async verify({ rawBody, headers }) {
        const signedAt = headers[timeHeader];
        const supplied = headers[signatureHeader];
        if (typeof signedAt !== 'string' || !/^\d{1,16}$/.test(signedAt) ||
            typeof supplied !== 'string' || !/^[0-9a-f]{64}$/.test(supplied)) return null;
        if (!timingSafeEqual(signature(signedAt, rawBody), Buffer.from(supplied, 'hex'))) return null;
        return { signedAtMs: Number(signedAt), observation: JSON.parse(rawBody.toString('utf8')) };
      }
    }
  };
}
