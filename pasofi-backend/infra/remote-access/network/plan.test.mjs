import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,stat,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildPlan,writePlan} from './plan.mjs';
import {validatePlan,ownerManifest} from './schema.mjs';
import {fixture} from './fixture.mjs';

// Interpret the rendered subset independently, including insertion before a
// pre-existing permissive/FastTrack rule. This is not a RouterOS runtime.
function routerModel(text) {
  const chains=new Map();
  for(const family of ['ip','ipv6']) for(const chain of ['input','output','forward','srcnat']) chains.set(`${family}:${chain}`,[{action:'accept'}]);
  for(const line of text.split('\n')) {
    const match=line.match(/do=\{ \/(ip|ipv6) firewall (?:filter|nat) add (.*?) place-before=\(/);
    if(!match) continue;
    assert.match(line,/else=\{ \/(?:ip|ipv6) firewall (?:filter|nat) add /);
    const rule=Object.fromEntries([...match[2].matchAll(/([a-z-]+)=(?:"([^"]*)"|([^ ]+))/g)].map(item=>[item[1],item[2]??item[3]]));
    chains.get(`${match[1]}:${rule.chain}`).unshift(rule);
  }
  return (family,chain,packet)=>{
    for(const rule of chains.get(`${family}:${chain}`)) {
      let matches=true;
      for(const field of ['in-interface','out-interface','protocol']) if(rule[field]!==undefined) {
        const expected=rule[field],negative=expected.startsWith('!');
        if(negative ? packet[field]===expected.slice(1) : packet[field]!==expected) matches=false;
      }
      for(const field of ['src-address','dst-address']) if(rule[field]&&rule[field].replace(/\/32$/,'')!==packet[field]) matches=false;
      for(const field of ['src-port','dst-port','connection-state']) if(rule[field]&&!rule[field].split(',').includes(String(packet[field]))) matches=false;
      if(rule['icmp-options']&&rule['icmp-options']!==packet['icmp-options']) matches=false;
      if(matches) return rule;
    }
    return {action:'accept'};
  };
}
const request=(changes={})=>({'in-interface':'pfi-owner','out-interface':'bridge','src-address':'10.210.0.1','dst-address':'192.168.20.10',protocol:'tcp','dst-port':80,'src-port':53000,'connection-state':'new',...changes});
const reply=(changes={})=>request({'in-interface':'bridge','out-interface':'pfi-owner','src-address':'192.168.20.10','dst-address':'10.210.0.1','src-port':80,'dst-port':53000,'connection-state':'established',...changes});

test('multi-gateway hub peers own disjoint management /32s; manifest contract is stable and prepared-only',()=>{
  const files=buildPlan(fixture()),manifest=JSON.parse(files['owner-targets.json']);
  assert.deepEqual(Object.keys(manifest).sort(),['schemaVersion','kind','status','planId','expectedTailscaleLogin','expectedHubNodeId','requiredRoutes','targets'].sort());
  assert.equal(manifest.kind,'pasofi-owner-management'); assert.equal(manifest.status,'prepared-only');
  assert.equal(manifest.expectedHubNodeId,'nSyntheticCNTRL'); assert.equal(manifest.targets.length,4);
  assert.deepEqual(manifest.requiredRoutes,['10.210.0.2/32','192.168.20.10/32','10.210.0.3/32','192.168.30.20/32']);
  assert.deepEqual(manifest.targets[0].tcpPorts,[22,8291]);
  assert.deepEqual(Object.keys(manifest.targets[0]).sort(),['id','name','role','gatewayId','vendor','address','tcpPorts','icmp','expectedIdentity','verifiedAt'].sort());
  assert.equal(manifest.targets[1].expectedIdentity.kind,'mac');
  const peers=files['hub-wireguard.conf.review'].split('[Peer]').slice(1);
  assert.equal(peers.length,2);
  assert.match(peers[0],/AllowedIPs = 10\.210\.0\.2\/32, 192\.168\.20\.10\/32/);
  assert.match(peers[1],/AllowedIPs = 10\.210\.0\.3\/32, 192\.168\.30\.20\/32/);
  assert.doesNotMatch(files['hub-wireguard.conf.review'],/AllowedIPs = .*\/24|0\.0\.0\.0\/0|::\/0|DNS\s*=|PostUp|PostDown/);
  const review=JSON.parse(files['review.json']);
  assert.equal(review.liveChangesPerformed,false);assert.equal(review.privateKeysIncluded,false);
  assert.ok(Object.values(review.qualification).every(value=>value===false));
});

test('router forwarding permits only selected target ports and established correctly routed replies before existing accepts',()=>{
  const decide=routerModel(buildPlan(fixture())['router-gateway-a.rsc.review']);
  assert.equal(decide('ip','forward',request()).action,'accept');
  assert.equal(decide('ip','forward',request({'connection-state':'established'})).action,'accept');
  assert.equal(decide('ip','forward',reply()).action,'accept');
  for(const packet of [request({'dst-port':443}),request({'dst-address':'192.168.20.11'}),request({'dst-address':'192.168.30.20'}),request({'src-address':'100.80.1.2'}),request({'out-interface':'ether1'}),request({'connection-state':'invalid'}),reply({'connection-state':'new'}),reply({'src-port':443}),reply({'in-interface':'ether1'}),reply({'dst-address':'10.210.0.3'}),request({'in-interface':'bridge'})]) assert.equal(decide('ip','forward',packet).action,'drop',JSON.stringify(packet));
  assert.equal(decide('ip','forward',request({'in-interface':'bridge','src-address':'192.168.20.50','out-interface':'ether1','dst-address':'1.1.1.1'})).action,'accept','Unrelated customer traffic retains existing rules');
  assert.equal(decide('ipv6','forward',request()).action,'drop');
  assert.equal(decide('ipv6','forward',reply()).action,'drop');
});

test('gateway TCP and replies are scoped, SSH is explicit, ICMP echo is optional and related errors retain conntrack checks',()=>{
  const files=buildPlan(fixture()),a=routerModel(files['router-gateway-a.rsc.review']),b=routerModel(files['router-gateway-b.rsc.review']);
  const incoming=request({'dst-address':'10.210.0.2','dst-port':22});
  assert.equal(a('ip','input',incoming).action,'accept');
  assert.equal(a('ip','input',{...incoming,'dst-port':80}).action,'drop');
  assert.equal(a('ip','input',{...incoming,'dst-address':'192.168.20.1'}).action,'drop');
  assert.equal(a('ip','input',{...incoming,'in-interface':'bridge'}).action,'drop');
  assert.equal(a('ip','output',reply({'src-address':'10.210.0.2','src-port':22})).action,'accept');
  assert.equal(a('ip','output',reply({'src-address':'10.210.0.2','src-port':22,'connection-state':'new'})).action,'drop');
  const echo=request({protocol:'icmp','icmp-options':'8:0'});
  assert.equal(a('ip','forward',echo).action,'accept');
  assert.equal(a('ip','forward',{...echo,'icmp-options':'13:0'}).action,'drop');
  assert.equal(a('ip','forward',reply({protocol:'icmp','icmp-options':'0:0'})).action,'accept');
  assert.equal(b('ip','forward',{...echo,'dst-address':'192.168.30.20'}).action,'drop');
  assert.equal(b('ip','input',{...incoming,'dst-address':'10.210.0.3'}).action,'drop');
  assert.equal(a('ip','forward',reply({protocol:'icmp','icmp-options':'3:4','connection-state':'related'})).action,'accept');
  assert.equal(a('ip','forward',reply({protocol:'icmp','icmp-options':'3:4','connection-state':'new'})).action,'drop');
  for(const chain of ['input','output']) assert.equal(a('ipv6',chain,chain==='input'?incoming:reply()).action,'drop');
});

test('optional source NAT is bound to hub source, exact device, selected ports and inspected LAN egress',()=>{
  const files=buildPlan(fixture()),nat=routerModel(files['router-gateway-a.rsc.review']);
  const translated=nat('ip','srcnat',request());
  assert.equal(translated.action,'src-nat'); assert.equal(translated['to-addresses'],'192.168.20.1');
  for(const packet of [request({'src-address':'192.168.20.50'}),request({'dst-address':'192.168.20.11'}),request({'dst-port':443}),request({'out-interface':'ether1'})]) assert.notEqual(nat('ip','srcnat',packet).action,'src-nat');
  assert.doesNotMatch(files['router-gateway-b.rsc.review'],/\/ip firewall nat add/);
  assert.doesNotMatch(files['router-gateway-a.rsc.review'],/action=masquerade/);
});

test('hub rendered filters use pre-SNAT owner sources and restored return destinations, with a fail-closed post-SNAT guard',()=>{
  const firewall=buildPlan(fixture())['hub-firewall.nft.review'];
  const forward=firewall.split('\n').filter(line=>line.startsWith('add rule inet pfi_owner_hub forward '));
  assert.ok(forward.some(line=>line.includes('iifname "tailscale0" oifname "pfi-owner-hub" ip saddr 100.64.0.0/10 ip daddr 192.168.20.10 tcp dport { 80 } ct state { new, established } accept')));
  assert.ok(forward.some(line=>line.includes('iifname "pfi-owner-hub" oifname "tailscale0" ip saddr 192.168.20.10 ip daddr 100.64.0.0/10 tcp sport { 80 } ct state established accept')));
  assert.deepEqual(forward.slice(-2),['add rule inet pfi_owner_hub forward iifname "pfi-owner-hub" drop','add rule inet pfi_owner_hub forward oifname "pfi-owner-hub" drop']);
  assert.doesNotMatch(forward.join('\n'),/iifname "tailscale0" .*ip saddr 10\.210\.0\.1/);
  assert.match(firewall,/after_snat \{ type filter hook postrouting priority 110;/);
  assert.match(firewall,/after_snat oifname "pfi-owner-hub" ip saddr 10\.210\.0\.1 accept\nadd rule inet pfi_owner_hub after_snat oifname "pfi-owner-hub" drop/);
  assert.doesNotMatch(firewall,/^(?:flush|delete table)|dport 22.*input|policy drop;/m);
  assert.ok(firewall.includes('input iifname "pfi-owner-hub" drop'));
  assert.ok(firewall.includes('output oifname "pfi-owner-hub" drop'));
});

test('existing IPv4 and IPv6 advertisements are preserved exactly and policy grants are target-specific',()=>{
  const p=fixture(),files=buildPlan(p),policy=JSON.parse(files['tailscale-policy-fragment.json']);
  assert.match(files['tailscale-route-command.txt.review'],/sudo tailscale set --advertise-routes=172\.21\.40\.0\/24,fd7a:115c:a1e0:beef::\/64,10\.210\.0\.2\/32,192\.168\.20\.10\/32,10\.210\.0\.3\/32,192\.168\.30\.20\/32\n$/);
  assert.deepEqual(policy.grants[1],{src:['owner@example.com'],dst:['192.168.20.10/32'],ip:['tcp:80','icmp:*']});
  assert.deepEqual(policy.grants[3].ip,['tcp:80','tcp:443']);
  assert.ok(policy.tests.every(row=>row.proto==='tcp' && row.deny.some(target=>target.endsWith(':8728'))));
  assert.doesNotMatch(files['tailscale-route-command.txt.review'],/--reset|--accept-dns|--ssh|--exit-node|--snat-subnet-routes=/);
  p.hub.existingAdvertisedRoutes=[];
  assert.deepEqual(JSON.parse(buildPlan(p)['review.json']).preservedAdvertisedRoutes,ownerManifest(validatePlan(p)).requiredRoutes);
});

test('owner logins support exact email, GitHub and passkey identities without endpoint suffix rules',()=>{
  for(const login of ['Owner+ops@company.example','operator@github','operator@passkey','owner@company.test']) {
    const p=fixture();p.owner.tailscaleLogin=login;
    assert.equal(JSON.parse(buildPlan(p)['owner-targets.json']).expectedTailscaleLogin,login);
  }
  for(const login of ['owner@-bad.example','owner@123.45','owner@localhost','owner@company..test','*','owner@github\n']) {
    const p=fixture();p.owner.tailscaleLogin=login;assert.throws(()=>buildPlan(p));
  }
});

test('fresh-interface, serial, service and route checks precede every mutation; enablement is last and rollback is exact',()=>{
  const files=buildPlan(fixture()),script=files['router-gateway-a.rsc.review'],before=script.slice(0,script.indexOf(' firewall filter add '));
  for(const marker of ['system routerboard get serial-number','public-key] !=','disabled] != true','listen-port','/routing rule','action=mark-routing','dst-address!=','/ip service find','gateway address changed','Prior or partial owner plan','public-key="AQEBAQ']) assert.ok(before.includes(marker),marker);
  assert.match(script.trimEnd(),/\/interface wireguard set .* disabled=no\n\}$/);
  assert.match(before,/name="ssh" and port=22 and disabled=no and dynamic=no and invalid=no/);
  assert.doesNotMatch(script,/\/ip service set|\/user |private-key=|\/interface list member add|\/interface bridge port add|\/ip dhcp|\/ip firewall filter remove|system reboot|package update|pasofi-service.*(?:set|remove)/);
  assert.match(script,/allowed-address=10\.210\.0\.1\/32/);
  const rollback=files['router-gateway-a.rollback.rsc.review'];
  assert.match(rollback,/Gateway serial differs/); assert.match(rollback,/Owner interface key changed/);
  assert.ok(rollback.indexOf('disabled=yes')<rollback.indexOf(' remove [find'));
  assert.doesNotMatch(rollback,/remove \[find\]|comment~|\/interface wireguard remove|\/ip firewall connection/);
});

test('each exact rollback ownership selector identifies exactly one rendered apply record',()=>{
  for(const targetId of ['bridge-a','gateway']) {
    const p=fixture();p.gateways[0].targets[0].id=targetId;
    const files=buildPlan(p);
    for(const g of p.gateways) {
      const records=new Map(),selectors=new Set();
      for(const line of files[`router-${g.id}.rsc.review`].split('\n')) {
        // Each conditional line executes exactly one add branch.
        const match=line.match(/(\/(?:ip|ipv6) (?:firewall (?:filter|nat)|address|route)|\/interface wireguard peers) add .*? comment="([^"]+)"/);
        if(match) {const key=`${match[1]}:${match[2]}`;records.set(key,(records.get(key)??0)+1);}
      }
      for(const match of files[`router-${g.id}.rollback.rsc.review`].matchAll(/\[(\/(?:ip|ipv6) (?:firewall (?:filter|nat)|address|route)|\/interface wireguard peers) find where comment="([^"]+)"\]/g)) selectors.add(`${match[1]}:${match[2]}`);
      assert.ok(selectors.size>0);
      assert.equal(selectors.size,records.size);
      for(const key of selectors) assert.equal(records.get(key),1,key);
    }
  }
});

test('complete apply and rollback stay within the 80-action fresh Safe Mode budget',()=>{
  const p=fixture();p.gateways=[p.gateways[0]];
  const sample=p.gateways[0].targets[0];
  const target=index=>({...sample,id:`target-${index}`,address:`192.168.20.${30+index}`,expectedIdentity:{kind:'mac',value:`02:00:00:00:00:${(10+index).toString(16).toUpperCase().padStart(2,'0')}`},management:{...sample.management},path:{...sample.path}});
  p.gateways[0].targets=Array.from({length:7},(_,index)=>target(index));
  const last=target(7);last.management.icmp=false;last.path.returnPath='verified-gateway-route';p.gateways[0].targets.push(last);
  const files=buildPlan(p),review=JSON.parse(files['review.json']);
  assert.deepEqual(review.mutationCounts['gateway-a'],{apply:80,rollback:80});
  const applyLines=files['router-gateway-a.rsc.review'].split('\n').filter(line=>/do=\{ \/(?:ip|ipv6) firewall (?:filter|nat) add /.test(line)||/^\/(?:ip address|ip route|interface wireguard(?: peers)?) (?:add|set) /.test(line));
  const rollbackLines=files['router-gateway-a.rollback.rsc.review'].split('\n').filter(line=>/^\/.* (?:remove|set) /.test(line));
  assert.equal(applyLines.length,80);assert.equal(rollbackLines.length,80);
  const extra=target(8);extra.management.icmp=false;extra.path.returnPath='verified-gateway-route';p.gateways[0].targets.push(extra);
  assert.throws(()=>buildPlan(p),/80-action fresh Safe Mode budget/);
});

test('unknown fields, incomplete inventories, overlap, ambiguous ownership, unsafe paths and malformed public input fail closed',()=>{
  const cases=[
    p=>{p.privateKey='never-accepted';}, p=>{p.hub.privateKey='never-accepted';},p=>{p.schemaVersion=2;},
    p=>{delete p.owner.ipv4Routes;},p=>{delete p.hub.ipv4Routes;},p=>{delete p.hub.existingAdvertisedRoutes;},p=>{delete p.gateways[0].ipv4Routes;},
    p=>{p.hub.ipv4Routes=['0.0.0.0/0'];},p=>{p.hub.existingAdvertisedRoutes=['::/0'];},p=>{p.hub.existingAdvertisedRoutes=['192.168.20.0/24'];},
    p=>{p.hub.existingAdvertisedRoutes=['fd00:0:0::/64'];},p=>{p.hub.existingAdvertisedRoutes=['fd00::1/64'];},
    p=>{p.owner.ipv4Routes.push('192.168.20.0/24');},p=>{p.hub.ipv4Routes.push('10.210.0.0/24');},p=>{p.gateways[1].ipv4Routes.push('10.210.0.0/16');},
    p=>{p.gateways[1].tunnelIp=p.gateways[0].tunnelIp;},p=>{p.gateways[1].publicKey=p.gateways[0].publicKey;},p=>{p.gateways[0].publicKey=p.hub.publicKey;},
    p=>{p.hub.publicKey=Buffer.alloc(32).toString('base64');},p=>{p.gateways[0].expectedSerial='bad";:error x';},p=>{p.gateways[1].expectedSerial=p.gateways[0].expectedSerial.toLowerCase();},
    p=>{p.gateways[0].interface='pasofi-service';},p=>{p.hub.interface='tailscale0';},p=>{p.hub.endpoint='100.80.1.2';},p=>{p.hub.endpoint='vpn.example.com;echo';},
    p=>{p.owner.tailscaleLogin='*';},p=>{p.hub.tailscaleNodeId='nodekey:secret';},p=>{p.gateways[0].management.tcpPorts=[8728];},p=>{p.gateways[0].management.tcpPorts=[22,22];},
    p=>{delete p.gateways[0].management.icmp;},p=>{p.gateways[0].targets[0].path.egressInterface='ether1';},p=>{p.gateways[0].targets[0].path.egressInterface='pasofi-service';},
    p=>{p.gateways[0].targets[0].path.returnPath='unknown';},p=>{p.gateways[0].targets[0].path.gatewayLanIp='192.168.99.1';},
    p=>{p.gateways[0].targets[0].address='192.168.20.255';},p=>{p.gateways[0].targets[0].address='192.168.20.1';},
    p=>{p.gateways[0].targets[0].verifiedAt='2026-02-30T12:00:00Z';},p=>{p.gateways[0].targets[0].expectedIdentity.value='03:00:00:00:00:01';},
    p=>{p.gateways[0].verifiedAt='0000-01-01T00:00:00Z';},p=>{p.gateways[0].name='\ud800';},
    p=>{p.gateways[0].targets[0].expectedIdentity.value='00:00:00:00:00:00';},p=>{p.gateways[1].targets[0].expectedIdentity=p.gateways[0].targets[0].expectedIdentity;},
    p=>{p.gateways[1].targets[0].id=p.gateways[0].id;},p=>{p.gateways[1].targets[0].address=p.gateways[0].targets[0].address;},
    p=>{p.gateways[0].ipv4Routes.push('192.168.20.10/32');},p=>{p.gateways[0].ipv4Routes=['192.168.20.1/24'];},
    p=>{p.gateways[0].targets[0].path.connectedCidr='192.168.20.0/25';},p=>{p.gateways=[];},
  ];
  for(const mutate of cases) {const p=fixture();mutate(p);assert.throws(()=>buildPlan(p),undefined,mutate.toString());}
  const ambiguous=fixture();ambiguous.gateways[1].ipv4Routes.push('192.168.20.0/24');
  ambiguous.gateways[1].targets[0].address='192.168.20.20';ambiguous.gateways[1].targets[0].path={...ambiguous.gateways[0].targets[0].path};
  assert.throws(()=>buildPlan(ambiguous),/ownership|ambiguous/);
  const empty=fixture();empty.owner.ipv4Routes=[];empty.hub.ipv4Routes=[];empty.gateways[1].targets=[];assert.doesNotThrow(()=>buildPlan(empty));
});

test('CLI/output are private, exclusive, secret-free and never created for invalid input',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pasofi-owner-network-'));
  try {
    const directory=join(root,'review');await writePlan(fixture(),directory);
    assert.equal((await stat(directory)).mode&0o777,0o700);
    const before=new Map();
    for(const file of await readdir(directory)) {
      assert.equal((await stat(join(directory,file))).mode&0o777,0o600);
      before.set(file,await readFile(join(directory,file),'utf8'));
    }
    await assert.rejects(writePlan(fixture(),directory),{code:'EEXIST'});
    for(const [file,body] of before) assert.equal(await readFile(join(directory,file),'utf8'),body);
    const invalid=fixture();invalid.hub.privateKey='DO_NOT_EMIT_THIS_VALUE';
    const input=join(root,'invalid.json'),output=join(root,'invalid-output');await writeFile(input,JSON.stringify(invalid));
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('./plan.mjs',import.meta.url)),input,output],{encoding:'utf8'});
    assert.equal(result.error,undefined);assert.notEqual(result.status,0);assert.doesNotMatch(`${result.stdout}${result.stderr}`,/DO_NOT_EMIT_THIS_VALUE/);
    await assert.rejects(stat(output),{code:'ENOENT'});
    const repo=join(root,'unrelated-repository');await mkdir(repo);await writeFile(join(repo,'.git'),'worktree marker');
    await assert.rejects(writePlan(fixture(),join(repo,'private-review')),/outside every Git worktree/);
    const alias=join(root,'repo-alias');await symlink(repo,alias,'dir');
    await assert.rejects(writePlan(fixture(),join(alias,'private-review')),/outside every Git worktree/);
    await assert.rejects(stat(join(repo,'private-review')),{code:'ENOENT'});
    await assert.rejects(writePlan(fixture(),'relative-private-review'),/absolute private/);
  } finally {await rm(root,{recursive:true,force:true});}
});
