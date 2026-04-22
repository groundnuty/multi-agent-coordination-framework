/**
 * Regression guard for macf#216: the PACKAGE_VERSION util derived
 * at module load must equal the current package.json version. If
 * someone refactors the util (changes the relative path walk, swaps
 * the JSON read, etc.) in a way that silently breaks the read, this
 * test catches it before landing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION } from '../src/package-version.js';

describe('PACKAGE_VERSION (macf#216)', () => {
  it('matches the package.json version at the package root', () => {
    // Walk up from this test file to the package root (same walk-up
    // the src util does, but from test/ dir; either way lands at the
    // package root since both test/ and src/ are one level down).
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { readonly version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it('is a non-empty semver-shaped string', () => {
    // Defensive: catches a future refactor that returns an empty
    // string, `undefined` cast to string, or the literal `"null"`.
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/);
  });
});
