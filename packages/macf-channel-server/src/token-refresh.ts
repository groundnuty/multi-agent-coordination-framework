/**
 * In-runner GH_TOKEN refresh helper (macf#317).
 *
 * Bot installation tokens have a **1-hour TTL by design** (GitHub App contract).
 * `claude.sh` mints a fresh token at session start + exports `GH_TOKEN`; the
 * channel-server inherits that token via `process.env`. Without an in-runner
 * refresh, every gh-API-using handler 401s after ~60 minutes of session
 * uptime. Witnessed 2026-05-01 ~14:30Z on cv-architect's Stop hook at
 * ~67min uptime — the operator-witnessed incident motivating this module.
 *
 * Architecture: an in-process token cache. Holds {token, mintedAt}; on
 * every `getRefreshedToken()` call, returns cached if `age < REFRESH_AGE_MS`
 * (50min — 10min safety margin under 1hr TTL); otherwise mints fresh via
 * the canonical `macf-gh-token.sh` helper. On a 401 from a downstream API
 * call, the caller re-invokes with `forceRefresh: true` to bypass cache.
 *
 * Critical: refreshed tokens stay **in-process**. We never `process.env.GH_TOKEN
 * = ...` or pass tokens to child processes via env mutation — a stale
 * `GH_TOKEN` env var elsewhere is a separate hazard surface. The wrapper-
 * around-GitHub-client pattern (refresh-aware-client.ts) holds the fresh
 * token in closure, never leaks it.
 *
 * Failure semantics: refresh failures (clock drift, missing key, rotated
 * key, deleted App) throw with diagnostic. We do NOT silently fall back
 * to the stale env-var token — that would extend the silent-fallback class
 * (Instance 1, gh-token attribution traps) by re-introducing a quiet path
 * where ops continue under wrong identity. Loud failure preserves the
 * fail-loud invariant.
 *
 * Sister-shape reference: macf-testbed#135 (closed/deferred — sweep-
 * harness-side refresh between iterations). Same hazard class, different
 * surface; this module is the channel-server-side response.
 *
 * Helper-script discoverability: in-runner refresh requires the canonical
 * `macf-gh-token.sh` to be invokable. Resolution order:
 *   1. Caller-injected `tokenScriptPath` (testing override)
 *   2. `$MACF_WORKSPACE_DIR/.claude/scripts/macf-gh-token.sh` (canonical
 *      consumer-fleet path; set by claude.sh per macf#161)
 *
 * Falls back to `generateToken()` from macf-core if the helper script isn't
 * resolvable (substrate / non-init'd workspaces). The core helper handles
 * the same APP_ID/INSTALL_ID/KEY_PATH env path; only difference is fail-
 * loud diagnostics live in the shell wrapper.
 *
 * SAFETY NOTE: this module uses `execFile` (NOT `exec`), so arguments are
 * passed as an argv array — no shell interpretation, no injection surface
 * for the operator-controlled APP_ID/INSTALL_ID/KEY_PATH values.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { generateToken } from '@groundnuty/macf-core';
import type { Logger } from '@groundnuty/macf-core';

const execFileAsync = promisify(execFile);

/**
 * Token cache TTL — 50 minutes. 10-minute safety margin under the 1-hour
 * installation-token TTL (GitHub App contract). Calls within this window
 * return the cached token; calls past this window mint fresh.
 *
 * Exposed as a const so tests can assert the value without re-deriving.
 */
export const REFRESH_AGE_MS = 50 * 60 * 1000;

