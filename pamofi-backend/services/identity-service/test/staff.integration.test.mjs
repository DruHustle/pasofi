import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { SignJWT } from 'jose';
import { buildApp } from '../dist/app.js';
import { encryptMfa, hashPassword, opaqueHash, totp, newTotpSecret } from '../dist/staff-crypto.js';
import { createFirstAdministrator } from '../dist/bootstrap-staff.js';

const url = process.env.PAMOFI_TEST_DATABASE_URL;
const origin = 'http://localhost:5173', password = 'Synthetic staff passphrase 489!';
const key = 'ab'.repeat(32), internalSecret = 'DEMO_ONLY_insecure_local_service_secret_123456789';
function configure() {
  Object.assign(process.env, { DATABASE_URL: url, APP_ENV: 'demo', NODE_ENV: 'development', PUBLIC_ORIGIN: origin, STAFF_MFA_ENCRYPTION_KEY: key, INTERNAL_IDENTITY_SECRET: internalSecret });
}
function cookie(response, name = 'pamofi_demo_staff_session') {
  const values = response.headers['set-cookie'];
  return (Array.isArray(values) ? values : [values]).find(value => value?.startsWith(`${name}=`) && !value.startsWith(`${name}=;`))?.split(';')[0];
}
const send = (app, route, payload = {}, auth, method = 'POST', requestOrigin = origin) => app.inject({ method, url: route, headers: { ...(requestOrigin ? { origin: requestOrigin } : {}), ...(auth ? { cookie: auth } : {}) }, ...(method === 'POST' ? { payload } : {}) });
async function token(scope = 'staff:resolve', overrides = {}) {
  return new SignJWT({ scope }).setProtectedHeader({ alg: 'HS256' }).setIssuer(overrides.issuer || 'prepaid-access').setSubject('prepaid-access').setAudience('identity').setIssuedAt().setExpirationTime(overrides.exp || '30s').sign(new TextEncoder().encode(internalSecret));
}
async function pending(app, pool, ids) {
  const email = `${randomUUID()}@staff.example.test`;
  assert.equal((await send(app, '/v1/staff/register', { email, password, displayName: 'Synthetic staff' })).statusCode, 202);
  const row = (await pool.query('SELECT id FROM staff_users WHERE email=$1', [email])).rows[0];
  ids.push(row.id);
  const login = await send(app, '/v1/staff/login', { email, password });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().next, 'mfa_setup');
  const challenge = cookie(login, 'pamofi_demo_staff_challenge');
  const setup = await send(app, '/v1/staff/mfa/setup', {}, challenge);
  assert.equal(setup.statusCode, 200);
  const secret = setup.json().secret;
  const confirm = await send(app, '/v1/staff/mfa/confirm', { code: totp(secret).generate() }, challenge);
  assert.equal(confirm.statusCode, 200);
  return { id: row.id, email, secret, cookie: cookie(confirm), challenge, response: confirm };
}
async function approved(app, pool, ids, role = 'admin') {
  const id = randomUUID(), email = `${id}@staff.example.test`, secret = newTotpSecret();
  ids.push(id);
  await pool.query("INSERT INTO staff_users(id,email,display_name,password_hash,status,role,site_ids,mfa_secret_ciphertext,mfa_enrolled_at) VALUES($1,$2,'Fixture staff',$3,'approved',$4,$5,$6,now())", [id, email, await hashPassword(password), role, role === 'admin' ? [] : [randomUUID()], encryptMfa(secret, Buffer.from(key, 'hex'), id)]);
  const login = await send(app, '/v1/staff/login', { email, password });
  assert.equal(login.statusCode, 200);
  const challenge = cookie(login, 'pamofi_demo_staff_challenge');
  const code = totp(secret).generate();
  const response = await send(app, '/v1/staff/mfa/verify', { code }, challenge);
  assert.equal(response.statusCode, 200);
  return { id, email, secret, cookie: cookie(response), challenge, code };
}
async function fixture(run) {
  configure();
  const app = buildApp(), pool = new pg.Pool({ connectionString: url }), ids = [];
  try { await run(app, pool, ids); }
  finally { if (ids.length) await pool.query('DELETE FROM staff_users WHERE id=ANY($1::uuid[])', [ids]); await pool.end(); await app.close(); }
}

