/**
 * Tests for `scripts/check-mention-routing.sh` — the PreToolUse hook
 * that structurally blocks `gh (issue|pr) comment` invocations whose
 * `--body` content contains raw `@<bot>[bot]` mentions in describing
 * contexts (mid-line, not backticked). Implements
 * `plugin/rules/mention-routing-hygiene.md` §5 enforcement.
 *
 * Background (groundnuty/macf#244 + #272): science-agent recorded 5+
 * routing-hygiene class breaches in 2 days (`observation_self_canonical_
 * rule_breaches.md` → public research at `macf-science-agent:research/
 * 2026-04-27-self-observed-canonical-rule-breach-pattern-analysis.md`).
 * Codification alone produced ~80% catch rate; structural defense is
 * load-bearing for the remaining 20%.
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 = allow, exit 2 =
 * block (stderr → Claude as the error). Override: MACF_SKIP_MENTION_CHECK=1.
 *
 * Heuristic per design synthesis:
 *   - Backticked `@<bot>[bot]` → allowed (describing form §5)
 *   - Line-start `@<bot>[bot]` after optional whitespace/blockquote/
 *     list-marker → allowed (addressing form §3)
 *   - Else → BLOCK
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'scripts', 'check-mention-routing.sh');

/**
 * Spawn the hook with a JSON stdin payload + env overrides. Mirrors the
 * shape of check-gh-token.test.ts so future hook authors recognize it.
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
  // Preserve PATH so bash/jq/awk resolve. Scrub MACF_* unless explicitly
  // set in opts.env so ambient overrides from the test runner don't leak.
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

describe('check-mention-routing.sh (hook)', () => {
  describe('positive path — non-comment commands pass through', () => {
    it('allows `gh issue view` (no body to validate)', () => {
      const r = runHook({ command: 'gh issue view 272' });
      expect(r.status).toBe(0);
    });

    it('allows `gh issue list` (no body to validate)', () => {
      const r = runHook({ command: 'gh issue list --label code-agent' });
      expect(r.status).toBe(0);
    });

    it('allows `gh pr view` (no body to validate)', () => {
      const r = runHook({ command: 'gh pr view 244' });
      expect(r.status).toBe(0);
    });

    it('allows `git push` (different command axis)', () => {
      const r = runHook({ command: 'git push -u origin main' });
      expect(r.status).toBe(0);
    });

    it('allows non-gh commands entirely', () => {
      const r = runHook({ command: 'make -f dev.mk check' });
      expect(r.status).toBe(0);
    });

    it('allows `gh issue close` without --comment (no body posted)', () => {
      const r = runHook({ command: 'gh issue close 272 --reason completed' });
      expect(r.status).toBe(0);
    });
  });

  describe('positive path — addressing form is allowed', () => {
    it('allows line-start `@<bot>[bot]` in heredoc body (canonical addressing)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\n@macf-science-agent[bot] PR ready for review.\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });

    it('allows list-item-prefixed `@<bot>[bot]` (bullet-as-addressing)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\n- @macf-science-agent[bot] please review\n- @macf-code-agent[bot] please implement\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });

    it('allows blockquoted line-start `@<bot>[bot]`', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\n> @macf-science-agent[bot] (quoted from earlier thread, raw OK)\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });
  });

  describe('positive path — backticked describing form is allowed', () => {
    it('allows backticked `@<bot>[bot]` mid-line (canonical describing §5)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe `@macf-tester-1-agent[bot]` response was clean.\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });

    it('allows backticked `@<bot>[bot]` mixed with addressing in same body', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nObservation: the `@macf-tester-1-agent[bot]` reply quoted rule §1.\n\n@macf-science-agent[bot] confirming this matches your read?\nEOF\n)"',
      });
      expect(r.status).toBe(0);
    });
  });

  describe('negative path — describing-context leak blocks', () => {
    it('blocks mid-line raw `@<bot>[bot]` in describing prose', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/mention-routing-hygiene/);
      expect(r.stderr).toMatch(/MACF_SKIP_MENTION_CHECK/);
    });

    it('blocks mid-line raw `@<bot>[bot]` after a sentence-starter', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nObserved that @macf-code-agent[bot] posted handoff at 12:00Z.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
    });

    it('blocks `gh pr comment` describing-leak (same shape, pr instead of issue)', () => {
      const r = runHook({
        command:
          'gh pr comment 99 --body "$(cat <<EOF\nThe @macf-tester-2-agent[bot] PR was reviewed clean.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
    });
  });

  describe('wrapper-aware matching (bypass prevention)', () => {
    it('blocks `sudo gh issue comment` with describing-leak', () => {
      const r = runHook({
        command:
          'sudo gh issue comment 123 --body "Mid-line @macf-bot-agent[bot] reference."',
      });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -c "gh issue comment ..."` with describing-leak', () => {
      const r = runHook({
        command:
          'bash -c \'gh issue comment 123 --body "Mid-line @macf-bot-agent[bot] reference."\'',
      });
      expect(r.status).toBe(2);
    });

    it('blocks `env FOO=bar gh issue comment` with describing-leak', () => {
      const r = runHook({
        command:
          'env FOO=bar gh issue comment 123 --body "Mid-line @macf-bot-agent[bot] reference."',
      });
      expect(r.status).toBe(2);
    });
  });

  describe('override path — MACF_SKIP_MENTION_CHECK=1 bypasses', () => {
    it('allows describing-leak when MACF_SKIP_MENTION_CHECK=1', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
        env: { MACF_SKIP_MENTION_CHECK: '1' },
      });
      expect(r.status).toBe(0);
    });

    it('does NOT bypass on MACF_SKIP_MENTION_CHECK=0 (only "1" overrides)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
        env: { MACF_SKIP_MENTION_CHECK: '0' },
      });
      expect(r.status).toBe(2);
    });
  });

  describe('--body-file path', () => {
    it('allows `gh issue comment ... --body-file path` (file content not lintable)', () => {
      // The hook intentionally skips file-based body — content not
      // available at hook-fire time. Operator discipline + the canonical
      // rule cover this.
      const r = runHook({
        command: 'gh issue comment 123 --body-file /tmp/comment.md',
      });
      expect(r.status).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('handles empty body (no @ mentions at all)', () => {
      const r = runHook({
        command: 'gh issue comment 123 --body "Just a status update, no mentions."',
      });
      expect(r.status).toBe(0);
    });

    it('handles body with no agent handles (only non-bot @ refs)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "Mention @somebody (not a bot pattern) in passing."',
      });
      expect(r.status).toBe(0);
    });

    it('does not match similar-looking patterns without [bot] suffix', () => {
      const r = runHook({
        command: 'gh issue comment 123 --body "Reference @macf-code-agent without bot suffix."',
      });
      expect(r.status).toBe(0);
    });

    it('handles digit-suffixed handles (e.g. macf-tester-1-agent)', () => {
      // Verifies the regex character class includes digits — earlier
      // iteration of the canonical rule's regex (`[a-z-]+`) missed this.
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nThe @macf-tester-1-agent[bot] response was clean.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
    });

    it('reports which line offended in stderr (operator orientation)', () => {
      const r = runHook({
        command:
          'gh issue comment 123 --body "$(cat <<EOF\nLine one is fine.\nLine two has @macf-bot-agent[bot] mid-line leak.\nLine three is fine.\nEOF\n)"',
      });
      expect(r.status).toBe(2);
      // The hook prints `<line_no>: <line_text>` for each offending line.
      // Don't assert exact line number (depends on shell heredoc parsing),
      // but the offending line text must appear.
      expect(r.stderr).toMatch(/has @macf-bot-agent\[bot\] mid-line leak/);
    });

    it('falls through to allow on parse error (defense-in-depth)', () => {
      // A broken or non-JSON payload should not brick the harness — the
      // hook must fail open. Same convention as check-gh-token.sh.
      const r = spawnSync('bash', [HOOK_SCRIPT], {
        input: 'not-json-at-all',
        env: { PATH: process.env['PATH'] ?? '' },
        encoding: 'utf-8',
      });
      expect(r.status).toBe(0);
    });
  });
});
