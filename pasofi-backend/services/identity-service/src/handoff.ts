import { OnesaError } from './onesa-staff.js';
import type { OnesaCustomer } from './onesa-customer.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { freshOpaque, isOpaque, opaqueHash } from './staff-crypto.js';

export function registerHandoffRoutes(app: FastifyInstance, options: { pool: pg.Pool | null; onesa?: OnesaCustomer | null; demo: boolean; validOrigin: boolean; originAllowed: (value: string | undefined) => boolean }) {
  const { pool, demo, validOrigin, originAllowed, onesa } = options;
  const cookieName = demo ? 'pamofi_demo_session' : '__Host-pamofi_session';
  async function guard(request: FastifyRequest, reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (!pool || !validOrigin) return reply.code(503).send({ error: 'identity_unavailable' });
    if (!originAllowed(request.headers.origin)) return reply.code(403).send({ error: 'origin_rejected' });
  }

  app.post('/v1/handoff', { preHandler: guard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { body: { type: 'object', additionalProperties: false } } }, async (request, reply) => {
    const token = request.cookies[cookieName];
    if (!isOpaque(token)) return reply.code(401).send({ error: 'not_authenticated' });
    if (onesa) {
      try {
        const central = await pool!.query('SELECT 1 FROM customer_onesa_sessions WHERE token_hash=$1',[opaqueHash(token)]);
        if (central.rowCount) return reply.code(201).send({...await onesa.issueHandoff(pool!,token),continueUrl:`${request.headers.origin}/handoff`});
      } catch(error) {return reply.code(error instanceof OnesaError ? error.status : 503).send({error:error instanceof OnesaError ? error.code : 'identity_unavailable'});}
    }
    const client = await pool!.connect().catch(() => null);
    if (!client) return reply.code(503).send({ error: 'identity_unavailable' });
    try {
      await client.query('BEGIN');
      const source = await client.query('SELECT customer_id FROM customer_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE', [opaqueHash(token)]);
      if (!source.rowCount) { await client.query('ROLLBACK'); return reply.code(401).send({ error: 'not_authenticated' }); }
      if ((await client.query('SELECT 1 FROM customer_onesa_identities WHERE customer_id=$1', [source.rows[0].customer_id])).rowCount) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'onesa_sign_in_required' }); }
      await client.query('UPDATE customer_handoffs SET consumed_at=now() WHERE source_session_hash=$1 AND consumed_at IS NULL', [opaqueHash(token)]);
      const handoffCode = freshOpaque();
      await client.query("INSERT INTO customer_handoffs(code_hash,customer_id,source_session_hash,expires_at) VALUES($1,$2,$3,now()+interval '2 minutes')", [opaqueHash(handoffCode), source.rows[0].customer_id, opaqueHash(token)]);
      await client.query('COMMIT');
      // The credential is deliberately absent from URLs, logs and browser
      // history. The clean destination asks the user to paste and confirm it.
      return reply.code(201).send({ handoffCode, expiresIn: 120, continueUrl: `${request.headers.origin}/handoff` });
    } catch { await client.query('ROLLBACK'); return reply.code(503).send({ error: 'identity_unavailable' }); }
    finally { client.release(); }
  });

  app.post<{ Body: { handoffCode: string } }>('/v1/handoff/redeem', { preHandler: guard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { body: {
    type: 'object', required: ['handoffCode'], additionalProperties: false, properties: { handoffCode: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } }
  } } }, async (request, reply) => {
    if (!isOpaque(request.body.handoffCode)) return reply.code(401).send({ error: 'invalid_handoff' });
    try {
      const central = await pool!.query('SELECT 1 FROM customer_onesa_handoffs WHERE code_hash=$1',[opaqueHash(request.body.handoffCode)]);
      if (central.rowCount) {
        if (!onesa) return reply.code(503).send({error:'identity_unavailable'});
        const result=await onesa.redeemHandoff(pool!,request.body.handoffCode,request.cookies[cookieName]);
        reply.setCookie(cookieName,result.token,{path:'/',httpOnly:true,secure:!demo,sameSite:'lax',maxAge:result.maxAge});
        return {customerId:result.customerId};
      }
    } catch(error) {return reply.code(error instanceof OnesaError ? error.status : 503).send({error:error instanceof OnesaError ? error.code : 'identity_unavailable'});}
    const client = await pool!.connect().catch(() => null);
    if (!client) return reply.code(503).send({ error: 'identity_unavailable' });
    try {
      await client.query('BEGIN');
      const existing = request.cookies[cookieName];
      if (isOpaque(existing)) {
        const session = await client.query('SELECT 1 FROM customer_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() UNION ALL SELECT 1 FROM customer_onesa_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [opaqueHash(existing)]);
        if (session.rowCount) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'session_already_exists' }); }
      }
      // Lock the source first, matching creation/logout order. Read the source
      // hash without accepting it, then recheck every condition under the locks.
      const lookup = await client.query('SELECT source_session_hash FROM customer_handoffs WHERE code_hash=$1', [opaqueHash(request.body.handoffCode)]);
      if (!lookup.rowCount) { await client.query('ROLLBACK'); return reply.code(401).send({ error: 'invalid_handoff' }); }
      const source = await client.query('SELECT customer_id FROM customer_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE', [lookup.rows[0].source_session_hash]);
      const handoff = await client.query('SELECT customer_id FROM customer_handoffs WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE', [opaqueHash(request.body.handoffCode)]);
      if (!source.rowCount || !handoff.rowCount || source.rows[0].customer_id !== handoff.rows[0].customer_id) { await client.query('ROLLBACK'); return reply.code(401).send({ error: 'invalid_handoff' }); }
      const customerId = handoff.rows[0].customer_id, token = freshOpaque();
      await client.query('UPDATE customer_handoffs SET consumed_at=now() WHERE code_hash=$1', [opaqueHash(request.body.handoffCode)]);
      await client.query("INSERT INTO customer_sessions(token_hash,customer_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [opaqueHash(token), customerId]);
      await client.query('COMMIT');
      reply.setCookie(cookieName, token, { path: '/', httpOnly: true, secure: !demo, sameSite: 'lax', maxAge: 30 * 86400 });
      return { customerId };
    } catch { await client.query('ROLLBACK'); return reply.code(503).send({ error: 'identity_unavailable' }); }
    finally { client.release(); }
  });
}
