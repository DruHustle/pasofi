import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRecords,checkContainers,checkBackup,queueQueries,aggregateProgram} from './check.mjs';
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
