import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Redirect `import ... from 'macf-core'` to the sibling workspace's
  // source entry during tests. Without this the resolver would find
  // `dist/index.js` via the workspace symlink, requiring a pre-test
  // build — fragile in watch mode and CI. Runtime (built CLI / server
  // binary) still resolves via normal node_modules workspace linkage
  // to the package's `main` → `dist/index.js`.
  resolve: {
    alias: {
      'macf-core': resolve(__dirname, '../macf-core/src/index.ts'),
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
      exclude: ['src/cli/**', 'src/server.ts', 'src/https.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
