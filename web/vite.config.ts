import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/demo-app/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.ENGINE_URL ?? 'http://localhost:4000',
    },
  },
});
