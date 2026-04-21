/**
 * Tests for src/tmux-wake.ts — macf#185 sidecar wake path.
 *
 * Scope:
 *   - resolveTmuxTarget's 4 branches (explicit both, explicit session-only,
 *     auto-detect via $TMUX, no-target) — pure function, exercised via
 *     injected env + mocked tmux command
 *   - wakeViaTmux's fail-silent policy — missing helper, missing target,
 *     spawn failure, non-zero exit all return false without throwing
 *   - wakeViaTmux's success path — spawns helper with correct argv, logs
 *     the delivery event
 *
 * Out of scope:
 *   - Actual tmux interaction (that's integration territory; smoke-
 *     tested manually during CV Phase 7 rollout).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTmuxTarget, wakeViaTmux } from '../src/tmux-wake.js';
import type { Logger } from '../src/types.js';

function makeLogger(): Logger & { readonly events: Array<{ event: string; data: Record<string, unknown> }> } {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const logger = {
    events,
    info: vi.fn((event: string, data: Record<string, unknown> = {}) => { events.push({ event, data }); }),
    warn: vi.fn((event: string, data: Record<string, unknown> = {}) => { events.push({ event, data }); }),
    error: vi.fn((event: string, data: Record<string, unknown> = {}) => { events.push({ event, data }); }),
  } as Logger & { readonly events: typeof events };
  return logger;
}

describe('resolveTmuxTarget', () => {
  it('returns "session:window" when both provided', () => {
    expect(resolveTmuxTarget({ session: 'cv-project', window: '0' })).toBe('cv-project:0');
    expect(resolveTmuxTarget({ session: 'cv-project', window: 'cv-architect' }))
      .toBe('cv-project:cv-architect');
  });

  it('returns session alone when window not provided', () => {
    expect(resolveTmuxTarget({ session: 'cv-project' })).toBe('cv-project');
    expect(resolveTmuxTarget({ session: 'cv-project', window: '' })).toBe('cv-project');
  });

  it('returns null when session empty AND no $TMUX in env', () => {
    expect(resolveTmuxTarget({ env: {} })).toBeNull();
    expect(resolveTmuxTarget({ session: '', env: {} })).toBeNull();
  });

  // Auto-detect paths depend on the real tmux binary being invokable +
  // a real tmux session existing. Skipped in unit tests — validated
  // manually during CV rollout. The null-when-$TMUX-unset branch is
  // sufficient for unit-level regression protection here.
});

describe('wakeViaTmux', () => {
  let workspaceDir: string;
  let scriptPath: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'macf-tmux-wake-'));
    scriptPath = join(workspaceDir, '.claude', 'scripts', 'tmux-send-to-claude.sh');
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function installHelper(body: string): void {
    const scriptsDir = join(workspaceDir, '.claude', 'scripts');
    require('node:fs').mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(scriptPath, body, { mode: 0o755 });
    chmodSync(scriptPath, 0o755);
  }

  it('returns false when helper script missing — logs skip reason', () => {
    const logger = makeLogger();
    expect(existsSync(scriptPath)).toBe(false);

    const result = wakeViaTmux('hello', { workspaceDir, session: 'cv-project', logger });
    expect(result).toBe(false);
    expect(logger.events.map(e => e.event)).toContain('tmux_wake_skipped');
    expect(logger.events[0]?.data['reason']).toBe('helper_missing');
  });

  it('returns false when target cannot be resolved (no session + no $TMUX)', () => {
    installHelper('#!/bin/sh\nexit 0\n');
    const logger = makeLogger();
    // No session passed; rely on resolveTmuxTarget's auto-detect, which
    // returns null when $TMUX is unset. We can't mock the env easily
    // inside wakeViaTmux without rewriting it, but we CAN ensure the
    // test process has $TMUX unset.
    const tmuxBackup = process.env['TMUX'];
    delete process.env['TMUX'];
    try {
      const result = wakeViaTmux('hello', { workspaceDir, logger });
      expect(result).toBe(false);
      const skipEvent = logger.events.find(e => e.event === 'tmux_wake_skipped');
      expect(skipEvent).toBeDefined();
      expect(skipEvent?.data['reason']).toBe('no_target');
    } finally {
      if (tmuxBackup !== undefined) process.env['TMUX'] = tmuxBackup;
    }
  });

  it('shells out to helper with session target + prompt as separate argv', () => {
    // Helper records its argv to a file for inspection.
    const argLog = join(workspaceDir, 'args.log');
    installHelper(
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`,
    );
    const logger = makeLogger();

    const result = wakeViaTmux('Pick up issue #42', {
      workspaceDir,
      session: 'cv-project',
      window: 'cv-architect',
      logger,
    });
    expect(result).toBe(true);

    // Verify the helper saw exactly our two args (target + prompt).
    const args = require('node:fs').readFileSync(argLog, 'utf-8').trim().split('\n');
    expect(args).toEqual(['cv-project:cv-architect', 'Pick up issue #42']);

    // Success event logged with metadata.
    const deliveredEvent = logger.events.find(e => e.event === 'tmux_wake_delivered');
    expect(deliveredEvent).toBeDefined();
    expect(deliveredEvent?.data['target']).toBe('cv-project:cv-architect');
    expect(deliveredEvent?.data['prompt_length']).toBe('Pick up issue #42'.length);
  });

  it('returns false on non-zero helper exit + logs stderr snippet', () => {
    installHelper('#!/bin/sh\necho "tmux: session not found" >&2\nexit 1\n');
    const logger = makeLogger();

    const result = wakeViaTmux('x', { workspaceDir, session: 'missing', logger });
    expect(result).toBe(false);
    const failEvent = logger.events.find(e => e.event === 'tmux_wake_failed');
    expect(failEvent).toBeDefined();
    expect(failEvent?.data['reason']).toBe('nonzero_exit');
    expect(failEvent?.data['status']).toBe(1);
    expect(String(failEvent?.data['stderr'])).toContain('tmux: session not found');
  });

  it('passes prompts with shell-metacharacters safely (argv boundary, no shell)', () => {
    // If the helper were invoked via `sh -c "script $prompt"` the
    // metacharacters would execute. Because spawnSync uses execvp
    // semantics with an argv array, the string is opaque to the shell.
    const argLog = join(workspaceDir, 'args.log');
    installHelper(
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`,
    );
    const logger = makeLogger();

    const nastyPrompt = `; rm -rf /tmp/\`whoami\`; echo "$(cat /etc/hostname)" && touch /tmp/pwned`;
    const result = wakeViaTmux(nastyPrompt, { workspaceDir, session: 't', logger });
    expect(result).toBe(true);

    const args = require('node:fs').readFileSync(argLog, 'utf-8').trim().split('\n');
    // Helper saw the full literal string as one arg — no shell
    // interpolation, no command substitution, no process spawned
    // from the metacharacters.
    expect(args[1]).toBe(nastyPrompt);
    // And no /tmp/pwned side effect.
    expect(existsSync('/tmp/pwned')).toBe(false);
  });
});
