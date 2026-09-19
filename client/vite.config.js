import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // shared/broking/calcs.js lives outside the client root.
    fs: { allow: ['..'] },
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
          if (id.includes('/shared/broking/')) return 'broking-calcs';
          if (id.includes('/client/src/broking/')) return 'broking';
        },
      },
    },
  },
});
