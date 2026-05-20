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
    // Serialize integration test files (macf#396 Phase 3): all files
    // share the Python venv at node_modules/.cache/a2a-python-venv;
    // parallel `ensureA2aVenv()` calls from multiple workers race on
    // `python3 -m venv` + pip-install — second worker hits ENOENT on
    // pip when its `bin/pip` lookup races against the first worker's
    // mid-creation venv state. Running sequentially is fine: tests are
    // ~6-15s each post-cache; 3 files × ~10s = 30s sequential vs the
    // unreliable parallel path. (Vitest 4: `fileParallelism: false`
    // alone is sufficient; `poolOptions` is deprecated.)
    fileParallelism: false,
  },
});
