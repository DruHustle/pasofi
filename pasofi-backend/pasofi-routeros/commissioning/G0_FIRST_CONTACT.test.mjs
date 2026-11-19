import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const script=readFileSync(new URL('./G0_FIRST_CONTACT.rsc',import.meta.url),'utf8');
const commands=[
 '/system identity print',
 '/system routerboard print',
 '/system resource print',
 '/system device-mode print',
 '/interface ethernet print',
 '/interface ethernet monitor ether1 once',
 '/interface ethernet monitor ether2 once',
 '/interface ethernet monitor ether4 once',
 '/interface bridge print',
 '/interface bridge port print',
 '/interface list member print where list=WAN',
 '/ip address print',
 '/ip route print',
 '/ip dhcp-client print',
 '/ip dhcp-server print',
 '/ip dhcp-server network print proplist=address,gateway,dns-server',
 '/ip dns print',
 '/ip firewall nat print',
 '/ip firewall filter print terse where chain=forward',
 '/ip hotspot print proplist=name,interface,profile,disabled',
 '/ip hotspot profile print proplist=name,hotspot-address,dns-name,login-by,use-radius',
 '/radius print proplist=service,address,src-address,disabled,comment',
 '/interface wireguard peers print proplist=interface,allowed-address,last-handshake,rx,tx',
 '/ip service print'
];
test('G0 inventory is exact-command allowlisted, read-only, and excludes credentials',()=>{
 assert.match(script,/LAN1 ether2 now connected to CPE1/);
 assert.match(script,/ether4 also active, far-end UNKNOWN/);
 assert.match(script,/pfi-pilot-hotspot enabled on pfi-pilot-br/);
 assert.match(script,/RADIUS comment says site01/);
 const expected=new Set(commands);
 const lines=script.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
 assert.equal(lines.length,commands.length+2);
 assert.match(lines[0],/^:put "PASOFI G0 READ-ONLY FIRST CONTACT - NO WRITES"$/);
 assert.match(lines.at(-1),/^:put "G0 READ-ONLY FIRST CONTACT FINISHED: NO CHANGES"$/);
 const seen=new Set();
 for(const line of lines.slice(1,-1)){
  const match=/^:do \{ (.+) \} on-error=\{ :put "[^"]+" \}$/.exec(line);
  assert.ok(match,'unsafe RouterOS command: '+line);
  assert.ok(expected.has(match[1]),'unexpected RouterOS inventory command: '+match[1]);
  assert.ok(!seen.has(match[1]),'duplicate RouterOS command: '+match[1]);
  seen.add(match[1]);
 }
 assert.deepEqual(seen,expected);
 assert.doesNotMatch(lines.join('\n'),/\/(?:system backup|export|import|system reset-configuration)|(?:private-key|shared-secret|password|secret)=/i);
 assert.ok(commands.every(cmd=>/\s(?:print|monitor)\b/.test(cmd)),'only print/monitor reads permitted');
});
