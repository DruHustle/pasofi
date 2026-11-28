import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_PAMOFI_');
  let apiOrigin = '';
  try { const url = new URL(env.VITE_PAMOFI_API_BASE_URL || ''); if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) apiOrigin = url.origin; } catch { /* The UI stays in preview when no valid gateway is configured. */ }
  const formOrigins: string[] = [];
  try {
    const values: unknown = JSON.parse(env.VITE_PAMOFI_ROUTER_FORM_ORIGINS ||
      '["https://login.pasofi.mobile.onesa.eu","https://wifi.pasofi.mobile.onesa.eu"]');
    if (Array.isArray(values) && values.length <= 20 && values.every(value => {
      if (typeof value !== 'string') return false;
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value && !url.hostname.includes('*') &&
        !['hotspot.pamofi.onesa.eu', 'hotspot.pasofi.onesa.eu'].includes(url.hostname);
    })) formOrigins.push(...values as string[]);
  } catch { /* Invalid lists do not permit cross-origin form submission. */ }
  const policy = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}; object-src 'none'; base-uri 'none'; form-action 'self'${formOrigins.length ? ` ${formOrigins.join(' ')}` : ''}`;
  // The CSP has no data: font source, so never inline a small font subset.
  const build = { assetsInlineLimit: (file: string) => (/\.(?:woff2?|ttf|otf)$/i.test(file) ? false : undefined) };
  return { build, plugins: [react(), { name: 'pasofi-mobile-build-policy', apply: 'build', transformIndexHtml() { return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }]; } }] };
});
