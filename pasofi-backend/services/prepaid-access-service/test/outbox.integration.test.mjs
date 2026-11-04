import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { SignJWT } from 'jose';
import { dispatchOnce, replayDeadLetter } from '../dist/outbox.js';
const prepaidUrl=process.env.PAMOFI_TEST_DATABASE_URL, notificationUrl=process.env.PAMOFI_TEST_NOTIFICATION_DATABASE_URL, endpoint=process.env.PAMOFI_TEST_NOTIFICATION_URL;
const secret='DEMO_ONLY_insecure_local_events_secret_123456789';
test('outbox retries and duplicate deliveries create one durable inbox job', {skip:!(prepaidUrl&&notificationUrl&&endpoint)}, async()=>{
 const prepaid=new pg.Pool({connectionString:prepaidUrl,max:3}), notifications=new pg.Pool({connectionString:notificationUrl,max:3});
 const id=randomUUID(), aggregate=randomUUID(), correlation=randomUUID(), actor=randomUUID();
 try {
  const pending=await prepaid.query("SELECT count(*)::int AS count FROM event_outbox WHERE status='pending'");
  assert.equal(pending.rows[0].count,0,'outbox tests require an isolated database with no pending events');
  await prepaid.query("INSERT INTO event_outbox(id,event_type,event_version,aggregate_id,aggregate_version,correlation_id,payload) VALUES ($1,'agent.sale.created',1,$2,1,$3,$4)",[id,aggregate,correlation,JSON.stringify({deliveryReference:aggregate})]);
  assert.equal(await dispatchOnce(prepaid,{endpoint:'http://127.0.0.1:1',secret,demo:true}),'retry');
  let row=(await prepaid.query('SELECT * FROM event_outbox WHERE id=$1',[id])).rows[0];
  assert.equal(row.attempts,1);assert.equal(row.status,'pending');
  await prepaid.query('UPDATE event_outbox SET next_at=now() WHERE id=$1',[id]);
  const badAck=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"accepted":false}');});
  await new Promise(resolve=>badAck.listen(0,'127.0.0.1',resolve));
  try { assert.equal(await dispatchOnce(prepaid,{endpoint:`http://127.0.0.1:${badAck.address().port}`,secret,demo:true}),'retry'); }
  finally { await new Promise(resolve=>badAck.close(resolve)); }
  await prepaid.query('UPDATE event_outbox SET next_at=now() WHERE id=$1',[id]);
  assert.equal(await dispatchOnce(prepaid,{endpoint,secret,demo:true}),'delivered');
  row=(await prepaid.query('SELECT * FROM event_outbox WHERE id=$1',[id])).rows[0];
  assert.equal(row.status,'delivered');
  // Simulate a producer crash or lost acknowledgement after the inbox committed.
  await prepaid.query("UPDATE event_outbox SET status='pending',dispatched_at=NULL,next_at=now() WHERE id=$1",[id]);
  assert.equal(await dispatchOnce(prepaid,{endpoint,secret,demo:true}),'delivered');
  const inbox=await notifications.query('SELECT * FROM event_inbox WHERE id=$1',[id]);
  const jobs=await notifications.query('SELECT * FROM delivery_jobs WHERE event_id=$1',[id]);
  assert.equal(inbox.rowCount,1);assert.equal(jobs.rowCount,1);assert.equal(jobs.rows[0].state,'awaiting_delivery_details');
  const token=await new SignJWT({scope:'event:deliver'}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('notification').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
  const event={id,type:'agent.sale.created',version:1,producer:'prepaid-access',aggregateId:aggregate,aggregateVersion:1,occurredAt:row.occurred_at.toISOString(),correlationId:correlation,payload:{deliveryReference:aggregate}};
  const send=body=>fetch(`${endpoint}/internal/v1/events`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const unauthenticated=await fetch(`${endpoint}/internal/v1/events`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event)});
  assert.equal(unauthenticated.status,401);
  const copies=await Promise.all(Array.from({length:6},()=>send(event)));
  assert.ok(copies.every(r=>r.status===200));
  assert.equal((await send({...event,correlationId:randomUUID()})).status,409);
  assert.equal((await send({...event,id:randomUUID()})).status,409);
  assert.equal((await send({...event,aggregateVersion:2})).status,400);
  await prepaid.query("UPDATE event_outbox SET status='pending',attempts=9,next_at=now() WHERE id=$1",[id]);
  assert.equal(await dispatchOnce(prepaid,{endpoint:'http://127.0.0.1:1',secret,demo:true}),'dead');
  await assert.rejects(replayDeadLetter(prepaid,id,actor,'short'));
  assert.equal(await replayDeadLetter(prepaid,id,actor,'Retry after investigating delivery failure'),true);
  assert.equal((await prepaid.query('SELECT * FROM outbox_replay_audit WHERE event_id=$1',[id])).rowCount,1);
 } finally {
  await notifications.query('DELETE FROM delivery_jobs WHERE event_id=$1',[id]);
  await notifications.query('DELETE FROM event_inbox WHERE id=$1',[id]);
  await prepaid.query('DELETE FROM outbox_replay_audit WHERE event_id=$1',[id]);
  await prepaid.query('DELETE FROM event_outbox WHERE id=$1',[id]);
  await Promise.all([prepaid.end(),notifications.end()]);
 }
});
