/**
 * Bin smoke tests for `@groundnuty/macf-channel-server`. See the
 * companion file `packages/macf/test/bin-smoke.test.ts` for the
 * design rationale; this file mirrors that pattern.
 *
 * macf#220 was filed exactly because of this package's `server.ts`
 * bin entry shipping rc.0 without a shebang (#219 fixed it). The
 * source-side regression guard here is the most direct prevention
 * of that bug class recurring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const pkgJsonPath = join(pkgRoot, 'package.json');

interface PackageJson {
  readonly name: string;
  readonly bin?: Record<string, string>;
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as PackageJson;

function distBinToSource(distPath: string): string {
  if (!distPath.startsWith('dist/')) {
    throw new Error(`bin entry must point under dist/, got: ${distPath}`);
  }
  return distPath.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
}

const SHEBANG = '#!/usr/bin/env node';

describe(`bin smoke tests — ${pkg.name}`, () => {
  it('has at least one bin entry declared', () => {
    expect(pkg.bin).toBeDefined();
    expect(Object.keys(pkg.bin ?? {}).length).toBeGreaterThan(0);
  });

  for (const [binName, distPath] of Object.entries(pkg.bin ?? {})) {
    describe(`${binName} → ${distPath}`, () => {
      const sourcePath = distBinToSource(distPath);
      const sourceAbs = join(pkgRoot, sourcePath);

      it('source file exists at the dist→src derived path', () => {
        expect(existsSync(sourceAbs)).toBe(true);
      });

      it('source file starts with #!/usr/bin/env node', () => {
        // The exact failure that produced rc.0's
        // `1: //: Permission denied / 2: Syntax error` crash class.
        // See macf#219 (fix) + macf#220 (regression guard).
        const firstLine = readFileSync(sourceAbs, 'utf-8').split('\n')[0];
        expect(firstLine).toBe(SHEBANG);
      });

      const distAbs = join(pkgRoot, distPath);
      it.skipIf(!existsSync(distAbs))('dist file (when built) starts with shebang', () => {
        const firstLine = readFileSync(distAbs, 'utf-8').split('\n')[0];
        expect(firstLine).toBe(SHEBANG);
      });
    });
  }
});
