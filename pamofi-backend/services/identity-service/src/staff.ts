import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { jwtVerify } from 'jose';
import { acceptedTotpCounter, decryptMfa, encryptMfa, freshOpaque, hashPassword, isOpaque, mfaKey, newTotpSecret, opaqueHash, totp, verifyPassword } from './staff-crypto.js';

const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
const email = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' };
const password = { type: 'string', minLength: 15, maxLength: 128, pattern: '\\S' };
const expectedVersion = { type: 'integer', minimum: 1, maximum: 2147483646 };
const reason = { type: 'string', minLength: 5, maxLength: 500, pattern: '\\S' };
const codeBody = { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', pattern: '^\\d{6}$' } } };
const paging = { type: 'object', additionalProperties: false, properties: { after: uuid } };
const ADMIN_LOCK = 'pamofi-staff-admin-decisions-v1';
const PUBLIC_COLUMNS = ['id', 'email', 'display_name', 'status', 'role', 'site_ids', 'version', 'mfa_enrolled_at', 'created_at'];

class StaffError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new StaffError(status, code); };
const state = (row: Record<string, any>) => ({ status: row.status, role: row.role, siteIds: row.site_ids });
export const publicStaff = (row: Record<string, any>) => ({
  staffId: row.id, email: row.email, displayName: row.display_name, ...state(row),
  version: row.version, mfaEnrolled: !!row.mfa_enrolled_at, createdAt: new Date(row.created_at).toISOString()
});

