import * as oidc from 'openid-client';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { decryptMfa, encryptMfa, freshOpaque, isOpaque, opaqueHash } from './staff-crypto.js';

type Store = pg.Pool | pg.PoolClient;
export type Configuration = { issuer: string; clientId: string; clientSecret: string; callback: URL; managed?: { audience: string; recordIssuer: string; keys: JSONWebKeySet; renewal?: boolean } };
export type Admin = { subject: string; email: string; name: string; expires: number; authenticated: number; siteOperator?: true; providerSubject?: string; authorizedClient?: string; localRole?: string };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class OnesaError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
// Retire the credential after any enclosing authorization transaction releases its locks.
export class RejectedStaffSession extends OnesaError {
  constructor(readonly hash: Buffer) { super(401, 'onesa_sign_in_rejected'); }
}
const denied = () => new OnesaError(401, 'onesa_sign_in_rejected');

export function adminAssertion(input: unknown, config: Configuration, now: number): Admin {
  if (!input || typeof input !== 'object') throw denied();
  const value = input as Record<string, unknown>;
  const roles = value.onesa_product_roles as Record<string, unknown> | undefined;
  if (value.active !== true || value.iss !== config.issuer || value.aud !== config.clientId ||
      typeof value.sub !== 'string' || !uuid.test(value.sub) || value.email_verified !== true ||
      typeof value.email !== 'string' || !value.email.includes('@') || value.email.length > 254 ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 ||
      !Array.isArray(value.onesa_applications) || !value.onesa_applications.includes('pasofi') ||
      !Array.isArray(value.onesa_roles) || !value.onesa_roles.includes('global_admin') || !['admin', 'administrator'].includes(String(roles?.pasofi)) ||
      !Array.isArray(value.amr) || !value.amr.some(method => method === 'otp' || method === 'mfa') ||
      typeof value.exp !== 'number' || !Number.isSafeInteger(value.exp) || value.exp <= now ||
      typeof value.auth_time !== 'number' || !Number.isSafeInteger(value.auth_time) ||
      value.auth_time > now || value.auth_time <= now - 28800) throw denied();
  return { subject: value.sub, email: value.email, name: value.name.trim(), authenticated: value.auth_time, expires: Math.min(value.exp, value.auth_time + 28800) };
}

export function customerAssertion(input: unknown, config: Configuration, now: number): Admin {
  if (!input || typeof input !== 'object') throw denied();
  const value = input as Record<string, unknown>;
  const roles = value.onesa_product_roles as Record<string, unknown> | undefined;
  if (roles?.pasofi === 'admin' || roles?.pasofi === 'administrator') return adminAssertion(input, config, now);
  if (value.active !== true || value.iss !== config.issuer || value.aud !== config.clientId ||
      typeof value.sub !== 'string' || !uuid.test(value.sub) || value.email_verified !== true ||
      typeof value.email !== 'string' || !value.email.includes('@') || value.email.length > 254 ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 ||
      !Array.isArray(value.onesa_applications) || !value.onesa_applications.includes('pasofi') || roles?.pasofi !== 'customer' ||
      typeof value.exp !== 'number' || !Number.isSafeInteger(value.exp) || value.exp <= now ||
      typeof value.auth_time !== 'number' || !Number.isSafeInteger(value.auth_time) || value.auth_time > now || value.auth_time <= now - 28800) throw denied();
  return { subject: value.sub, email: value.email, name: value.name.trim(), authenticated: value.auth_time, expires: Math.min(value.exp, value.auth_time + 28800) };
}
function staffAssertion(input: unknown, config: Configuration, now: number): Admin {
  const identity = customerAssertion(input, config, now);
  const claims = input as { onesa_product_roles: { pasofi: string }; amr?: unknown };
  if (claims.onesa_product_roles.pasofi === 'admin' || claims.onesa_product_roles.pasofi === 'administrator') return identity;
  if (!Array.isArray(claims.amr) || !claims.amr.some(method => method === 'mfa' || method === 'otp')) throw denied();
  return { ...identity, siteOperator: true };
}

const ns = 'https://onesa.eu/claims/';
const mfaPolicy = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';

function publicKeys(raw: string): JSONWebKeySet {
  const keys = JSON.parse(raw)?.keys;
  if (!Array.isArray(keys) || !keys.length || keys.length > 16 ||
      !keys.every(key => key && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') &&
        (!key.use || key.use === 'sig') && typeof key.kid === 'string' && key.kid &&
        typeof key.n === 'string' && typeof key.e === 'string' && !('d' in key)) ||
      new Set(keys.map(key => key.kid)).size !== keys.length) throw Error('Invalid managed public keys');
  return { keys };
}

