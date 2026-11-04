import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const url=process.env.PAMOFI_TEST_DATABASE_URL;
test('SIGTERM closes the service and outbox worker cleanly',{skip:!url,timeout:15000},async()=>{
 const reservation=createServer();
 await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const port=reservation.address().port;
 await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/server.js',import.meta.url))],{
  env:{...process.env,DATABASE_URL:url,HOST:'127.0.0.1',PORT:String(port),APP_ENV:'demo',NODE_ENV:'development',OUTBOX_DISPATCH_ENABLED:'true',INTERNAL_EVENTS_SECRET:'test_only_events_key_at_least_32_bytes',NOTIFICATION_URL:'http://127.0.0.1:1',PAMOFI_PESEPAY_SANDBOX_ENABLED:'false'},
  stdio:['ignore','ignore','pipe']
 });
 let stderr='';child.stderr.on('data',data=>{stderr+=data.toString();});
 const ended=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try {
  let ready=false;
  const deadline=Date.now()+5000;
  while(Date.now()<deadline && child.exitCode===null) {
   try {ready=(await fetch(`http://127.0.0.1:${port}/health/ready`,{signal:AbortSignal.timeout(500)})).ok;}catch{}
   if(ready)break;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(ready,`Test service did not start: ${stderr}`);
  child.kill('SIGTERM');
  let timer;
  const stopped=await Promise.race([ended,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Graceful shutdown did not finish')),5000);})]).finally(()=>clearTimeout(timer));
  assert.deepEqual(stopped,{code:0,signal:null},stderr);
 } finally {
  if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
  await ended;
 }
});
