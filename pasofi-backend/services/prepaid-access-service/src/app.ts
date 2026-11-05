import { publicOrigins } from './public-origins.js';
import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';
import { registerRadiusInternal } from './radius-internal.js';
import {registerCommerce} from './commerce.js';
import {registerCheckout,paymentConfiguration} from './checkout.js';
import {registerCustomerNetwork} from './network-lifecycle.js';
import {trustedProxyCidrs} from './proxy.js';
import {registerUsage} from './usage.js';
import {InvoiceError,invoiceDeliverySchema,normalizeInvoiceDelivery,saveOrderInvoiceIntent,assertOrderInvoiceIntent} from './invoices.js';
const { Pool } = pg;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 16384, trustProxy:trustedProxyCidrs() });
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 }) : null;
  // pg emits an error when an idle pooled connection is dropped. Keep the
  // process alive so readiness can report the outage and later reconnect.
  pool?.on('error', () => { console.error('Prepaid database connection unavailable'); });
  const demo = process.env.APP_ENV === 'demo' && process.env.NODE_ENV === 'development';
  app.register(rateLimit, { global: false });
  // Register routes only after the plugin has installed its onRoute hook.
  // Otherwise route-level rateLimit settings are silently ignored.
  app.after(error=>{
  if(error)throw error;
  // Account and internal authority responses must never be reused by a cache.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  const checkout=paymentConfiguration(demo);
  const stopCheckout=registerCheckout(app,pool,demo,customer,originAllowed);
  registerCommerce(app,pool,demo,customer,originAllowed);
  registerCustomerNetwork(app,pool,demo,customer,originAllowed);
  registerUsage(app,pool,customer);
  app.addHook('onClose', async () => { await stopCheckout(); if (pool) await pool.end(); });
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
  function originAllowed(request: FastifyRequest) { const origins = publicOrigins(process.env.PUBLIC_ORIGIN, process.env.PUBLIC_ORIGIN_ALIASES, demo); return typeof request.headers.origin === 'string' && origins?.has(request.headers.origin) === true; }
  app.get<{Querystring:{requestKey?:string}}>('/v1/orders', {
    schema:{querystring:{type:'object',additionalProperties:false,properties:{
      requestKey:{type:'string',minLength:16,maxLength:128,pattern:'^[A-Za-z0-9_-]{16,128}$'}
    }}}
  }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error:'unavailable' });
    try {
      const id = await customer(request); if (!id) return reply.code(401).send({ error:'not_authenticated' });
      const {requestKey}=request.query;
      if(requestKey!==undefined){
        // Recover only this customer's original quote, even if its bundle or
        // checkout is now unavailable. A lookup never creates or retries payment.
        const rows=await pool.query('SELECT id,bundle_id,price_minor,currency,byte_limit::text,validity_seconds,status,created_at,quote_expires_at,purchase_mode FROM purchase_orders WHERE customer_id=$1 AND idempotency_key=$2 LIMIT 1',[id,requestKey]);
        return {customerId:id,lookupKey:requestKey,orders:rows.rows};
      }
      const rows = await pool.query('SELECT id,bundle_id,price_minor,currency,byte_limit::text,validity_seconds,status,created_at,quote_expires_at,purchase_mode FROM purchase_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[id]);
      return { customerId:id,orders:rows.rows };
    } catch { return reply.code(503).send({error:'unavailable'}); }
  });
  app.get<{Querystring:{limit:number;offset:number}}>('/v1/access', {
    schema:{querystring:{type:'object',additionalProperties:false,properties:{
      limit:{type:'integer',minimum:1,maximum:100,default:100},
      offset:{type:'integer',minimum:0,maximum:1000000,default:0}
    }}}
  }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error:'unavailable' });
    try {
      const id = await customer(request); if (!id) return reply.code(401).send({error:'not_authenticated'});
      const {limit,offset}=request.query;
      // Keep usable access visible even after a customer has more than a page
      // of old purchases. Active access precedes the FIFO queue; history follows.
      const rows = await pool.query(`SELECT id,bundle_id,byte_limit::text,consumed_bytes::text,validity_seconds,purchased_at,start_by,activated_at,revoked_at
        FROM purchase_entitlements WHERE customer_id=$1
        ORDER BY CASE
          WHEN revoked_at IS NULL AND consumed_bytes<byte_limit AND activated_at IS NOT NULL
            AND activated_at+make_interval(secs=>validity_seconds)>now() THEN 0
          WHEN revoked_at IS NULL AND consumed_bytes<byte_limit AND activated_at IS NULL AND start_by>=now() THEN 1
          ELSE 2 END, purchased_at,id
        LIMIT $2 OFFSET $3`,[id,limit+1,offset]);
      const hasMore=rows.rows.length>limit;
      return { customerId:id,entitlements:rows.rows.slice(0,limit),hasMore,nextOffset:hasMore?offset+limit:null };
    } catch { return reply.code(503).send({error:'unavailable'}); }
  });
  app.post<{Body:{bundleId:string;mode?:'demo'|'checkout';invoiceDelivery?:unknown}}>('/v1/orders', { config:{rateLimit:{max:30,timeWindow:'1 minute'}}, schema:{body:{type:'object',required:['bundleId'],additionalProperties:false,properties:{bundleId:{type:'string',minLength:1,maxLength:40,pattern:'^[a-z][a-z0-9-]{0,39}$'},mode:{type:'string',enum:['demo','checkout'],default:'demo'},invoiceDelivery:invoiceDeliverySchema}}} }, async (request, reply) => {
    if ((!demo&&request.body.mode!=='checkout')||(request.body.mode==='checkout'&&!checkout.enabled)) return reply.code(404).send({error:'not_found'});
    if (!pool) return reply.code(503).send({error:'unavailable'});
    if (!originAllowed(request)) return reply.code(403).send({error:'origin_rejected'});
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return reply.code(400).send({error:'invalid_idempotency_key'});
    try {
      const id = await customer(request); if (!id) return reply.code(401).send({error:'not_authenticated'});
      const invoiceDelivery=normalizeInvoiceDelivery(request.body.invoiceDelivery),client=await pool.connect();
      try{
       await client.query('BEGIN');
       await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`order:${id}:${key}`]);
       const existing = await client.query('SELECT id,bundle_id,price_minor,currency,byte_limit::text,validity_seconds,status,created_at,quote_expires_at,purchase_mode FROM purchase_orders WHERE customer_id=$1 AND idempotency_key=$2',[id,key]);
       if(existing.rowCount){
        if(existing.rows[0].bundle_id!==request.body.bundleId||existing.rows[0].purchase_mode!==(request.body.mode??'demo'))throw new InvoiceError('idempotency_conflict');
        await assertOrderInvoiceIntent(client,existing.rows[0].id,invoiceDelivery);await client.query('COMMIT');return {order:existing.rows[0]};
       }
       const created = await client.query(`INSERT INTO purchase_orders (id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at,purchase_mode)
         SELECT $1,$2,$3,id,price_minor,currency,byte_limit,validity_seconds,'awaiting_payment',now()+interval '15 minutes',$5 FROM bundle_versions WHERE id=$4 AND published=true
         RETURNING id,bundle_id,price_minor,currency,byte_limit::text,validity_seconds,status,created_at,quote_expires_at,purchase_mode`,[randomUUID(),id,key,request.body.bundleId,request.body.mode??'demo']);
       if(!created.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'bundle_unavailable'});}
       await saveOrderInvoiceIntent(client,created.rows[0].id,invoiceDelivery);await client.query('COMMIT');return reply.code(201).send({order:created.rows[0]});
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    } catch(error) { return reply.code(error instanceof InvoiceError?(error.code==='invalid_invoice_delivery'?400:error.code==='idempotency_conflict'?409:503):503).send({error:error instanceof InvoiceError?error.code:'unavailable'}); }
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
        if(order.purchase_mode!=='demo'){await client.query('ROLLBACK');return reply.code(409).send({error:'wrong_order_mode'});}
        if (order.status === 'payment_confirmed') { await client.query('COMMIT'); return {status:'payment_confirmed',simulation:true}; }
        if (!order.quote_valid) { await client.query('ROLLBACK'); return reply.code(409).send({error:'quote_expired'}); }
        await client.query('INSERT INTO mock_payment_records (id,order_id,amount_minor,currency) VALUES ($1,$2,$3,$4)',[randomUUID(),order.id,order.price_minor,order.currency]);
        await client.query("INSERT INTO purchase_entitlements (id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 days')",[randomUUID(),order.id,customerId,order.bundle_id,order.byte_limit,order.validity_seconds]);
        await client.query("UPDATE purchase_orders SET status='payment_confirmed' WHERE id=$1",[order.id]);
        await client.query('COMMIT'); return {status:'payment_confirmed',simulation:true};
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch { return reply.code(503).send({error:'unavailable'}); }
  });
  });
  return app;
}