test('public registration cannot assign a role; password-only challenges cannot authorize and MFA enrollment remains pending', { skip: !url }, async () => fixture(async (app, pool, ids) => {
  const bad = await send(app, '/v1/staff/register', { email: `${randomUUID()}@example.test`, password, displayName: 'Requester', role: 'admin' });
  assert.equal(bad.statusCode, 400);
  const staff = await pending(app, pool, ids);
  assert.equal(staff.response.json().status, 'pending');
  assert.equal(staff.response.json().role, null);
  assert.deepEqual(staff.response.json().siteIds, []);
  assert.equal(staff.response.json().mfaVerified, true);
  assert.equal((await send(app, '/v1/staff/users', {}, staff.challenge, 'GET')).statusCode, 401);
  assert.equal((await send(app, '/v1/staff/users', {}, staff.cookie, 'GET')).statusCode, 403);
  const resolved = await app.inject({ method: 'GET', url: '/internal/v1/staff/session', headers: { cookie: staff.cookie, authorization: `Bearer ${await token()}` } });
  assert.equal(resolved.statusCode, 403);
  assert.equal(resolved.json().error, 'staff_not_approved');
  assert.equal((await send(app, '/v1/staff/mfa/setup', {}, staff.challenge)).statusCode, 401);
  const stored = (await pool.query('SELECT password_hash,mfa_secret_ciphertext FROM staff_users WHERE id=$1', [staff.id])).rows[0];
  assert.equal(stored.password_hash.includes(password), false);
  assert.equal(stored.mfa_secret_ciphertext.includes(staff.secret), false);
  assert.equal(staff.response.headers['cache-control'], 'no-store');
}));

