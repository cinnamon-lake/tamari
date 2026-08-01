import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
      '/api': 'http://localhost:8000',
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // Never inline fonts as data: URLs — the server CSP is font-src 'self',
    // so fonts must be emitted as real same-origin files.
    assetsInlineLimit: (filePath) => {
      if (/\.(woff2?|ttf|otf|eot)$/.test(filePath)) return false;
    },
    // Sourcemaps are only needed to remap E2E coverage back to src/ — skip
    // them in normal builds to keep dist small.
    sourcemap: !!process.env.E2E_COVERAGE,
  },
});
