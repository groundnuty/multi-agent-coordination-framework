/**
 * Package version, derived from `package.json` at module load.
 *
 * Structural fix for macf#216 — replaces hardcoded version literals
 * in `cli/index.ts` (commander `.version()`), `version-resolver.ts`
 * (`FALLBACK_VERSIONS.cli` default), and the init-versions test
 * assertion. Without this util, every release bump required editing
 * 4 source literals plus 5 package.json fields; missing any one
 * caused silent drift (seen on macf#215 PR review + macf#219 rc.1
 * bump).
 *
 * Path resolution works for both dev (source loaded from `src/`) and
 * installed (compiled loaded from `dist/`) layouts: one dir up from
 * this file's location lands at the package root where
 * `package.json` lives in both cases.
 *
 * `package.json` is always included in npm-published tarballs
 * regardless of the `files` field, so the runtime read works post-
 * publish for operators consuming `@groundnuty/macf` via npm.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(pkgPath, 'utf-8')) as { readonly version: string }
).version;
