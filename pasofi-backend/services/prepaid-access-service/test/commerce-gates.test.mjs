import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../dist/app.js';

test('SMS capability requires a working dispatch configuration and compatible delivery mode',async t=>{
  const env={DATABASE_URL:'',APP_ENV:'demo',NODE_ENV:'development',PAMOFI_PAYMENTS_ENABLED:'false',PAMOFI_PESEPAY_SANDBOX_ENABLED:'false',PAMOFI_COMMERCE_ENABLED:'true',PAMOFI_AGENT_COMMISSION_BPS:'0',VOUCHER_DELIVERY_ACTIVE_KEY_ID:'test',VOUCHER_DELIVERY_KEYS_JSON:JSON.stringify({test:Buffer.alloc(32,1).toString('base64')}),PAMOFI_SMS_DELIVERY_ENABLED:'true',OUTBOX_DISPATCH_ENABLED:'false',INTERNAL_EVENTS_SECRET:'',NOTIFICATION_URL:'http://notification.test',INTERNAL_DELIVERY_SECRET:'test_delivery_secret_at_least_32_bytes'};
  const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
  let capability={enabled:true,mode:'mock',simulation:true},lookups=0;
  t.mock.method(globalThis,'fetch',async()=>{lookups++;return new Response(JSON.stringify(capability),{headers:{'content-type':'application/json'}});});
  async function read(changes={}){Object.assign(process.env,env,changes);const app=buildApp();try{return (await app.inject({url:'/v1/capabilities'})).json();}finally{await app.close();}}
  try {
    assert.equal((await read()).deliverySms,false);assert.equal(lookups,0);
    assert.equal((await read({OUTBOX_DISPATCH_ENABLED:'true'})).deliverySms,false);assert.equal(lookups,0);
    const dispatch={OUTBOX_DISPATCH_ENABLED:'true',INTERNAL_EVENTS_SECRET:'test_event_secret_at_least_32_bytes'};
    assert.equal((await read(dispatch)).deliverySms,true);assert.equal(lookups,1);
    capability={enabled:false,mode:'disabled',simulation:false};assert.equal((await read(dispatch)).deliverySms,false);
    capability={enabled:true,mode:'sendai',simulation:false};assert.equal((await read(dispatch)).deliverySms,false);
    assert.equal((await read({...dispatch,PAMOFI_COMMERCE_ENABLED:'false'})).staffSales,false);
  } finally {for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
