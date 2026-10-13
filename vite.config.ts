import { defineConfig } from 'vite';

// Served from https://jdank417.github.io/live-boston/
export default defineConfig({
  base: '/live-boston/',
  build: {
    // MapLibre and three.js are big on their own; ship them as separate,
    // long-cached chunks so an app change doesn't re-download them.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: { maplibre: ['maplibre-gl'], three: ['three'] },
      },
    },
  },
});
