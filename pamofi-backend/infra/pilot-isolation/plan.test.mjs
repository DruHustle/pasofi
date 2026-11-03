import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan} from './plan.mjs';

test('pilot scaffold remains disabled and guards both IP families before adding the radio',()=>{
  const text=buildPlan();
  assert.match(text,/bridge add name="pfi-pilot-br" disabled=yes/);
  assert.match(text,/wireless add name="pfi-pilot-wifi".*default-forwarding=no disabled=yes/);
  for(const family of ['/ip firewall filter','/ipv6 firewall filter']) {
    for(const [chain,direction] of [['input','in'],['output','out'],['forward','in'],['forward','out']]) {
      assert.ok(text.includes(`${family} add chain=${chain} action=drop ${direction}-interface="pfi-pilot-br"`));
      assert.ok(text.indexOf(`${family} add chain=${chain} action=drop`) < text.indexOf('/interface wireless add'));
    }
  }
  assert.doesNotMatch(text,/\/ip address add|\/ip dhcp-server add|\/ip hotspot add|\/radius add|masquerade|disabled=no comment=/);
});
