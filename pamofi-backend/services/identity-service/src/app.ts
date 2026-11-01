import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { jwtVerify } from 'jose';
const { Pool } = pg;
const tokenHash = (token: string) => createHash('sha256').update(token).digest();
export function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 }) : null;
  const demo = process.env.APP_ENV === 'demo' && process.env.NODE_ENV === 'development';
  const cookieName = demo ? 'pamofi_demo_session' : '__Host-pamofi_session';
  const origin = process.env.PUBLIC_ORIGIN;
  const validOrigin = (() => { try { const u = new URL(origin!); return u.origin === origin && (u.protocol === 'https:' || (demo && u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))); } catch { return false; } })();
  app.register(cookie);
  app.register(rateLimit, { global: false });
  app.addHook('onClose', async () => { if (pool) await pool.end(); });
  app.get('/health/live', async () => ({ status: 'ok', service: 'identity' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!pool) return reply.code(503).send({ status: 'not_ready' });
    try { await pool.query('SELECT 1'); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  async function current(request: FastifyRequest) {
    const token = request.cookies[cookieName];
    if (!pool || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await pool.query('SELECT customer_id FROM customer_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()', [tokenHash(token)]);
    return result.rows[0]?.customer_id as string | undefined;
  }
  // Only the prepaid service may resolve its forwarded customer cookie. The
  // browser never supplies a customer ID to select the account.
  app.get('/internal/v1/session', async (request, reply) => {
    const secret = process.env.INTERNAL_IDENTITY_SECRET;
    if (!pool || !secret || Buffer.byteLength(secret) < 32 || (!demo && secret.startsWith('DEMO_ONLY_'))) return reply.code(503).send({ error: 'identity_unavailable' });
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const { payload } = await jwtVerify(auth.slice(7), new TextEncoder().encode(secret), {
        algorithms: ['HS256'], issuer: 'prepaid-access', audience: 'identity', subject: 'prepaid-access',
        requiredClaims: ['exp', 'iat', 'sub'], maxTokenAge: '30s'
      });
      if (payload.scope !== 'identity:resolve') return reply.code(403).send({ error: 'forbidden' });
    } catch { return reply.code(401).send({ error: 'unauthorized' }); }
    try {
      const customerId = await current(request);
      return customerId ? { customerId } : reply.code(401).send({ error: 'not_authenticated' });
    } catch { return reply.code(503).send({ error: 'identity_unavailable' }); }
  });
  app.get('/v1/session', async (request, reply) => {
    if (!pool || !validOrigin) return reply.code(503).send({ error: 'identity_unavailable' });
    try { const customerId = await current(request); return customerId ? { customerId } : reply.code(401).send({ error: 'not_authenticated' }); }
    catch { return reply.code(503).send({ error: 'identity_unavailable' }); }
  });
  app.post('/v1/session', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply: FastifyReply) => {
    if (!pool || !validOrigin) return reply.code(503).send({ error: 'identity_unavailable' });
    if (request.headers.origin !== origin) return reply.code(403).send({ error: 'origin_rejected' });
    try {
      const existing = await current(request);
      if (existing) return { customerId: existing };
      const token = randomBytes(32).toString('base64url');
      const id = randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO customers (id) VALUES ($1)', [id]);
        await client.query("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES ($1, $2, now() + interval '30 days')", [tokenHash(token), id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      reply.setCookie(cookieName, token, { path: '/', httpOnly: true, secure: !demo, sameSite: 'lax', maxAge: 30 * 86400 });
      return reply.code(201).send({ customerId: id });
    } catch { return reply.code(503).send({ error: 'identity_unavailable' }); }
  });
  return app;
}