export function registerStaffRoutes(app: FastifyInstance, options: { pool: pg.Pool | null; demo: boolean; origin?: string; validOrigin: boolean }) {
  const { pool, demo, origin, validOrigin } = options;
  const key = mfaKey(demo);
  const sessionCookie = demo ? 'pamofi_demo_staff_session' : '__Host-pamofi_staff_session';
  const challengeCookie = demo ? 'pamofi_demo_staff_challenge' : '__Host-pamofi_staff_challenge';
  const attributes = { path: '/', httpOnly: true, secure: !demo, sameSite: 'lax' as const };

  async function publicGuard(request: FastifyRequest, reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    if (!pool || !key || !validOrigin) return reply.code(503).send({ error: 'identity_unavailable' });
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) return reply.code(403).send({ error: 'origin_rejected' });
  }
  async function execute(reply: FastifyReply, run: () => Promise<unknown>) {
    try { return await run(); }
    catch (error) {
      if (error instanceof StaffError) return reply.code(error.status).send({ error: error.code });
      return reply.code(503).send({ error: 'identity_unavailable' });
    }
  }
  async function transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function current(request: FastifyRequest, client: pg.Pool | pg.PoolClient = pool!, lock = false) {
    const token = request.cookies[sessionCookie];
    if (!isOpaque(token)) return fail(401, 'not_authenticated');
    const found = await client.query(`SELECT ${PUBLIC_COLUMNS.map(column => `u.${column}`).join(',')}, s.token_hash AS session_hash FROM staff_sessions s JOIN staff_users u ON u.id=s.staff_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.staff_version=u.version
      ${lock ? 'FOR UPDATE OF u,s' : ''}`, [opaqueHash(token)]);
    if (!found.rowCount) return fail(401, 'not_authenticated');
    return found.rows[0];
  }
  async function administrator(request: FastifyRequest, client: pg.Pool | pg.PoolClient = pool!, lock = false) {
    const actor = await current(request, client, lock);
    if (actor.status !== 'approved' || actor.role !== 'admin') return fail(403, 'admin_required');
    return actor;
  }
  async function challenge(request: FastifyRequest, client: pg.PoolClient) {
    const token = request.cookies[challengeCookie];
    if (!isOpaque(token)) return fail(401, 'challenge_expired');
    const result = await client.query(`SELECT u.*, c.token_hash AS challenge_hash, c.enrollment_ciphertext, c.attempts,
      c.expires_at AS challenge_expires_at FROM staff_auth_challenges c JOIN staff_users u ON u.id=c.staff_id
      WHERE c.token_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now() AND c.attempts<5 AND c.staff_version=u.version
      AND (u.locked_until IS NULL OR u.locked_until<=now()) AND u.status IN ('pending','approved') FOR UPDATE OF u,c`, [opaqueHash(token)]);
    if (!result.rowCount) return fail(401, 'challenge_expired');
    return result.rows[0];
  }
  function authenticated(reply: FastifyReply, token: string, user: Record<string, any>) {
    reply.clearCookie(challengeCookie, attributes);
    reply.setCookie(sessionCookie, token, { ...attributes, maxAge: 8 * 3600 });
    return { ...publicStaff(user), mfaVerified: true };
  }
  async function invalidate(client: pg.PoolClient, staffId: string) {
    await client.query('UPDATE staff_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE staff_id=$1', [staffId]);
    await client.query('UPDATE staff_auth_challenges SET consumed_at=COALESCE(consumed_at,now()),enrollment_ciphertext=NULL WHERE staff_id=$1', [staffId]);
  }
  async function audit(client: pg.PoolClient, actor: string | null, before: Record<string, any>, after: Record<string, any>, action: string, explanation: string) {
    await client.query(`INSERT INTO staff_audit_events(id,actor_staff_id,target_staff_id,action,reason,previous_version,new_version,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), actor, after.id, action, explanation.trim(), before.version, after.version, state(before), state(after)]);
  }

  app.post<{ Body: { email: string; password: string; displayName: string } }>('/v1/staff/register', {
    preHandler: publicGuard, config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['email', 'password', 'displayName'], properties: { email, password, displayName: { type: 'string', minLength: 2, maxLength: 80, pattern: '\\S' } } } }
  }, async (request, reply) => execute(reply, async () => {
    const name = request.body.displayName.trim();
    if (name.length < 2) return fail(400, 'invalid_display_name');
    const encoded = await hashPassword(request.body.password);
    await pool!.query('INSERT INTO staff_users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING', [randomUUID(), request.body.email.toLowerCase(), name, encoded]);
    // A duplicate address neither changes credentials nor reveals registration.
    return reply.code(202).send({ status: 'pending', next: 'login' });
  }));

  app.post<{ Body: { email: string; password: string } }>('/v1/staff/login', {
    preHandler: publicGuard, config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: { email, password } } }
  }, async (request, reply) => execute(reply, async () => {
    const outcome = await transaction(async client => {
      const found = await client.query('SELECT *,locked_until>now() AS locked FROM staff_users WHERE email=$1 FOR UPDATE', [request.body.email.toLowerCase()]);
      const user = found.rows[0];
      const correct = await verifyPassword(request.body.password, user?.password_hash);
      if (!user || user.locked || !correct) {
        if (user && !user.locked) await client.query(`UPDATE staff_users SET failed_passwords=failed_passwords+1,
          locked_until=CASE WHEN failed_passwords+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1`, [user.id]);
        return null;
      }
      if (!['pending', 'approved'].includes(user.status)) return null;
      await client.query('UPDATE staff_users SET failed_passwords=0,locked_until=NULL WHERE id=$1', [user.id]);
      await client.query('UPDATE staff_auth_challenges SET consumed_at=COALESCE(consumed_at,now()),enrollment_ciphertext=NULL WHERE staff_id=$1', [user.id]);
      const token = freshOpaque();
      await client.query("INSERT INTO staff_auth_challenges(token_hash,staff_id,staff_version,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", [opaqueHash(token), user.id, user.version]);
      return { token, staffId: user.id, enrolled: !!user.mfa_enrolled_at };
    });
    if (!outcome) return fail(401, 'invalid_credentials');
    // Logging in starts a fresh MFA ceremony; a prior staff cookie cannot stand
    // in for completing this challenge in another account's name.
    reply.clearCookie(sessionCookie, attributes);
    reply.setCookie(challengeCookie, outcome.token, { ...attributes, maxAge: 300 });
    return { staffId: outcome.staffId, next: outcome.enrolled ? 'mfa_verify' : 'mfa_setup', expiresIn: 300 };
  }));

  app.post('/v1/staff/mfa/setup', { preHandler: publicGuard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { body: { type: 'object', additionalProperties: false } } }, async (request, reply) => execute(reply, async () => {
    return transaction(async client => {
      const user = await challenge(request, client);
      if (user.mfa_enrolled_at) return fail(409, 'mfa_already_enrolled');
      let encrypted = user.enrollment_ciphertext as string | null;
      if (!encrypted) {
        encrypted = encryptMfa(newTotpSecret(), key!, user.id);
        await client.query('UPDATE staff_auth_challenges SET enrollment_ciphertext=$2 WHERE token_hash=$1', [user.challenge_hash, encrypted]);
      }
      const secret = decryptMfa(encrypted, key!, user.id);
      return { staffId: user.id, secret, uri: totp(secret, user.email).toString(), expiresIn: Math.max(0, Math.floor((new Date(user.challenge_expires_at).getTime() - Date.now()) / 1000)) };
    });
  }));

  for (const enrollment of [true, false]) {
    app.post<{ Body: { code: string } }>(enrollment ? '/v1/staff/mfa/confirm' : '/v1/staff/mfa/verify', {
      preHandler: publicGuard, config: { rateLimit: { max: 15, timeWindow: '1 minute' } }, schema: { body: codeBody }
    }, async (request, reply) => execute(reply, async () => {
      const outcome = await transaction(async client => {
        const user = await challenge(request, client);
        const encrypted = enrollment ? user.enrollment_ciphertext : user.mfa_secret_ciphertext;
        if (!encrypted || (!!user.mfa_enrolled_at === enrollment)) return fail(409, 'mfa_state_changed');
        const secret = decryptMfa(encrypted, key!, user.id);
        const counter = acceptedTotpCounter(secret, request.body.code, user.mfa_last_counter);
        if (counter === null) {
          // Commit failures even though the HTTP response is unauthorized. The
          // per-user count also survives replacing a five-attempt challenge.
          await client.query(`UPDATE staff_auth_challenges SET attempts=attempts+1,
            consumed_at=CASE WHEN attempts+1>=5 THEN now() ELSE NULL END WHERE token_hash=$1`, [user.challenge_hash]);
          await client.query(`UPDATE staff_users SET failed_mfa=failed_mfa+1,
            locked_until=CASE WHEN failed_mfa+1>=10 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1`, [user.id]);
          return null;
        }
        const changed = await client.query(`UPDATE staff_users SET mfa_secret_ciphertext=$2,mfa_enrolled_at=COALESCE(mfa_enrolled_at,now()),
          mfa_last_counter=$3,failed_mfa=0,failed_passwords=0,locked_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [user.id, encrypted, counter]);
        await client.query('UPDATE staff_auth_challenges SET consumed_at=now(),enrollment_ciphertext=NULL WHERE token_hash=$1', [user.challenge_hash]);
        const token = freshOpaque();
        await client.query("INSERT INTO staff_sessions(token_hash,staff_id,staff_version,mfa_verified_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '8 hours')", [opaqueHash(token), user.id, user.version]);
        return { token, user: changed.rows[0] };
      });
      if (!outcome) return fail(401, 'invalid_mfa_code');
      return authenticated(reply, outcome.token, outcome.user);
    }));
  }

  app.get('/v1/staff/session', { preHandler: publicGuard }, async (request, reply) => execute(reply, async () => ({ ...publicStaff(await current(request)), mfaVerified: true })));
  app.delete('/v1/staff/session', { preHandler: publicGuard, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => execute(reply, async () => {
    await transaction(async client => {
      const session = request.cookies[sessionCookie], pending = request.cookies[challengeCookie];
      if (isOpaque(session)) await client.query('UPDATE staff_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1', [opaqueHash(session)]);
      if (isOpaque(pending)) await client.query('UPDATE staff_auth_challenges SET consumed_at=COALESCE(consumed_at,now()),enrollment_ciphertext=NULL WHERE token_hash=$1', [opaqueHash(pending)]);
    });
    reply.clearCookie(sessionCookie, attributes);
    reply.clearCookie(challengeCookie, attributes);
    return reply.code(204).send();
  }));

  app.get<{ Querystring: { after?: string } }>('/v1/staff/users', { preHandler: publicGuard, schema: { querystring: paging } }, async (request, reply) => execute(reply, async () => {
    await administrator(request);
    const result = await pool!.query(`SELECT ${PUBLIC_COLUMNS.join(',')} FROM staff_users WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 51`, [request.query.after || null]);
    const rows = result.rows.slice(0, 50);
    return { users: rows.map(publicStaff), nextCursor: result.rows.length > 50 ? rows.at(-1)!.id : null };
  }));

  type Decision = { expectedVersion: number; status: 'approved' | 'rejected' | 'disabled'; role?: 'admin' | 'agent' | 'support'; siteIds?: string[]; reason: string };
  app.post<{ Params: { id: string }; Body: Decision }>('/v1/staff/users/:id/decision', {
    preHandler: publicGuard, config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'status', 'reason'], properties: {
      expectedVersion, status: { enum: ['approved', 'rejected', 'disabled'] }, role: { enum: ['admin', 'agent', 'support'] }, siteIds: { type: 'array', maxItems: 100, uniqueItems: true, items: uuid }, reason
    } } }
  }, async (request, reply) => execute(reply, async () => transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ADMIN_LOCK]);
    const actor = await administrator(request, client, true);
    if (actor.id === request.params.id.toLowerCase()) return fail(409, 'self_decision_rejected');
    const found = await client.query(`SELECT ${PUBLIC_COLUMNS.join(',')} FROM staff_users WHERE id=$1 FOR UPDATE`, [request.params.id]);
    const user = found.rows[0];
    if (!user) return fail(404, 'staff_not_found');
    if (user.version !== request.body.expectedVersion) return fail(409, 'staff_changed');
    if (request.body.reason.trim().length < 5) return fail(400, 'invalid_reason');
    const approved = request.body.status === 'approved';
    const role = approved ? request.body.role : user.role;
    const sites = approved ? request.body.siteIds?.map(id => id.toLowerCase()).sort() : user.site_ids;
    if (approved && (!role || !sites || new Set(sites).size !== sites.length || (role === 'admin' ? sites.length !== 0 : sites.length === 0))) return fail(400, 'invalid_role_scope');
    if (!approved && (request.body.role !== undefined || request.body.siteIds !== undefined)) return fail(400, 'unexpected_role_scope');
    if (approved && !user.mfa_enrolled_at) return fail(409, 'mfa_enrollment_required');
    if (user.status === 'approved' && user.role === 'admin' && (!approved || role !== 'admin')) {
      const remaining = await client.query("SELECT count(*)::integer AS count FROM staff_users WHERE status='approved' AND role='admin' AND id<>$1", [user.id]);
      if (remaining.rows[0].count < 1) return fail(409, 'last_admin_protected');
    }
    const updated = await client.query('UPDATE staff_users SET status=$2,role=$3,site_ids=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *', [user.id, request.body.status, role, sites]);
    await invalidate(client, user.id);
    await audit(client, actor.id, user, updated.rows[0], 'decision', request.body.reason);
    return publicStaff(updated.rows[0]);
  })));

  app.post<{ Params: { id: string }; Body: { expectedVersion: number; reason: string } }>('/v1/staff/users/:id/revoke-sessions', {
    preHandler: publicGuard, config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'reason'], properties: { expectedVersion, reason } } }
  }, async (request, reply) => execute(reply, async () => transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ADMIN_LOCK]);
    const actor = await administrator(request, client, true);
    const found = await client.query(`SELECT ${PUBLIC_COLUMNS.join(',')} FROM staff_users WHERE id=$1 FOR UPDATE`, [request.params.id]);
    const user = found.rows[0];
    if (!user) return fail(404, 'staff_not_found');
    if (user.version !== request.body.expectedVersion) return fail(409, 'staff_changed');
    if (request.body.reason.trim().length < 5) return fail(400, 'invalid_reason');
    const updated = await client.query('UPDATE staff_users SET version=version+1,updated_at=now() WHERE id=$1 RETURNING *', [user.id]);
    await invalidate(client, user.id);
    await audit(client, actor.id, user, updated.rows[0], 'revoke_sessions', request.body.reason);
    return publicStaff(updated.rows[0]);
  })));

  app.get<{ Querystring: { after?: string } }>('/v1/staff/audit', { preHandler: publicGuard, schema: { querystring: paging } }, async (request, reply) => execute(reply, async () => {
    await administrator(request);
    const result = await pool!.query(`SELECT * FROM staff_audit_events WHERE ($1::uuid IS NULL OR
      (created_at,id)<(SELECT created_at,id FROM staff_audit_events WHERE id=$1::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`, [request.query.after || null]);
    const rows = result.rows.slice(0, 50);
    return { events: rows.map(row => ({ id: row.id, actorStaffId: row.actor_staff_id, targetStaffId: row.target_staff_id, action: row.action, reason: row.reason, previousVersion: row.previous_version, newVersion: row.new_version, before: row.before_state, after: row.after_state, createdAt: new Date(row.created_at).toISOString() })), nextCursor: result.rows.length > 50 ? rows.at(-1)!.id : null };
  }));

  async function serviceGuard(request: FastifyRequest, reply: FastifyReply, scope: string) {
    reply.header('Cache-Control', 'no-store');
    const secret = process.env.INTERNAL_IDENTITY_SECRET;
    if (!pool || !key || !secret || Buffer.byteLength(secret) < 32 || (!demo && secret.startsWith('DEMO_ONLY_'))) return reply.code(503).send({ error: 'identity_unavailable' });
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const { payload } = await jwtVerify(authorization.slice(7), new TextEncoder().encode(secret), { algorithms: ['HS256'], issuer: 'prepaid-access', subject: 'prepaid-access', audience: 'identity', requiredClaims: ['exp', 'iat', 'sub'], maxTokenAge: '30s' });
      if (payload.scope !== scope) return reply.code(403).send({ error: 'forbidden' });
    } catch { return reply.code(401).send({ error: 'unauthorized' }); }
  }
  app.get('/internal/v1/staff/session', { preHandler: (request, reply) => serviceGuard(request, reply, 'staff:resolve') }, async (request, reply) => execute(reply, async () => {
    const user = await current(request);
    if (user.status !== 'approved') return fail(403, 'staff_not_approved');
    return { staffId: user.id, role: user.role, siteIds: user.site_ids, version: user.version, mfaVerified: true };
  }));
  app.get<{ Params: { id: string } }>('/internal/v1/staff/users/:id', { preHandler: (request, reply) => serviceGuard(request, reply, 'staff:read'), schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => execute(reply, async () => {
    const result = await pool!.query('SELECT id,status,role,site_ids,version FROM staff_users WHERE id=$1', [request.params.id]);
    if (!result.rowCount) return fail(404, 'staff_not_found');
    const user = result.rows[0];
    return { staffId: user.id, ...state(user), version: user.version };
  }));
}
