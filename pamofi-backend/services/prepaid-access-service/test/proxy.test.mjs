import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../dist/app.js';
import {trustedProxyCidrs} from '../dist/proxy.js';

test('proxy configuration requires explicit IP ranges and rejects blanket trust',()=>{
  assert.equal(trustedProxyCidrs(''),false);
  assert.deepEqual(trustedProxyCidrs('10.0.4.0/24, 127.0.0.1, ::1/128'),['10.0.4.0/24','127.0.0.1','::1/128']);
  for (const value of ['*','true','loopback','0.0.0.0/0','::/0','10.0.4.0/33','::/129','10.0.4.1,','10.0.4.1/foo','10.0.4.1/24/1']) assert.throws(()=>trustedProxyCidrs(value),/invalid_trusted_proxy_cidrs/);
});
test('forwarded client rate limits trust only configured proxy hops',async()=>{
  const keys=['DATABASE_URL','PAMOFI_TRUST_PROXY_CIDRS'],saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  delete process.env.DATABASE_URL;process.env.PAMOFI_TRUST_PROXY_CIDRS='10.0.4.0/24';
  const app=buildApp();
  app.after(()=>{app.get('/test/proxy-limit',{config:{rateLimit:{max:2,timeWindow:'1 minute'}}},async request=>({ip:request.ip}));});
  const call=(remoteAddress,forwarded)=>app.inject({url:'/test/proxy-limit',remoteAddress,headers:{'x-forwarded-for':forwarded}});
  try {
    const first=await call('198.51.100.1','203.0.113.1');assert.equal(first.statusCode,200);assert.equal(first.json().ip,'198.51.100.1');
    assert.equal((await call('198.51.100.1','203.0.113.2')).statusCode,200);
    assert.equal((await call('198.51.100.1','203.0.113.3')).statusCode,429);
    const trusted=await call('10.0.4.3','203.0.113.5, 10.0.4.4');assert.equal(trusted.statusCode,200);assert.equal(trusted.json().ip,'203.0.113.5');
    assert.equal((await call('10.0.4.3','203.0.113.6, 10.0.4.4')).statusCode,200);
    assert.equal((await call('10.0.4.3','203.0.113.5, 10.0.4.4')).statusCode,200);
    assert.equal((await call('10.0.4.3','203.0.113.5, 10.0.4.4')).statusCode,429);
    const boundary=await call('10.0.4.3','203.0.113.100, 198.51.100.7');assert.equal(boundary.json().ip,'198.51.100.7');
    // The service's real voucher route also gets the plugin hook; the limit is
    // enforced even while authorization/configuration refuses the requests.
    for(let i=0;i<10;i++)assert.notEqual((await app.inject({method:'POST',url:'/v1/vouchers/redeem',remoteAddress:'198.51.100.99',payload:{code:'invalid'}})).statusCode,429);
    assert.equal((await app.inject({method:'POST',url:'/v1/vouchers/redeem',remoteAddress:'198.51.100.99',payload:{code:'invalid'}})).statusCode,429);
  } finally {await app.close();for (const [key,value] of Object.entries(saved)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