export function configuredOnesaStaff(key: Buffer | null, allowed: (origin: string) => boolean): OnesaStaff | null {
  const { PASOFI_ONESA_ISSUER: issuer, PASOFI_ONESA_CLIENT_ID: clientId, PASOFI_ONESA_CLIENT_SECRET: clientSecret, PASOFI_ONESA_REDIRECT_URI: uri } = process.env;
  if (!key || !issuer || !clientId || !clientSecret || !uri) return null;
  try {
    const endpoint = new URL(issuer), callback = new URL(uri);
    const mode = process.env.PASOFI_ONESA_MODE || 'portal';
    if (mode !== 'portal' && mode !== 'managed') return null;
    const managed = mode === 'managed';
    if (endpoint.protocol !== 'https:' || issuer !== endpoint.origin + (managed ? '/' : '/api/v1/identity') ||
        callback.protocol !== 'https:' || uri !== callback.origin + '/onesa-callback.html' || !allowed(callback.origin) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(clientId) || clientSecret.length < 48 || clientSecret.length > 256) return null;
    const config: Configuration = { issuer, clientId, clientSecret, callback };
    if (managed) {
      const audience = process.env.PASOFI_ONESA_AUDIENCE;
      const recordIssuer = process.env.PASOFI_ONESA_RECORD_ISSUER;
      if (!audience || !recordIssuer) return null;
      const legacy = new URL(recordIssuer);
      const resource = new URL(audience);
      if (legacy.protocol !== 'https:' || recordIssuer !== legacy.origin + '/api/v1/identity' ||
          resource.protocol !== 'https:' || resource.origin !== audience) return null;
      config.managed = {
        audience, recordIssuer, keys: publicKeys(process.env.PASOFI_ONESA_PUBLIC_JWKS || ''),
        renewal: process.env.PASOFI_ONESA_SESSION_RENEWAL === 'true',
      };
    }
    return new OnesaStaff(config, key);
  } catch { return null; }
}

