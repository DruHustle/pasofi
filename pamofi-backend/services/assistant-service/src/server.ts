import { buildApp } from './app.js';
const app = buildApp();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  void app.close().catch(() => { console.error('Assistant shutdown failed'); process.exitCode = 1; });
});
try { await app.listen({ host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 3000) }); } catch (error) { console.error(error); process.exit(1); }
