import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRecords,checkContainers,checkBackup,queueQueries,aggregateProgram,checkHttpsOrigins} from './check.mjs';
const services=['postgres','identity','prepaid-access','network','notification','assistant','web','gateway','internal-gateway'];
const healthy=()=>services.map(Service=>({Service,State:'running',Health:'healthy',Publishers:Service==='gateway'?[{Protocol:'tcp',TargetPort:443,PublishedPort:443}]:null}));

test('monitor accepts current JSON Lines and older arrays, and fails missing, unhealthy or exposed private services',()=>{
 const rows=healthy();assert.deepEqual(parseRecords(JSON.stringify(rows)),rows);assert.deepEqual(parseRecords(rows.map(row=>JSON.stringify(row)).join('\n')),rows);assert.deepEqual(checkContainers(rows).problems,[]);
 assert.ok(checkContainers(rows.filter(row=>row.Service!=='prepaid-access')).problems.includes('prepaid-access:missing_or_duplicate'));
 const bad=healthy();bad.find(row=>row.Service==='identity').Health='unhealthy';bad.find(row=>row.Service==='postgres').Publishers=[{Protocol:'tcp',TargetPort:5432,PublishedPort:5432}];
 const problems=checkContainers(bad).problems;assert.ok(problems.includes('identity:not_ready'));assert.ok(problems.includes('postgres:unexpected_published_port'));
 assert.throws(()=>parseRecords('{malformed'));
});

test('backup diagnostic rejects missing, failed, stale and future evidence',()=>{
 const now=1800000000,stanza=stop=>[{name:'pamofi',status:{code:0},backup:[{timestamp:{stop}}]}];
 assert.equal(checkBackup(stanza(now-3600),{now}).ok,true);
 assert.equal(checkBackup(stanza(now-31*3600),{now}).ok,false);
 assert.equal(checkBackup(stanza(now+120),{now}).ok,false);
 assert.equal(checkBackup([],{now}).ok,false);
 assert.equal(checkBackup([{name:'pamofi',status:{code:2},backup:[{timestamp:{stop:now}}]}],{now}).ok,false);
 assert.equal(checkBackup([{name:'pamofi',status:{code:0},backup:[{error:true,timestamp:{stop:now}}]}],{now}).ok,false);
});

test('aggregate programs enforce read-only bounded queries and never select customer payloads',()=>{
 for(const query of Object.values(queueQueries)){
  assert.match(query,/^SELECT/);assert.doesNotMatch(query,/SELECT\s+\*|UPDATE |DELETE |INSERT |voucher_code|phone|secret/i);
  const program=aggregateProgram(query);assert.match(program,/BEGIN READ ONLY/);assert.match(program,/statement_timeout:3000/);assert.match(program,/DATABASE_URL_FILE/);
 }
});

const radiusBind='10.78.0.1';
function withRadius(){return [...healthy(),{Service:'radius',State:'running',Publishers:[1812,1813].map(port=>({Protocol:'udp',TargetPort:port,PublishedPort:port,URL:radiusBind}))},{Service:'radius-api',State:'running',Health:'healthy',Publishers:null}];}

test('production RADIUS monitoring requires explicit private binding and both services',()=>{
 assert.deepEqual(checkContainers(withRadius(),{radiusBind}).problems,[]);
 assert.ok(checkContainers(withRadius()).problems.includes('radius:unexpected_published_port'));
 assert.ok(checkContainers(withRadius().filter(row=>row.Service!=='radius-api'),{radiusBind}).problems.includes('radius-api:missing_or_duplicate'));
 const unhealthy=withRadius();unhealthy.find(row=>row.Service==='radius-api').Health='unhealthy';
 assert.ok(checkContainers(unhealthy,{radiusBind}).problems.includes('radius-api:not_ready'));
 for(const invalid of ['0.0.0.0','127.0.0.1','203.0.113.2','100.64.0.1','::1','10.0.0.1/32','10.0.0.1,10.0.0.2'])assert.throws(()=>checkContainers(withRadius(),{radiusBind:invalid}));
});

