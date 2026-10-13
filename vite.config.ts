import { defineConfig } from 'vite';

// Served from https://jdank417.github.io/live-boston/
export default defineConfig({
  base: '/live-boston/',
  // MapLibre alone is ~800 kB minified; that's expected.
  build: { chunkSizeWarningLimit: 1200 },
});
