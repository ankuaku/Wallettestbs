import { defineConfig } from 'vite';

// Local development: the backend runs on :3001 and this dev server proxies /api to it.
export default defineConfig({
  server: {
    port: 3000,
    proxy: { '/api': 'http://localhost:3001' },
  },
});