test('RADIUS monitor rejects public or wrong binds, wrong protocols/ports and an exposed authority',()=>{
 for(const patch of [{URL:'0.0.0.0'},{URL:'::'},{URL:'198.51.100.1'},{URL:'10.78.0.2'},{URL:undefined},{Protocol:'tcp'},{PublishedPort:9999},{TargetPort:3799}]){
  const rows=withRadius();Object.assign(rows.find(row=>row.Service==='radius').Publishers[0],patch);
  assert.ok(checkContainers(rows,{radiusBind}).problems.includes('radius:unexpected_published_port'),JSON.stringify(patch));
 }
 const missing=withRadius();missing.find(row=>row.Service==='radius').Publishers.pop();
 assert.ok(checkContainers(missing,{radiusBind}).problems.includes('radius:private_binding_missing_or_invalid'));
 const exposed=withRadius();exposed.find(row=>row.Service==='radius-api').Publishers=[{Protocol:'tcp',TargetPort:3443,PublishedPort:3443,URL:radiusBind}];
 assert.ok(checkContainers(exposed,{radiusBind}).problems.includes('radius-api:unexpected_published_port'));
});

function httpsFixture({split=true,change}={}){
 const calls=[];
 return {calls,fetcher:async(url,options)=>{
  calls.push({url:String(url),options});
  assert.equal(options.redirect,'error');assert.ok(options.signal);assert.equal(options.headers,undefined);
  const status=url.pathname==='/health/live'?200:url.pathname==='/api/session'?(split&&url.hostname==='api.pamofi.test'?403:401):404;
  const headers={'content-type':'application/json; charset=utf-8'};
  const result={status,headers};change?.(url,result);
  return new Response(JSON.stringify({error:'fixture'}),result);
 }};
}

test('split HTTPS diagnostic separately proves Oracle rejection and frontend anonymous privacy',async()=>{
 const fixture=httpsFixture();
 assert.deepEqual(await checkHttpsOrigins({gatewayOrigin:'https://api.pamofi.test',frontendOrigin:'https://pamofi.test',fetcher:fixture.fetcher}),{ok:true,split:true});
 assert.equal(fixture.calls.length,6);
 assert.equal(fixture.calls.filter(call=>new URL(call.url).hostname==='api.pamofi.test').length,4);
 assert.equal(fixture.calls.filter(call=>new URL(call.url).hostname==='pamofi.test').length,2);
 const old=httpsFixture({split:false});
 assert.deepEqual(await checkHttpsOrigins({gatewayOrigin:'https://pamofi.test',fetcher:old.fetcher}),{ok:true,split:false});
 assert.equal(old.calls.length,4);
});

test('HTTPS diagnostic rejects accidental direct access, SPA fallback and manufactured cookies',async()=>{
 const mutations=[
  (url,result)=>{if(url.hostname==='api.pamofi.test'&&url.pathname==='/api/session')result.status=401;},
  (url,result)=>{if(url.hostname==='pamofi.test'&&url.pathname==='/api/session')result.status=200;},
  (url,result)=>{if(url.hostname==='pamofi.test')result.headers['content-type']='text/html';},
  (url,result)=>{if(url.pathname==='/api/session')result.headers['set-cookie']='__Host-pamofi_session=unexpected; Secure; Path=/';},
 ];
 for(const change of mutations){const fixture=httpsFixture({change});assert.equal((await checkHttpsOrigins({gatewayOrigin:'https://api.pamofi.test',frontendOrigin:'https://pamofi.test',fetcher:fixture.fetcher})).ok,false);}
 const failed=await checkHttpsOrigins({gatewayOrigin:'https://api.pamofi.test',frontendOrigin:'https://pamofi.test',fetcher:async()=>{throw Error('fixture_tls_failure');}});
 assert.equal(failed.problem,'public_https:contract_unavailable');
});

test('monitor refuses credentialed, insecure or non-origin URLs before network access',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error('unexpected');};
 for(const value of ['http://api.pamofi.test','https://user:secret@api.pamofi.test','https://api.pamofi.test/api','https://api.pamofi.test/?key=secret','https://api.pamofi.test/#secret']){
  await assert.rejects(checkHttpsOrigins({gatewayOrigin:value,fetcher}));
  await assert.rejects(checkHttpsOrigins({gatewayOrigin:'https://api.pamofi.test',frontendOrigin:value,fetcher}));
 }
 assert.equal(calls,0);
});
