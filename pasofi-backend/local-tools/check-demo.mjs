import assert from 'node:assert/strict';
const expected = [
  ['mini', 50, '2000000000', 259200],
  ['flex', 100, '5000000000', 604800],
  ['week', 300, '20000000000', 604800],
  ['fortnight', 500, '35000000000', 1209600],
  ['month', 1000, '75000000000', 2592000]
];
const response = await fetch('http://127.0.0.1:18082/v1/bundles');
assert.equal(response.status, 200);
const data = await response.json();
assert.equal(data.candidate, true);
assert.deepEqual(data.products.map(p => [p.id, p.price_minor, p.byte_limit, p.validity_seconds]), expected);
assert.ok(data.products.every(p => p.currency === 'USD'));
const help = await fetch('http://127.0.0.1:18085/v1/help');
assert.equal(help.status, 200);
assert.ok((await help.json()).articles.length > 0);
for (const port of [18081, 18082, 18083, 18084, 18085]) {
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
}
console.log('Demo catalogue, help, and five database readiness checks passed.');
