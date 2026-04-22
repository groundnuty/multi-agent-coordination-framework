import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Redirect `@groundnuty/macf-core` imports to the sibling workspace's
  // source entry, same as `vitest.config.ts` does for the unit suite.
  // Without this, vitest tries to resolve the bare specifier via the
  // workspace symlink → `packages/macf-core/package.json.main` →
  // `dist/index.js`, which doesn't exist during `make test-e2e` (CI
  // flow is install → test-e2e; no build step in between). Surfaced
  // after PR #212 (1c split) rewired the e2e tests' imports from
  // relative paths to the scoped package name; fix for macf#184.
  resolve: {
    alias: {
      '@groundnuty/macf-core': resolve(__dirname, '../macf-core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 180_000,
  },
});
