import * as oidc from 'openid-client';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { OnesaStaff, OnesaError, customerAssertion, configuredOnesaStaff, nativeCustomerClient, type Admin } from './onesa-staff.js';
import { freshOpaque, isOpaque, mfaKey, opaqueHash } from './staff-crypto.js';

const denied = () => new OnesaError(401, 'onesa_sign_in_rejected');
const managedIssuer = 'https://auth.onesa.eu/';
// Long enough to create an account and confirm its email on the provider's
// pages within one sign-in. The flow stays single-use and browser-bound.
export const customerFlowLifetime = 15 * 60;
export { customerAssertion };
export function customerReturnTo(value: unknown, hotspot = false): string {
  if (typeof value !== 'string') return '/#account';
  if (value === '/#connect' || (hotspot && ['/connect', '/connect#bundles', '/connect#voucher'].includes(value))) return value;
  return /^\/#(?:home|usage|bundles|history|account|wifi|voucher|checkout|receipt)(?:\?bundle=[a-z][a-z0-9-]{0,39})?$/.test(value) ? value : '/#account';
}
export class OnesaCustomer extends OnesaStaff {
  constructor(config: OnesaStaff['config'], key: Buffer, readonly hotspotCallback?: URL) { super(config, key); }
  protected get staffFlow() { return false; }
  protected assertion(input: unknown): Admin { return customerAssertion(input, this.config, Math.floor(Date.now() / 1000)); }
  get signupEnabled() {
    return Boolean(this.config.managed && process.env.PASOFI_ONESA_DIRECT_SIGNUP === 'true');
  }
  get verifiedNativeCallback() {
    return this.config.callback.origin === 'https://pasofi.mobile.onesa.eu' &&
      process.env.PASOFI_ONESA_VERIFIED_NATIVE_CALLBACK === 'true'
      ? 'https://pasofi.mobile.onesa.eu/native/onesa-callback.html' : undefined;
  }
  nativeClient(platform: 'ios' | 'android') {
    if (process.env.PASOFI_ONESA_NATIVE_CLIENT_ID && !this.verifiedNativeCallback) return null;
    return nativeCustomerClient(platform, this.config.clientId);
  }
  // Keep the opaque member locator after provider authorization expires. Its
  // database privileges still end at expires_at and it cannot create a guest.
  private cookieAge(expires: number) {
    return this.config.managed ? 30 * 86400 : Math.max(1, expires - Math.floor(Date.now() / 1000));
  }
  webCallback(origin: string | undefined) {
    if (origin === this.config.callback.origin) return this.config.callback;
    return origin && this.hotspotCallback?.origin === origin ? this.hotspotCallback : null;
  }
  private browserHash(browser: string, callback: URL) {
    // Retain existing canonical in-flight flows. A captive flow's cookie proof
    // is bound to its exact callback even if a client replays it on another host.
    return opaqueHash(callback.href === this.config.callback.href ? browser : callback.href + '\0' + browser);
  }
  async start(db: pg.Pool | pg.PoolClient, returnTo: unknown = '/#account', callback = this.config.callback, guestToken?: string, signup = false) {
    if (signup && (!this.signupEnabled || guestToken)) throw new OnesaError(403, 'onesa_signup_unavailable');
    const state = freshOpaque(), browser = freshOpaque(), verifier = oidc.randomPKCECodeVerifier(), nonce = freshOpaque();
    const authorization = oidc.buildAuthorizationUrl(await this.protocolClient(), {
      redirect_uri: callback.href, response_type: 'code', ...this.authorizationParameters,
      state, nonce, code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      // A customer entry asks Onesa for the customer role only. Onesa's Actions
      // then skip the staff authenticator detour for administrators and issue
      // a customer token; earlier Actions ignore the value.
      ...(this.config.managed ? {acr_values:'urn:onesa:authentication:pasofi-customer'} : {}),
      ...(signup ? { screen_hint: 'signup', prompt: 'login' } : {}),
      ...(guestToken ? {prompt:'login',max_age:'0'} : {}),
    });
    await db.query('DELETE FROM customer_onesa_flows WHERE expires_at<=now()');
    await db.query("INSERT INTO customer_onesa_flows(state_hash,browser_hash,verifier,nonce,return_to,guest_session_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+($7 * interval '1 second'))",
      [opaqueHash(state), this.browserHash(browser, callback), verifier, nonce, customerReturnTo(returnTo, callback.href === this.hotspotCallback?.href),
        guestToken ? opaqueHash(guestToken) : null, customerFlowLifetime]);
    return { browser, authorizationUrl: authorization.href };
  }
  async finish(db: pg.Pool, browser: unknown, params: { state: string; code: string; iss?: string }, callback = this.config.callback, guestToken?: string) {
    if (!isOpaque(browser) || !isOpaque(params.state)) throw denied();
    const result = await db.query('DELETE FROM customer_onesa_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING verifier,nonce,return_to,guest_session_hash', [opaqueHash(params.state), this.browserHash(browser, callback)]);
    if (!result.rowCount) throw denied();
    const guestHash: Buffer | null = result.rows[0].guest_session_hash;
    if (guestHash && (!isOpaque(guestToken) || !guestHash.equals(opaqueHash(guestToken)))) throw denied();
    const url = new URL(callback);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const tokens = await oidc.authorizationCodeGrant(await this.protocolClient(), url, {
      pkceCodeVerifier: result.rows[0].verifier, expectedNonce: result.rows[0].nonce, expectedState: params.state, idTokenExpected: true,
      ...(guestHash ? {maxAge:300} : {}),
    }).catch(() => { throw denied(); });
    if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.access_token || tokens.access_token.length > (this.config.managed ? 16384 : 2048)) throw denied();
    const identity = await this.inspect(tokens.access_token);
    if (tokens.claims()?.sub !== (identity.providerSubject ?? identity.subject)) throw denied();
    if (this.config.managed && identity.authorizedClient && identity.authorizedClient !== this.config.clientId) throw denied();
    return {
      ...await this.saveCustomer(db, tokens.access_token, identity, undefined, tokens.refresh_token, guestHash),
      returnTo: customerReturnTo(result.rows[0].return_to, callback.href === this.hotspotCallback?.href),
    };
  }
  async nativeSession(db: pg.Pool, access: string, platform: 'ios' | 'android', existingToken?: string, refresh?: string) {
    const id = this.nativeClient(platform);
    if (!this.config.managed || !id) throw new OnesaError(503,'onesa_unavailable');
    const identity = await this.inspect(access);
    if (identity.authorizedClient !== id) throw denied();
    return this.saveCustomer(db, access, identity, existingToken, refresh);
  }
  private async saveCustomer(db: pg.Pool, access: string, identity: Admin, existingToken?: string, refresh?: string, guestHash?: Buffer | null) {
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
      let guestId: string | undefined;
      if (guestHash) {
        const presented = await transaction.query('SELECT customer_id FROM customer_sessions WHERE token_hash=$1',[guestHash]);
        guestId = presented.rows[0]?.customer_id;
        if (!guestId) throw new OnesaError(409,'guest_session_changed');
        await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['onesa-guest-link:' + guestId]);
        const guest = await transaction.query(`SELECT 1 FROM customer_sessions
          WHERE token_hash=$1 AND customer_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`, [guestHash,guestId]);
        if (!guest.rowCount || (await transaction.query('SELECT 1 FROM customer_onesa_identities WHERE customer_id=$1',[guestId])).rowCount)
          throw new OnesaError(409,'guest_session_changed');
        if (existing.rowCount) throw new OnesaError(409,'guest_transfer_requires_review');
      }
      customerId = existing.rows[0]?.customer_id ?? guestId ?? randomUUID();
      if (!existing.rowCount) {
        if (!guestId) await transaction.query('INSERT INTO customers(id) VALUES($1)',[customerId]);
        await transaction.query('INSERT INTO customer_onesa_identities(issuer,subject,customer_id) VALUES($1,$2,$3)',[this.recordIssuer,identity.subject,customerId]);
        if (guestId) await transaction.query('UPDATE customer_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE customer_id=$1',[guestId]);
      }
      const renewal = await this.startRenewal(transaction,access,refresh,identity);
      await transaction.query('INSERT INTO customer_onesa_sessions(token_hash,customer_id,access_ciphertext,expires_at,renewal_id) VALUES($1,$2,$3,to_timestamp($4),$5)',
        [hash,customerId,envelope,renewal?.expires ?? identity.expires,renewal?.id ?? null]);
      await transaction.query('COMMIT');
    } catch(error) { await transaction.query('ROLLBACK'); throw error; } finally { transaction.release(); }
    return { session, maxAge: this.cookieAge(identity.expires), customerId };
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
    if (await this.customerByHash(db,source.token_hash,source.customer_id) !== source.customer_id) throw denied();
    const access = this.readAccess(source.access_ciphertext, 'onesa-customer:'+source.token_hash.toString('hex'));
    const token=freshOpaque(),hash=opaqueHash(token),expires=Math.floor(source.expires_at.getTime()/1000);
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
      await client.query('INSERT INTO customer_onesa_sessions(token_hash,customer_id,access_ciphertext,expires_at,renewal_id) VALUES($1,$2,$3,to_timestamp($4),$5)',
        [hash,source.customer_id,this.protectAccess(access,'onesa-customer:'+hash.toString('hex')),expires,source.renewal_id]);
      await client.query('COMMIT');
      return {customerId:source.customer_id as string,token,maxAge:this.cookieAge(expires)};
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async customer(db: pg.Pool, token: string, customerId: string): Promise<string | null> {
    return this.customerByHash(db,opaqueHash(token),customerId);
  }
  private async customerByHash(db: pg.Pool, hash: Buffer, customerId: string): Promise<string | null> {
    const row = (await db.query(`SELECT i.issuer,i.subject,s.access_ciphertext,s.renewal_id FROM customer_onesa_identities i
      LEFT JOIN customer_onesa_sessions s ON s.token_hash=$2 AND s.customer_id=i.customer_id AND s.revoked_at IS NULL AND s.expires_at>now()
      WHERE i.customer_id=$1`, [customerId, hash])).rows[0];
    if (!row) return customerId;
    if (row.issuer !== this.recordIssuer || !row.access_ciphertext) return null;
    let identity: Admin;
    try {
      identity = row.renewal_id ? await this.renewalIdentity(db,row.renewal_id,false)
        : await this.inspect(this.readAccess(row.access_ciphertext, 'onesa-customer:' + hash.toString('hex')));
    }
    catch (error) {
      if (error instanceof OnesaError && error.status === 401) {
        await db.query('UPDATE customer_onesa_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1 AND customer_id=$2',[hash,customerId]);
        return null;
      }
      throw error;
    }
    if (row.subject !== identity.subject) {
      await db.query('UPDATE customer_onesa_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1 AND customer_id=$2',[hash,customerId]);
      return null;
    }
    const current = await db.query('SELECT 1 FROM customer_onesa_sessions WHERE token_hash=$1 AND customer_id=$2 AND revoked_at IS NULL AND expires_at>now()', [hash, customerId]);
    return current.rowCount ? customerId : null;
  }
}
export function configureOnesaCustomer(demo: boolean, allowed: (value: string | undefined) => boolean) {
  const key = mfaKey(demo), config = configuredOnesaStaff(key, allowed);
  if (!key || !config) return null;
  let hotspotCallback: URL | undefined;
  const uri = process.env.PASOFI_ONESA_HOTSPOT_REDIRECT_URI;
  if (uri && config.config.managed && config.config.issuer === managedIssuer) {
    try {
      const callback = new URL(uri);
      if (callback.protocol === 'https:' && uri === callback.origin + '/onesa-callback.html' &&
          callback.origin !== config.config.callback.origin && allowed(callback.origin)) hotspotCallback = callback;
    } catch { /* An invalid optional binding leaves the canonical flow available. */ }
  }
  return new OnesaCustomer(config.config, key, hotspotCallback);
}
export function registerCustomerOnesa(app: FastifyInstance, pool: pg.Pool | null, demo: boolean, onesa: OnesaCustomer | null) {
  const flowCookie = demo ? 'pasofi_demo_onesa_customer_flow' : '__Host-pasofi_onesa_customer_flow';
  const sessionCookie = demo ? 'pamofi_demo_session' : '__Host-pamofi_session';
  const attributes = { path: '/', httpOnly: true, secure: !demo, sameSite: 'lax' as const };
  const signingKey = mfaKey(demo);
  const signature = (id:string) => createHmac('sha256', signingKey!).update('pasofi-onesa-browser-rate:'+id).digest();
  const browserKeys = new WeakMap<object,string>();
  let checkBrowserRate:ReturnType<typeof app.createRateLimit>;
  app.addHook('onReady', async () => {
    checkBrowserRate = app.createRateLimit({ max: 12, timeWindow: '1 minute', keyGenerator: request => browserKeys.get(request)! });
  });
  app.get('/v1/onesa/availability', async (_request, reply) => {
    reply.header('Cache-Control','no-store');
    const origin = pool && onesa ? onesa.config.callback.origin : null;
    const managed = onesa?.config.managed;
    const hotspotOrigin = pool && onesa?.hotspotCallback?.origin;
    return { origin, handoff: Boolean(origin), ...(origin && onesa?.signupEnabled ? { signup: true } : {}),
      ...(hotspotOrigin ? { hotspotOrigin } : {}), ...(origin && managed ? { native: {
      issuer: onesa.config.issuer, audience: managed.audience, ios: onesa.nativeClient('ios'), android: onesa.nativeClient('android'),
      ...(managed.renewal ? { renewal: true } : {}),
      ...(onesa.verifiedNativeCallback ? {
        verifiedCallback: onesa.verifiedNativeCallback,
        ...(onesa.signupEnabled ? { signup: true } : {}),
      } : {}),
    } } : {}) };
  });
  app.post<{Body:{accessToken:string;platform:'ios'|'android';refreshToken?:string}}>('/v1/onesa/native-session', {
    config:{rateLimit:{max:20,timeWindow:'1 minute'}}, schema:{body:{type:'object',additionalProperties:false,
      required:['accessToken','platform'],properties:{
        platform:{enum:['ios','android']},accessToken:{type:'string',minLength:100,maxLength:12000},
        refreshToken:{type:'string',minLength:1,maxLength:3000},
      }}},
  }, async (request,reply)=>{
    reply.header('Cache-Control','no-store');
    if (!pool || !onesa?.config.managed) return reply.code(503).send({error:'onesa_unavailable'});
    if (request.headers.origin !== onesa.config.callback.origin) return reply.code(403).send({error:'origin_rejected'});
    try {
      const issued = await onesa.nativeSession(pool, request.body.accessToken, request.body.platform, request.cookies[sessionCookie], request.body.refreshToken);
      reply.setCookie(sessionCookie, issued.session, {...attributes,maxAge:issued.maxAge});
      return {customerId:issued.customerId};
    } catch(error) { return reply.code(error instanceof OnesaError ? error.status : 503).send({error:error instanceof OnesaError ? error.code : 'onesa_unavailable'}); }
  });
  for (const action of ['start', 'complete'] as const) app.post<{Body:Record<string,unknown>}>(`/v1/onesa/${action}`, {
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: action === 'complete' ? ['code','state'] : [], properties: action === 'start' ? {
      returnTo: { type:'string',maxLength:100 }, claimGuest: { type:'boolean' }, signup: { type:'boolean' },
    } : {
      state: { type:'string',minLength:43,maxLength:43 }, code:{ type:'string',minLength:1,maxLength:2048 }, iss:{ type:'string',maxLength:1024 }
    } } }
  }, async (request, reply) => {
    reply.header('Cache-Control','no-store');
    if (!pool || !onesa) return reply.code(503).send({error:'onesa_unavailable'});
    const callback = onesa.webCallback(request.headers.origin);
    if (!callback) return reply.code(403).send({error:'origin_rejected'});
    const presented = request.cookies[flowCookie];
    const [proof, browserId, mac, extra] = (presented ?? '').split('.');
    const validBrowser = !!signingKey && isOpaque(proof) && isOpaque(browserId) && isOpaque(mac) && extra === undefined &&
      timingSafeEqual(signature(browserId), Buffer.from(mac,'base64url'));
    if (validBrowser) {
      browserKeys.set(request, action + ':' + browserId);
      const limit = await checkBrowserRate(request);
      if (!limit.isAllowed && limit.isExceeded) return reply.header('Retry-After',limit.ttlInSeconds).code(429).send({error:'onesa_rate_limited'});
    }
    try {
      if (action === 'start') {
        const guest = request.cookies[sessionCookie];
        const signup = request.body.signup === true;
        if (signup && request.body.claimGuest === true) return reply.code(403).send({error:'onesa_signup_unavailable'});
        if (request.body.claimGuest === true && (!isOpaque(guest) || !(await pool.query(`SELECT 1 FROM customer_sessions s
          WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
          AND NOT EXISTS (SELECT 1 FROM customer_onesa_identities i WHERE i.customer_id=s.customer_id)`, [opaqueHash(guest)])).rowCount))
          return reply.code(409).send({error:'guest_session_changed'});
        const flow = await onesa.start(pool, request.body.returnTo, callback, request.body.claimGuest === true ? guest : undefined, signup);
        const id = validBrowser ? browserId : freshOpaque();
        const cookie = signingKey ? flow.browser + '.' + id + '.' + signature(id).toString('base64url') : flow.browser;
        reply.setCookie(flowCookie, cookie, {...attributes,maxAge:customerFlowLifetime});
        return {authorizationUrl:flow.authorizationUrl,expiresIn:customerFlowLifetime};
      }
      const result = await onesa.finish(pool, validBrowser ? proof : presented, request.body as {state:string;code:string;iss?:string}, callback,request.cookies[sessionCookie]);
      reply.clearCookie(flowCookie,attributes);
      reply.setCookie(sessionCookie,result.session,{...attributes,maxAge:result.maxAge});
      return {authenticated:true,customerId:result.customerId,returnTo:result.returnTo};
    } catch(error) { return reply.code(error instanceof OnesaError ? error.status : 503).send({error:error instanceof OnesaError ? error.code : 'onesa_unavailable'}); }
  });
}
