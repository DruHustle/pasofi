import { buildEmailRelayApp } from './email-relay-app.js';

const app = buildEmailRelayApp();
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => { console.error('email relay shutdown timed out'); process.exit(1); }, 10000);
  deadline.unref();
  void app.close().catch(() => { console.error('email relay shutdown failed'); process.exitCode = 1; })
    .finally(() => { clearTimeout(deadline); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try { await app.listen({ host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 10000) }); }
catch { console.error('email relay failed to start'); process.exit(1); }
