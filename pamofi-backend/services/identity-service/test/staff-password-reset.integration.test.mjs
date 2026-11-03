import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../dist/app.js';
import { encryptMfa, hashPassword, newTotpSecret, opaqueHash, totp } from '../dist/staff-crypto.js';

const url = process.env.PAMOFI_TEST_DATABASE_URL, origin = 'http://localhost:5173', key = 'ab'.repeat(32);
const oldPassword = 'Old synthetic password 123!', newPassword = 'New synthetic password 456!';
function configure() {
  Object.assign(process.env, { DATABASE_URL: url, APP_ENV: 'demo', NODE_ENV: 'development', PUBLIC_ORIGIN: origin, STAFF_MFA_ENCRYPTION_KEY: key, PAMOFI_TEST_CONFIRM_ISOLATED: '1' });
  delete process.env.STAFF_RESET_DELIVERY_ENABLED; delete process.env.STAFF_RESET_DELIVERY_QUALIFIED;
}
const send = (app, method, path, payload, cookie, requestOrigin = origin) => app.inject({ method, url: path, headers: { ...(requestOrigin ? { origin: requestOrigin } : {}), ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) });
function getCookie(response, name) { const headers = response.headers['set-cookie']; return (Array.isArray(headers) ? headers : [headers]).find(v => v?.startsWith(`${name}=`))?.split(';')[0]; }
async function until(predicate) { for (let i=0; i<100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve,20)); } throw Error('Timed out waiting for synthetic delivery'); }

test('password recovery is disabled without qualified delivery and test injection cannot enter production', { skip: !url }, async () => {
  configure(); const app = buildApp();
  try {
    const capability = await send(app, 'GET', '/v1/staff/password-reset/availability');
    assert.deepEqual(capability.json(), { enabled: false });
    const response = await send(app, 'POST', '/v1/staff/password-reset/request', { email: 'unknown@example.test' });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error, 'staff_recovery_unavailable');
  } finally { await app.close(); }
  process.env.APP_ENV = 'production'; process.env.NODE_ENV = 'production';
  assert.throws(() => buildApp({ staffResetDelivery: { async send() {} } }), /isolated demo/);
});

test('staff password recovery is non-enumerating, throttled, single-use, audited and preserves MFA', { skip: !url }, async () => {
  configure(); const sent = [], app = buildApp({ staffResetDelivery: { async send(email, token) { sent.push({ email, token }); } } }), pool = new pg.Pool({ connectionString: url });
  const id = randomUUID(), address = `${id}@staff.example.test`, secret = newTotpSecret();
  try {
    await pool.query("INSERT INTO staff_users(id,email,display_name,password_hash,status,role,site_ids,mfa_secret_ciphertext,mfa_enrolled_at) VALUES($1,$2,'Recovery fixture',$3,'approved','admin','{}',$4,now())", [id,address,await hashPassword(oldPassword),encryptMfa(secret,Buffer.from(key,'hex'),id)]);
    const login = await send(app,'POST','/v1/staff/login',{email:address,password:oldPassword}); assert.equal(login.statusCode,200);
    const challenge = getCookie(login,'pamofi_demo_staff_challenge');
    const confirmed = await send(app,'POST','/v1/staff/mfa/verify',{code:totp(secret).generate()},challenge); assert.equal(confirmed.statusCode,200);
    const session = getCookie(confirmed,'pamofi_demo_staff_session');
    assert.equal((await send(app,'GET','/v1/staff/password-reset/availability')).json().enabled,true);
    const denied = await send(app,'POST','/v1/staff/password-reset/request',{email:address},undefined,'https://evil.test'); assert.equal(denied.statusCode,403);
    const known = await send(app,'POST','/v1/staff/password-reset/request',{email:address});
    const unknown = await send(app,'POST','/v1/staff/password-reset/request',{email:`${randomUUID()}@staff.example.test`});
    assert.equal(known.statusCode,202); assert.equal(unknown.statusCode,202); assert.deepEqual(known.json(),unknown.json()); assert.equal(known.headers['cache-control'],'no-store');
    await until(() => sent.length===1); assert.equal(sent[0].email,address); assert.match(sent[0].token,/^[A-Za-z0-9_-]{43}$/);
    const token = sent[0].token;
    await send(app,'POST','/v1/staff/password-reset/request',{email:address});
    await new Promise(resolve => setTimeout(resolve,100)); assert.equal(sent.length,1);
    const stored = (await pool.query('SELECT token_hash,staff_version FROM staff_password_reset_tokens WHERE staff_id=$1',[id])).rows;
    assert.equal(stored.length,1); assert.deepEqual(stored[0].token_hash,opaqueHash(token)); assert.equal(stored[0].token_hash.includes(Buffer.from(token)),false);
    const wrong = await send(app,'POST','/v1/staff/password-reset/confirm',{email:address,code:'A'.repeat(43),password:newPassword}); assert.equal(wrong.statusCode,400);
    const payload={email:address,code:token,password:newPassword};
    const race=await Promise.all([send(app,'POST','/v1/staff/password-reset/confirm',payload),send(app,'POST','/v1/staff/password-reset/confirm',payload)]);
    assert.deepEqual(race.map(x=>x.statusCode).sort(),[200,400]);
    assert.deepEqual(race.find(x=>x.statusCode===200).json(),{status:'password_reset',mfaUnchanged:true});
    assert.equal((await send(app,'GET','/v1/staff/session',undefined,session)).statusCode,401);
    assert.equal((await send(app,'POST','/v1/staff/password-reset/confirm',payload)).statusCode,400);
    const row=(await pool.query('SELECT mfa_secret_ciphertext,mfa_enrolled_at,version FROM staff_users WHERE id=$1',[id])).rows[0];
    assert.ok(row.mfa_enrolled_at); assert.equal(row.version,2);
    const audit=(await pool.query("SELECT action,actor_staff_id,previous_version,new_version FROM staff_audit_events WHERE target_staff_id=$1 AND action='password_reset'",[id])).rows;
    assert.deepEqual(audit,[{action:'password_reset',actor_staff_id:null,previous_version:1,new_version:2}]);
    assert.equal((await send(app,'POST','/v1/staff/login',{email:address,password:oldPassword})).statusCode,401);
    const newLogin=await send(app,'POST','/v1/staff/login',{email:address,password:newPassword}); assert.equal(newLogin.statusCode,200); assert.equal(newLogin.json().next,'mfa_verify');
    assert.equal((await send(app,'GET','/v1/staff/session',undefined,getCookie(newLogin,'pamofi_demo_staff_challenge'))).statusCode,401);
    const mfa=await send(app,'POST','/v1/staff/mfa/verify',{code:totp(secret).generate({timestamp:Date.now()+30000})},getCookie(newLogin,'pamofi_demo_staff_challenge')); assert.equal(mfa.statusCode,200);
    await pool.query("UPDATE staff_users SET password_reset_requested_at=now()-interval '3 minutes' WHERE id=$1",[id]);
    await send(app,'POST','/v1/staff/password-reset/request',{email:address}); await until(()=>sent.length===2);
    await pool.query("UPDATE staff_password_reset_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[opaqueHash(sent[1].token)]);
    assert.equal((await send(app,'POST','/v1/staff/password-reset/confirm',{email:address,code:sent[1].token,password:oldPassword})).statusCode,400);
  } finally { await app.close(); await pool.query('DELETE FROM staff_users WHERE id=$1',[id]); await pool.end(); }
});
