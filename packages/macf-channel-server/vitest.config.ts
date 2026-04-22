import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Redirect `import ... from '@groundnuty/macf-core'` to the sibling
  // workspace's source entry during tests. Keeps test runs from
  // requiring a pre-built core dist/. Runtime (built server binary)
  // resolves via workspaces symlink → package.json main → dist/index.js.
  resolve: {
    alias: {
      '@groundnuty/macf-core': resolve(__dirname, '../macf-core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/https.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
