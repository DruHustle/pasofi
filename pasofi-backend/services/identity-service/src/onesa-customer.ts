import * as oidc from 'openid-client';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { OnesaStaff, OnesaError, customerAssertion, configuredOnesaStaff, type Admin } from './onesa-staff.js';
import { freshOpaque, isOpaque, mfaKey, opaqueHash } from './staff-crypto.js';

const denied = () => new OnesaError(401, 'onesa_sign_in_rejected');
export { customerAssertion };
export function customerReturnTo(value: unknown): string {
  if (value === '/#connect') return value;
  return typeof value === 'string' && /^\/#(?:home|bundles|history|account|wifi|voucher|checkout|receipt)(?:\?bundle=[a-z][a-z0-9-]{0,39})?$/.test(value) ? value : '/#account';
}
export class OnesaCustomer extends OnesaStaff {
  protected get staffFlow() { return false; }
  protected assertion(input: unknown): Admin { return customerAssertion(input, this.config, Math.floor(Date.now() / 1000)); }
  async start(db: pg.Pool | pg.PoolClient, returnTo: unknown = '/#account') {
    const state = freshOpaque(), browser = freshOpaque(), verifier = oidc.randomPKCECodeVerifier(), nonce = freshOpaque();
    const authorization = oidc.buildAuthorizationUrl(await this.protocolClient(), {
      redirect_uri: this.config.callback.href, response_type: 'code', ...this.authorizationParameters,
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
    const tokens = await oidc.authorizationCodeGrant(await this.protocolClient(), url, {
      pkceCodeVerifier: result.rows[0].verifier, expectedNonce: result.rows[0].nonce, expectedState: params.state, idTokenExpected: true,
    }).catch(() => { throw denied(); });
    if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.access_token || tokens.access_token.length > (this.config.managed ? 16384 : 2048)) throw denied();
    const identity = await this.inspect(tokens.access_token);
    if (tokens.claims()?.sub !== (identity.providerSubject ?? identity.subject)) throw denied();
    if (this.config.managed && identity.authorizedClient && identity.authorizedClient !== this.config.clientId) throw denied();
    return { ...await this.saveCustomer(db, tokens.access_token, identity), returnTo: customerReturnTo(result.rows[0].return_to) };
  }
  async nativeSession(db: pg.Pool, access: string, platform: 'ios' | 'android', existingToken?: string) {
    const id = nativeClient(platform);
    if (!this.config.managed || !id) throw new OnesaError(503,'onesa_unavailable');
    const identity = await this.inspect(access);
    if (identity.authorizedClient !== id) throw denied();
    return this.saveCustomer(db, access, identity, existingToken);
  }
  private async saveCustomer(db: pg.Pool, access: string, identity: Admin, existingToken?: string) {
    const session = freshOpaque(), hash = opaqueHash(session);
    const envelope = this.protectAccess(access, 'onesa-customer:' + hash.toString('hex'));
    const transaction = await db.connect();
    let customerId: string;
    try {
      await transaction.query('BEGIN');
      if (existingToken && isOpaque(existingToken)) {
        const occupied = await transaction.query('SELECT 1 FROM customer_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() UNION ALL SELECT 1 FROM customer_onesa_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [opaqueHash(existingToken)]);
        if (occupied.rowCount) throw new OnesaError(409, 'session_already_exists');
      }
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [this.recordIssuer + ':' + identity.subject]);
      const existing = await transaction.query('SELECT customer_id FROM customer_onesa_identities WHERE issuer=$1 AND subject=$2', [this.recordIssuer,identity.subject]);
      customerId = existing.rows[0]?.customer_id ?? randomUUID();
      if (!existing.rowCount) {
        await transaction.query('INSERT INTO customers(id) VALUES($1)',[customerId]);
        await transaction.query('INSERT INTO customer_onesa_identities(issuer,subject,customer_id) VALUES($1,$2,$3)',[this.recordIssuer,identity.subject,customerId]);
      }
      await transaction.query('INSERT INTO customer_onesa_sessions(token_hash,customer_id,access_ciphertext,expires_at) VALUES($1,$2,$3,to_timestamp($4))',[hash,customerId,envelope,identity.expires]);
      await transaction.query('COMMIT');
    } catch(error) { await transaction.query('ROLLBACK'); throw error; } finally { transaction.release(); }
    return { session, maxAge: Math.max(1, identity.expires - Math.floor(Date.now() / 1000)), customerId };
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
    if (!source || source.issuer !== this.recordIssuer) throw denied();
    let access: string;
    let assertion: Admin;
    try {
      access = this.readAccess(source.access_ciphertext, 'onesa-customer:'+source.token_hash.toString('hex'));
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
      await client.query('INSERT INTO customer_onesa_sessions(token_hash,customer_id,access_ciphertext,expires_at) VALUES($1,$2,$3,to_timestamp($4))',[hash,source.customer_id,this.protectAccess(access,'onesa-customer:'+hash.toString('hex')),expires]);
      await client.query('COMMIT');
      return {customerId:source.customer_id as string,token,maxAge:Math.max(1,expires-Math.floor(Date.now()/1000))};
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async customer(db: pg.Pool, token: string, customerId: string): Promise<string | null> {
    const row = (await db.query(`SELECT i.issuer,i.subject,s.access_ciphertext FROM customer_onesa_identities i
      LEFT JOIN customer_onesa_sessions s ON s.token_hash=$2 AND s.customer_id=i.customer_id WHERE i.customer_id=$1`, [customerId, opaqueHash(token)])).rows[0];
    if (!row) return customerId;
    if (row.issuer !== this.recordIssuer || !row.access_ciphertext) return null;
    let identity: Admin;
    try { identity = await this.inspect(this.readAccess(row.access_ciphertext, 'onesa-customer:' + opaqueHash(token).toString('hex'))); }
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
function nativeClient(platform: 'ios' | 'android') {
  const id = platform === 'ios' ? process.env.PASOFI_ONESA_IOS_CLIENT_ID : process.env.PASOFI_ONESA_ANDROID_CLIENT_ID;
  const other = platform === 'ios' ? process.env.PASOFI_ONESA_ANDROID_CLIENT_ID : process.env.PASOFI_ONESA_IOS_CLIENT_ID;
  return id && /^[A-Za-z0-9_-]{16,128}$/.test(id) && id !== other && id !== process.env.PASOFI_ONESA_CLIENT_ID ? id : null;
}
export function registerCustomerOnesa(app: FastifyInstance, pool: pg.Pool | null, demo: boolean, onesa: OnesaCustomer | null) {
  const flowCookie = demo ? 'pasofi_demo_onesa_customer_flow' : '__Host-pasofi_onesa_customer_flow';
  const sessionCookie = demo ? 'pamofi_demo_session' : '__Host-pamofi_session';
  const attributes = { path: '/', httpOnly: true, secure: !demo, sameSite: 'lax' as const };
  app.get('/v1/onesa/availability', async (_request, reply) => {
    reply.header('Cache-Control','no-store');
    const origin = pool && onesa ? onesa.config.callback.origin : null;
    const managed = onesa?.config.managed;
    return { origin, handoff: Boolean(origin), ...(origin && managed ? { native: {
      issuer: onesa.config.issuer, audience: managed.audience, ios: nativeClient('ios'), android: nativeClient('android'),
    } } : {}) };
  });
  app.post<{Body:{accessToken:string;platform:'ios'|'android'}}>('/v1/onesa/native-session', {
    config:{rateLimit:{max:20,timeWindow:'1 minute'}}, schema:{body:{type:'object',additionalProperties:false,
      required:['accessToken','platform'],properties:{platform:{enum:['ios','android']},accessToken:{type:'string',minLength:100,maxLength:12000}}}},
  }, async (request,reply)=>{
    reply.header('Cache-Control','no-store');
    if (!pool || !onesa?.config.managed) return reply.code(503).send({error:'onesa_unavailable'});
    if (request.headers.origin !== onesa.config.callback.origin) return reply.code(403).send({error:'origin_rejected'});
    try {
      const issued = await onesa.nativeSession(pool, request.body.accessToken, request.body.platform, request.cookies[sessionCookie]);
      reply.setCookie(sessionCookie, issued.session, {...attributes,maxAge:issued.maxAge});
      return {customerId:issued.customerId};
    } catch(error) { return reply.code(error instanceof OnesaError ? error.status : 503).send({error:error instanceof OnesaError ? error.code : 'onesa_unavailable'}); }
  });
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
