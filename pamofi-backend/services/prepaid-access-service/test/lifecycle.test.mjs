import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessState, activateOnConnection } from '../dist/lifecycle.js';
const bundle = (id, purchasedAt=0) => ({ id,purchasedAt,startBy:100000,validitySeconds:10,byteLimit:5000000000n,consumedBytes:0n,activatedAt:null });
test('payment alone leaves time unstarted and connection activates the oldest eligible entitlement', () => {
  const items=[bundle('second',2),bundle('first',1)];
  assert.equal(accessState(items[1],500),'queued');
  const started=activateOnConnection(items,1000,3000);
  assert.equal(started[1].activatedAt,1000);
  assert.equal(started[0].activatedAt,null);
  assert.equal(accessState(started[1],11000),'expired');
});
test('a top-up waits while active and offline expiry never starts it', () => {
  const items=[{...bundle('first'),activatedAt:1000},bundle('next',2)];
  assert.equal(activateOnConnection(items,5000,5000)[1].activatedAt,null);
  assert.equal(accessState(items[0],12000),'expired');
  assert.equal(items[1].activatedAt,null);
  assert.equal(activateOnConnection(items,12000,12000)[1].activatedAt,12000);
});
test('data exhaustion and start-by deadlines are enforced', () => {
  const used={...bundle('first'),activatedAt:1000,consumedBytes:5000000000n};
  assert.equal(accessState(used,1001),'exhausted');
  const missed={...bundle('old'),startBy:10};
  assert.equal(accessState(missed,11),'start-by-missed');
  assert.equal(activateOnConnection([missed,bundle('next')],20,30)[1].activatedAt,20);
  assert.throws(() => activateOnConnection([bundle('x')],101,100));
  assert.throws(() => activateOnConnection([{...bundle('newer'),activatedAt:50},bundle('queued')],40,60));
});
