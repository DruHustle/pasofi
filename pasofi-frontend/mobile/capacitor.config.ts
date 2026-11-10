import type { CapacitorConfig } from '@capacitor/cli';

// This is a public origin, never the server-only Oracle proxy credential. It is
// copied into the installed native bundle during sync, outside JavaScript control.
const configured = process.env.VITE_PAMOFI_API_BASE_URL?.trim();
let customerOrigin = '';
if (configured) {
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) || url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost')) throw Error('Pasofi native customer API requires a public HTTPS origin.');
  customerOrigin = url.origin;
}

const config: CapacitorConfig = {
  appId: 'com.onesa.pasofi',
  appName: 'Pasofi',
  webDir: 'dist',
  // Capacitor debug logs otherwise include native call arguments, including a
  // payment's client secret. Keep bridge argument logging disabled in all builds.
  loggingBehavior: 'none',
  plugins: { PasoFiCustomerApi: { origin: customerOrigin } },
  // Bundle the app. Remote WebView URLs are for development only.
};

export default config;
