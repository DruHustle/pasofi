import { readFileSync } from 'node:fs';
import pg from 'pg';
import { buildRadiusApp } from './radius-app.js';

// Separate private mutual-TLS listener. Production requires an explicit
// qualification flag, HTTPS ledger transport, and configured trust anchors.
function required(name:string):string {
 const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;
}
const pool=new pg.Pool({connectionString:required('DATABASE_URL'),max:3,connectionTimeoutMillis:2000});
pool.on('error',()=>console.error('network-radius: database idle connection lost'));
try {
 const app=buildRadiusApp({pool,tls:{ca:readFileSync(required('RADIUS_CA_FILE')),cert:readFileSync(required('RADIUS_SERVER_CERT_FILE')),key:readFileSync(required('RADIUS_SERVER_KEY_FILE'))},clientFingerprint:required('RADIUS_CLIENT_FINGERPRINT'),prepaidUrl:required('PREPAID_URL'),networkSecret:required('INTERNAL_NETWORK_SECRET')});
 app.addHook('onClose',async()=>pool.end());
 let stopping=false;
 const shutdown=()=>{
  if(stopping)return;stopping=true;
  const deadline=setTimeout(()=>{console.error('RADIUS shutdown timed out');process.exit(1);},10000);deadline.unref();
  void app.close().catch(()=>{console.error('RADIUS shutdown failed');process.exitCode=1;}).finally(()=>clearTimeout(deadline));
 };
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
 await app.listen({host:process.env.RADIUS_LISTEN_HOST || '127.0.0.1',port:Number(process.env.RADIUS_LISTEN_PORT || 3443)});
} catch(error) { await pool.end();console.error('RADIUS service failed to start');process.exitCode=1; }
