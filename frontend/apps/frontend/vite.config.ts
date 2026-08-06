import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backendPort = Number(process.env.GCT_PORT ?? 17840);
const frontendPort = Number(process.env.GCT_FRONTEND_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: frontendPort,
    strictPort: true,
    proxy: {
      '/health': `http://127.0.0.1:${backendPort}`,
      '/api': `http://127.0.0.1:${backendPort}`,
      '/secure': `http://127.0.0.1:${backendPort}`,
      '/ws': { target: `ws://127.0.0.1:${backendPort}`, ws: true },
    },
  },
});
