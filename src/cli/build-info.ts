/**
 * Stale-dist detection (#144).
 *
 * The installed `macf` CLI is typically `npm link`-ed to
 * `<source-repo>/dist/cli/index.js`. When a CLI-behavior PR merges to
 * main, operators must rebuild before the linked CLI reflects the
 * change — forgetting the rebuild produces silent-no-op behavior.
 *
 * At build time, `scripts/write-build-info.mjs` writes the git HEAD
 * into `dist/.build-info.json`. At runtime, `detectStaleDist()`
 * compares that stamp against the source repo's current HEAD
 * (via `git rev-parse HEAD`) and returns a non-null result when
 * they differ.
 *
 * Fail-soft: if the build stamp is missing, is "unknown" (npm tarball
 * install where git wasn't available at build time), or the source
 * repo has no `.git/` directory, detection returns null. The detector
 * never warns spuriously — it either catches a real drift or stays
 * silent.
 *
 * Bootstrap limitation: detection only works from the CLI version
 * that introduces it forward. Workspaces running pre-#144 CLIs won't
 * get the warning until they rebuild once.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildInfo {
  readonly commit: string;
  readonly built_at: string;
}

export interface StaleDistInfo {
  /** The commit that was current when `dist/` was last built. */
  readonly buildCommit: string;
  /** The source repo's current HEAD. */
  readonly currentCommit: string;
  /** ISO timestamp of when `dist/` was built. */
  readonly builtAt: string;
}

/**
 * Load `<packageRoot>/dist/.build-info.json`. Returns null if the file
 * is missing or malformed — never throws.
 */
export function readBuildInfo(packageRoot: string): BuildInfo | null {
  const path = join(packageRoot, 'dist', '.build-info.json');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'commit' in parsed &&
      typeof (parsed as { commit: unknown }).commit === 'string' &&
      'built_at' in parsed &&
      typeof (parsed as { built_at: unknown }).built_at === 'string'
    ) {
      return { commit: (parsed as BuildInfo).commit, built_at: (parsed as BuildInfo).built_at };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run `git rev-parse HEAD` in `packageRoot`. Returns null if the repo
 * has no `.git/` directory or git errors for any reason (e.g., no
 * commits, command not installed).
 */
function currentHeadCommit(packageRoot: string): string | null {
  if (!existsSync(join(packageRoot, '.git'))) return null;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: packageRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Compare the dist/ build stamp against the source repo's current
 * HEAD. Returns null when the check can't run (no build info, no git,
 * stamp is `unknown`) or when the dist is fresh. Returns non-null
 * only when a real stale-dist condition is detected.
 */
export function detectStaleDist(packageRoot: string): StaleDistInfo | null {
  const info = readBuildInfo(packageRoot);
  if (info === null) return null;
  if (info.commit === 'unknown') return null;

  const head = currentHeadCommit(packageRoot);
  if (head === null) return null;

  if (head === info.commit) return null;

  return {
    buildCommit: info.commit,
    currentCommit: head,
    builtAt: info.built_at,
  };
}

/**
 * Non-null iff the source repo is a git-clone install (has `.git/`)
 * AND the build-info is missing or its commit is "unknown". This is
 * the "you built via `npx tsc` directly and skipped the postbuild
 * hook" case — distinct from a stale-dist condition. Treat as a soft
 * warning pointing at the canonical `npm run build`, not as a fail.
 *
 * Returns null for the legit cases: no git (tarball install), or the
 * build stamp matches current HEAD (fresh).
 */
export function detectUnknownFreshness(
  packageRoot: string,
): { readonly reason: 'missing_build_info' | 'unknown_build_commit' } | null {
  // Only soft-warn for git-cloned installs. Tarball/npm-registry
  // installs never have .git/ and can't benefit from `npm run build`.
  if (!existsSync(join(packageRoot, '.git'))) return null;

  const info = readBuildInfo(packageRoot);
  if (info === null) return { reason: 'missing_build_info' };
  if (info.commit === 'unknown') return { reason: 'unknown_build_commit' };

  // Info is present and genuine — stale-detect is the right check for
  // drift, not this function.
  return null;
}
