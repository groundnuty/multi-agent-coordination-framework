/**
 * Tests for `scripts/check-gh-token.sh` — the PreToolUse hook that
 * structurally blocks `gh` / `git push` invocations when `GH_TOKEN`
 * is missing or isn't a bot installation token (`ghs_` prefix).
 *
 * Background (#140): behavioral controls for the attribution trap
 * recurred 5 times in a single day. This hook moves enforcement
 * from operator discipline to the harness itself.
 *
 * The hook receives JSON on stdin per Claude Code's PreToolUse
 * contract: `{ tool_name, tool_input: { command }, ... }`.
 * Exit 0 = allow, exit 2 = block (stderr → Claude as error).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'scripts', 'check-gh-token.sh');

/**
 * Spawn the hook with a JSON stdin payload + env overrides.
 * Returns the raw spawn result for exit-code + stderr assertions.
 */
function runHook(opts: {
  readonly command: string;
  readonly env?: Record<string, string | undefined>;
}): ReturnType<typeof spawnSync> {
  const payload = JSON.stringify({
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: opts.command },
  });
  // Preserve PATH so bash/jq resolve, but scrub GH_TOKEN/MACF_* unless
  // explicitly set in opts.env. Otherwise ambient GH_TOKEN from the
  // test runner leaks in and masks the negative cases.
  const cleanEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
  };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }
  }
  return spawnSync('bash', [HOOK_SCRIPT], {
    input: payload,
    env: cleanEnv,
    encoding: 'utf-8',
  });
}

