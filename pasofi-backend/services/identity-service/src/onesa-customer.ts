import * as oidc from 'openid-client';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { OnesaStaff, OnesaError, adminAssertion, configuredOnesaStaff, type Configuration, type Admin } from './onesa-staff.js';
import { decryptMfa, encryptMfa, freshOpaque, isOpaque, mfaKey, opaqueHash } from './staff-crypto.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const denied = () => new OnesaError(401, 'onesa_sign_in_rejected');
export function customerAssertion(input: unknown, config: Configuration, now: number): Admin {
  if (!input || typeof input !== 'object') throw denied();
  const value = input as Record<string, unknown>;
  const roles = value.onesa_product_roles as Record<string, unknown> | undefined;
  if (roles?.pasofi === 'admin') return adminAssertion(input, config, now);
  if (value.active !== true || value.iss !== config.issuer || value.aud !== config.clientId ||
      typeof value.sub !== 'string' || !uuid.test(value.sub) || value.email_verified !== true ||
      typeof value.email !== 'string' || !value.email.includes('@') || value.email.length > 254 ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 ||
      !Array.isArray(value.onesa_applications) || !value.onesa_applications.includes('pasofi') || roles?.pasofi !== 'customer' ||
      typeof value.exp !== 'number' || !Number.isSafeInteger(value.exp) || value.exp <= now ||
      typeof value.auth_time !== 'number' || !Number.isSafeInteger(value.auth_time) || value.auth_time > now || value.auth_time <= now - 28800) throw denied();
  return { subject: value.sub, email: value.email, name: value.name.trim(), authenticated: value.auth_time, expires: Math.min(value.exp, value.auth_time + 28800) };
}
export function customerReturnTo(value: unknown): string {
  return typeof value === 'string' && /^\/#(?:home|bundles|history|account|wifi|voucher|checkout|receipt)(?:\?bundle=[a-z][a-z0-9-]{0,39})?$/.test(value) ? value : '/#account';
}
export class OnesaCustomer extends OnesaStaff {
  protected assertion(input: unknown): Admin { return customerAssertion(input, this.config, Math.floor(Date.now() / 1000)); }
  async start(db: pg.Pool | pg.PoolClient, returnTo: unknown = '/#account') {
    const state = freshOpaque(), browser = freshOpaque(), verifier = oidc.randomPKCECodeVerifier(), nonce = freshOpaque();
    const authorization = oidc.buildAuthorizationUrl(this.client, {
      redirect_uri: this.config.callback.href, response_type: 'code', scope: 'openid email profile onesa',
      state, nonce, code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    });
    await db.query('DELETE FROM customer_onesa_flows WHERE expires_at<=now()');
    await db.query('INSERT INTO customer_onesa_flows(state_hash,browser_hash,verifier,nonce,return_to) VALUES($1,$2,$3,$4,$5)',
      [opaqueHash(state), opaqueHash(browser), verifier, nonce, customerReturnTo(returnTo)]);
    return { browser, authorizationUrl: authorization.href };
  }
  async finish(db: pg.Pool, browser: unknown, params: { state: string; code: string; iss?: string }) {
    if (!isOpaque(browser) || !isOpaque(params.state)) throw denied();
    const result = await db.query('DELETE FROM customer_onesa_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING verifier,nonce,return_to', [opaqueHash(params.state), opaqueHash(browser)]);
    if (!result.rowCount) throw denied();
    const url = new URL(this.config.callback);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const tokens = await oidc.authorizationCodeGrant(this.client, url, {
      pkceCodeVerifier: result.rows[0].verifier, expectedNonce: result.rows[0].nonce, expectedState: params.state, idTokenExpected: true,
    }).catch(() => { throw denied(); });
    if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.access_token || tokens.access_token.length > 2048) throw denied();
    const identity = await this.inspect(tokens.access_token);
    if (tokens.claims()?.sub !== identity.subject) throw denied();
    const session = freshOpaque(), hash = opaqueHash(session);
    const envelope = encryptMfa(tokens.access_token, this.key, 'onesa-customer:' + hash.toString('hex'));
    const transaction = await db.connect();
    let customerId: string;
    try {
      await transaction.query('BEGIN');
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [this.config.issuer + ':' + identity.subject]);
      const existing = await transaction.query('SELECT customer_id FROM customer_onesa_identities WHERE issuer=$1 AND subject=$2', [this.config.issuer,identity.subject]);
      customerId = existing.rows[0]?.customer_id ?? randomUUID();
      if (!existing.rowCount) {
        await transaction.query('INSERT INTO customers(id) VALUES($1)',[customerId]);
        await transaction.query('INSERT INTO customer_onesa_identities(issuer,subject,customer_id) VALUES($1,$2,$3)',[this.config.issuer,identity.subject,customerId]);
      }
      await transaction.query('INSERT INTO customer_onesa_sessions(token_hash,customer_id,access_ciphertext,expires_at) VALUES($1,$2,$3,to_timestamp($4))',[hash,customerId,envelope,identity.expires]);
      await transaction.query('COMMIT');
    } catch(error) { await transaction.query('ROLLBACK'); throw error; } finally { transaction.release(); }
    return { session, maxAge: Math.max(1, identity.expires - Math.floor(Date.now() / 1000)), customerId, returnTo: customerReturnTo(result.rows[0].return_to) };
  }

  async issueHandoff(db: pg.Pool, token: string) {
    const hash = opaqueHash(token);
    const source = (await db.query('SELECT customer_id FROM customer_onesa_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',[hash])).rows[0];
    if (!source || await this.customer(db,token,source.customer_id) !== source.customer_id) throw denied();
    const client = await db.connect(), code = freshOpaque();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT customer_id FROM customer_onesa_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',[hash]);
      if (!current.rowCount || current.rows[0].customer_id !== source.customer_id) throw denied();
      await client.query('UPDATE customer_onesa_handoffs SET consumed_at=now() WHERE source_session_hash=$1 AND consumed_at IS NULL',[hash]);
      const issued = await client.query("INSERT INTO customer_onesa_handoffs(code_hash,customer_id,source_session_hash,expires_at) SELECT $1,customer_id,token_hash,LEAST(expires_at,now()+interval '2 minutes') FROM customer_onesa_sessions WHERE token_hash=$2 RETURNING expires_at",[opaqueHash(code),hash]);
      await client.query('COMMIT');
      return {handoffCode:code,expiresIn:Math.max(0,Math.min(120,Math.floor((issued.rows[0].expires_at.getTime()-Date.now())/1000)))};
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async redeemHandoff(db: pg.Pool, code: string, existingToken: string | undefined) {
    const codeHash = opaqueHash(code);
    const source = (await db.query(`SELECT s.*,i.issuer,i.subject FROM customer_onesa_handoffs h
      JOIN customer_onesa_sessions s ON s.token_hash=h.source_session_hash AND s.customer_id=h.customer_id
      JOIN customer_onesa_identities i ON i.customer_id=s.customer_id
      WHERE h.code_hash=$1 AND h.consumed_at IS NULL AND h.expires_at>now() AND s.revoked_at IS NULL AND s.expires_at>now()`,[codeHash])).rows[0];
    if (!source || source.issuer !== this.config.issuer) throw denied();
    const access = decryptMfa(source.access_ciphertext,this.key,'onesa-customer:'+source.token_hash.toString('hex'));
    let assertion: Admin;
    try {
      assertion = await this.inspect(access);
      if (assertion.subject !== source.subject) throw denied();
    } catch(error) {
      if (error instanceof OnesaError && error.status === 401) await db.query('UPDATE customer_onesa_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1',[source.token_hash]);
      throw error;
    }
    const token=freshOpaque(),hash=opaqueHash(token),expires=Math.min(assertion.expires,Math.floor(source.expires_at.getTime()/1000));
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      if (isOpaque(existingToken)) {
        const existing=await client.query('SELECT 1 FROM customer_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() UNION ALL SELECT 1 FROM customer_onesa_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',[opaqueHash(existingToken)]);
        if(existing.rowCount)throw new OnesaError(409,'session_already_exists');
      }
      const current=await client.query('SELECT customer_id FROM customer_onesa_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',[source.token_hash]);
      const handoff=await client.query('SELECT customer_id,source_session_hash FROM customer_onesa_handoffs WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',[codeHash]);
      if(!current.rowCount||!handoff.rowCount||current.rows[0].customer_id!==source.customer_id||handoff.rows[0].customer_id!==source.customer_id||!handoff.rows[0].source_session_hash.equals(source.token_hash)||expires<=Math.floor(Date.now()/1000))throw denied();
      await client.query('UPDATE customer_onesa_handoffs SET consumed_at=now() WHERE code_hash=$1',[codeHash]);
      await client.query('INSERT INTO customer_onesa_sessions(token_hash,customer_id,access_ciphertext,expires_at) VALUES($1,$2,$3,to_timestamp($4))',[hash,source.customer_id,encryptMfa(access,this.key,'onesa-customer:'+hash.toString('hex')),expires]);
      await client.query('COMMIT');
      return {customerId:source.customer_id as string,token,maxAge:Math.max(1,expires-Math.floor(Date.now()/1000))};
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async customer(db: pg.Pool, token: string, customerId: string): Promise<string | null> {
    const row = (await db.query(`SELECT i.issuer,i.subject,s.access_ciphertext FROM customer_onesa_identities i
      LEFT JOIN customer_onesa_sessions s ON s.token_hash=$2 AND s.customer_id=i.customer_id WHERE i.customer_id=$1`, [customerId, opaqueHash(token)])).rows[0];
    if (!row) return customerId;
    if (row.issuer !== this.config.issuer || !row.access_ciphertext) return null;
    let identity: Admin;
    try { identity = await this.inspect(decryptMfa(row.access_ciphertext, this.key, 'onesa-customer:' + opaqueHash(token).toString('hex'))); }
    catch (error) {
      if (error instanceof OnesaError && error.status === 401) {
        await db.query('UPDATE customer_onesa_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1 AND customer_id=$2',[opaqueHash(token),customerId]);
        return null;
      }
      throw error;
    }
    if (row.subject !== identity.subject) {
      await db.query('UPDATE customer_onesa_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1 AND customer_id=$2',[opaqueHash(token),customerId]);
      return null;
    }
    const current = await db.query('SELECT 1 FROM customer_onesa_sessions WHERE token_hash=$1 AND customer_id=$2 AND revoked_at IS NULL AND expires_at>now()', [opaqueHash(token), customerId]);
    return current.rowCount ? customerId : null;
  }
}
export function configureOnesaCustomer(demo: boolean, allowed: (value: string | undefined) => boolean) {
  const key = mfaKey(demo), config = configuredOnesaStaff(key, allowed);
  return key && config ? new OnesaCustomer(config.config, key) : null;
}
export function registerCustomerOnesa(app: FastifyInstance, pool: pg.Pool | null, demo: boolean, onesa: OnesaCustomer | null) {
  const flowCookie = demo ? 'pasofi_demo_onesa_customer_flow' : '__Host-pasofi_onesa_customer_flow';
  const sessionCookie = demo ? 'pamofi_demo_session' : '__Host-pamofi_session';
  const attributes = { path: '/', httpOnly: true, secure: !demo, sameSite: 'lax' as const };
  app.get('/v1/onesa/availability', async (_request, reply) => { reply.header('Cache-Control','no-store'); return { origin: pool && onesa ? onesa.config.callback.origin : null, handoff: Boolean(pool && onesa) }; });
  for (const action of ['start', 'complete'] as const) app.post<{Body:Record<string,unknown>}>(`/v1/onesa/${action}`, {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: action === 'complete' ? ['code','state'] : [], properties: action === 'start' ? { returnTo: { type:'string',maxLength:100 } } : {
      state: { type:'string',minLength:43,maxLength:43 }, code:{ type:'string',minLength:1,maxLength:2048 }, iss:{ type:'string',maxLength:1024 }
    } } }
  }, async (request, reply) => {
    reply.header('Cache-Control','no-store');
    if (!pool || !onesa) return reply.code(503).send({error:'onesa_unavailable'});
    if (request.headers.origin !== onesa.config.callback.origin) return reply.code(403).send({error:'origin_rejected'});
    try {
      if (action === 'start') {
        const flow = await onesa.start(pool, request.body.returnTo);
        reply.setCookie(flowCookie, flow.browser, {...attributes,maxAge:300});
        return {authorizationUrl:flow.authorizationUrl};
      }
      const result = await onesa.finish(pool, request.cookies[flowCookie], request.body as {state:string;code:string;iss?:string});
      reply.clearCookie(flowCookie,attributes);
      reply.setCookie(sessionCookie,result.session,{...attributes,maxAge:result.maxAge});
      return {authenticated:true,customerId:result.customerId,returnTo:result.returnTo};
    } catch(error) { return reply.code(error instanceof OnesaError ? error.status : 503).send({error:error instanceof OnesaError ? error.code : 'onesa_unavailable'}); }
  });
}
