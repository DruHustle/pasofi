import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {SignJWT} from 'jose';
import {buildApp} from '../dist/app.js';
import {safeLoginUrl} from '../dist/internal.js';
const url=process.env.PAMOFI_TEST_NETWORK_DATABASE_URL;

test('customer credential boundary scopes tokens, rejects unregistered sites and rotates delivery keys safely',{skip:!url},async()=>{
 const previous={...process.env},secret=randomBytes(32).toString('hex'),key=randomBytes(32).toString('hex');
 Object.assign(process.env,{DATABASE_URL:url,APP_ENV:'demo',NODE_ENV:'development',INTERNAL_RADIUS_ENABLED:'true',PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',INTERNAL_NETWORK_SECRET:secret,RADIUS_CREDENTIAL_KEY_VERSION:'1',RADIUS_CREDENTIAL_KEYS:JSON.stringify({'1':key})});
 const pool=new pg.Pool({connectionString:url}),site=randomUUID(),nas=randomUUID(),customerId=randomUUID(),requestKey=randomUUID(),app=buildApp();
 const token=scope=>new SignJWT({scope}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
 try {
  await pool.query("INSERT INTO radius_nas(id,site_id,client_name,enabled,site_name,login_url) VALUES($1,$2,$3,true,'Test site','https://hotspot.example/login')",[nas,site,'test_'+nas.replaceAll('-','')]);
  assert.equal((await app.inject({url:'/internal/v1/network/sites'})).statusCode,401);
  assert.equal((await app.inject({url:'/internal/v1/network/sites',headers:{authorization:'Bearer '+await token('network:credentials')}})).statusCode,403);
  const sites=await app.inject({url:'/internal/v1/network/sites',headers:{authorization:'Bearer '+await token('network:sites')}});
  assert.equal(sites.statusCode,200);assert.ok(sites.json().sites.some(s=>s.id===site&&s.loginUrl==='https://hotspot.example/login'));assert.equal(sites.headers['cache-control'],'no-store');
  const headers={authorization:'Bearer '+await token('network:credentials')};
  const send=payload=>app.inject({method:'POST',url:'/internal/v1/network/credentials',headers,payload});
  assert.equal((await send({customerId,siteId:randomUUID(),requestKey})).statusCode,409);
  const first=await send({customerId,siteId:site,requestKey});assert.equal(first.statusCode,200);assert.match(first.json().password,/^[A-Za-z0-9_-]{43}$/);
  process.env.RADIUS_CREDENTIAL_KEY_VERSION='2';process.env.RADIUS_CREDENTIAL_KEYS=JSON.stringify({'1':key,'2':randomBytes(32).toString('hex')});
  const retry=await send({customerId,siteId:site,requestKey});assert.equal(retry.statusCode,200);assert.deepEqual(retry.json(),first.json());
  process.env.RADIUS_CREDENTIAL_KEYS=JSON.stringify({'2':randomBytes(32).toString('hex')});
  assert.equal((await send({customerId,siteId:site,requestKey})).statusCode,503);
  assert.equal(safeLoginUrl('https://hotspot.example/login?password=secret'),null);assert.equal(safeLoginUrl('javascript:alert(1)'),null);
  await pool.query('UPDATE radius_nas SET enabled=false WHERE id=$1',[nas]);assert.equal((await send({customerId,siteId:site,requestKey:randomUUID()})).statusCode,409);
 } finally {
  await app.close();await pool.query('DELETE FROM radius_credentials WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM radius_nas WHERE id=$1',[nas]);await pool.end();
  for(const name of ['DATABASE_URL','APP_ENV','NODE_ENV','INTERNAL_RADIUS_ENABLED','PAMOFI_CUSTOMER_NETWORK_ENABLED','INTERNAL_NETWORK_SECRET','RADIUS_CREDENTIAL_KEY_VERSION','RADIUS_CREDENTIAL_KEYS']){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
 }
});

test('same-site gateways require exact selection while an owned legacy retry stays on its original NAS',{skip:!url},async()=>{
 const previous={...process.env},secret=randomBytes(32).toString('hex'),key=randomBytes(32).toString('hex');
 Object.assign(process.env,{DATABASE_URL:url,APP_ENV:'demo',NODE_ENV:'development',INTERNAL_RADIUS_ENABLED:'true',PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',INTERNAL_NETWORK_SECRET:secret,RADIUS_CREDENTIAL_KEY_VERSION:'1',RADIUS_CREDENTIAL_KEYS:JSON.stringify({'1':key})});
 const pool=new pg.Pool({connectionString:url}),site=randomUUID(),otherSite=randomUUID(),customerId=randomUUID(),originalKey=randomUUID();
 const [firstNas,secondNas,otherNas,disabledNas,unsafeNas]=Array.from({length:5},()=>randomUUID());
 const allNas=[firstNas,secondNas,otherNas,disabledNas,unsafeNas],app=buildApp();
 const token=scope=>new SignJWT({scope}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
 const register=(nas,selectedSite,enabled,loginUrl)=>pool.query('INSERT INTO radius_nas(id,site_id,client_name,enabled,site_name,login_url) VALUES($1,$2,$3,$4,$5,$6)',[nas,selectedSite,`test_${nas.replaceAll('-','')}`,enabled,'Shared test location',loginUrl]);
 try {
  await register(firstNas,site,true,'https://first.example.test/login');
  const headers={authorization:'Bearer '+await token('network:credentials')};
  const send=(body,override=headers)=>app.inject({method:'POST',url:'/internal/v1/network/credentials',headers:override,payload:{customerId,siteId:site,requestKey:randomUUID(),...body}});
  const original=await send({requestKey:originalKey});assert.equal(original.statusCode,200);
  assert.equal(original.json().nasId,firstNas);assert.equal(original.json().siteId,site);
  await register(secondNas,site,true,'https://second.example.test/login');
  await register(otherNas,otherSite,true,'https://other.example.test/login');
  await register(disabledNas,site,false,'https://disabled.example.test/login');
  await register(unsafeNas,site,true,'https://unsafe.example.test/login?untrusted=value');
  const listed=await app.inject({url:'/internal/v1/network/sites',headers:{authorization:'Bearer '+await token('network:sites')}});
  assert.equal(listed.statusCode,200);
  assert.equal(listed.json().sites.some(item=>item.id===site),false);
  assert.ok(listed.json().sites.some(item=>item.id===otherSite));
  assert.deepEqual(new Set(listed.json().accessPoints.filter(item=>item.siteId===site).map(item=>item.nasId)),new Set([firstNas,secondNas]));
  assert.equal((await send({})).json().error,'nas_selection_required');
  const legacyRetry=await send({requestKey:originalKey});assert.equal(legacyRetry.statusCode,200);assert.deepEqual(legacyRetry.json(),original.json());
  const explicitKey=randomUUID(),selected=await send({nasId:secondNas,requestKey:explicitKey});
  assert.equal(selected.statusCode,200);assert.equal(selected.json().nasId,secondNas);assert.equal(selected.json().siteId,site);assert.equal(selected.json().loginUrl,'https://second.example.test/login');
  const retry=await send({nasId:secondNas,requestKey:explicitKey});assert.deepEqual(retry.json(),selected.json());
  assert.equal((await send({nasId:firstNas,requestKey:explicitKey})).json().error,'idempotency_conflict');
  const stored=await pool.query('SELECT nas_id FROM radius_credentials WHERE customer_id=$1 AND request_key=$2',[customerId,explicitKey]);
  assert.equal(stored.rowCount,1);assert.equal(stored.rows[0].nas_id,secondNas);
  assert.equal((await send({nasId:secondNas},{})).statusCode,401);
  assert.equal((await send({nasId:secondNas},{authorization:'Bearer '+await token('network:sites')})).statusCode,403);
  for(const body of [{nasId:otherNas},{nasId:disabledNas},{nasId:unsafeNas},{nasId:randomUUID()},{nasId:firstNas,siteId:otherSite}]){
   const denied=await send(body);assert.equal(denied.statusCode,409);assert.equal(denied.json().error,'nas_unavailable');
  }
  assert.equal((await pool.query('SELECT count(*)::int AS total FROM radius_credentials WHERE customer_id=$1',[customerId])).rows[0].total,2);
  await pool.query('UPDATE radius_nas SET enabled=false WHERE id=$1',[firstNas]);
  const fenced=await send({requestKey:originalKey});assert.equal(fenced.statusCode,409);assert.equal(fenced.json().error,'credential_expired');
 } finally {
  await app.close();await pool.query('DELETE FROM radius_credentials WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM radius_nas WHERE id=ANY($1::uuid[])',[allNas]);await pool.end();
  for(const name of ['DATABASE_URL','APP_ENV','NODE_ENV','INTERNAL_RADIUS_ENABLED','PAMOFI_CUSTOMER_NETWORK_ENABLED','INTERNAL_NETWORK_SECRET','RADIUS_CREDENTIAL_KEY_VERSION','RADIUS_CREDENTIAL_KEYS']){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
 }
});
