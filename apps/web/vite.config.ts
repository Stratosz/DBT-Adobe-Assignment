import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Inside the dev container (compose.dev.yaml) Vite must listen on all interfaces, and file
// changes from the macOS/Windows host arrive over a bind mount, where polling is reliable.
const inDocker = process.env.DEV_IN_DOCKER === 'true';
const api = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: inDocker ? '0.0.0.0' : 'localhost',
    watch: inDocker ? { usePolling: true, interval: 300 } : undefined,
    proxy: {
      '/api': api,
      '/metrics': api,
      '/health': api,
      '/ready': api,
      '/docs': api,
    },
  },
});
