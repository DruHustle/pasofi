import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../dist/app.js';

const url = process.env.PAMOFI_TEST_DATABASE_URL;
test('an idle database connection failure does not kill the service and readiness recovers', { skip: !url }, async () => {
  const connection = new URL(url), marker = `pamofi-recovery-${randomUUID()}`;
  connection.searchParams.set('application_name', marker);
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connection.toString();
  const app = buildApp(), observer = new pg.Pool({ connectionString: url });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);
    // Only terminate this test's uniquely named, idle connection. No database
    // restart or other service/client connection is affected.
    const terminated = await observer.query(
      "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name=$1 AND state='idle' AND pid<>pg_backend_pid()",
      [marker]
    );
    assert.equal(terminated.rowCount, 1);
    assert.equal(terminated.rows[0].terminated, true);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
    let ready;
    for (let attempt = 0; attempt < 20; attempt++) {
      ready = await app.inject({ method: 'GET', url: '/health/ready' });
      if (ready.statusCode === 200) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(ready.statusCode, 200);
  } finally {
    await app.close();
    await observer.end();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
