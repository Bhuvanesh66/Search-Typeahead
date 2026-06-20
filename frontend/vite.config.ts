import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy /api/* to the backend so the frontend can call relative URLs in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // Use 127.0.0.1 (not "localhost") so the proxy doesn't resolve to ::1
        // (IPv6) while the backend listens on IPv4 — a common ECONNREFUSED cause.
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
