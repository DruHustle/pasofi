import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildKuwadzanaScript} from './build-prepare.mjs';

test('checked-in Kuwadzana script is reproducible and keeps guest access disabled',async()=>{
  const plan=buildKuwadzanaScript();
  assert.equal(await readFile(new URL('./kuwadzana-prepare.rsc',import.meta.url),'utf8'),plan);
  const firstMutation=plan.indexOf('/ip hotspot profile add');
  for(const guard of ['This is not the reviewed Kuwadzana router','Pilot bridge must be disabled',
    'Pilot Wi-Fi must be disabled','Pilot DHCP must be disabled','Site RADIUS client must be the only client and disabled',
    'Expected reviewed hotspot certificate missing or changed','Partial hotspot state requires review',
    'Partial torrent policy requires review']) assert.ok(plan.indexOf(guard)>=0&&plan.indexOf(guard)<firstMutation,guard);
  assert.match(plan,/:if \(\$pfiHotspotCount = 0\) do=\{/);
  assert.match(plan,/:if \(\$pfiTorrentCount = 0\) do=\{/);
  assert.match(plan,/login-by=https .*use-radius=yes radius-accounting=yes/);
  assert.match(plan,/\/ip hotspot add name="pfi-pilot-hotspot".*disabled=yes/);
  assert.equal((plan.match(/PamoFi torrent: common tcp ports/g)||[]).length,3);
  assert.equal((plan.match(/PamoFi torrent: common udp ports/g)||[]).length,3);
  assert.doesNotMatch(plan,/\/radius (?:add|set|enable)|\/interface wireless enable|\/ip hotspot enable|secret=/);
});
