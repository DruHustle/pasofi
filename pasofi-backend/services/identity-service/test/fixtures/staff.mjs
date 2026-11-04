// A separate-process fixture for browser acceptance tests. It is not copied into
// the service Docker image and refuses non-demo/non-loopback databases.
import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { hashPassword, encryptMfa, decryptMfa, mfaKey, newTotpSecret, totp } from '../../dist/staff-crypto.js';

async function main() {
  if (process.env.APP_ENV !== 'demo' || process.env.NODE_ENV !== 'development' || process.env.PAMOFI_TEST_CONFIRM_ISOLATED !== '1') throw Error('Explicit isolated demo test environment required.');
  const url = new URL(process.env.PAMOFI_TEST_DATABASE_URL || ''), key = mfaKey(true);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || !url.username || url.search || url.hash || !key) throw Error('Explicit loopback test database and demo MFA key required.');
  const [action, id, registeredEmail] = process.argv.slice(2);
  if (!['create', 'code', 'remove', 'remove-registered'].includes(action) || (action !== 'create' && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || ''))) throw Error('Use create, code UUID, remove UUID or remove-registered UUID EMAIL.');
  if (action === 'remove-registered' && !/^pamofi-browser-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}@staff\.pamofi\.test$/.test(registeredEmail || '')) throw Error('Exact browser-registration fixture email required.');
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000 });
  try {
    if (action === 'create') {
      const staffId = randomUUID(), email = `pamofi-fixture-${staffId}@staff.pamofi.test`, password = randomBytes(24).toString('base64url'), secret = newTotpSecret();
      await pool.query("INSERT INTO staff_users(id,email,display_name,password_hash,status,role,mfa_secret_ciphertext,mfa_enrolled_at) VALUES($1,$2,'Browser test administrator',$3,'approved','admin',$4,now())", [staffId, email, await hashPassword(password), encryptMfa(secret, key, staffId)]);
      console.log(JSON.stringify({ staffId, email, password }));
      return;
    }
    const found = await pool.query('SELECT * FROM staff_users WHERE id=$1 AND email=$2', [id, action === 'remove-registered' ? registeredEmail : `pamofi-fixture-${id}@staff.pamofi.test`]);
    if (!found.rowCount) throw Error('Owned browser fixture not found.');
    if (action === 'remove-registered' && ![null, 'agent', 'support'].includes(found.rows[0].role)) throw Error('Registered fixture must not be an administrator.');
    if (action === 'remove' || action === 'remove-registered') { await pool.query('DELETE FROM staff_users WHERE id=$1', [id]); console.log(JSON.stringify({ removed: true })); return; }
    const user = found.rows[0], current = Math.floor(Date.now() / 30000), next = Math.max(current, Number(user.mfa_last_counter) + 1);
    const waitMs = Math.max(0, (next - 1) * 30000 + 50 - Date.now());
    if (waitMs > 31000) throw Error('Fixture counter is unexpectedly far in the future.');
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    console.log(JSON.stringify({ code: totp(decryptMfa(user.mfa_secret_ciphertext, key, id)).generate({ timestamp: next * 30000 }) }));
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Staff fixture failed; verify isolated test configuration and owned fixture ID.'); process.exitCode = 1; });
