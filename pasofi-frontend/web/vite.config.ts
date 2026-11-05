import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Server-only targets. Only explicit public customer/staff routes can reach the services.
const rewrite = (path: string) => path.replace(/^\/api\//, '/v1/');
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'PAMOFI_');
  const portal = { ...loadEnv(mode, '.', 'VITE_'), ...process.env }.VITE_PASOFI_HOTSPOT_PORTAL;
  if (portal !== undefined && portal !== '' && portal !== '0' && portal !== '1') throw Error('Invalid hotspot portal build flag');
  const identity = env.PAMOFI_IDENTITY_URL || 'http://localhost:18081';
  const prepaid = env.PAMOFI_PREPAID_URL || 'http://localhost:18082';
  const assistant = env.PAMOFI_ASSISTANT_URL || 'http://localhost:18085';
  const routes: Record<string, { target: string; rewrite: typeof rewrite }> = {
    '^/api/(?:bundles|capabilities|sites|access|usage)(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/help(?:\\?|$)': { target: assistant, rewrite },
    '^/api/session(?:\\?|$)': { target: identity, rewrite },
    '^/api/orders(?:/[0-9a-fA-F-]+/(?:demo-confirm|checkout|status|mock-payment|expire-unused))?(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/(?:customer|staff)/invoices(?:/[0-9a-fA-F-]+(?:/pdf)?)?(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/invoice-downloads(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/recovery(?:/(?:status|setup|rotate))?(?:\\?|$)': { target: identity, rewrite },
    '^/api/handoff(?:/redeem)?(?:\\?|$)': { target: identity, rewrite },
    '^/api/staff/(?:register|login|session|mfa/(?:setup|confirm|verify)|password-reset/(?:availability|request|confirm)|users(?:/[0-9a-fA-F-]+/(?:decision|revoke-sessions|recover-mfa))?|audit)(?:\\?|$)': { target: identity, rewrite },
    '^/api/staff/(?:sites|inventory|cash-refunds(?:/[0-9a-fA-F-]+/(?:prepare-payout|payout))?|cash-shifts(?:/[0-9a-fA-F-]+/close)?|cash-references/lookup|sales(?:/[0-9a-fA-F-]+/(?:receipt|delivery|resend))?)(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/admin/(?:sites|cash-refunds/[0-9a-fA-F-]+/decision|inventory/allocations|network/reviews(?:/[0-9a-fA-F-]+/resolve)?|bundles(?:/[a-z][a-z0-9-]{0,39})?)(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/admin/routers(?:/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:/changes(?:/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:/(?:apply|reconcile|rollback))?)?)?)?(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/receipt-pairings(?:/[0-9a-fA-F-]+(?:/cancel)?)?(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/vouchers/redeem(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/payments/methods(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/network/(?:sites|session|credentials|disconnect)(?:\\?|$)': { target: prepaid, rewrite },
  };
  const allowed = Object.keys(routes).map(pattern => new RegExp(pattern));
  return {
    plugins: [react(), {
      name: 'pasofi-hotspot-build-marker',
      generateBundle() {
        if (portal === '1') this.emitFile({ type: 'asset', fileName: 'hotspot-build.json', source: '{"apiPrefix":"/portal-api"}\n' });
      },
    }, {
      name: 'pamofi-public-api-boundary',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = (request as { url?: string }).url || '';
          if (/^\/api(?:\/|$)/.test(path) && !allowed.some(pattern => pattern.test(path))) {
            response.statusCode = 404; response.setHeader('Content-Type', 'application/json'); response.end('{"error":"not_found"}'); return;
          }
          next();
        });
      },
    }],
    server: { proxy: routes },
  };
});
