import { buildApp } from './app.js';
import { dispatchOnce } from './outbox.js';
import pg from 'pg';
const app = buildApp();
if (process.env.OUTBOX_DISPATCH_ENABLED === 'true') {
  const { DATABASE_URL, INTERNAL_EVENTS_SECRET, NOTIFICATION_URL } = process.env;
  if (!DATABASE_URL || !INTERNAL_EVENTS_SECRET || !NOTIFICATION_URL) throw new Error('Outbox dispatcher configuration is incomplete');
  const pool = new pg.Pool({ connectionString:DATABASE_URL, max:1, connectionTimeoutMillis:2000 });
  const config = { endpoint:NOTIFICATION_URL, secret:INTERNAL_EVENTS_SECRET, demo:process.env.APP_ENV==='demo' && process.env.NODE_ENV==='development' };
  let inflight:Promise<void>|null = null;
  const timer=setInterval(()=>{
    if(inflight) return;
    inflight=(async()=>{
      try { for(let i=0;i<10;i++) if(await dispatchOnce(pool,config)==='idle') break; }
      catch { console.error('Outbox dispatcher unavailable'); }
    })().finally(()=>{inflight=null;});
  },1000);
  timer.unref();
  app.addHook('onClose',async()=>{clearInterval(timer);if(inflight) await inflight;await pool.end();});
}
try { await app.listen({ host:process.env.HOST || '0.0.0.0', port:Number(process.env.PORT || 3000) }); }
catch(error) { console.error(error); process.exit(1); }
