import {test} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {chmodSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {RouterOS} from '../dist/routeros.js';
import {bindingComment,normalizeLabel,normalizeMac,normalizeReason,planBindings,reconcileRouter,taggedId} from '../dist/allowlist.js';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const desired=[{id:A,macAddress:'02:00:00:00:00:0A',label:'Office printer'},{id:B,macAddress:'3C:22:FB:12:34:56',label:'Owner phone'}];
const tagged=(id,mac,extra={})=>({id:extra.id??'*'+mac.slice(-2),macAddress:mac,type:'bypassed',server:'all',comment:bindingComment(id,'label'),disabled:false,...extra});

test('MAC addresses normalize to upper-case colon form and reject non-unicast values',()=>{
 for(const value of ['3c:22:fb:12:34:56','3C-22-FB-12-34-56','3c22.fb12.3456','3C22FB123456',' 3c:22:fb:12:34:56 '])assert.equal(normalizeMac(value),'3C:22:FB:12:34:56');
 // Locally administered (randomized phone) addresses are valid unicast.
 assert.equal(normalizeMac('02:00:00:00:00:0a'),'02:00:00:00:00:0A');
 assert.throws(()=>normalizeMac('FF:FF:FF:FF:FF:FF'),{code:'broadcast_mac_address'});
 for(const multicast of ['01:00:5E:00:00:FB','33:33:00:00:00:01','03:00:00:00:00:01'])assert.throws(()=>normalizeMac(multicast),{code:'multicast_mac_address'});
 for(const invalid of ['00:00:00:00:00:00','3C:22:FB:12:34','3C:22:FB:12:34:56:78','3C:22-FB:12:34:56','GG:22:FB:12:34:56','3c22fb12345','3c:22:fb:12:34:56;reboot','3c:22:fb:12\n:34:56',' ',42,null,undefined,{}])
  assert.throws(()=>normalizeMac(invalid),error=>['invalid_mac_address'].includes(error.code));
});

test('labels and reasons are bounded, trimmed and free of control characters',()=>{
 assert.equal(normalizeLabel('  Front   desk  tablet '),'Front desk tablet');
 assert.equal(normalizeLabel('x'.repeat(80)),'x'.repeat(80));
 assert.equal(normalizeLabel('Tendai’s phone 📱'),'Tendai’s phone 📱');
 for(const invalid of ['','   ','x'.repeat(81),'bad\nlabel','tab\tlabel','null\u0000',7])assert.throws(()=>normalizeLabel(invalid),{code:'invalid_label'});
 assert.equal(normalizeReason('  Owner approved this kiosk  '),'Owner approved this kiosk');
 for(const invalid of ['too short','x'.repeat(501),'Approved by\u0007owner',undefined])assert.throws(()=>normalizeReason(invalid),{code:'invalid_reason'});
});

test('only the exact allowlist tag marks a binding as owned',()=>{
 assert.equal(taggedId(bindingComment(A,'Office printer')),A);
 assert.equal(taggedId(`pasofi-allowlist:${A}`),A);
 for(const comment of [undefined,'','K1 management uplink',`PASOFI-ALLOWLIST:${A}`,'pasofi-allowlist:ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF',`pasofi-allowlist:${A}x`,`note pasofi-allowlist:${A}`,'pasofi-allowlist:not-a-uuid'])
  assert.equal(taggedId(comment),null,String(comment));
 assert.throws(()=>bindingComment('not-a-uuid','x'));
});

test('the reconcile diff adds missing, removes stale and never touches untagged bindings',()=>{
 const operator=[
  {id:'*1',macAddress:'D4:01:C3:00:00:01',type:'bypassed',server:'all',comment:'K1 management uplink',disabled:false},
  {id:'*2',macAddress:'D4:01:C3:00:00:02',type:'blocked',server:'pfi-guest20',disabled:false},
  {id:'*3',type:'bypassed',server:'all',comment:'address-only rule',disabled:false},
  {id:'*4',macAddress:'D4:01:C3:00:00:04',type:'bypassed',server:'all',comment:'pasofi-allowlist:legacy',disabled:false},
 ];
 // Nothing wanted: owned stale bindings go, operator bindings stay.
 let plan=planBindings([...operator,tagged(C,'AA:00:00:00:00:0C',{id:'*9'})],[]);
 assert.deepEqual(plan.remove,[{bindingId:'*9',entryId:C,macAddress:'AA:00:00:00:00:0C'}]);
 assert.deepEqual(plan.add,[]);
 // Empty router: everything wanted is added, nothing removed.
 plan=planBindings(operator,desired);
 assert.deepEqual(plan.remove,[]);assert.deepEqual(plan.add.map(d=>d.id),[A,B]);
 // Already present: idempotent, no writes.
 plan=planBindings([...operator,tagged(A,'02:00:00:00:00:0A'),tagged(B,'3C:22:FB:12:34:56')],desired);
 assert.deepEqual(plan.remove,[]);assert.deepEqual(plan.add,[]);
 assert.deepEqual([...plan.states],[[A,'applied'],[B,'applied']]);
 // Lower-case MAC on the router still matches.
 plan=planBindings([tagged(A,'02:00:00:00:00:0a'),tagged(B,'3c:22:fb:12:34:56')],desired);
 assert.deepEqual(plan.remove,[]);assert.deepEqual(plan.add,[]);
 // An untagged binding for a wanted MAC is reported, not replaced or duplicated.
 plan=planBindings([{id:'*7',macAddress:'3c:22:fb:12:34:56',type:'regular',server:'all',comment:'manual',disabled:false}],desired);
 assert.deepEqual(plan.add.map(d=>d.id),[A]);assert.equal(plan.states.get(B),'conflict');assert.deepEqual(plan.remove,[]);
 // Modified or duplicated owned bindings are replaced by exactly one correct one.
 for(const changed of [{type:'regular'},{type:'blocked'},{server:'pfi-guest20'},{disabled:true},{macAddress:'02:00:00:00:00:0B'}]){
  plan=planBindings([tagged(A,'02:00:00:00:00:0A',{id:'*A',...changed}),tagged(B,'3C:22:FB:12:34:56')],desired);
  assert.deepEqual(plan.remove.map(r=>r.bindingId),['*A'],JSON.stringify(changed));assert.deepEqual(plan.add.map(d=>d.id),[A]);
 }
 plan=planBindings([tagged(A,'02:00:00:00:00:0A',{id:'*A'}),tagged(A,'02:00:00:00:00:0A',{id:'*B'}),tagged(B,'3C:22:FB:12:34:56')],desired);
 assert.deepEqual(plan.remove.map(r=>r.bindingId),['*B']);assert.deepEqual(plan.add,[]);
 // A MAC that moved from a removed entry to a new one: remove old tag, add new.
 plan=planBindings([tagged(C,'02:00:00:00:00:0A',{id:'*C'})],desired);
 assert.deepEqual(plan.remove.map(r=>r.entryId),[C]);assert.deepEqual(plan.add.map(d=>d.id),[A,B]);
 for(const item of [...operator])assert.ok(!plan.remove.some(r=>r.bindingId===item.id));
});

function memoryRouter(initial=[],options={}){
 let next=100;const state={bindings:[...initial],calls:[]};
 return {state,
  async bindings(){state.calls.push('read');if(options.unreachable)throw Error('router_unavailable');if(options.verifyFails&&state.calls.filter(c=>c==='read').length>1)throw Error('router_unavailable');return state.bindings.map(b=>({...b}));},
  async addBypassBinding(mac,comment){state.calls.push(`add ${mac}`);if(options.addFails)throw Error('router_unavailable');state.bindings.push({id:`*${(next++).toString(16).toUpperCase()}`,macAddress:mac,type:'bypassed',server:'all',comment,disabled:false});},
  async removeBinding(id){state.calls.push(`remove ${id}`);if(options.removeFails)throw Error('router_unavailable');state.bindings=state.bindings.filter(b=>b.id!==id);},
 };
}

test('reconciling a router converges, is idempotent and verifies by re-reading',async()=>{
 const uplink={id:'*1',macAddress:'D4:01:C3:00:00:01',type:'bypassed',server:'all',comment:'K1 management uplink',disabled:false};
 const router=memoryRouter([uplink,tagged(C,'AA:00:00:00:00:0C',{id:'*9'})]);
 const first=await reconcileRouter(router,desired);
 assert.equal(first.status,'synced');assert.equal(first.errorCode,null);
 assert.deepEqual(first.added.map(d=>d.id),[A,B]);assert.deepEqual(first.removed.map(r=>r.entryId),[C]);
 assert.deepEqual(router.state.calls,['read','remove *9','add 02:00:00:00:00:0A','add 3C:22:FB:12:34:56','read']);
 assert.deepEqual(router.state.bindings[0],uplink);
 assert.ok(router.state.bindings.some(b=>b.comment===`pasofi-allowlist:${A} Office printer`));
 router.state.calls.length=0;
 const second=await reconcileRouter(router,desired);
 assert.equal(second.status,'synced');assert.deepEqual(router.state.calls,['read','read']);
 // Removing everything leaves only the operator's binding.
 const cleared=await reconcileRouter(router,[]);
 assert.equal(cleared.status,'synced');assert.deepEqual(router.state.bindings,[uplink]);
});

test('unreachable routers, failed writes and untagged conflicts are reported per router',async()=>{
 const unreachable=await reconcileRouter(memoryRouter([],{unreachable:true}),desired);
 assert.equal(unreachable.status,'unreachable');assert.equal(unreachable.errorCode,'router_unavailable');assert.equal(unreachable.states.size,0);
 const failed=memoryRouter([],{addFails:true}),partial=await reconcileRouter(failed,desired);
 assert.equal(partial.status,'attention');assert.equal(partial.errorCode,'write_failed');assert.equal(partial.states.get(A),'missing');
 const verify=await reconcileRouter(memoryRouter([],{verifyFails:true}),desired);
 assert.equal(verify.status,'unreachable');assert.equal(verify.errorCode,'verification_unavailable');assert.equal(verify.added.length,2);
 const stuck=await reconcileRouter(memoryRouter([tagged(C,'AA:00:00:00:00:0C',{id:'*9'})],{removeFails:true}),[]);
 assert.equal(stuck.status,'attention');assert.equal(stuck.pendingRemovals,1);
 const conflict=memoryRouter([{id:'*7',macAddress:'3C:22:FB:12:34:56',type:'bypassed',server:'all',comment:'manual phone',disabled:false}]);
 const result=await reconcileRouter(conflict,desired);
 assert.equal(result.status,'attention');assert.equal(result.errorCode,'untagged_conflict');assert.equal(result.conflicts,1);
 assert.equal(result.states.get(A),'applied');assert.equal(result.states.get(B),'conflict');
 assert.ok(!conflict.state.calls.includes('remove *7'));assert.equal(conflict.state.bindings[0].comment,'manual phone');
});

test('RouterOS ip-binding requests use the exact REST paths, payload and pinned TLS',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pasofi-allowlist-rest-'));let server;
 try {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:router.invalid,IP:127.0.0.1'],{stdio:'ignore'});
  chmodSync(join(dir,'cert'),0o444);
  const requests=[];let reply=()=>[];
  server=https.createServer({key:readFileSync(join(dir,'key')),cert:readFileSync(join(dir,'cert'))},async(request,response)=>{
   let body='';for await(const chunk of request)body+=chunk;
   const url=new URL(request.url,'https://router.invalid');
   requests.push({method:request.method,path:url.pathname,query:Object.fromEntries(url.searchParams),contentType:request.headers['content-type'],authorization:request.headers.authorization,body:body?JSON.parse(body):null});
   response.setHeader('content-type','application/json');
   if(request.method==='DELETE'){response.writeHead(204);response.end();return;}
   if(request.method==='PUT'){response.end(JSON.stringify({'.id':'*1F',...JSON.parse(body)}));return;}
   response.end(JSON.stringify(reply()));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const router=new RouterOS({nasId:'test',url:`https://router.invalid:${server.address().port}/rest/`,username:'allowlist',password:'test-only-secret',caFile:join(dir,'cert')},
   {resolveHost:async()=>[{address:'127.0.0.1',family:4}],isPrivateAddress:address=>address==='127.0.0.1',allowNonstandardPort:true});
  reply=()=>[{'.id':'*1','mac-address':'D4:01:C3:00:00:01',type:'bypassed',server:'all',comment:'K1 management uplink',disabled:'false'},{'.id':'*2',address:'10.20.0.9',type:'regular',server:'all',disabled:'true'}];
  assert.deepEqual(await router.bindings(),[
   {id:'*1',macAddress:'D4:01:C3:00:00:01',type:'bypassed',server:'all',comment:'K1 management uplink',disabled:false},
   {id:'*2',macAddress:undefined,type:'regular',server:'all',comment:undefined,disabled:true},
  ]);
  assert.deepEqual(requests[0].query,{'.proplist':'.id,mac-address,type,server,comment,disabled'});
  assert.equal(requests[0].path,'/rest/ip/hotspot/ip-binding');assert.equal(requests[0].method,'GET');
  assert.equal(requests[0].authorization,'Basic '+Buffer.from('allowlist:test-only-secret').toString('base64'));
  await router.addBypassBinding('3C:22:FB:12:34:56',bindingComment(A,'Owner phone'));
  assert.deepEqual(requests[1],{method:'PUT',path:'/rest/ip/hotspot/ip-binding',query:{},contentType:'application/json',authorization:requests[0].authorization,
   body:{'mac-address':'3C:22:FB:12:34:56',type:'bypassed',server:'all',comment:`pasofi-allowlist:${A} Owner phone`}});
  await router.removeBinding('*1F');
  assert.equal(requests[2].method,'DELETE');assert.equal(requests[2].path,'/rest/ip/hotspot/ip-binding/*1F');assert.equal(requests[2].body,null);
  // Arbitrary record paths, unsafe payloads and malformed responses never reach or pass the router client.
  const before=requests.length;
  for(const id of ['*1/../../system/reset','1','*','*GG','*1?x=1'])await assert.rejects(router.removeBinding(id),{message:'router_unavailable'});
  for(const [mac,comment] of [['3c:22:fb:12:34:56','x'],['3C:22:FB:12:34:56',''],['3C:22:FB:12:34:56','bad\ncomment'],['3C:22:FB:12:34:56','x'.repeat(256)]])
   await assert.rejects(router.addBypassBinding(mac,comment),{message:'router_unavailable'});
  assert.equal(requests.length,before);
  for(const body of [{error:'x'},[{'.id':'*1/../x'}],[null],[{type:'bypassed'}]]){reply=()=>body;await assert.rejects(router.bindings(),{message:'router_unavailable'});}
 } finally {if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}rmSync(dir,{recursive:true,force:true});}
});
