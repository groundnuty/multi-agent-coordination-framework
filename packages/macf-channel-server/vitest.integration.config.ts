import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Integration test config — runs `test/integration/**` only.
 *
 * Separate from the default vitest run (which excludes `test/integration/**`
 * + `test/e2e/**`) because integration tests require a Python venv with
 * the `a2a-sdk` package installed (~10s first run; sub-second cached).
 * Used by `npm run test:integration` and the operator-invoked
 * `make -f dev.mk test-integration` target.
 *
 * groundnuty/macf#376 — separates Python-cross-implementation tests
 * from the always-fast `make check` gate. Devbox-Python required.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@groundnuty/macf-core': resolve(__dirname, '../macf-core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['test/integration/**/*.test.ts'],
    // Generous timeout: the venv setup (first run only) is ~10s for
    // pip-install of a2a-sdk; subsequent runs are sub-second. Plus
    // each probe spawn is ~1s of Python interpreter cold-start.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
