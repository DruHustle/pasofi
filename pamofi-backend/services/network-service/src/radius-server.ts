import { readFileSync } from 'node:fs';
import pg from 'pg';
import { buildRadiusApp } from './radius-app.js';

// Separate private HTTPS listener. The main network-service health endpoint
// remains independent. Production startup is deliberately disabled for now.
function required(name:string):string {
 const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;
}
const pool=new pg.Pool({connectionString:required('DATABASE_URL'),max:3,connectionTimeoutMillis:2000});
try {
 const app=buildRadiusApp({pool,tls:{ca:readFileSync(required('RADIUS_CA_FILE')),cert:readFileSync(required('RADIUS_SERVER_CERT_FILE')),key:readFileSync(required('RADIUS_SERVER_KEY_FILE'))},clientFingerprint:required('RADIUS_CLIENT_FINGERPRINT'),prepaidUrl:required('PREPAID_URL'),networkSecret:required('INTERNAL_NETWORK_SECRET')});
 app.addHook('onClose',async()=>pool.end());
 await app.listen({host:process.env.RADIUS_LISTEN_HOST || '127.0.0.1',port:Number(process.env.RADIUS_LISTEN_PORT || 3443)});
} catch(error) { await pool.end();console.error('RADIUS lab failed to start');process.exitCode=1; }
