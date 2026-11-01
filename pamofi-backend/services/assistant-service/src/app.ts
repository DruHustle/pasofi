import Fastify from 'fastify';
import pg from 'pg';
const { Pool } = pg;
export function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 }) : null;
  app.addHook('onClose', async () => { if (pool) await pool.end(); });
  app.get('/health/live', async () => ({ status: 'ok', service: 'assistant' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!pool) return reply.code(503).send({ status: 'not_ready' });
    try { await pool.query('SELECT 1'); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  app.get('/v1/help', async () => ({ version: 1, articles: [
    { question: 'When does my bundle start?', answer: 'Time starts when you first connect successfully. It ends when the time or data runs out.' },
    { question: 'What counts towards my data?', answer: 'Both uploads and downloads count. One GB is 1,000,000,000 bytes.' },
    { question: 'Can I use my bundle at either site?', answer: 'The intended service supports use at either PamoFi site, with one active connection per customer.' },
    { question: 'What if my payment is pending?', answer: 'Check the existing payment before trying again. Payment confirmation does not itself mean you are connected.' },
    { question: 'How do top-ups work?', answer: 'Top-ups wait in a queue; they do not reset the current bundle. Each purchase has a start-by deadline.' }
  ] }));
  return app;
}
