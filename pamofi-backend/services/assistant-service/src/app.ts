import Fastify from 'fastify';
import pg from 'pg';
import { findHelp } from './help.js';
const { Pool } = pg;
export function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 }) : null;
  // pg removes the failed idle client; handling the event keeps the process alive.
  pool?.on('error', () => { console.error('Assistant database connection interrupted'); });
  app.addHook('onClose', async () => { if (pool) await pool.end(); });
  app.get('/health/live', async () => ({ status: 'ok', service: 'assistant' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!pool) return reply.code(503).send({ status: 'not_ready' });
    try { await pool.query('SELECT 1'); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  app.get<{ Querystring: { q?: string } }>('/v1/help', {
    schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 200 } } } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { version: 1, mode: 'reviewed-faq', articles: findHelp(request.query.q),
      notice: 'Reviewed guidance only. No payments, account changes or network actions.' };
  });
  return app;
}
