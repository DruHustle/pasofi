import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../dist/app.js';
test('liveness does not depend on external services', async () => { const app = buildApp(); const r = await app.inject({method:'GET',url:'/health/live'}); assert.equal(r.statusCode,200); assert.equal(r.json().status,'ok'); await app.close(); });
