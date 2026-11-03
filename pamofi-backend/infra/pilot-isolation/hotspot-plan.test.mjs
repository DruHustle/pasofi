import test from 'node:test';
import assert from 'node:assert/strict';
import {buildHotspotPlan} from './hotspot-plan.mjs';

test('HTTPS hotspot remains isolated and requires the reviewed identity and RADIUS client',()=>{
  const plan=buildHotspotPlan(),firstAdd=plan.indexOf('/ip hotspot profile add');
  for(const guard of ['Pilot bridge must be disabled','Pilot Wi-Fi must be disabled','Pilot DHCP must be disabled',
    'Expected disabled site RADIUS client','RADIUS tunnel endpoints differ','RADIUS service settings differ',
    'Hotspot certificate fingerprint differs','Existing local hotspot users require review',
    'Expected four pilot deny rules per IP family','Pilot deny rule is disabled']){
    assert.ok(plan.indexOf(guard)>=0 && plan.indexOf(guard)<firstAdd,guard);
  }
  assert.equal((plan.match(/Unexpected pilot deny rule/g)||[]).length,8);
  assert.match(plan,/login-by=https ssl-certificate="pamofi-hotspot-onesaeu\.p12_0" use-radius=yes radius-accounting=yes/);
  assert.match(plan,/hotspot add name="pfi-pilot-hotspot".*disabled=yes/);
  assert.doesNotMatch(plan,/login-by=(?:http-pap|http-chap|cookie|mac|trial)|\/radius (?:set|enable)|\/ip firewall nat|\/ip hotspot walled-garden|\/ip hotspot user add/);
  assert.doesNotMatch(plan,/https-redirect=/); // RouterOS 7.25.1 rejects this profile parameter.
});
