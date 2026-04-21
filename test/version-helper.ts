/**
 * Test helper — read the CLI version from package.json so test
 * assertions don't have to be manually bumped on every release.
 *
 * Previously several tests hardcoded string literals like
 * `expect(health.version).toBe('0.1.0')`. PR #155 bumped 0.1.0 → 0.1.1
 * and caught 5 of the hardcoded sites on the first pass but missed 3
 * E2E ones — #160 auto-opened after the merge, PR #162 fixed them
 * retrospectively. See `memory/project_version_literal_drift.md`.
 *
 * Using this helper: import `EXPECTED_VERSION` and assert against it.
 * Any future bump updates package.json once; the tests follow
 * automatically.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
  readonly version: string;
};

export const EXPECTED_VERSION: string = pkg.version;
