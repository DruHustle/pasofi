import Fastify from 'fastify';
import { ResendInvoiceAdapter } from './invoice-email.js';
import { invoiceRelayPath, invoiceRelaySender, matchesRelayBody, relayScope, relayUuid, validRelaySecret, verifyRelayAuthorization } from './email-relay-protocol.js';

/** Standalone Render process: no database, queue worker or Oracle connection. */
export function buildEmailRelayApp(env: NodeJS.ProcessEnv = process.env, providerFetch: typeof fetch = fetch) {
  const app = Fastify({ logger: false, bodyLimit: 1400000, ajv: { customOptions: { removeAdditional: false } } });
  const secret = env.INVOICE_EMAIL_RELAY_SECRET ?? '';
  const requested = env.INVOICE_EMAIL_RELAY_ENABLED === 'true';
  let adapter: ResendInvoiceAdapter | null = null;
  if (requested && env.INVOICE_EMAIL_RELAY_QUALIFIED === 'true' && env.APP_ENV === 'production' && env.NODE_ENV === 'production' && validRelaySecret(secret)) {
    try { adapter = new ResendInvoiceAdapter(env.RESEND_API_KEY ?? '', providerFetch); } catch { /* A missing provider credential leaves delivery disabled. */ }
  }
  const source = /^[0-9a-f]{40}$/i.test(env.RENDER_GIT_COMMIT ?? '') ? env.RENDER_GIT_COMMIT!.toLowerCase() : 'unknown';
  const envelope = { product: 'pasofi', provider: 'resend', sender: invoiceRelaySender };
  const hashes = new WeakMap<object, string>();
  app.setErrorHandler((error, _request, reply) => reply.code(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413 ? 413 : 400).send({ error: 'invalid_request' }));
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff'); return payload; });
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' && ['/health/live', '/health/ready'].includes(request.url)) return;
    if (!relayScope(request.method, request.url)) return reply.code(404).send({ error: 'not_found' });
    const header = request.headers.authorization;
    if (!validRelaySecret(secret)) return reply.code(503).send({ error: 'relay_unavailable' });
    if (!header?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized' });
    try { hashes.set(request, await verifyRelayAuthorization(secret, header.slice(7), request.method, request.url)); }
    catch { return reply.code(401).send({ error: 'unauthorized' }); }
  });
  app.addHook('preValidation', async (request, reply) => {
    const hash = hashes.get(request);
    if (hash && !matchesRelayBody(hash, request.body)) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.get('/health/live', async () => ({ status: 'ok', service: 'pasofi-email-relay', source }));
  app.get('/health/ready', async (_request, reply) => {
    if (requested && !adapter) return reply.code(503).send({ status: 'not_ready', deliveryEnabled: false, source });
    return { status: 'ready', deliveryEnabled: Boolean(adapter), source };
  });
  app.get(`${invoiceRelayPath}/capabilities`, async () => ({ ...envelope, enabled: Boolean(adapter) }));
  app.post<{ Body: { id: string; to: string; number: string; filename: string; pdf: string } }>(invoiceRelayPath, {
    schema: { body: { type: 'object', additionalProperties: false, required: ['id', 'to', 'number', 'filename', 'pdf'], properties: {
      id: { type: 'string', pattern: relayUuid.source }, to: { type: 'string', maxLength: 254 },
      number: { type: 'string', pattern: '^[A-Z0-9-]{1,80}$' }, filename: { type: 'string', maxLength: 84 },
      pdf: { type: 'string', minLength: 8, maxLength: 1398104 },
    } } },
  }, async (request, reply) => {
    if (!adapter) return reply.code(503).send({ error: 'relay_unavailable' });
    const body = request.body, pdf = Buffer.from(body.pdf, 'base64');
    if (pdf.toString('base64') !== body.pdf || body.filename !== `${body.number}.pdf`) return reply.code(400).send({ error: 'invalid_invoice_email' });
    try {
      const result = await adapter.send({ id: body.id, to: body.to, from: invoiceRelaySender, number: body.number, filename: body.filename, pdf });
      return { ...envelope, jobId: body.id, result };
    } catch { return reply.code(400).send({ error: 'invalid_invoice_email' }); }
  });
  app.get<{ Params: { id: string } }>(`${invoiceRelayPath}/:id`, async (request, reply) => {
    if (!adapter) return reply.code(503).send({ error: 'relay_unavailable' });
    return { ...envelope, providerId: request.params.id, result: await adapter.retrieve(request.params.id) };
  });
  return app;
}
