import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Local testing: backend runs on :3001, this dev server proxies /api to it.
export default defineConfig({
  // Relative asset paths, so the admin works both at its own domain
  // and under /admin/ when the backend serves everything.
  base: './',
  server: {
    port: 3002,
    proxy: { '/api': 'http://localhost:3001' },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        deploy: resolve(__dirname, 'deploy.html'),
        withdraw: resolve(__dirname, 'withdraw.html'),
      },
    },
  },
});
