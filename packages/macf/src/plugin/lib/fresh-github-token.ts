import { generateToken } from '@groundnuty/macf-core';

/**
 * Force-mint a fresh GitHub App installation token from claude.sh-exported
 * APP_ID/INSTALL_ID/KEY_PATH env vars (or TokenSource if explicitly passed),
 * bypassing any GH_TOKEN env var the parent process may have inherited.
 *
 * Why this helper exists (macf#338): every `macf-plugin-cli` invocation runs
 * as a short-lived npx subprocess from a Claude TUI parent. The parent's
 * `GH_TOKEN` env was minted at TUI startup (1hr-TTL bot installation token);
 * after ≥1hr of TUI uptime, that env-token is stale. Reading it as-is via
 * `generateToken()`'s default env-shortcut path causes 401 from GitHub APIs.
 *
 * This helper wraps `generateToken(undefined, { forceMint: true })` as a
 * single declarative entry point. The plugin-cli's bin file imports THIS
 * helper exclusively — never `generateToken` directly. That import-boundary
 * invariant is enforced by `test/plugin/lib/fresh-github-token.test.ts` so
 * a future call-site addition can't silently regress to the env-shortcut
 * behavior.
 *
 * Local-mode invocations don't use this helper (no GitHub backend → no
 * token needed); the LocalRegistryClient ignores the token argument
 * entirely. See `bin/macf-plugin-cli.ts` ternary at each call site.
 */
export async function mintFreshGitHubToken(): Promise<string> {
  return generateToken(undefined, { forceMint: true });
}
