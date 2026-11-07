import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.onesa.pasofi',
  appName: 'PasoFi',
  webDir: 'dist',
  // Capacitor debug logs otherwise include native call arguments, including a
  // payment's client secret. Keep bridge argument logging disabled in all builds.
  loggingBehavior: 'none',
  // Bundle the app. Remote WebView URLs are for development only.
};

export default config;
