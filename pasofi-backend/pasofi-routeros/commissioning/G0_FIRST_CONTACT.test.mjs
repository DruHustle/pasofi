import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('./G0_FIRST_CONTACT.rsc',import.meta.url),'utf8');
const menus=new Set(['/system identity','/system routerboard','/system resource','/system device-mode','/interface ethernet','/interface bridge','/interface bridge port','/ip address','/ip route','/ip dhcp-client','/ip dhcp-server','/ip firewall nat','/ip hotspot','/ip service']);
test('G0 current Ethernet first-contact inventory has no RouterOS writes or secrets',()=>{
 assert.match(script,/G0 LAN1 -> G2/);assert.match(script,/future G1\/CPE1\/CPE2 NOT commissioned/);assert.match(script,/K0 LAN4 EMPTY/);
 const lines=script.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
 assert.ok(lines.length>13);
 for(const line of lines){
  if(line.startsWith(':put ')){assert.match(line,/^:put "[^"]*"$/);continue;}
  const m=/^:do \{ (\/[\w-]+(?: [\w-]+){0,2}) print \} on-error=\{ :put "[^"]+" \}$/.exec(line);
  assert.ok(m,'unsafe command: '+line);assert.ok(menus.has(m[1]),'unapproved menu: '+m[1]);
 }
 assert.doesNotMatch(script,/\/(?:radius|interface wireguard) print/);
 assert.doesNotMatch(script,/\/(?:system backup|export|import|system reset-configuration)/);
});
