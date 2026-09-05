import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Vite serves these in development and includes them in the desktop bundle.
const assets = fileURLToPath(new URL('./.generated/pdfjs/', import.meta.url));
mkdirSync(assets, { recursive: true });
for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(
    fileURLToPath(new URL(`./node_modules/pdfjs-dist/${directory}/`, import.meta.url)),
    `${assets}/${directory}`,
    { recursive: true },
  );
}

export default defineConfig({
  clearScreen: false,
  publicDir: '.generated',
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
