import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { proxy: { '/api/bundles': { target: 'http://localhost:18082', rewrite: () => '/v1/bundles' }, '/api/help': { target: 'http://localhost:18085', rewrite: () => '/v1/help' } } } });
