/**
 * Package version, derived from `package.json` at module load.
 *
 * Structural fix for macf#216 — replaces the hardcoded version
 * literal in `mcp.ts` (the MCP handshake's server-info version
 * field). Without this util, every release bump required editing
 * the literal in sync with package.json; missing it caused the
 * handshake to advertise a stale version to clients.
 *
 * Path resolution works for both dev (source loaded from `src/`)
 * and installed (compiled loaded from `dist/`) layouts: one dir up
 * from this file's location lands at the package root where
 * `package.json` lives in both cases.
 *
 * `package.json` is always included in npm-published tarballs
 * regardless of the `files` field, so the runtime read works post-
 * publish for the server invoked via `npx -y @groundnuty/macf-
 * channel-server`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(pkgPath, 'utf-8')) as { readonly version: string }
).version;
