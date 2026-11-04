import { test } from 'node:test';
import assert from 'node:assert/strict';
import { radiusCounter, radiusLimit, observe, remainingTimeoutSeconds } from '../dist/accounting.js';
test('large combined grants round-trip and zero cannot mean unlimited', () => {
  for (const n of [4294967296n, 5000000000n, 75000000000n]) {
    const { high, low } = radiusLimit(n);
    assert.equal(radiusCounter(high, low), n);
  }
  assert.deepEqual(radiusLimit(4294967296n), { high: 1n, low: 0n });
  assert.throws(() => radiusLimit(0n));
  assert.throws(() => radiusCounter(0n, 4294967296n));
});
test('combined usage is monotone and regressions retain uncertainty', () => {
  const a = observe({upload:0n,download:0n},{upload:4294967296n,download:50n});
  assert.equal(a.additionalBytes, 4294967346n);
  const duplicate = observe(a.highWater,a.highWater);
  assert.equal(duplicate.additionalBytes,0n);
  const reordered = observe(a.highWater,{upload:2n,download:30n});
  assert.equal(reordered.additionalBytes,0n);
  assert.equal(reordered.uncertain,true);
  assert.deepEqual(reordered.highWater,a.highWater);
  const advanced = observe(reordered.highWater,{upload:4294967300n,download:60n});
  assert.equal(advanced.additionalBytes,14n);
});
test('a replay cannot extend an absolute deadline', () => {
  assert.equal(remainingTimeoutSeconds(200000, 100000, 2), 98);
  assert.equal(remainingTimeoutSeconds(200000, 150000, 2), 48);
  assert.equal(remainingTimeoutSeconds(200000, 199500, 2), 0);
  assert.throws(() => remainingTimeoutSeconds(0,0,-1));
});
