import Fastify from 'fastify';
import pg from 'pg';
const { Pool } = pg;
export function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 }) : null;
  app.addHook('onClose', async () => { if (pool) await pool.end(); });
  app.get('/health/live', async () => ({ status: 'ok', service: 'prepaid-access' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!pool) return reply.code(503).send({ status: 'not_ready' });
    try { await pool.query('SELECT 1'); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  app.get('/v1/bundles', async (_request, reply) => {
    if (!pool) return reply.code(503).send({ error: 'catalogue_unavailable' });
    try {
      const result = await pool.query("SELECT id, price_minor, currency, byte_limit::text, validity_seconds FROM bundle_versions WHERE published = true ORDER BY price_minor");
      return { products: result.rows, candidate: true };
    } catch { return reply.code(503).send({ error: 'catalogue_unavailable' }); }
  });
  return app;
}
