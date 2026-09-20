import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Served from https://<owner>.github.io/bad-game/ on Pages; override with BASE_PATH for other hosts.
export default defineConfig({
  root,
  base: process.env['BASE_PATH'] ?? '/bad-game/',
  publicDir: 'public',
  build: { outDir: fileURLToPath(new URL('../dist', import.meta.url)), emptyOutDir: true },
  server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
});
