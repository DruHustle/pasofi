import * as oidc from 'openid-client';
import type pg from 'pg';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { decryptMfa, encryptMfa, freshOpaque, isOpaque, opaqueHash } from './staff-crypto.js';

type Store = pg.Pool | pg.PoolClient;
export type Configuration = { issuer: string; clientId: string; clientSecret: string; callback: URL; managed?: { audience: string; recordIssuer: string; keys: JSONWebKeySet } };
export type Admin = { subject: string; email: string; name: string; expires: number; authenticated: number; siteOperator?: true; providerSubject?: string; localRole?: string };
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
      !Array.isArray(value.onesa_roles) || !value.onesa_roles.includes('global_admin') || roles?.pasofi !== 'admin' ||
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
function staffAssertion(input: unknown, config: Configuration, now: number): Admin {
  const identity = customerAssertion(input, config, now);
  const claims = input as { onesa_product_roles: { pasofi: string }; amr?: unknown };
  if (claims.onesa_product_roles.pasofi === 'admin') return identity;
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
      config.managed = { audience, recordIssuer, keys: publicKeys(process.env.PASOFI_ONESA_PUBLIC_JWKS || '') };
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
      ? { scope: 'openid email profile', audience: this.config.managed.audience }
      : { scope: 'openid email profile onesa' };
  }
  protected async protocolClient() {
    if (this.legacyClient) return this.legacyClient;
    const { issuer, clientId, clientSecret } = this.config;
    this.discovery ??= oidc.discovery(new URL(issuer), clientId,
      { client_secret: clientSecret, id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic(clientSecret),
      { timeout: 5, [oidc.customFetch]: (url, init) => fetch(url, { ...init, redirect: 'error' } as RequestInit) }
    ).then(client => {
      if (client.serverMetadata().issuer !== issuer) throw denied();
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

  async start(db: Store) {
    const state = freshOpaque(), browser = freshOpaque(), verifier = oidc.randomPKCECodeVerifier(), nonce = freshOpaque();
    const authorization = oidc.buildAuthorizationUrl(await this.protocolClient(), {
      redirect_uri: this.config.callback.href, response_type: 'code', ...this.authorizationParameters,
      state, nonce, code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      acr_values: this.config.managed ? mfaPolicy : 'urn:onesa:mfa', max_age: '300',
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

  async inspect(token: string) {
    const managed = this.config.managed;
    if (managed && this.verificationKeys) {
      const now = Math.floor(Date.now() / 1000);
      const { payload } = await jwtVerify(token, this.verificationKeys, { algorithms: ['RS256'],
        issuer: this.config.issuer, audience: managed.audience, requiredClaims: ['sub','exp','iat'], maxTokenAge: '300s',
      }).catch(() => { throw denied(); });
      const stable = payload[ns + 'user_id'], products = payload[ns + 'products'], roles = payload[ns + 'roles'];
      if (typeof stable !== 'string' || !uuid.test(stable) || typeof payload.sub !== 'string' || !payload.sub || !Number.isSafeInteger(payload.iat) || !payload.iat ||
          !Number.isSafeInteger(payload.exp) || !payload.exp ||
          payload.exp <= payload.iat || payload.exp - payload.iat > 300 || !Array.isArray(products) ||
          !products.includes('pasofi') || !Array.isArray(roles)) throw denied();
      const identity: Admin = { subject: stable.toLowerCase(), providerSubject: payload.sub, email: '', name: '',
        authenticated: payload.iat, expires: payload.exp };
      if (!this.staffFlow) {
        if (!roles.some(role => ['admin','agent','support','customer'].includes(role))) throw denied();
        return identity;
      }
      const mfa = payload[ns + 'mfa_time'];
      const localRole = roles.find(role => ['admin','agent','support'].includes(role));
      if (!localRole || typeof mfa !== 'number' || !Number.isSafeInteger(mfa) || mfa > now || mfa + 300 <= now) throw denied();
      return { ...identity, localRole, siteOperator: true as const, authenticated: mfa, expires: Math.min(payload.exp, mfa + 300) };
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
    if (tokens.claims()?.sub !== (staff.providerSubject ?? staff.subject)) throw denied();
    const session = freshOpaque(), hash = opaqueHash(session);
    const envelope = this.protectAccess(tokens.access_token, 'onesa-session:' + hash.toString('hex'));
    await db.query('DELETE FROM staff_onesa_sessions WHERE expires_at<=now()');
    const values = [hash, this.recordIssuer, staff.subject, envelope, staff.expires];
    if (staff.siteOperator) {
      const inserted = await db.query(`INSERT INTO staff_onesa_sessions(token_hash,issuer,subject,access_ciphertext,expires_at,binding_id,staff_version)
        SELECT $1,$2,$3,$4,to_timestamp($5),b.id,u.version FROM staff_onesa_bindings b JOIN staff_users u ON u.id=b.staff_id
        WHERE b.issuer=$2 AND b.subject=$3::uuid AND u.status='approved' AND (($6::text IS NULL AND u.role IN ('agent','support')) OR u.role=$6)`, [...values, staff.localRole ?? null]);
      if (!inserted.rowCount) throw denied();
    } else {
      await db.query('INSERT INTO staff_onesa_sessions(token_hash,issuer,subject,access_ciphertext,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5))', values);
    }
    return { session, maxAge: Math.max(1, staff.expires - Math.floor(Date.now() / 1000)) };
  }

  async principal(db: Store, session: string, lock: boolean) {
    const hash = opaqueHash(session);
    const result = await db.query('SELECT subject,access_ciphertext,created_at,binding_id FROM staff_onesa_sessions WHERE token_hash=$1 AND issuer=$2 AND expires_at>now()',
      [hash, this.recordIssuer]);
    if (!result.rowCount) throw denied();
    const row = result.rows[0];
    let assertion: Admin;
    try {
      assertion = await this.inspect(this.readAccess(row.access_ciphertext, 'onesa-session:' + hash.toString('hex')));
    } catch (error) {
      if (error instanceof OnesaError && error.status === 401) throw new RejectedStaffSession(hash);
      throw error;
    }
    if (row.subject !== assertion.subject || Boolean(row.binding_id) !== Boolean(assertion.siteOperator)) throw new RejectedStaffSession(hash);
    if (assertion.siteOperator) {
      const operator = await db.query(`SELECT u.id,u.email,u.display_name,u.status,u.role,u.site_ids,u.version,u.created_at
        FROM staff_onesa_sessions s JOIN staff_onesa_bindings b ON b.id=s.binding_id AND b.issuer=s.issuer AND b.subject=s.subject
        JOIN staff_users u ON u.id=b.staff_id AND u.version=s.staff_version
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='approved' AND (($2::text IS NULL AND u.role IN ('agent','support')) OR u.role=$2)
        ${lock ? 'FOR UPDATE OF u,s' : ''}`, [hash, assertion.localRole ?? null]);
      if (!operator.rowCount) throw new RejectedStaffSession(hash);
      return { ...operator.rows[0], mfa_enrolled_at: new Date(assertion.authenticated * 1000) };
    }
    // Fence sign-out while the live Portal check was in flight.
    const current = await db.query('SELECT 1 FROM staff_onesa_sessions WHERE token_hash=$1 AND expires_at>now()' + (lock ? ' FOR UPDATE' : ''), [hash]);
    if (!current.rowCount) throw denied();
    return { id: assertion.subject, email: assertion.email, display_name: assertion.name, status: 'approved', role: 'admin', site_ids: [],
      version: 1, mfa_enrolled_at: new Date(assertion.authenticated * 1000), created_at: row.created_at };
  }
}
