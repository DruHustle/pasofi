import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNetworkPlan} from './network-plan.mjs';

test('pilot network plan requires disabled, guarded interfaces and never enables service',()=>{
  const plan=buildNetworkPlan(),firstAdd=plan.indexOf('/ip address add');
  assert.ok(plan.indexOf('Expected disabled pilot bridge')<firstAdd);
  assert.ok(plan.indexOf('Expected disabled pilot radio')<firstAdd);
  assert.equal((plan.match(/Expected four pilot deny rules per IP family/g)||[]).length,2);
  for(const chain of ['input','output','forward'])assert.ok(plan.indexOf(`chain="${chain}"`)<firstAdd);
  assert.equal((plan.match(/Unexpected pilot deny rule/g)||[]).length,8);
  assert.equal(plan.split(String.raw`\$"`).length-1,8);
  assert.equal((plan.match(/Pilot deny rule is disabled/g)||[]).length,2);
  assert.equal((plan.match(/get \$pfiRule disabled\] = true/g)||[]).length,2);
  assert.doesNotMatch(plan,/firewall filter find where[^\n]*disabled=no/);
  assert.doesNotMatch(plan,/comment~"\^PamoFi pilot:"/);
  assert.doesNotMatch(plan,/comment="PamoFi pilot: (?:input|output|forward) (?:in|out)"/);
  assert.match(plan,/PamoFi pilot DHCP disabled:/);
  assert.match(plan,/address=10\.77\.10\.1\/24 interface="pfi-pilot-br"/);
  assert.match(plan,/dhcp-server add name="pfi-pilot-dhcp".*disabled=yes/);
  assert.doesNotMatch(plan,/\/ip dns static add|\/ip firewall nat add|\/ip hotspot add|\/radius add|disabled=no comment=/);
});
