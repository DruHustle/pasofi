import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan} from './plan.mjs';

test('pilot scaffold remains disabled and guards both IP families before adding the radio',()=>{
  const text=buildPlan();
  assert.ok(text.indexOf('/interface bridge port find where comment~"^PamoFi pilot:"') < text.indexOf('/interface bridge add'));
  assert.match(text,/bridge add name="pfi-pilot-br" disabled=yes/);
  assert.match(text,/ssid="PasoFi Pilot"/);
  assert.match(text,/wireless add name="pfi-pilot-wifi".*default-forwarding=no wps-mode=disabled disabled=yes/);
  assert.ok(text.indexOf('Pilot radio already has bridge membership') > text.indexOf('/interface wireless add'));
  assert.ok(text.indexOf('Pilot radio already has bridge membership') < text.indexOf('/interface bridge port add'));
  assert.match(text,/find where interface="pfi-pilot-wifi" and bridge="pfi-pilot-br" and comment="PamoFi pilot: disabled test port"/);
  for(const family of ['/ip firewall filter','/ipv6 firewall filter']) {
    for(const [chain,direction] of [['input','in'],['output','out'],['forward','in'],['forward','out']]) {
      assert.ok(text.includes(`${family} add chain=${chain} action=drop ${direction}-interface="pfi-pilot-br"`));
      assert.ok(text.indexOf(`${family} add chain=${chain} action=drop`) < text.indexOf('/interface wireless add'));
    }
  }
  assert.doesNotMatch(text,/\/ip address add|\/ip dhcp-server add|\/ip hotspot add|\/radius add|masquerade|disabled=no comment=/);
});
