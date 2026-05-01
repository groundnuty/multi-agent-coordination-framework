import type { RegistryConfig } from '@groundnuty/macf-core';

/**
 * Build a `RegistryConfig` from `claude.sh`-exported env vars.
 *
 * Env-var → variant mapping (matches `claude.sh` template's
 * `registryEnvLines()` for each registry type):
 *
 * - `MACF_REGISTRY_TYPE=local` + `MACF_REGISTRY_PATH=<abs-path>` — DR-024
 *   local mode (sister to DR-010). Path is required when type is `local`;
 *   throws with a fix-it diagnostic if missing.
 * - `MACF_REGISTRY_REPO=<owner>/<repo>` — repo-scoped GitHub Variables.
 * - `MACF_REGISTRY_ORG=<org>` — org-scoped GitHub Variables.
 * - `MACF_REGISTRY_USER=<user>` — profile-scoped GitHub Variables.
 *
 * Default fallback: `groundnuty/macf` repo (preserves pre-DR-024 behaviour
 * for plugin invocations outside a launched workspace, e.g. one-off CLI
 * use against the framework repo).
 *
 * Local mode wins over repo/org/profile env vars when both are set —
 * `MACF_REGISTRY_TYPE` is the explicit signal claude.sh exports for
 * mode selection.
 *
 * Surfaced by macf#332 — pre-fix, the function ignored
 * `MACF_REGISTRY_TYPE=local` entirely and fell through to the default
 * fallback, so `/macf-peers` etc. dispatched to a GitHub registry path
 * that then required App-cred env vars. Critical regression for v0.2.12
 * local-mode consumers.
 */
export function getRegistryConfig(env: NodeJS.ProcessEnv = process.env): RegistryConfig {
  if (env['MACF_REGISTRY_TYPE'] === 'local') {
    const path = env['MACF_REGISTRY_PATH'];
    if (!path) {
      throw new Error(
        'MACF_REGISTRY_TYPE=local but MACF_REGISTRY_PATH is not set. ' +
        'Run `macf init --local` to regenerate claude.sh, or set MACF_REGISTRY_PATH manually.',
      );
    }
    return { type: 'local', path };
  }
  const repoEnv = env['MACF_REGISTRY_REPO'];
  if (repoEnv) {
    const parts = repoEnv.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { type: 'repo', owner: parts[0], repo: parts[1] };
    }
  }
  const orgEnv = env['MACF_REGISTRY_ORG'];
  if (orgEnv) return { type: 'org', org: orgEnv };
  const userEnv = env['MACF_REGISTRY_USER'];
  if (userEnv) return { type: 'profile', user: userEnv };
  return { type: 'repo', owner: 'groundnuty', repo: 'macf' };
}
