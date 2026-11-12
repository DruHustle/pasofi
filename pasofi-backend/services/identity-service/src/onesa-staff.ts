import * as oidc from 'openid-client';
import type pg from 'pg';
import { decryptMfa, encryptMfa, freshOpaque, isOpaque, opaqueHash } from './staff-crypto.js';

type Store = pg.Pool | pg.PoolClient;
export type Configuration = { issuer: string; clientId: string; clientSecret: string; callback: URL };
export type Admin = { subject: string; email: string; name: string; expires: number; authenticated: number; siteOperator?: true };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class OnesaError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
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

export function configuredOnesaStaff(key: Buffer | null, allowed: (origin: string) => boolean): OnesaStaff | null {
  const { PASOFI_ONESA_ISSUER: issuer, PASOFI_ONESA_CLIENT_ID: clientId, PASOFI_ONESA_CLIENT_SECRET: clientSecret, PASOFI_ONESA_REDIRECT_URI: uri } = process.env;
  if (!key || !issuer || !clientId || !clientSecret || !uri) return null;
  try {
    const endpoint = new URL(issuer), callback = new URL(uri);
    if (endpoint.protocol !== 'https:' || issuer !== endpoint.origin + '/api/v1/identity' ||
        callback.protocol !== 'https:' || uri !== callback.origin + '/onesa-callback.html' || !allowed(callback.origin) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(clientId) || clientSecret.length < 48 || clientSecret.length > 256) return null;
    return new OnesaStaff({ issuer, clientId, clientSecret, callback }, key);
  } catch { return null; }
}

export class OnesaStaff {
  readonly client: oidc.Configuration;
  constructor(readonly config: Configuration, protected readonly key: Buffer) {
    const { issuer, clientId, clientSecret } = config;
    this.client = new oidc.Configuration({
      issuer, authorization_endpoint: issuer + '/auth', token_endpoint: issuer + '/token',
      jwks_uri: issuer + '/jwks', code_challenge_methods_supported: ['S256'],
    }, clientId, { client_secret: clientSecret, id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic(clientSecret));
    this.client.timeout = 5;
    this.client[oidc.customFetch] = (url, init) => fetch(url, { ...init, redirect: 'error' } as RequestInit);
    oidc.enableNonRepudiationChecks(this.client);
  }

  async start(db: Store) {
    const state = freshOpaque(), browser = freshOpaque(), verifier = oidc.randomPKCECodeVerifier(), nonce = freshOpaque();
    const authorization = oidc.buildAuthorizationUrl(this.client, {
      redirect_uri: this.config.callback.href, response_type: 'code', scope: 'openid email profile onesa',
      state, nonce, code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      acr_values: 'urn:onesa:mfa', max_age: '300',
    });
    await db.query('DELETE FROM staff_onesa_flows WHERE expires_at<=now()');
    await db.query('INSERT INTO staff_onesa_flows(state_hash,browser_hash,verifier,nonce) VALUES($1,$2,$3,$4)',
      [opaqueHash(state), opaqueHash(browser), verifier, nonce]);
    return { browser, authorizationUrl: authorization.href };
  }

  protected assertion(input: unknown): Admin {
    return staffAssertion(input, this.config, Math.floor(Date.now() / 1000));
  }

  async inspect(token: string) {
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
    const tokens = await oidc.authorizationCodeGrant(this.client, url, {
      pkceCodeVerifier: result.rows[0].verifier, expectedNonce: result.rows[0].nonce, expectedState: params.state, idTokenExpected: true, maxAge: 300,
    }).catch(() => { throw denied(); });
    if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.access_token || tokens.access_token.length > 2048) throw denied();
    const staff = await this.inspect(tokens.access_token);
    if (tokens.claims()?.sub !== staff.subject) throw denied();
    const session = freshOpaque(), hash = opaqueHash(session);
    const envelope = encryptMfa(tokens.access_token, this.key, 'onesa-session:' + hash.toString('hex'));
    await db.query('DELETE FROM staff_onesa_sessions WHERE expires_at<=now()');
    const values = [hash, this.config.issuer, staff.subject, envelope, staff.expires];
    if (staff.siteOperator) {
      const inserted = await db.query(`INSERT INTO staff_onesa_sessions(token_hash,issuer,subject,access_ciphertext,expires_at,binding_id,staff_version)
        SELECT $1,$2,$3,$4,to_timestamp($5),b.id,u.version FROM staff_onesa_bindings b JOIN staff_users u ON u.id=b.staff_id
        WHERE b.issuer=$2 AND b.subject=$3::uuid AND u.status='approved' AND u.role IN ('agent','support')`, values);
      if (!inserted.rowCount) throw denied();
    } else {
      await db.query('INSERT INTO staff_onesa_sessions(token_hash,issuer,subject,access_ciphertext,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5))', values);
    }
    return { session, maxAge: Math.max(1, staff.expires - Math.floor(Date.now() / 1000)) };
  }

  async principal(db: Store, session: string, lock: boolean) {
    const hash = opaqueHash(session);
    const result = await db.query('SELECT subject,access_ciphertext,created_at,binding_id FROM staff_onesa_sessions WHERE token_hash=$1 AND issuer=$2 AND expires_at>now()',
      [hash, this.config.issuer]);
    if (!result.rowCount) throw denied();
    const row = result.rows[0];
    const assertion = await this.inspect(decryptMfa(row.access_ciphertext, this.key, 'onesa-session:' + hash.toString('hex')));
    if (row.subject !== assertion.subject || Boolean(row.binding_id) !== Boolean(assertion.siteOperator)) throw denied();
    if (assertion.siteOperator) {
      const operator = await db.query(`SELECT u.id,u.email,u.display_name,u.status,u.role,u.site_ids,u.version,u.created_at
        FROM staff_onesa_sessions s JOIN staff_onesa_bindings b ON b.id=s.binding_id AND b.issuer=s.issuer AND b.subject=s.subject
        JOIN staff_users u ON u.id=b.staff_id AND u.version=s.staff_version
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='approved' AND u.role IN ('agent','support')
        ${lock ? 'FOR UPDATE OF u,s' : ''}`, [hash]);
      if (!operator.rowCount) throw denied();
      return { ...operator.rows[0], mfa_enrolled_at: new Date(assertion.authenticated * 1000) };
    }
    // Fence sign-out while the live Portal check was in flight.
    const current = await db.query('SELECT 1 FROM staff_onesa_sessions WHERE token_hash=$1 AND expires_at>now()' + (lock ? ' FOR UPDATE' : ''), [hash]);
    if (!current.rowCount) throw denied();
    return { id: assertion.subject, email: assertion.email, display_name: assertion.name, status: 'approved', role: 'admin', site_ids: [],
      version: 1, mfa_enrolled_at: new Date(assertion.authenticated * 1000), created_at: row.created_at };
  }
}