test('admin decisions are scoped, optimistic, atomic, audited and revoke target sessions; internal resolution checks token scope', { skip: !url }, async () => fixture(async (app, pool, ids) => {
  const admin = await approved(app, pool, ids), staff = await pending(app, pool, ids), siteId = randomUUID();
  const body = { expectedVersion: 1, status: 'approved', role: 'agent', siteIds: [siteId], reason: 'Verified employment and site assignment' };
  assert.equal((await send(app, `/v1/staff/users/${staff.id}/decision`, body, admin.cookie, 'POST', 'https://evil.test')).statusCode, 403);
  assert.equal((await send(app, `/v1/staff/users/${staff.id}/decision`, { ...body, siteIds: [] }, admin.cookie)).statusCode, 400);
  assert.equal((await send(app, `/v1/staff/users/${admin.id}/decision`, { ...body, role: 'admin', siteIds: [] }, admin.cookie)).statusCode, 409);
  const attempts = await Promise.all([send(app, `/v1/staff/users/${staff.id}/decision`, body, admin.cookie), send(app, `/v1/staff/users/${staff.id}/decision`, { ...body, role: 'support' }, admin.cookie)]);
  assert.deepEqual(attempts.map(value => value.statusCode).sort(), [200, 409]);
  const authorized = attempts.find(value => value.statusCode === 200).json();
  assert.equal(authorized.version, 2);
  assert.deepEqual(authorized.siteIds, [siteId]);
  assert.equal((await send(app, '/v1/staff/session', {}, staff.cookie, 'GET')).statusCode, 401);
  const login = await send(app, '/v1/staff/login', { email: staff.email, password });
  const verified = await send(app, '/v1/staff/mfa/verify', { code: totp(staff.secret).generate({ timestamp: Date.now() + 30000 }) }, cookie(login, 'pamofi_demo_staff_challenge'));
  assert.equal(verified.statusCode, 200);
  const approvedCookie = cookie(verified);
  assert.equal((await send(app, '/v1/staff/users', {}, approvedCookie, 'GET')).statusCode, 403);
  for (const [scope, issuer, status] of [['identity:resolve', undefined, 403], ['staff:resolve', 'notification', 401], ['staff:resolve', undefined, 200]]) {
    const response = await app.inject({ method: 'GET', url: '/internal/v1/staff/session', headers: { cookie: approvedCookie, authorization: `Bearer ${await token(scope, { issuer })}` } });
    assert.equal(response.statusCode, status);
    if (status === 200) assert.deepEqual(response.json(), { staffId: staff.id, role: authorized.role, siteIds: [siteId], version: 2, mfaVerified: true });
  }
  const target = await app.inject({ method: 'GET', url: `/internal/v1/staff/users/${staff.id}`, headers: { authorization: `Bearer ${await token('staff:read')}` } });
  assert.equal(target.statusCode, 200);
  assert.equal(target.json().status, 'approved');
  const audit = (await pool.query('SELECT * FROM staff_audit_events WHERE target_staff_id=$1', [staff.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_staff_id, admin.id);
  assert.equal(audit[0].previous_version, 1);
  assert.equal(audit[0].new_version, 2);
  await assert.rejects(pool.query('UPDATE staff_audit_events SET reason=$2 WHERE id=$1', [audit[0].id, 'Attempted audit modification']), { code: '23514' });
  assert.equal((await send(app, `/v1/staff/users/${staff.id}/revoke-sessions`, { expectedVersion: 2, reason: 'Security investigation session revocation' }, admin.cookie)).statusCode, 200);
  assert.equal((await send(app, '/v1/staff/session', {}, approvedCookie, 'GET')).statusCode, 401);
}));

test('MFA challenge replay and concurrent code redemption issue exactly one session; consumed time steps cannot sign in again', { skip: !url }, async () => fixture(async (app, pool, ids) => {
  const staff = await approved(app, pool, ids, 'agent');
  const login = await send(app, '/v1/staff/login', { email: staff.email, password });
  const challenge = cookie(login, 'pamofi_demo_staff_challenge');
  const code = totp(staff.secret).generate({ timestamp: Date.now() + 30000 });
  const before = Number((await pool.query('SELECT count(*) FROM staff_sessions WHERE staff_id=$1', [staff.id])).rows[0].count);
  const race = await Promise.all([send(app, '/v1/staff/mfa/verify', { code }, challenge), send(app, '/v1/staff/mfa/verify', { code }, challenge)]);
  assert.deepEqual(race.map(value => value.statusCode).sort(), [200, 401]);
  assert.equal(Number((await pool.query('SELECT count(*) FROM staff_sessions WHERE staff_id=$1', [staff.id])).rows[0].count), before + 1);
  const next = await send(app, '/v1/staff/login', { email: staff.email, password });
  const replayChallenge = cookie(next, 'pamofi_demo_staff_challenge');
  const replay = await send(app, '/v1/staff/mfa/verify', { code }, replayChallenge);
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error, 'invalid_mfa_code');
  assert.equal(replay.headers['set-cookie'], undefined);
  await pool.query("UPDATE staff_auth_challenges SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [opaqueHash(replayChallenge.split('=')[1])]);
  assert.equal((await send(app, '/v1/staff/mfa/verify', { code }, replayChallenge)).json().error, 'challenge_expired');
}));

test('persistent password and MFA attempt limits survive replacing a challenge', { skip: !url }, async () => fixture(async (app, pool, ids) => {
  const staff = await approved(app, pool, ids, 'agent');
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await send(app, '/v1/staff/login', { email: staff.email, password: 'Wrong synthetic passphrase' })).statusCode, 401);
  assert.equal((await send(app, '/v1/staff/login', { email: staff.email, password })).statusCode, 401);
  assert.equal((await pool.query('SELECT locked_until>now() AS locked FROM staff_users WHERE id=$1', [staff.id])).rows[0].locked, true);
  await pool.query("UPDATE staff_users SET locked_until=now()-interval '1 second',failed_passwords=0 WHERE id=$1", [staff.id]);
  for (let ceremony = 0; ceremony < 2; ceremony++) {
    const login = await send(app, '/v1/staff/login', { email: staff.email, password });
    const challenge = cookie(login, 'pamofi_demo_staff_challenge');
    const oldCode = staff.code;
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await send(app, '/v1/staff/mfa/verify', { code: oldCode }, challenge)).statusCode, 401);
    assert.equal((await send(app, '/v1/staff/mfa/verify', { code: oldCode }, challenge)).json().error, 'challenge_expired');
  }
  const row = (await pool.query('SELECT failed_mfa,locked_until>now() AS locked FROM staff_users WHERE id=$1', [staff.id])).rows[0];
  assert.equal(row.failed_mfa, 10);
  assert.equal(row.locked, true);
}));

