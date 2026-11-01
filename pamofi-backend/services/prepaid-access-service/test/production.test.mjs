import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../dist/app.js';
test('demo payment routes are unavailable unless explicitly in demo mode', async () => {
  process.env.APP_ENV = 'demo';
  process.env.NODE_ENV = 'production';
  const app = buildApp();
  const response = await app.inject({method:'POST',url:'/v1/orders/00000000-0000-4000-8000-000000000000/demo-confirm'});
  assert.equal(response.statusCode,404);
  await app.close();
});
