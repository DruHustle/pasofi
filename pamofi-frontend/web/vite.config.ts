import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Server-only configuration; these origins are not shipped to browser code.
const rewrite = (path: string) => path.replace(/^\/api\//, '/v1/');
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'PAMOFI_');
  const identity = env.PAMOFI_IDENTITY_URL || 'http://localhost:18081';
  const prepaid = env.PAMOFI_PREPAID_URL || 'http://localhost:18082';
  const assistant = env.PAMOFI_ASSISTANT_URL || 'http://localhost:18085';
  return {
  plugins: [react()],
  server: {
    proxy: {
      '^/api/bundles(?:\\?|$)': { target: prepaid, rewrite },
      '^/api/help(?:\\?|$)': { target: assistant, rewrite },
      '^/api/session(?:\\?|$)': { target: identity, rewrite },
      '^/api/orders(?:/|\\?|$)': { target: prepaid, rewrite },
      '^/api/access(?:\\?|$)': { target: prepaid, rewrite },
      '^/api/recovery(?:/|\\?|$)': { target: identity, rewrite },
    },
  },
  };
});
