/**
 * Refresh-aware wrapper around `GitHubVariablesClient` (macf#317).
 *
 * Decorates a base client with two behaviors:
 *
 *  1. **Pre-call refresh** — every method invocation calls
 *     `tokenRefresher.getRefreshedToken()` to get a current token + builds
 *     a fresh inner client. The cache inside `tokenRefresher` keeps this
 *     cheap (no fresh mint within ~50 min of last refresh).
 *
 *  2. **401 retry with force-refresh** — if the inner call throws
 *     `GitHubApiError` with `status === 401`, the wrapper invokes
 *     `getRefreshedToken({ forceRefresh: true })` (bypasses cache),
 *     rebuilds the inner client, and retries the call once. A second 401
 *     bubbles up — the issue isn't expiry but a different auth problem
 *     (revoked App, deleted installation, etc).
 *
 * Why decorate at the GitHubVariablesClient layer (not the Registry layer):
 * the Registry interface is project-business-logic (register/get/list/
 * remove for agents). The token-stale failure surfaces at the lower
 * (HTTP/auth) layer. Decorating at the lower layer keeps the failure-
 * recovery surface small + uniform across all 4 Registry methods, plus
 * the `/sign` flow's `varsClient`. One wrapper, all callers benefit.
 *
 * Note on closure-capture: the inner client built by `createGitHubClient`
 * captures the token in its closure — there's no mutable token slot. So
 * "rebuild the inner client when the token changes" is the cheapest +
 * cleanest change. Builds are pure-function pricing (~microseconds);
 * negligible vs the network round-trip.
 */
import { createGitHubClient, GitHubApiError } from '@groundnuty/macf-core';
import type { GitHubVariablesClient, Logger } from '@groundnuty/macf-core';
import type { TokenRefresher } from './token-refresh.js';

export interface RefreshAwareClientDeps {
  readonly pathPrefix: string;
  readonly tokenRefresher: TokenRefresher;
  readonly logger: Logger;
}

/**
 * Wrap a path-prefix + token-refresher into a `GitHubVariablesClient`
 * that auto-refreshes on 401. Drop-in replacement for the bare
 * `createGitHubClient(pathPrefix, token)` call in `server.ts` —
 * passes through the existing Registry.create chain unchanged.
 */
export function createRefreshAwareClient(
  deps: RefreshAwareClientDeps,
): GitHubVariablesClient {
  const { pathPrefix, tokenRefresher, logger } = deps;

  /**
   * Per-call: get token (cached or fresh), build inner client, invoke fn.
   * On 401, force-refresh + rebuild + retry once. Anything else propagates.
   */
  async function withRefresh<T>(
    label: string,
    fn: (inner: GitHubVariablesClient) => Promise<T>,
  ): Promise<T> {
    const initialToken = await tokenRefresher.getRefreshedToken();
    const inner = createGitHubClient(pathPrefix, initialToken);
    try {
      return await fn(inner);
    } catch (err) {
      // GitHubApiError carries status; 401 means token-related auth
      // failure (expired, revoked, missing perm). Other GitHubApiError
      // statuses (404, 422, 5xx) aren't auth-related; let them through.
      if (err instanceof GitHubApiError && err.status === 401) {
        logger.warn('github_api_401_refreshing_and_retrying', {
          method: label,
        });
        const freshToken = await tokenRefresher.getRefreshedToken({
          forceRefresh: true,
        });
        const fresh = createGitHubClient(pathPrefix, freshToken);
        return await fn(fresh);
      }
      throw err;
    }
  }

  return {
    async writeVariable(name: string, value: string): Promise<void> {
      await withRefresh('writeVariable', (c) => c.writeVariable(name, value));
    },
    async readVariable(name: string): Promise<string | null> {
      return withRefresh('readVariable', (c) => c.readVariable(name));
    },
    async listVariables(): Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>> {
      return withRefresh('listVariables', (c) => c.listVariables());
    },
    async deleteVariable(name: string): Promise<void> {
      await withRefresh('deleteVariable', (c) => c.deleteVariable(name));
    },
  };
}
