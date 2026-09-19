// client/vitest.config.js — React/jsdom unit + component tests (run from client/).
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx,ts,tsx}'],
    css: false,
    testTimeout: 15_000,
  },
});
