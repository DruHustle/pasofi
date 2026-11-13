import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { issueRadiusCredential } from '/app/dist/credentials.js';
const [customer, siteA, siteB, nasA, nasB] = process.argv.slice(2);
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, 'postgres');
assert.equal(url.pathname, '/pamofi_network');
assert.equal(process.env.APP_ENV, 'demo');
const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
try {
  const key = { version: 1, key: randomBytes(32) };
  for (const [site, nas, client] of [
    [siteA, nasA, 'nas_a'],
    [siteB, nasB, 'nas_b'],
  ]) {
    await pool.query(
      'INSERT INTO radius_nas(id,site_id,client_name,enabled,login_url) VALUES ($1,$2,$3,true,$4)',
      [nas, site, client, 'https://' + client.replace('_', '-') + '.invalid/login'],
    );
    const requestKey = randomUUID();
    const input = { customerId: customer, nasId: nas, siteId: site, requestKey };
    const c = await issueRadiusCredential(pool, input, key);
    const repeat = await issueRadiusCredential(pool, input, key);
    assert.equal(c.username, repeat.username);
    assert.equal(c.password, repeat.password);
    assert.equal(c.siteId, site);
    assert.equal(c.nasId, nas);
    assert(/^[A-Za-z0-9_-]+$/.test(c.username) && /^[A-Za-z0-9_-]+$/.test(c.password));
    process.stdout.write(c.username + ' ' + c.password + '\n');
  }
} finally {
  await pool.end();
}
