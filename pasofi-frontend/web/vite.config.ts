import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

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
    '^/api/onesa/(?:availability|start|complete|native-session)(?:\\?|$)': { target: identity, rewrite },
    '^/api/orders(?:/[0-9a-fA-F-]+/(?:demo-confirm|checkout|status|mock-payment|expire-unused))?(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/(?:customer|staff)/invoices(?:/[0-9a-fA-F-]+(?:/(?:pdf|resend))?)?(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/invoice-downloads(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/recovery(?:/(?:status|setup|rotate))?(?:\\?|$)': { target: identity, rewrite },
    '^/api/handoff(?:/redeem)?(?:\\?|$)': { target: identity, rewrite },
    '^/api/staff/(?:register|login|session|onesa/(?:availability|start|complete)|mfa/(?:setup|confirm|verify)|password-reset/(?:availability|request|confirm)|users(?:/[0-9a-fA-F-]+/(?:decision|revoke-sessions|recover-mfa))?|audit)(?:\\?|$)': { target: identity, rewrite },
    '^/api/staff/(?:sites|inventory|cash-refunds(?:/[0-9a-fA-F-]+/(?:prepare-payout|payout))?|cash-shifts(?:/[0-9a-fA-F-]+/close)?|cash-references/lookup|sales(?:/[0-9a-fA-F-]+/(?:receipt|delivery|resend))?)(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/admin/(?:sites(?:/[0-9a-fA-F-]+)?|cash-refunds/[0-9a-fA-F-]+/decision|inventory/allocations|network/reviews(?:/[0-9a-fA-F-]+/resolve)?|bundles(?:/[a-z][a-z0-9-]{0,39})?)(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/admin/routers(?:/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:/changes(?:/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:/(?:apply|reconcile|rollback))?)?)?)?(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/receipt-pairings(?:/[0-9a-fA-F-]+(?:/cancel)?)?(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/vouchers/redeem(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/payments/methods(?:\\?|$)': { target: prepaid, rewrite },
    '^/api/network/(?:sites|session|credentials|disconnect)(?:\\?|$)': { target: prepaid, rewrite },
  };
  const allowed = Object.keys(routes).map(pattern => new RegExp(pattern));
  return {
    plugins: [react(), {
      name: 'pasofi-native-link-associations',
      generateBundle() {
        if (portal === '1') return;
        const ios = process.env.PASOFI_ASSOCIATED_IOS_APP_ID;
        const android = process.env.PASOFI_ANDROID_APP_LINK_CERT_SHA256;
        if (ios) {
          if (!/^[A-Z0-9]{10}\.com\.onesa\.pasofi$/.test(ios)) throw Error('Invalid PasoFi iOS app identifier');
          this.emitFile({ type: 'asset', fileName: '.well-known/apple-app-site-association', source: JSON.stringify({
            applinks: { details: [{ appIDs: [ios], components: [{ '/': '/native/onesa-callback.html' }] }] },
            webcredentials: { apps: [ios] },
          }) });
        }
        if (android) {
          const certificates = android.split(',').map(value => value.trim().toUpperCase());
          if (certificates.length > 5 || new Set(certificates).size !== certificates.length ||
              !certificates.every(value => /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value))) throw Error('Invalid PasoFi Android app signing fingerprints');
          this.emitFile({ type: 'asset', fileName: '.well-known/assetlinks.json', source: JSON.stringify([{
            relation: ['delegate_permission/common.handle_all_urls'], target: {
              namespace: 'android_app', package_name: 'com.onesa.pasofi', sha256_cert_fingerprints: certificates,
            },
          }]) });
        }
      },
    }, {
      name: 'pasofi-hotspot-build-marker',
      generateBundle() {
        if (portal !== '1') return;
        this.emitFile({ type: 'asset', fileName: 'hotspot-build.json', source: '{"apiPrefix":"/portal-api"}\n' });
        const callback = readFileSync(new URL('./public/onesa-callback.html', import.meta.url), 'utf8');
        const script = 'src="/onesa-callback.js"';
        if (callback.split(script).length !== 2) throw Error('Expected exactly one PasoFi callback script');
        this.emitFile({
          type: 'asset',
          fileName: 'hotspot-onesa-callback.html',
          source: callback.replace(script, script + ' data-api-prefix="/portal-api"').replace('href="/"', 'href="/connect"'),
        });
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
