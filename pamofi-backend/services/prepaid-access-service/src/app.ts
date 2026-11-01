import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';
import { registerRadiusInternal } from './radius-internal.js';
import { registerPesepaySandbox } from './pesepay-sandbox.js';
const { Pool } = pg;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 }) : null;
  const demo = process.env.APP_ENV === 'demo' && process.env.NODE_ENV === 'development';
  app.register(rateLimit, { global: false });
  const stopPesepaySandbox = registerPesepaySandbox(app,pool,demo);
  app.addHook('onClose', async () => { await stopPesepaySandbox(); if (pool) await pool.end(); });
  registerRadiusInternal(app,pool,demo);
  app.get('/health/live', async () => ({ status: 'ok', service: 'prepaid-access' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!pool) return reply.code(503).send({ status: 'not_ready' });
    try { await pool.query('SELECT 1'); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  app.get('/v1/bundles', async (_request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'catalogue_unavailable' });
    try { const result = await pool.query('SELECT id, price_minor, currency, byte_limit::text, validity_seconds FROM bundle_versions WHERE published = true ORDER BY price_minor'); return { products: result.rows, candidate: demo }; }
    catch { return reply.code(503).send({ error: 'catalogue_unavailable' }); }
  });
  async function customer(request: FastifyRequest): Promise<string | null> {
    const secret = process.env.INTERNAL_IDENTITY_SECRET;
    const base = process.env.IDENTITY_URL;
    if (!secret || Buffer.byteLength(secret) < 32 || !base || (!demo && secret.startsWith('DEMO_ONLY_'))) throw new Error('identity unavailable');
    const parsed = new URL(base);
    if ((!demo && parsed.protocol !== 'https:') || (demo && !['http:','https:'].includes(parsed.protocol)) || parsed.username || parsed.password || parsed.pathname !== '/') throw new Error('identity unavailable');
    const token = await new SignJWT({ scope:'identity:resolve' }).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('identity').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
    const response = await fetch(new URL('/internal/v1/session', parsed), { headers: { authorization: `Bearer ${token}`, cookie: request.headers.cookie ?? '' }, signal: AbortSignal.timeout(2000), redirect:'error' });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error('identity unavailable');
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null || !('customerId' in data) || typeof data.customerId !== 'string' || !uuid.test(data.customerId)) throw new Error('invalid identity response');
    return data.customerId;
  }
  function originAllowed(request: FastifyRequest) { return !!process.env.PUBLIC_ORIGIN && request.headers.origin === process.env.PUBLIC_ORIGIN; }
  app.get('/v1/orders', async (request, reply) => {
    if (!pool) return reply.code(503).send({ error:'unavailable' });
    try {
      const id = await customer(request); if (!id) return reply.code(401).send({ error:'not_authenticated' });
      const rows = await pool.query('SELECT id,bundle_id,price_minor,currency,byte_limit::text,validity_seconds,status,created_at,quote_expires_at FROM purchase_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[id]);
      return { orders:rows.rows };
    } catch { return reply.code(503).send({error:'unavailable'}); }
  });
  app.get('/v1/access', async (request, reply) => {
    if (!pool) return reply.code(503).send({ error:'unavailable' });
    try {
      const id = await customer(request); if (!id) return reply.code(401).send({error:'not_authenticated'});
      const rows = await pool.query('SELECT id,bundle_id,byte_limit::text,consumed_bytes::text,validity_seconds,purchased_at,start_by,activated_at,revoked_at FROM purchase_entitlements WHERE customer_id=$1 ORDER BY purchased_at,id LIMIT 100',[id]);
      return { entitlements:rows.rows };
    } catch { return reply.code(503).send({error:'unavailable'}); }
  });
  app.post<{Body:{bundleId:string}}>('/v1/orders', { config:{rateLimit:{max:30,timeWindow:'1 minute'}}, schema:{body:{type:'object',required:['bundleId'],additionalProperties:false,properties:{bundleId:{type:'string',minLength:1,maxLength:40,pattern:'^[a-z]+$'}}}} }, async (request, reply) => {
    if (!demo) return reply.code(404).send({error:'not_found'});
    if (!pool) return reply.code(503).send({error:'unavailable'});
    if (!originAllowed(request)) return reply.code(403).send({error:'origin_rejected'});
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return reply.code(400).send({error:'invalid_idempotency_key'});
    try {
      const id = await customer(request); if (!id) return reply.code(401).send({error:'not_authenticated'});
      const existing = await pool.query('SELECT id,bundle_id,price_minor,currency,byte_limit::text,validity_seconds,status,created_at,quote_expires_at FROM purchase_orders WHERE customer_id=$1 AND idempotency_key=$2',[id,key]);
      if (existing.rowCount) return existing.rows[0].bundle_id === request.body.bundleId ? { order:existing.rows[0] } : reply.code(409).send({error:'idempotency_conflict'});
      const created = await pool.query(`INSERT INTO purchase_orders (id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at)
        SELECT $1,$2,$3,id,price_minor,currency,byte_limit,validity_seconds,'awaiting_payment',now()+interval '15 minutes' FROM bundle_versions WHERE id=$4 AND published=true
        ON CONFLICT (customer_id,idempotency_key) DO NOTHING RETURNING id,bundle_id,price_minor,currency,byte_limit::text,validity_seconds,status,created_at,quote_expires_at`,[randomUUID(),id,key,request.body.bundleId]);
      if (created.rowCount) return reply.code(201).send({order:created.rows[0]});
      const retry = await pool.query('SELECT id,bundle_id,price_minor,currency,byte_limit::text,validity_seconds,status,created_at,quote_expires_at FROM purchase_orders WHERE customer_id=$1 AND idempotency_key=$2',[id,key]);
      if (!retry.rowCount) return reply.code(404).send({error:'bundle_unavailable'});
      return retry.rows[0].bundle_id === request.body.bundleId ? {order:retry.rows[0]} : reply.code(409).send({error:'idempotency_conflict'});
    } catch { return reply.code(503).send({error:'unavailable'}); }
  });
  app.post<{Params:{id:string}}>('/v1/orders/:id/demo-confirm', {config:{rateLimit:{max:30,timeWindow:'1 minute'}}}, async (request, reply) => {
    if (!demo) return reply.code(404).send({error:'not_found'});
    if (!pool) return reply.code(503).send({error:'unavailable'});
    if (!originAllowed(request)) return reply.code(403).send({error:'origin_rejected'});
    if (!uuid.test(request.params.id)) return reply.code(404).send({error:'not_found'});
    try {
      const customerId = await customer(request); if (!customerId) return reply.code(401).send({error:'not_authenticated'});
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query('SELECT *,quote_expires_at > now() AS quote_valid FROM purchase_orders WHERE id=$1 AND customer_id=$2 FOR UPDATE',[request.params.id,customerId]);
        if (!found.rowCount) { await client.query('ROLLBACK'); return reply.code(404).send({error:'not_found'}); }
        const order = found.rows[0];
        if (order.status === 'payment_confirmed') { await client.query('COMMIT'); return {status:'payment_confirmed',simulation:true}; }
        if (!order.quote_valid) { await client.query('ROLLBACK'); return reply.code(409).send({error:'quote_expired'}); }
        await client.query('INSERT INTO mock_payment_records (id,order_id,amount_minor,currency) VALUES ($1,$2,$3,$4)',[randomUUID(),order.id,order.price_minor,order.currency]);
        await client.query("INSERT INTO purchase_entitlements (id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 days')",[randomUUID(),order.id,customerId,order.bundle_id,order.byte_limit,order.validity_seconds]);
        await client.query("UPDATE purchase_orders SET status='payment_confirmed' WHERE id=$1",[order.id]);
        await client.query('COMMIT'); return {status:'payment_confirmed',simulation:true};
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch { return reply.code(503).send({error:'unavailable'}); }
  });
  return app;
}
