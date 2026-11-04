import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('Lawfield bootstrap retains its own key and does not enable customer service',async()=>{
  const plan=await readFile(new URL('./lawfield-prepare.rsc',import.meta.url),'utf8');
  const create=plan.indexOf('/interface wireguard add');
  for(const guard of ['Lawfield preparation requires RouterOS 7','A legacy or PasoFi service interface already exists',
    'UDP port 51821 is already used','Install the matching official HotSpot package']){
    assert.ok(plan.indexOf(guard)>=0 && plan.indexOf(guard)<create,guard);
  }
  assert.match(plan,/name="pamofi-service" or name="pasofi-service"/);
  assert.match(plan,/wireguard add name="pasofi-service" listen-port=51821 disabled=yes/);
  assert.match(plan,/get \[find where name="pasofi-service"\] public-key/);
  assert.doesNotMatch(plan,/private-key\s*=|\/radius add|\/ip hotspot add|\/ip address add|disabled=no/);
});


test('Lawfield login draft is offline and sends hotspot credentials over HTTPS',async()=>{
  const page=await readFile(new URL('./lawfield-pilot-login.html',import.meta.url),'utf8');
  assert.match(page,/Lawfield Farm &bull; Pilot/);
  assert.match(page,/<form action="https:\/\/hotspot\.pasofi\.onesa\.eu\/login" method="post">/);
  assert.match(page,/name="username"/);
  assert.match(page,/name="password" type="password"/);
  assert.match(page,/Pilot testing is in progress/);
  assert.doesNotMatch(page,/<(?:script|link|img|iframe)\b/i);
});
