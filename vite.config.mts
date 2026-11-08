import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        admin: resolve(__dirname, 'index.html'),
        mobile: resolve(__dirname, 'mobile.html'),
      },
    },
  },
});