describe('check-gh-token.sh (hook)', () => {
  describe('positive path — valid ghs_ token', () => {
    it('allows `gh issue view` when GH_TOKEN starts with ghs_', () => {
      const r = runHook({
        command: 'gh issue view 140',
        env: { GH_TOKEN: 'ghs_faketokenvalue1234567890' },
      });
      expect(r.status).toBe(0);
    });

    it('allows `git push` when GH_TOKEN starts with ghs_', () => {
      const r = runHook({
        command: 'git push origin main',
        env: { GH_TOKEN: 'ghs_faketokenvalue1234567890' },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('negative path — missing or wrong-prefix token', () => {
    it('blocks `gh issue view` when GH_TOKEN is unset', () => {
      const r = runHook({
        command: 'gh issue view 140',
        env: {}, // GH_TOKEN deliberately absent
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/macf-gh-token\.sh/);
    });

    it('blocks `gh issue close` when GH_TOKEN is empty', () => {
      const r = runHook({
        command: 'gh issue close 140',
        env: { GH_TOKEN: '' },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
    });

    it('blocks when GH_TOKEN has user-token prefix (ghp_)', () => {
      const r = runHook({
        command: 'gh pr create',
        env: { GH_TOKEN: 'ghp_personalaccesstokenvalue123' },
      });
      expect(r.status).toBe(2);
    });

    it('blocks when GH_TOKEN has oauth-token prefix (gho_)', () => {
      const r = runHook({
        command: 'gh api user',
        env: { GH_TOKEN: 'gho_oauthtokenvalue1234567890' },
      });
      expect(r.status).toBe(2);
    });

    it('blocks `git push` when GH_TOKEN is unset', () => {
      const r = runHook({
        command: 'git push -u origin HEAD',
        env: {},
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
    });
  });

  describe('wrapper-aware matching (bypass prevention)', () => {
    it('blocks `sudo gh issue close` when token is bad', () => {
      const r = runHook({
        command: 'sudo gh issue close 140',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `GH_TOKEN=x gh ...` (inline env prefix) when outer token is bad', () => {
      // Inline env assignment doesn't rescue us — the hook runs in
      // Claude's process context, where the outer GH_TOKEN is what
      // counts. The inline assignment would only affect the child.
      const r = runHook({
        command: 'GH_TOKEN=ghp_useronly gh pr merge 99',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `env FOO=bar gh ...` when token is bad', () => {
      const r = runHook({
        command: 'env FOO=bar gh issue list',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `make && sudo gh issue close` (chained wrapper)', () => {
      const r = runHook({
        command: 'make && sudo gh issue close 140',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `watch gh run list` when token is bad', () => {
      const r = runHook({
        command: 'watch gh run list',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    // Shell-wrapper bypass — caught by post-#140 audit. `bash -c "gh ..."`
    // and `sh -c '...'` invocations were a trivial bypass in the original
    // regex because `bash`/`sh` weren't in the wrapper allowlist and the
    // `gh` inside the quoted string wasn't preceded by an allowed
    // delimiter. The -c flag executes the quoted string AS A COMMAND,
    // so gh inside it IS an invocation (unlike `echo "gh is cool"` where
    // gh is just literal data).
    it('blocks `bash -c "gh issue close"` when token is bad (shell-wrapper bypass)', () => {
      const r = runHook({
        command: 'bash -c "gh issue close 42"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -c \'gh pr merge\'` (single-quoted form)', () => {
      const r = runHook({
        command: "bash -c 'gh pr merge 1'",
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `sh -c "gh api user"` when token is bad', () => {
      const r = runHook({
        command: 'sh -c "gh api user"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `sudo bash -c "gh issue close"` (chained shell wrapper)', () => {
      const r = runHook({
        command: 'sudo bash -c "gh issue close 42"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -lc "gh ..."` (login shell flag combined with -c)', () => {
      // `-lc` is a shorthand for `-l -c` that some operators use. The
      // regex tolerates the `l` prefix.
      const r = runHook({
        command: 'bash -lc "gh issue close 42"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `sh -c "git push origin main"` (git-push variant)', () => {
      const r = runHook({
        command: 'sh -c "git push origin main"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('still ALLOWS `echo "gh is cool"` (string-mention, not an invocation)', () => {
      // Regression guard — the shell-wrapper fix must not trip on
      // literal `gh` text inside non-executing quoted strings.
      const r = runHook({
        command: 'echo "gh is cool"',
        env: {},
      });
      expect(r.status).toBe(0);
    });
  });

  describe('override — MACF_SKIP_TOKEN_CHECK', () => {
    it('bypasses when MACF_SKIP_TOKEN_CHECK=1, even for gh with no token', () => {
      const r = runHook({
        command: 'gh issue close 1',
        env: { MACF_SKIP_TOKEN_CHECK: '1' },
      });
      expect(r.status).toBe(0);
    });
  });

  // `gh auth *` is identity-management; user-attribution is correct by
  // design, so the hook must not block it. Without this carve-out, the
  // first `gh auth login` in a fresh workspace hits a wall of text
  // before onboarding completes — per science-agent's #140 review.
  describe('carve-out — gh auth is exempt (identity management)', () => {
    it('allows `gh auth login` with no GH_TOKEN (onboarding path)', () => {
      const r = runHook({
        command: 'gh auth login',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `gh auth status` with no GH_TOKEN', () => {
      const r = runHook({
        command: 'gh auth status',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `gh auth token` with no GH_TOKEN', () => {
      const r = runHook({
        command: 'gh auth token',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `gh auth refresh` with no GH_TOKEN', () => {
      const r = runHook({
        command: 'gh auth refresh',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `gh auth setup-git` with no GH_TOKEN', () => {
      const r = runHook({
        command: 'gh auth setup-git',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `sudo gh auth login` (wrapped form) with no GH_TOKEN', () => {
      const r = runHook({
        command: 'sudo gh auth login',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('still BLOCKS `gh authorize-team` (not gh auth — similar prefix, different command)', () => {
      // Defensive: if someone ever adds a command called `authorize-team`
      // or similar, the carve-out should not leak. `gh auth` requires a
      // word boundary (space or end) after `auth`.
      const r = runHook({
        command: 'gh authorize-team foo',
        env: {},
      });
      expect(r.status).toBe(2);
    });
  });

  describe('no-op path — unrelated commands', () => {
    it('allows `ls -la` regardless of GH_TOKEN state', () => {
      const r = runHook({
        command: 'ls -la',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `echo "gh is cool"` (literal inside quoted string, not a gh call)', () => {
      const r = runHook({
        command: 'echo "gh is cool"',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `git status` (git but not git push)', () => {
      const r = runHook({
        command: 'git status',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `npm install` with no GH_TOKEN', () => {
      const r = runHook({
        command: 'npm install',
        env: {},
      });
      expect(r.status).toBe(0);
    });
  });

  describe('error message quality', () => {
    it('block message points at macf-gh-token.sh helper', () => {
      const r = runHook({
        command: 'gh issue view 1',
        env: {},
      });
      expect(r.stderr).toMatch(/macf-gh-token\.sh/);
    });

    it('block message mentions MACF_SKIP_TOKEN_CHECK override', () => {
      const r = runHook({
        command: 'gh issue view 1',
        env: {},
      });
      expect(r.stderr).toMatch(/MACF_SKIP_TOKEN_CHECK/);
    });

    it('block message surfaces the offending command', () => {
      const r = runHook({
        command: 'gh issue close 42',
        env: {},
      });
      expect(r.stderr).toContain('gh issue close 42');
    });
  });
});
