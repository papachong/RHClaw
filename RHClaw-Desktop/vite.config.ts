import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const apiProxyTarget = process.env.VITE_DEV_API_PROXY_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api/v1': {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
      },
      '/gateway': {
        target: 'http://127.0.0.1:18789',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gateway/, ''),
      },
      '/__local_gateway': {
        target: 'http://127.0.0.1:18789',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__local_gateway/, ''),
      },
    },
  },
  preview: {
    port: 4174,
    strictPort: true,
  },
});
