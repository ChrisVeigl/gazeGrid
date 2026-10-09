import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so dist/ works from any folder or sub-path.
  base: './',
  server: { port: 5174 },   // WebUSB needs a secure context; localhost counts.
  build: { target: 'es2022' },
});