test('staff logout is CSRF-protected, revokes only the presented session and never returns success on storage failure', { skip: !url }, async () => fixture(async (app, pool, ids) => {
  const staff = await approved(app, pool, ids);
  const login = await send(app, '/v1/staff/login', { email: staff.email, password });
  const verification = await send(app, '/v1/staff/mfa/verify', { code: totp(staff.secret).generate({ timestamp: Date.now() + 30000 }) }, cookie(login, 'pamofi_demo_staff_challenge'));
  assert.equal(verification.statusCode, 200);
  const otherSession = cookie(verification);
  const missingOrigin = await app.inject({ method: 'DELETE', url: '/v1/staff/session', headers: { cookie: staff.cookie } });
  assert.equal(missingOrigin.statusCode, 403);
  assert.equal((await send(app, '/v1/staff/session', {}, staff.cookie, 'DELETE')).statusCode, 204);
  assert.equal((await send(app, '/v1/staff/session', {}, staff.cookie, 'GET')).statusCode, 401);
  assert.equal((await send(app, '/v1/staff/session', {}, otherSession, 'GET')).statusCode, 200);
  const other = await approved(app, pool, ids, 'agent');
  const rejected = await send(app, '/v1/staff/session', {}, other.cookie, 'DELETE', 'https://evil.test');
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers['set-cookie'], undefined);
  assert.equal((await send(app, '/v1/staff/session', {}, other.cookie, 'GET')).statusCode, 200);
  const loggedOut = await send(app, '/v1/staff/session', {}, other.cookie, 'DELETE');
  assert.equal(loggedOut.statusCode, 204);
  assert.ok(loggedOut.headers['set-cookie'].every(value => /Max-Age=0/.test(value) && /HttpOnly/.test(value)));
  process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
  const unavailable = buildApp();
  try {
    const response = await send(unavailable, '/v1/staff/session', {}, other.cookie, 'DELETE');
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['set-cookie'], undefined);
  } finally { await unavailable.close(); }
}));

test('first-admin bootstrap serializes competing requests and remains closed after the administrator is disabled', { skip: !url }, async () => {
  const pool = new pg.Pool({ connectionString: url }), schema = `staff_bootstrap_${randomBytes(8).toString('hex')}`;
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    for (const table of ['staff_users', 'staff_bootstrap_guard', 'staff_audit_events']) await pool.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    async function bootstrap() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path=${schema},public`);
        const id = await createFirstAdministrator(client, { email: `${randomUUID()}@bootstrap.test`, displayName: 'First operator', password, reason: 'Explicit synthetic bootstrap test' });
        await client.query('COMMIT');
        return id;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const race = await Promise.allSettled([bootstrap(), bootstrap()]);
    assert.equal(race.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(race.filter(value => value.status === 'rejected').length, 1);
    const users = (await pool.query(`SELECT * FROM ${schema}.staff_users`)).rows;
    assert.equal(users.length, 1);
    assert.equal(users[0].mfa_enrolled_at, null);
    assert.equal(users[0].status, 'approved');
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${schema}.staff_audit_events`)).rows[0].count, 1);
    await pool.query(`UPDATE ${schema}.staff_users SET status='disabled'`);
    await assert.rejects(bootstrap(), /permanently closed/);
  } finally { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); }
});
