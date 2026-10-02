import { defineConfig } from 'vite';

export default defineConfig({
  base: '/qrfile/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
