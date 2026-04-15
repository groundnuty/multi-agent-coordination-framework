/**
 * Fetch the macf-agent plugin from groundnuty/macf-marketplace at a pinned
 * version and place it at <workspace>/.macf/plugin/.
 *
 * Per DR-013, each workspace gets its own copy of the plugin at a specific
 * version; claude.sh invokes `claude --plugin-dir <workspace>/.macf/plugin`
 * so each agent runs an independent, pinnable plugin. No user-scope install,
 * no cross-project contamination.
 *
 * Mechanism: shallow git clone at the tag, copy the `macf-agent/` subdir
 * into place, remove the clone. Uses `execFileSync` (no shell — safe against
 * injection since args are list form) and `cpSync({recursive: true})` for
 * the copy.
 *
 * Network failures during fetch surface as a thrown Error; callers decide
 * whether to abort setup or warn-and-continue.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_MARKETPLACE_URL = 'https://github.com/groundnuty/macf-marketplace';
const DEFAULT_PLUGIN_SUBDIR = 'macf-agent';

export interface FetchPluginOptions {
  /** Override the marketplace git URL (for testing). */
  readonly marketplaceUrl?: string;
  /** Override the subdir inside the marketplace repo (for testing). */
  readonly pluginSubdir?: string;
  /** If true, throw on fetch failure. If false, throw with a helpful message. Default: true. */
  readonly throwOnError?: boolean;
}

/**
 * Path to the target plugin directory inside a workspace.
 */
export function workspacePluginDir(workspaceDir: string): string {
  return join(resolve(workspaceDir), '.macf', 'plugin');
}

/**
 * Clone macf-marketplace at `v<version>`, extract the plugin subdir to
 * `<workspace>/.macf/plugin/`. Idempotent: an existing plugin dir is
 * removed before the new one is written, so re-running gives a clean
 * replacement (no stale files from a previous version hanging around).
 *
 * Throws if the git clone fails (network down, tag missing, etc.).
 */
export function fetchPluginToWorkspace(
  workspaceDir: string,
  version: string,
  options: FetchPluginOptions = {},
): void {
  const marketplaceUrl = options.marketplaceUrl ?? DEFAULT_MARKETPLACE_URL;
  const pluginSubdir = options.pluginSubdir ?? DEFAULT_PLUGIN_SUBDIR;
  const target = workspacePluginDir(workspaceDir);

  // git tag for plugin versions is `v<semver>` (e.g. v0.1.0).
  const tag = `v${version}`;

  // Use a temp dir for the shallow clone so we can discard everything
  // except the plugin subdir.
  const tmpClone = mkdtempSync(join(tmpdir(), 'macf-plugin-clone-'));

  try {
    execFileSync('git', [
      'clone',
      '--depth', '1',
      '--branch', tag,
      marketplaceUrl,
      tmpClone,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const pluginSrc = join(tmpClone, pluginSubdir);
    if (!existsSync(pluginSrc)) {
      throw new Error(
        `Plugin subdir "${pluginSubdir}" not found in ${marketplaceUrl} at ${tag}. ` +
        `Repo layout may have changed.`,
      );
    }

    // Clean up any existing plugin dir so stale files from a previous
    // version don't linger. Parent .macf/ is created by `macf init`
    // already; we just manage the plugin/ child.
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(target, { recursive: true });

    // Recursive copy. cpSync preserves timestamps and file modes.
    cpSync(pluginSrc, target, { recursive: true });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Plugin subdir')) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to fetch plugin from ${marketplaceUrl} at ${tag}: ${msg}. ` +
      `Check network access and that the tag exists.`,
      { cause: err },
    );
  } finally {
    rmSync(tmpClone, { recursive: true, force: true });
  }
}
