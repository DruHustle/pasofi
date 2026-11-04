import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { hashPassword, mfaKey } from './staff-crypto.js';
import { strongStaffPassword } from './staff-password-policy.js';

type BootstrapInput = { email: string; displayName: string; password: string; reason: string };

// The caller owns the transaction. This uses the same lock as administrator
// decisions, so no two bootstrap attempts can both pass the empty-state check.
export async function createFirstAdministrator(client: pg.PoolClient, input: BootstrapInput): Promise<string> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['pamofi-staff-admin-decisions-v1']);
  const guard = await client.query("SELECT EXISTS(SELECT 1 FROM staff_bootstrap_guard) OR EXISTS(SELECT 1 FROM staff_users WHERE role='admin') AS already_initialized");
  if (guard.rows[0].already_initialized) throw new Error('First administrator already initialized; bootstrap is permanently closed.');
  if (!strongStaffPassword(input.password, input.email, input.displayName)) throw new Error('Choose a stronger staff password of 18–128 characters.');
  const id = randomUUID(), encoded = await hashPassword(input.password);
  await client.query("INSERT INTO staff_users(id,email,display_name,password_hash,status,role) VALUES($1,$2,$3,$4,'approved','admin')", [id, input.email.toLowerCase(), input.displayName.trim(), encoded]);
  await client.query('INSERT INTO staff_bootstrap_guard(singleton,staff_id) VALUES(true,$1)', [id]);
  await client.query(`INSERT INTO staff_audit_events(id,actor_staff_id,target_staff_id,action,reason,previous_version,new_version,before_state,after_state)
    VALUES($1,NULL,$2,'bootstrap',$3,NULL,1,NULL,$4)`, [randomUUID(), id, input.reason.trim(), { status: 'approved', role: 'admin', siteIds: [] }]);
  return id;
}

export async function bootstrapMain(args = process.argv.slice(2)) {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!['--email', '--display-name', '--password-file', '--reason'].includes(name) || !value || values[name]) throw new Error('Use --email, --display-name, --password-file and --reason once each.');
    values[name] = value;
  }
  if (Object.keys(values).length !== 4) throw new Error('All four named bootstrap inputs are required; never put a password in command arguments.');
  const environment = process.env.APP_ENV;
  if (!environment || !['demo', 'staging', 'production'].includes(environment) || process.env.STAFF_BOOTSTRAP_CONFIRM !== 'first-admin' || process.env.STAFF_BOOTSTRAP_ENVIRONMENT !== environment) throw new Error('Explicit matching STAFF_BOOTSTRAP_CONFIRM=first-admin and STAFF_BOOTSTRAP_ENVIRONMENT are required.');
  const url = new URL(process.env.DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.pathname.slice(1) || url.search || url.hash || process.env.STAFF_BOOTSTRAP_DATABASE !== decodeURIComponent(url.pathname.slice(1))) throw new Error('DATABASE_URL must name the explicitly acknowledged STAFF_BOOTSTRAP_DATABASE without connection overrides.');
  const demo = environment === 'demo' && process.env.NODE_ENV === 'development';
  if (environment === 'demo' && (!demo || process.env.STAFF_BOOTSTRAP_ISOLATED !== '1' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Demo bootstrap requires development mode, a loopback database and STAFF_BOOTSTRAP_ISOLATED=1.');
  if (!demo && process.env.NODE_ENV !== 'production') throw new Error('Staging/production bootstrap requires NODE_ENV=production.');
  const origin = new URL(process.env.PUBLIC_ORIGIN || '');
  if (origin.origin !== process.env.PUBLIC_ORIGIN || (origin.protocol !== 'https:' && !(demo && origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new Error('Configure a canonical secure PUBLIC_ORIGIN before bootstrap.');
  if (!mfaKey(demo)) throw new Error('Configure a separate 32-byte STAFF_MFA_ENCRYPTION_KEY before bootstrap.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values['--email']) || values['--email'].length > 254 || values['--display-name'].trim().length < 2 || values['--display-name'].length > 80 || values['--reason'].trim().length < 5 || values['--reason'].length > 500) throw new Error('Invalid email, display name or audit reason.');
  const file = await open(values['--password-file'], constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let password: string;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) || metadata.size > 1024) throw new Error('The password file must be a small regular file owned by this user with mode 0600 or 0400.');
    password = (await file.readFile('utf8')).replace(/\r?\n$/, '');
    if (!strongStaffPassword(password, values['--email'], values['--display-name'])) throw new Error('Choose a stronger staff password of 18–128 characters on one line.');
  } finally { await file.close(); }
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('Bootstrap database connection lost.'));
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      const staffId = await createFirstAdministrator(client, { email: values['--email'], displayName: values['--display-name'], password, reason: values['--reason'] });
      await client.query('COMMIT');
      console.log(JSON.stringify({ staffId, status: 'approved', role: 'admin', mfaEnrolled: false, next: 'login_and_enroll_mfa' }));
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapMain().catch(error => {
    // CLI errors may originate in libpq and include a DSN or role details. Emit
    // only deliberate validation errors; never echo arguments or file contents.
    const message = error instanceof Error && !('code' in error) && !(error instanceof TypeError) ? error.message : 'Bootstrap failed; verify configuration, migrations and database availability.';
    console.error(message);
    process.exitCode = 1;
  });
}
