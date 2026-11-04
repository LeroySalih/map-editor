import { defineConfig } from 'vite';

// `npm run dev` proxies the map server (python server/run.py, port 5000) so the page and the API share an origin.
export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:5000', '/health': 'http://127.0.0.1:5000' } },
});