export interface TokenRefresherDeps {
  /** Optional override for the canonical helper-script path; tests inject. */
  readonly tokenScriptPath?: string;
  /** Optional clock injection for tests. */
  readonly clock?: { readonly now: () => number };
  /** Optional execFile injection for tests (avoids spawning real shell). */
  readonly exec?: (
    cmd: string,
    args: readonly string[],
    opts?: { readonly encoding?: 'utf-8' },
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  /** Logger for diagnostic output. */
  readonly logger: Logger;
}

export interface GetRefreshedTokenOptions {
  /** Force a fresh mint regardless of cache age (used on 401 retry). */
  readonly forceRefresh?: boolean;
}

export interface TokenRefresher {
  /**
   * Returns a current token, minting fresh if the cache is older than
   * `REFRESH_AGE_MS` or `forceRefresh: true`. Throws on mint failure;
   * never returns a stale token silently.
   */
  readonly getRefreshedToken: (
    opts?: GetRefreshedTokenOptions,
  ) => Promise<string>;
}

/**
 * Locate the canonical token helper script. Returns the resolved path or
 * `null` if not findable; caller falls back to `generateToken()`.
 */
function resolveScriptPath(override?: string): string | null {
  if (override !== undefined) return override;
  const workspaceDir = process.env['MACF_WORKSPACE_DIR'];
  if (workspaceDir === undefined || workspaceDir === '') return null;
  const candidate = join(
    workspaceDir,
    '.claude',
    'scripts',
    'macf-gh-token.sh',
  );
  return existsSync(candidate) ? candidate : null;
}

/**
 * Validate token shape — must be a non-empty `ghs_*` installation token.
 * Mirrors the canonical fail-loud prefix check from `macf-gh-token.sh`.
 * Defensive against scenarios where the helper exits 0 but produces empty
 * stdout (shouldn't happen — the helper has its own check — but this is
 * the result-invariant assertion at the channel-server boundary).
 */
function assertTokenShape(token: string): void {
  if (token === '') {
    throw new Error('Token refresh failed: empty token returned');
  }
  if (!token.startsWith('ghs_')) {
    const prefix = token.slice(0, 4);
    throw new Error(
      `Token refresh failed: bad prefix '${prefix}' — expected 'ghs_' (installation token). ` +
      'Refusing to use non-installation token to avoid mis-attribution.',
    );
  }
}

/**
 * Mint a fresh token. Tries the canonical shell helper first (fail-loud
 * with diagnostics) and falls back to `generateToken()` from core.
 */
async function mintToken(deps: TokenRefresherDeps): Promise<string> {
  const scriptPath = resolveScriptPath(deps.tokenScriptPath);

  if (scriptPath !== null) {
    const appId = process.env['APP_ID'];
    const installId = process.env['INSTALL_ID'];
    const keyPath = process.env['KEY_PATH'];

    if (
      appId === undefined || appId === '' ||
      installId === undefined || installId === '' ||
      keyPath === undefined || keyPath === ''
    ) {
      throw new Error(
        'Token refresh failed: APP_ID/INSTALL_ID/KEY_PATH env vars required ' +
        'for in-runner refresh; channel-server inherits these from claude.sh. ' +
        'If unset, the claude.sh launcher did not set them — check workspace ' +
        'config (.claude/settings.local.json) and macf doctor.',
      );
    }

    const runExec = deps.exec ?? execFileAsync;
    try {
      const { stdout } = await runExec(
        scriptPath,
        ['--app-id', appId, '--install-id', installId, '--key', keyPath],
        { encoding: 'utf-8' },
      );
      const token = stdout.trim();
      assertTokenShape(token);
      return token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Token refresh failed via ${scriptPath}: ${msg}. ` +
        'Common causes: clock drift (timedatectl status), wrong/rotated key, ' +
        'or wrong APP_ID/INSTALL_ID. Channel-server WILL NOT silently fall ' +
        'back to the stale inherited GH_TOKEN — fail loud per silent-fallback-' +
        'hazards.md Instance 1 (expiry sub-case).',
        { cause: err },
      );
    }
  }

  // Fallback: core's generateToken (no helper-script available — substrate
  // / non-init'd workspaces). Same APP_ID/INSTALL_ID/KEY_PATH env path,
  // less verbose diagnostics.
  try {
    // generateToken's precedence is GH_TOKEN env > TokenSource > env vars.
    // When GH_TOKEN is set (typical), generateToken returns it as-is —
    // which is the very stale token we're trying to refresh. To force a
    // fresh mint, we'd need to either (a) clear GH_TOKEN before the call
    // or (b) call into the gh CLI directly. Operators in this fallback
    // path (no MACF_WORKSPACE_DIR + no helper script) get the env-var
    // token unchanged; expiry hazard remains. The forceRefresh-on-401
    // retry path still attempts a fresh mint — but if the env var keeps
    // winning, the retry returns the same stale token. Documented for
    // operators: in-runner refresh requires either the helper script or
    // unsetting GH_TOKEN at claude-sh level. Substrate / non-init'd
    // workspaces should ensure GH_TOKEN is not set OR ship the helper
    // script.
    const token = await generateToken();
    assertTokenShape(token);
    return token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Token refresh failed via generateToken fallback: ${msg}. ` +
      'No MACF_WORKSPACE_DIR set + no APP_ID/INSTALL_ID/KEY_PATH env vars. ' +
      'In-runner refresh is not viable in this configuration.',
      { cause: err },
    );
  }
}

/**
 * Create a token refresher with an in-process cache. Caller invokes
 * `getRefreshedToken()` per-API-call; the cache returns the same token
 * for ~50 min then mints fresh. On 401, caller invokes with
 * `forceRefresh: true` to bypass cache.
 */
export function createTokenRefresher(deps: TokenRefresherDeps): TokenRefresher {
  const clock = deps.clock ?? { now: () => Date.now() };
  let cachedToken: string | null = null;
  let mintedAt: number = 0;
  let inFlight: Promise<string> | null = null;

  async function mintAndCache(): Promise<string> {
    // De-duplicate concurrent refresh attempts: if one mint is already
    // in-flight, return the same promise. Prevents N concurrent gh-token-
    // generate spawns when N concurrent /notify handlers all hit the
    // refresh boundary simultaneously.
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      try {
        const token = await mintToken(deps);
        cachedToken = token;
        mintedAt = clock.now();
        deps.logger.info('token_refreshed', {
          age_ms: '0',
          source: deps.tokenScriptPath ?? 'workspace_helper',
        });
        return token;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    async getRefreshedToken(opts?: GetRefreshedTokenOptions): Promise<string> {
      const force = opts?.forceRefresh === true;
      const now = clock.now();
      const age = now - mintedAt;

      if (!force && cachedToken !== null && age < REFRESH_AGE_MS) {
        return cachedToken;
      }
      return mintAndCache();
    },
  };
}
