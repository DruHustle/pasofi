import Fastify from 'fastify';
import pg from 'pg';
import {registerNetworkInternal} from './internal.js';
import {startReconciler} from './reconciler.js';
import {registerRouterFleet} from './fleet.js';
const { Pool } = pg;
export function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 }) : null;
  // pg discards the broken idle connection; handling its error keeps the
  // service alive so readiness and later requests can recover. Never log DSNs.
  pool?.on('error', () => console.error('network: database idle connection lost'));
  app.addHook('onClose', async () => { if (pool) await pool.end(); });
  app.get('/health/live', async () => ({ status: 'ok', service: 'network' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!pool) return reply.code(503).send({ status: 'not_ready' });
    try { await pool.query('SELECT 1'); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');return payload;});
  registerNetworkInternal(app,pool);
  registerRouterFleet(app,pool);
  if(pool&&process.env.NETWORK_RECONCILER_ENABLED==='true') {
    const stop=startReconciler(pool);app.addHook('preClose',stop);
  }
  return app;
}
