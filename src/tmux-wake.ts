/**
 * Programmatic prompt injection into a running Claude Code TUI via the
 * canonical `tmux-send-to-claude.sh` helper — "sidecar wake" sibling to
 * the MCP notification push.
 *
 * Background (macf#185):
 *
 *   Phase 7's mTLS /notify delivery works end-to-end: routing Action
 *   mTLS-POSTs to a peer agent's channel server, server receives the
 *   payload, pushes it through the MCP channel. But Claude Code's
 *   running TUI never sees the notification as a new prompt — the MCP
 *   push deposits data into the channel-server-observable state,
 *   doesn't interrupt the running session with a fresh prompt.
 *
 *   Users expected /notify to "wake the agent to work on the new
 *   thing." What actually happened: the /notify was queue-deposit, not
 *   wake. Agents only processed new work when the human operator
 *   manually ran `tmux-send-to-claude.sh` (or killed + relaunched the
 *   TUI so the SessionStart auto-pickup hook fired).
 *
 * Fix shape (this module):
 *
 *   Extend the `onNotify` callback chain with a second step — after
 *   the MCP push completes, shell out to `tmux-send-to-claude.sh` with
 *   a human-readable prompt synthesized from the NotifyPayload. The
 *   running Claude TUI receives the prompt text in its input buffer
 *   just as if the operator had typed it, and processes it as the
 *   next turn.
 *
 * Target discovery:
 *
 *   1. Explicit via `MACF_TMUX_SESSION` / `MACF_TMUX_WINDOW` env
 *      (sourced from `macf-agent.json`'s `tmux_session` /
 *      `tmux_window` fields, emitted by `claude.sh`). Operator-
 *      declared target.
 *   2. Auto-detect from `TMUX` env + `tmux display-message -p`. Works
 *      when the server was launched from within a tmux pane (the
 *      canonical MACF launch pattern: `tmux new -d -s cv-architect
 *      './claude.sh'`). Zero-config for this case.
 *   3. Neither available → no-op, return `false`. /notify's 200
 *      response reflects "accepted into MCP", not "delivered to
 *      human TUI" — operators without tmux get the MCP notification
 *      in the channel-server state + the old manual-check UX.
 *
 * Fail-silent policy:
 *
 *   Every error path (missing helper script, tmux not installed, pane
 *   gone, exit-code-nonzero) logs at debug level + returns `false`.
 *   Never throws. /notify's contract with the caller is unaffected —
 *   we return 200 regardless of wake-path outcome.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './types.js';

export interface WakeOptions {
  /** Workspace root for locating `.claude/scripts/tmux-send-to-claude.sh`. */
  readonly workspaceDir: string;
  /** Explicit tmux session name (e.g. "cv-project"). Optional. */
  readonly session?: string;
  /** Explicit tmux window index/name (e.g. "0", "cv-architect"). Optional. */
  readonly window?: string;
  /** Debug logger. Info/warn events on success paths; debug on skips. */
  readonly logger: Logger;
}

/**
 * Build the `tmux-send-to-claude.sh` target argument from explicit env
 * + auto-detection fallback. Returns the target string to pass as the
 * script's first arg, or `null` if no target resolvable.
 *
 *   session + window set     → "session:window"
 *   session only             → "session"
 *   neither + $TMUX present  → auto-detect via `tmux display-message`
 *   neither + no $TMUX       → null (no-op)
 *
 * Exported for unit tests.
 */
export function resolveTmuxTarget(opts: {
  readonly session?: string;
  readonly window?: string;
  readonly env?: NodeJS.ProcessEnv;
}): string | null {
  const env = opts.env ?? process.env;
  if (opts.session !== undefined && opts.session !== '') {
    const target = opts.window !== undefined && opts.window !== ''
      ? `${opts.session}:${opts.window}`
      : opts.session;
    return target;
  }

  // Auto-detect: only if launched from inside tmux.
  if (!env['TMUX']) return null;
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '#{session_name}:#{window_index}'], {
      encoding: 'utf-8',
      // Tight timeout — tmux display-message is instant locally.
      timeout: 2000,
    });
    const target = out.trim();
    // display-message returns ":0" or similar when no session context
    // is available; guard against those degenerate cases.
    if (target === '' || target.startsWith(':')) return null;
    return target;
  } catch {
    return null;
  }
}

/**
 * Wake a running Claude Code TUI by injecting a prompt via the
 * canonical tmux helper. Returns `true` when the helper ran
 * successfully, `false` on any no-op or error path.
 *
 * `prompt` is text-only — becomes the TUI's next input. Newlines,
 * quotes, shell-metacharacters are all safe because we pass the
 * prompt as a separate argv to the helper (no shell interpolation).
 */
export function wakeViaTmux(prompt: string, opts: WakeOptions): boolean {
  const scriptPath = join(opts.workspaceDir, '.claude', 'scripts', 'tmux-send-to-claude.sh');
  if (!existsSync(scriptPath)) {
    opts.logger.info('tmux_wake_skipped', {
      reason: 'helper_missing',
      path: scriptPath,
    });
    return false;
  }

  const target = resolveTmuxTarget({ session: opts.session, window: opts.window });
  if (target === null) {
    opts.logger.info('tmux_wake_skipped', {
      reason: 'no_target',
      detail: 'MACF_TMUX_SESSION unset and $TMUX auto-detect unavailable',
    });
    return false;
  }

  const result = spawnSync(scriptPath, [target, prompt], {
    encoding: 'utf-8',
    // Helper sleeps 1s between the two Enters; give headroom for
    // pane startup + tmux IPC.
    timeout: 10_000,
  });

  if (result.error !== undefined) {
    opts.logger.warn('tmux_wake_failed', {
      reason: 'spawn_error',
      error: result.error.message,
    });
    return false;
  }
  if (result.status !== 0) {
    opts.logger.warn('tmux_wake_failed', {
      reason: 'nonzero_exit',
      status: result.status,
      stderr: result.stderr.slice(0, 200),
    });
    return false;
  }

  opts.logger.info('tmux_wake_delivered', {
    target,
    prompt_length: prompt.length,
  });
  return true;
}