export class OnesaStaff {
  private discovery?: Promise<oidc.Configuration>;
  private readonly legacyClient?: oidc.Configuration;
  private readonly verificationKeys?: ReturnType<typeof createLocalJWKSet>;
  get recordIssuer() { return this.config.managed?.recordIssuer ?? this.config.issuer; }
  protected get authorizationParameters(): Record<string, string> {
    return this.config.managed
      ? { scope: 'openid email profile' + (this.config.managed.renewal ? ' offline_access' : ''), audience: this.config.managed.audience }
      : { scope: 'openid email profile onesa' };
  }
  protected async protocolClient() {
    if (this.legacyClient) return this.legacyClient;
    const { issuer, clientId, clientSecret } = this.config;
    this.discovery ??= oidc.discovery(new URL(issuer), clientId,
      { client_secret: clientSecret, id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic(clientSecret),
      { timeout: 5, [oidc.customFetch]: (url, init) => fetch(url, { ...init, redirect: 'error' } as RequestInit) }
    ).then(client => {
      const metadata = client.serverMetadata();
      if (metadata.issuer !== issuer || ![metadata.authorization_endpoint,metadata.token_endpoint,metadata.jwks_uri].every(endpoint => {
        if (!endpoint) return false;
        const url = new URL(endpoint);
        return url.origin === new URL(issuer).origin && !url.username && !url.password && !url.hash;
      })) throw denied();
      oidc.enableNonRepudiationChecks(client);
      return client;
    }).catch(error => { this.discovery = undefined; throw error; });
    return this.discovery;
  }
  protected protectAccess(token: string, context: string) {
    const envelope = encryptMfa(token, this.key, context);
    return this.config.managed ? 'managed.' + envelope : envelope;
  }
  protected readAccess(envelope: string, context: string) {
    const isManaged = envelope.startsWith('managed.');
    if (isManaged !== Boolean(this.config.managed)) throw denied();
    return decryptMfa(isManaged ? envelope.slice(8) : envelope, this.key, context);
  }

  protected async startRenewal(db: Store, access: string, refresh: unknown, identity: Admin) {
    if (!this.config.managed?.renewal || !identity.providerSubject || !identity.authorizedClient ||
        typeof refresh !== 'string' || !refresh || refresh.length > 16384) return null;
    const id = randomUUID(), expires = Math.floor(Date.now() / 1000) + 8 * 3600;
    await db.query("DELETE FROM onesa_session_renewals WHERE expires_at<now()-interval '10 minutes'");
    await db.query(`INSERT INTO onesa_session_renewals
        (id,subject,provider_subject,client_id,access_ciphertext,refresh_ciphertext,access_expires_at,expires_at,staff_mfa_at)
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8),to_timestamp($9))`,
    [id, identity.subject, identity.providerSubject, identity.authorizedClient, this.protectAccess(access, 'onesa-access:' + id),
      this.protectAccess(refresh, 'onesa-refresh:' + id), identity.expires, expires, this.staffFlow ? identity.authenticated : null]);
    return { id, expires };
  }

  protected async renewalIdentity(db: Store, id: string, staff: boolean, inTransaction = false): Promise<Admin> {
    const load = async (store: Store, lock: boolean) => (await store.query(`SELECT * FROM onesa_session_renewals
      WHERE id=$1 AND expires_at>now() AND (staff_mfa_at IS NOT NULL)=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, staff])).rows[0];
    const check = async (row: { subject: string; provider_subject: string; client_id: string; staff_mfa_at?: Date }, access: string) => {
      const identity = await this.inspect(access, true);
      if(identity.subject!==row.subject || identity.providerSubject!==row.provider_subject || identity.authorizedClient!==row.client_id)throw denied();
      return staff && row.staff_mfa_at ? {...identity, authenticated: Math.floor(row.staff_mfa_at.getTime()/1000)} : identity;
    };
    const existing = await load(db,false);
    if (!existing) throw denied();
    if (existing.access_expires_at.getTime() > Date.now() + 20000) {
      return check(existing,this.readAccess(existing.access_ciphertext,'onesa-access:' + id));
    }
    const renew = async (store: Store) => {
      const row = await load(store,true);
      if (!row) throw denied();
      if (row.access_expires_at.getTime() > Date.now() + 20000)
        return check(row,this.readAccess(row.access_ciphertext,'onesa-access:' + id));
      const confidential = await this.protocolClient();
      let provider = confidential;
      if(row.client_id!==this.config.clientId){
        if(staff || ![process.env.PASOFI_ONESA_IOS_CLIENT_ID,process.env.PASOFI_ONESA_ANDROID_CLIENT_ID].includes(row.client_id))throw denied();
        provider = new oidc.Configuration(confidential.serverMetadata(),row.client_id,undefined,oidc.None());
        provider.timeout=5;
        provider[oidc.customFetch]=(url, init)=>fetch(url,{...init,redirect:'error'} as RequestInit);
      }
      const saved = this.readAccess(row.refresh_ciphertext,'onesa-refresh:' + id);
      let tokens;
      try { tokens = await oidc.refreshTokenGrant(provider,saved); }
      catch(error) {
        if(error instanceof oidc.ResponseBodyError && ['invalid_grant','access_denied'].includes(error.error)) {
          // Remove the rejected provider credential, allowing any sibling
          // handoff session to fail closed from the same revocation.
          await store.query("UPDATE onesa_session_renewals SET expires_at=now(),refresh_ciphertext='' WHERE id=$1",[id]);
          return null;
        }
        throw new OnesaError(503,'onesa_unavailable');
      }
      if(tokens.token_type.toLowerCase()!=='bearer'||!tokens.access_token||tokens.access_token.length>16384||
          tokens.refresh_token!==undefined&&(!tokens.refresh_token||tokens.refresh_token.length>16384))throw denied();
      const checked = await check(row,tokens.access_token);
      await store.query(`UPDATE onesa_session_renewals SET access_ciphertext=$2,refresh_ciphertext=$3,access_expires_at=to_timestamp($4) WHERE id=$1`,
        [id,this.protectAccess(tokens.access_token,'onesa-access:' + id),
          this.protectAccess(tokens.refresh_token ?? saved,'onesa-refresh:' + id),checked.expires]);
      return checked;
    };
    if (inTransaction) {
      const result = await renew(db);
      if (!result) throw denied();
      return result;
    }
    const client = await (db as pg.Pool).connect();
    let identity: Admin | null;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      identity = await renew(client);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    if (!identity) throw denied();
    return identity;
  }

  constructor(readonly config: Configuration, protected readonly key: Buffer) {
    const { issuer, clientId, clientSecret } = config;
    if (config.managed) {
      this.verificationKeys = createLocalJWKSet(config.managed.keys);
      return;
    }
    this.legacyClient = new oidc.Configuration({
      issuer, authorization_endpoint: issuer + '/auth', token_endpoint: issuer + '/token',
      jwks_uri: issuer + '/jwks', code_challenge_methods_supported: ['S256'],
    }, clientId, { client_secret: clientSecret, id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic(clientSecret));
    this.legacyClient.timeout = 5;
    this.legacyClient[oidc.customFetch] = (url, init) => fetch(url, { ...init, redirect: 'error' } as RequestInit);
    oidc.enableNonRepudiationChecks(this.legacyClient);
  }

  async start(db: Store, reauthenticate = false) {
    const state = freshOpaque(), browser = freshOpaque(), verifier = oidc.randomPKCECodeVerifier(), nonce = freshOpaque();
    const authorization = oidc.buildAuthorizationUrl(await this.protocolClient(), {
      redirect_uri: this.config.callback.href, response_type: 'code', ...this.authorizationParameters,
      state, nonce, code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      acr_values: this.config.managed ? mfaPolicy : 'urn:onesa:mfa', max_age: reauthenticate ? '0' : '300',
      ...(reauthenticate ? {prompt:'login'} : {}),
    });
    await db.query('DELETE FROM staff_onesa_flows WHERE expires_at<=now()');
    await db.query('INSERT INTO staff_onesa_flows(state_hash,browser_hash,verifier,nonce) VALUES($1,$2,$3,$4)',
      [opaqueHash(state), opaqueHash(browser), verifier, nonce]);
    return { browser, authorizationUrl: authorization.href };
  }

  protected assertion(input: unknown): Admin {
    return staffAssertion(input, this.config, Math.floor(Date.now() / 1000));
  }

  protected get staffFlow() { return true; }

  async inspect(token: string, renewal = false) {
    const managed = this.config.managed;
    if (managed && this.verificationKeys) {
      const now = Math.floor(Date.now() / 1000);
      const { payload } = await jwtVerify(token, this.verificationKeys, { algorithms: ['RS256'],
        issuer: this.config.issuer, audience: managed.audience, requiredClaims: ['sub','exp','iat'], maxTokenAge: '300s',
      }).catch(() => { throw denied(); });
      const stable = payload[ns + 'user_id'], products = payload[ns + 'products'], roles = payload[ns + 'roles'];
      if (typeof stable !== 'string' || !uuid.test(stable) || typeof payload.sub !== 'string' || !payload.sub || !Number.isSafeInteger(payload.iat) || !payload.iat ||
          !Number.isSafeInteger(payload.exp) || !payload.exp ||
          payload.exp <= payload.iat || !Array.isArray(products) ||
          products.length !== 1 || products[0] !== 'pasofi' || !Array.isArray(roles)) throw denied();
      const identity: Admin = { subject: stable.toLowerCase(), providerSubject: payload.sub, authorizedClient: typeof payload.azp === 'string' ? payload.azp : undefined, email: '', name: '',
        authenticated: payload.iat, expires: Math.min(payload.exp,payload.iat + 300) };
      const mfa = payload[ns + 'mfa_time'];
      const freshMfa = typeof mfa === 'number' && Number.isSafeInteger(mfa) && mfa <= now && mfa + 300 > now;
      if (!this.staffFlow) {
        // Customer access requires its own product grant. Legacy global roles
        // are outside the managed resource-token contract.
        if (roles.includes('customer')) return identity;
        if (roles.length===1 && (roles[0]==='admin' || roles[0]==='administrator') && (freshMfa || renewal)) return identity;
        throw denied();
      }
      // Every managed staff role, including administrator, needs its matching
      // approved local binding. Multiple staff roles cannot select a weaker
      // binding based on claim order or bypass product-owned approval.
      const localRoles = roles.filter(role => role === 'admin' || role === 'administrator' || role === 'agent' || role === 'support');
      if (localRoles.length !== 1 || (!freshMfa && !renewal)) throw denied();
      return { ...identity, localRole: (localRoles[0] === 'administrator' ? 'admin' : localRoles[0]) as 'admin' | 'agent' | 'support', siteOperator: true as const,
        authenticated: freshMfa ? mfa as number : 0, expires: identity.expires };
    }
    const { clientId, clientSecret, issuer } = this.config;
    const encode = (value: string) => new URLSearchParams({ c: value }).toString().slice(2);
    const basic = Buffer.from(encode(clientId) + ':' + encode(clientSecret)).toString('base64');
    const response = await fetch(issuer + '/session', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new OnesaError(503, 'onesa_unavailable');
    return this.assertion(await response.json());
  }

  async finish(db: Store, browser: unknown, params: { state: string; code: string; iss?: string }) {
    if (!isOpaque(browser) || !isOpaque(params.state)) throw denied();
    const result = await db.query('DELETE FROM staff_onesa_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING verifier,nonce',
      [opaqueHash(params.state), opaqueHash(browser)]);
    if (!result.rowCount) throw denied();
    const url = new URL(this.config.callback);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const tokens = await oidc.authorizationCodeGrant(await this.protocolClient(), url, {
      pkceCodeVerifier: result.rows[0].verifier, expectedNonce: result.rows[0].nonce, expectedState: params.state, idTokenExpected: true, maxAge: 300,
    }).catch(() => { throw denied(); });
    if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.access_token || tokens.access_token.length > (this.config.managed ? 16384 : 2048)) throw denied();
    const staff = await this.inspect(tokens.access_token);
    const claims = tokens.claims();
    if (claims?.sub !== (staff.providerSubject ?? staff.subject)) throw denied();
    if (this.config.managed && staff.authorizedClient && staff.authorizedClient !== this.config.clientId) throw denied();
    if (this.config.managed && staff.siteOperator && process.env.PASOFI_ONESA_STAFF_ONBOARDING === 'true') {
      const bound = await db.query(`SELECT u.status FROM staff_onesa_bindings b JOIN staff_users u ON u.id=b.staff_id
        WHERE b.issuer=$1 AND b.subject=$2::uuid`, [this.recordIssuer, staff.subject]);
      if (bound.rows[0]?.status === 'pending') throw new OnesaError(403, 'staff_assignment_pending');
      if (!bound.rowCount) {
        if (claims.email_verified !== true || typeof claims.email !== 'string') throw denied();
        const created = await db.query('SELECT public.create_managed_staff_applicant($1,$2::uuid,$3) AS created',
          [this.recordIssuer, staff.subject, claims.email.trim().toLowerCase()]);
        if (created.rows[0].created) throw new OnesaError(403, 'staff_assignment_pending');
        // A parallel request may have created the same applicant. Email
        // conflicts with another identity remain an ownership review.
        const applicant = await db.query(`SELECT u.status FROM staff_onesa_bindings b JOIN staff_users u ON u.id=b.staff_id
          WHERE b.issuer=$1 AND b.subject=$2::uuid`, [this.recordIssuer, staff.subject]);
        if (applicant.rows[0]?.status === 'pending') throw new OnesaError(403, 'staff_assignment_pending');
        if (!applicant.rowCount) throw new OnesaError(409, 'staff_binding_review_required');
      }
    }
    const session = freshOpaque(), hash = opaqueHash(session);
    const envelope = this.protectAccess(tokens.access_token, 'onesa-session:' + hash.toString('hex'));
    const renewal = await this.startRenewal(db,tokens.access_token,tokens.refresh_token,staff);
    // Keep recently expired managed session records available for explicit SSO
    // logout. Principal lookup still checks the database expiry independently.
    await db.query("DELETE FROM staff_onesa_sessions WHERE expires_at<=now() AND (left(access_ciphertext,8)<>'managed.' OR expires_at<now()-interval '30 days')");
    const values = [hash, this.recordIssuer, staff.subject, envelope, renewal?.expires ?? staff.expires, renewal?.id ?? null];
    if (staff.siteOperator) {
      const inserted = await db.query(`INSERT INTO staff_onesa_sessions(token_hash,issuer,subject,access_ciphertext,expires_at,renewal_id,binding_id,staff_version)
        SELECT $1,$2,$3,$4,to_timestamp($5),$6,b.id,u.version FROM staff_onesa_bindings b JOIN staff_users u ON u.id=b.staff_id
        WHERE b.issuer=$2 AND b.subject=$3::uuid AND u.status='approved' AND (($7::text IS NULL AND u.role IN ('agent','support')) OR u.role=$7)`, [...values, staff.localRole ?? null]);
      if (!inserted.rowCount) {
        if (!this.config.managed || staff.localRole!=='admin') throw denied();
        // A central administrator can enter PasoFi without a site grant. Never
        // replace an existing, conflicting or disabled local staff binding.
        const pending=await db.query(`INSERT INTO staff_onesa_sessions(token_hash,issuer,subject,access_ciphertext,expires_at,renewal_id)
          SELECT $1,$2,$3::uuid,$4,to_timestamp($5),$6 WHERE NOT EXISTS
          (SELECT 1 FROM staff_onesa_bindings WHERE issuer=$2 AND subject=$3::uuid)`,values);
        if(!pending.rowCount)throw denied();
      }
    } else {
      await db.query('INSERT INTO staff_onesa_sessions(token_hash,issuer,subject,access_ciphertext,expires_at,renewal_id) VALUES($1,$2,$3,$4,to_timestamp($5),$6)', values);
    }
    return { session, maxAge: this.config.managed ? 30 * 86400 : Math.max(1, staff.expires - Math.floor(Date.now() / 1000)) };
  }

  async principal(db: Store, session: string, lock: boolean) {
    const hash = opaqueHash(session);
    const result = await db.query('SELECT subject,access_ciphertext,created_at,binding_id,renewal_id FROM staff_onesa_sessions WHERE token_hash=$1 AND issuer=$2 AND expires_at>now()',
      [hash, this.recordIssuer]);
    if (!result.rowCount) throw denied();
    const row = result.rows[0];
    let assertion: Admin;
    try {
      assertion = row.renewal_id ? await this.renewalIdentity(db,row.renewal_id,true,lock)
        : await this.inspect(this.readAccess(row.access_ciphertext, 'onesa-session:' + hash.toString('hex')));
    } catch (error) {
      if (error instanceof OnesaError && error.status === 401) throw new RejectedStaffSession(hash);
      throw error;
    }
    if (row.subject !== assertion.subject) throw new RejectedStaffSession(hash);
    const pendingAdmin=!row.binding_id && this.config.managed && assertion.siteOperator && assertion.localRole==='admin';
    if(pendingAdmin){
      const current=await db.query(`SELECT 1 FROM staff_onesa_sessions s WHERE token_hash=$1 AND expires_at>now()
        AND binding_id IS NULL AND NOT EXISTS (SELECT 1 FROM staff_onesa_bindings b WHERE b.issuer=s.issuer AND b.subject=s.subject)
        ${lock?'FOR UPDATE OF s':''}`,[hash]);
      if(!current.rowCount)throw new RejectedStaffSession(hash);
      return {id:assertion.subject,email:assertion.email,display_name:assertion.name,status:'pending',role:'admin',site_ids:[],
        version:1,mfa_enrolled_at:new Date(assertion.authenticated*1000),mfa_verified_at:new Date(assertion.authenticated*1000),created_at:row.created_at};
    }
    if (Boolean(row.binding_id) !== Boolean(assertion.siteOperator)) throw new RejectedStaffSession(hash);
    if (assertion.siteOperator) {
      const operator = await db.query(`SELECT u.id,u.email,u.display_name,u.status,u.role,u.site_ids,u.version,u.created_at
        FROM staff_onesa_sessions s JOIN staff_onesa_bindings b ON b.id=s.binding_id AND b.issuer=s.issuer AND b.subject=s.subject
        JOIN staff_users u ON u.id=b.staff_id AND u.version=s.staff_version
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='approved' AND (($2::text IS NULL AND u.role IN ('agent','support')) OR u.role=$2)
        ${lock ? 'FOR UPDATE OF u,s' : ''}`, [hash, assertion.localRole ?? null]);
      if (!operator.rowCount) throw new RejectedStaffSession(hash);
      return { ...operator.rows[0], mfa_enrolled_at: new Date(assertion.authenticated * 1000), mfa_verified_at: new Date(assertion.authenticated * 1000) };
    }
    // Fence sign-out while the live Portal check was in flight.
    const current = await db.query('SELECT 1 FROM staff_onesa_sessions WHERE token_hash=$1 AND expires_at>now()' + (lock ? ' FOR UPDATE' : ''), [hash]);
    if (!current.rowCount) throw denied();
    return { id: assertion.subject, email: assertion.email, display_name: assertion.name, status: 'approved', role: 'admin', site_ids: [],
      version: 1, mfa_enrolled_at: new Date(assertion.authenticated * 1000), mfa_verified_at: new Date(assertion.authenticated * 1000), created_at: row.created_at };
  }
}
