import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
    reply.header('Cache-Control','no-store');
    if (!pool || !validOrigin) return reply.code(503).send({ error: 'identity_unavailable' });
    try { const customerId = await current(request); return customerId ? { customerId } : reply.code(401).send({ error: 'not_authenticated' }); }
    catch { return reply.code(503).send({ error: 'identity_unavailable' }); }
  });
  // Recovery values are displayed once, never logged or sent in URLs.
  app.post('/v1/recovery/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control','no-store');
    if (!pool || !validOrigin) return reply.code(503).send({error:'identity_unavailable'});
    if (request.headers.origin!==origin) return reply.code(403).send({error:'origin_rejected'});
    try {
      const id=await current(request);if(!id)return reply.code(401).send({error:'not_authenticated'});
      const accountReference=randomBytes(10).toString('base64url'), recoveryKey=randomBytes(32).toString('base64url');
      const row=await pool.query('INSERT INTO customer_recovery(customer_id,account_reference,key_hash) VALUES ($1,$2,$3) ON CONFLICT(customer_id) DO NOTHING RETURNING customer_id',[id,accountReference,tokenHash(recoveryKey)]);
      if(!row.rowCount)return reply.code(409).send({error:'recovery_already_set'});
      return reply.code(201).send({accountReference,recoveryKey});
    } catch {return reply.code(503).send({error:'identity_unavailable'});}
  });
  app.get('/v1/recovery/status', async (request,reply) => {
    reply.header('Cache-Control','no-store');
    if (!pool || !validOrigin) return reply.code(503).send({error:'identity_unavailable'});
    try {
      const id=await current(request);if(!id)return reply.code(401).send({error:'not_authenticated'});
      const result=await pool.query('SELECT account_reference,version FROM customer_recovery WHERE customer_id=$1',[id]);
      return result.rowCount?{configured:true,accountReference:result.rows[0].account_reference,version:result.rows[0].version}:{configured:false};
    } catch{return reply.code(503).send({error:'identity_unavailable'});}
  });
  app.post<{Body:{expectedVersion:number}}>('/v1/recovery/rotate', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema:{body:{type:'object',required:['expectedVersion'],additionalProperties:false,properties:{expectedVersion:{type:'integer',minimum:1,maximum:2147483646}}}} }, async (request, reply) => {
    reply.header('Cache-Control','no-store');
    if (!pool || !validOrigin) return reply.code(503).send({error:'identity_unavailable'});
    if (request.headers.origin!==origin) return reply.code(403).send({error:'origin_rejected'});
    try {
      const id=await current(request);if(!id)return reply.code(401).send({error:'not_authenticated'});
      const recoveryKey=randomBytes(32).toString('base64url');
      const result=await pool.query('UPDATE customer_recovery SET key_hash=$2,version=version+1,updated_at=now() WHERE customer_id=$1 AND version=$3 RETURNING account_reference',[id,tokenHash(recoveryKey),request.body.expectedVersion]);
      if(!result.rowCount)return reply.code(409).send({error:'recovery_changed'});
      return {accountReference:result.rows[0].account_reference,recoveryKey};
    } catch {return reply.code(503).send({error:'identity_unavailable'});}
  });
  app.post<{Body:{accountReference:string;recoveryKey:string}}>('/v1/recovery', {
    config:{rateLimit:{max:8,timeWindow:'1 minute'}},
    schema:{body:{type:'object',required:['accountReference','recoveryKey'],additionalProperties:false,properties:{accountReference:{type:'string',pattern:'^[A-Za-z0-9_-]{14}$'},recoveryKey:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}}}}
  }, async (request,reply) => {
    reply.header('Cache-Control','no-store');
    if (!pool || !validOrigin) return reply.code(503).send({error:'identity_unavailable'});
    if (request.headers.origin!==origin) return reply.code(403).send({error:'origin_rejected'});
    try {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const found=await client.query('SELECT customer_id,key_hash FROM customer_recovery WHERE account_reference=$1 FOR UPDATE',[request.body.accountReference]);
        const supplied=tokenHash(request.body.recoveryKey), stored=found.rowCount?found.rows[0].key_hash:Buffer.alloc(32);
        if(!timingSafeEqual(supplied,stored) || !found.rowCount){await client.query('ROLLBACK');return reply.code(401).send({error:'invalid_recovery'});}
        const token=randomBytes(32).toString('base64url'), customerId=found.rows[0].customer_id as string;
        await client.query("INSERT INTO customer_sessions(token_hash,customer_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[tokenHash(token),customerId]);
        await client.query('COMMIT');
        reply.setCookie(cookieName,token,{path:'/',httpOnly:true,secure:!demo,sameSite:'lax',maxAge:30*86400});
        return {customerId};
      } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
    } catch {return reply.code(503).send({error:'identity_unavailable'});}
  });
  app.post('/v1/session', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply: FastifyReply) => {
    reply.header('Cache-Control','no-store');
    if (!pool || !validOrigin) return reply.code(503).send({ error: 'identity_unavailable' });
    if (request.headers.origin !== origin) return reply.code(403).send({ error: 'origin_rejected' });
    try {
      const existing = await current(request);
      if (existing) return { customerId: existing };
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key,'base64url').toString('base64url') !== key) return reply.code(400).send({error:'invalid_idempotency_key'});
      const secret=process.env.SESSION_CREATION_SECRET;
      if (!secret || Buffer.byteLength(secret)<32 || (!demo && secret.startsWith('DEMO_ONLY_'))) return reply.code(503).send({error:'identity_unavailable'});
      const requestHash=createHash('sha256').update('pamofi-session-request\0').update(key).digest();
      const token=createHmac('sha256',secret).update('pamofi-session-token\0').update(key).digest('base64url');
      const hashedToken=tokenHash(token);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[requestHash.toString('hex')]);
        const previous=await client.query(`SELECT s.customer_id,s.token_hash,s.revoked_at,s.expires_at>now() AS session_valid,c.expires_at>now() AS retry_valid
          FROM customer_session_creations c JOIN customer_sessions s ON s.token_hash=c.session_token_hash WHERE c.request_hash=$1 FOR UPDATE OF c,s`,[requestHash]);
        if(previous.rowCount){
          const row=previous.rows[0];
          if(row.revoked_at || !row.session_valid || !row.retry_valid){await client.query('ROLLBACK');return reply.code(409).send({error:'session_retry_expired'});}
          if(!timingSafeEqual(hashedToken,row.token_hash)){await client.query('ROLLBACK');return reply.code(503).send({error:'identity_unavailable'});}
          await client.query('COMMIT');
          reply.setCookie(cookieName,token,{path:'/',httpOnly:true,secure:!demo,sameSite:'lax',maxAge:30*86400});
          return {customerId:row.customer_id};
        }
        const id=randomUUID();
        await client.query('INSERT INTO customers (id) VALUES ($1)', [id]);
        await client.query("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES ($1, $2, now() + interval '30 days')", [hashedToken,id]);
        await client.query('INSERT INTO customer_session_creations(request_hash,session_token_hash) VALUES ($1,$2)',[requestHash,hashedToken]);
        await client.query('COMMIT');
        reply.setCookie(cookieName,token,{path:'/',httpOnly:true,secure:!demo,sameSite:'lax',maxAge:30*86400});
        return reply.code(201).send({customerId:id});
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch { return reply.code(503).send({ error: 'identity_unavailable' }); }
  });
  return app;
}
