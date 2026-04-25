/**
 * Bin smoke tests — assert each `package.json.bin` entry resolves to
 * a source file with the `#!/usr/bin/env node` shebang as line 1.
 *
 * Per macf#220: the v0.2.0-rc.0 → rc.1 cycle surfaced a missing-
 * shebang failure mode. `server.ts` was promoted to a `bin` entry in
 * #212's npx-dispatch cutover but never received a shebang; rc.0
 * published successfully and `npx -y @groundnuty/macf-channel-server`
 * died with `1: //: Permission denied / 2: Syntax error: "(" unexpected`.
 * #219 added the shebang; this test regression-guards the invariant
 * across all bin entries.
 *
 * Test design: source-side check on the .ts files in src/. The build
 * tsc emits dist/<bin>.js preserving the shebang verbatim — a missing
 * source shebang would silently produce a missing dist shebang and
 * hit the same publish-time failure. Source check catches the bug
 * class without requiring dist/ to be built first (keeps `make check`
 * fast — see #127 for the deliberate split between `check` and
 * `build`).
 *
 * If dist/ exists (post-`make build` or in a CI publish job), we ALSO
 * verify the dist file's shebang for defense-in-depth. Skipped
 * otherwise — not all `make check` runs come after a build.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/macf/test/bin-smoke.test.ts → packages/macf/
const pkgRoot = resolve(__dirname, '..');
const pkgJsonPath = join(pkgRoot, 'package.json');

interface PackageJson {
  readonly name: string;
  readonly bin?: Record<string, string>;
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as PackageJson;

/**
 * Map a `bin` entry like `dist/cli/index.js` to the source path
 * `src/cli/index.ts`. Path layout convention is preserved by the
 * tsc build — `tsc` reads from `src/`, writes to `dist/` with
 * matching subdirs and `.ts` → `.js` rename.
 */
function distBinToSource(distPath: string): string {
  if (!distPath.startsWith('dist/')) {
    throw new Error(`bin entry must point under dist/, got: ${distPath}`);
  }
  return distPath.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
}

const SHEBANG = '#!/usr/bin/env node';

describe(`bin smoke tests — ${pkg.name}`, () => {
  // Regression guard against a future refactor that drops `bin` entries
  // (e.g. accidentally during a package.json edit). If `bin` becomes
  // empty/undefined, the rest of this file's tests no-op silently.
  it('has at least one bin entry declared', () => {
    expect(pkg.bin).toBeDefined();
    expect(Object.keys(pkg.bin ?? {}).length).toBeGreaterThan(0);
  });

  for (const [binName, distPath] of Object.entries(pkg.bin ?? {})) {
    describe(`${binName} → ${distPath}`, () => {
      const sourcePath = distBinToSource(distPath);
      const sourceAbs = join(pkgRoot, sourcePath);

      it('source file exists at the dist→src derived path', () => {
        // Sanity: prevents a `bin` typo from passing the shebang
        // check via the falsy-source-file fallback.
        expect(existsSync(sourceAbs)).toBe(true);
      });

      it('source file starts with #!/usr/bin/env node', () => {
        // Per macf#220 — missing shebang on a bin source = silent
        // publish-time crash. `tsc` preserves the shebang verbatim
        // into dist/, so source-side check catches the bug class.
        const firstLine = readFileSync(sourceAbs, 'utf-8').split('\n')[0];
        expect(firstLine).toBe(SHEBANG);
      });

      // Defense-in-depth: when dist/ exists (post-build runs), check
      // the actual published shape too. Skipped when dist/ absent
      // (the normal `make check` flow doesn't run `make build`).
      const distAbs = join(pkgRoot, distPath);
      it.skipIf(!existsSync(distAbs))('dist file (when built) starts with shebang', () => {
        const firstLine = readFileSync(distAbs, 'utf-8').split('\n')[0];
        expect(firstLine).toBe(SHEBANG);
      });
    });
  }
});
