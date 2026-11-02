import { buildApp } from './app.js';
const app = buildApp();
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => { console.error('notification shutdown timed out'); process.exit(1); }, 10_000);
  deadline.unref();
  void app.close().catch(() => { console.error('notification shutdown failed'); process.exitCode = 1; })
    .finally(() => { clearTimeout(deadline); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try { await app.listen({ host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 3000) }); }
catch { console.error('notification failed to start'); process.exit(1); }
