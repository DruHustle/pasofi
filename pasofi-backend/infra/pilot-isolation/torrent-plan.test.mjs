import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTorrentPlan} from './torrent-plan.mjs';

test('common torrent ports are dropped only on the disabled guest bridge before existing forwarding rules',()=>{
  const plan=buildTorrentPlan();
  assert.ok(plan.indexOf('Pilot bridge must be disabled')<plan.indexOf('/ip firewall filter add'));
  assert.equal((plan.match(/action=drop in-interface="pfi-pilot-br" protocol=tcp dst-port=6881-6999,51413/g)||[]).length,2);
  assert.equal((plan.match(/action=drop in-interface="pfi-pilot-br" protocol=udp dst-port=6881-6999,51413/g)||[]).length,2);
  assert.match(plan,/place-before=\(\[\/ip firewall filter find where chain="forward"\]->0\)/);
  assert.equal((plan.match(/Pilot isolation rule is disabled/g)||[]).length,2);
  assert.doesNotMatch(plan,/dst-port=443|\/ip dns set|\/interface wireless enable|\/ip hotspot enable/);
});
