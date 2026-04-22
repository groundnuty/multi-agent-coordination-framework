/**
 * Content guard for plugin/rules/coordination.md (#100).
 *
 * The Issue Lifecycle rule needs to cover BOTH failure modes:
 *   - don't close issues filed by someone else (via auto-close keywords or
 *     manual `gh issue close`)
 *   - DO close issues you filed yourself after your PR merges, don't post a
 *     reflexive "ready for you to close" handoff to nobody
 *
 * Observed precedent: session on 2026-04-16 — code-agent filed 7 audit
 * issues, merged all PRs, and posted handoff comments on each. Queue sat
 * at 7 open in-review until the user pointed it out.
 *
 * This test pins the content so the rule doesn't drift out.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rulesPath = join(repoRoot, 'plugin', 'rules', 'coordination.md');

function body(): string {
  return readFileSync(rulesPath, 'utf-8');
}

describe('coordination.md — Issue Lifecycle rule covers both failure modes (#100)', () => {
  it('states that reporter owns closure', () => {
    expect(body()).toMatch(/reporter (owns|of an issue) (the |)?(issue|clos)/i);
  });

  it('states explicitly that if YOU opened it, YOU close it', () => {
    // Prior wording only covered "don't close others' issues". New wording
    // must cover the self-close case so agents stop posting handoff
    // comments on their own issues.
    const text = body();
    const hasSelfClose =
      /\bclose (it|your own|the issue) (yourself|your)/i.test(text) ||
      /you (opened|filed|reported).*(?:you|reporter).*close/is.test(text) ||
      /if you opened/i.test(text);
    expect(hasSelfClose, 'coordination.md must state that the reporter closes their own issue after merge').toBe(true);
  });

  it('lists all 9 auto-close keyword variants', () => {
    const text = body();
    const variants = [
      'Closes', 'Fixes', 'Resolves',
      'Close', 'Fix', 'Resolve',
      'Closed', 'Fixed', 'Resolved',
    ];
    for (const v of variants) {
      expect(text, `coordination.md should mention auto-close keyword "${v}"`).toContain(v);
    }
  });

  it('recommends "Refs #N" as the safe alternative', () => {
    expect(body()).toMatch(/Refs #N/);
  });

  it('includes the reporter self-check recipe', () => {
    // `gh issue view <N> --json author --jq '.author.login'`
    expect(body()).toMatch(/gh issue view.*--json author/);
    expect(body()).toMatch(/\.author\.login/);
  });
});

describe('coordination.md — issue body frozen during active work (#141)', () => {
  it('codifies the body-freeze rule', () => {
    const text = body();
    expect(text).toMatch(/body (is frozen|is the assignee['s]+ working spec|should not be edited)/i);
  });

  it('names the triggers that freeze the body', () => {
    const text = body();
    expect(text).toMatch(/in-progress|in-review|picking up|actively working/i);
  });

  it('names comments as the channel for scope changes', () => {
    const text = body();
    expect(text).toMatch(/follow-up comment|thread comment|issue comment/i);
  });

  it('allows assignee to edit their own body', () => {
    const text = body();
    expect(text).toMatch(/assignee.*editing.*own|own issue body/i);
  });
});

describe('coordination.md — verify comment actually posted (#143)', () => {
  it('states that describing ≠ doing', () => {
    const text = body();
    expect(text).toMatch(
      /describing.*not.*doing|describing.*not.*posting|writing.*is not.*posting|chat output is invisible|prose.*not.*same as posting/i,
    );
  });

  it('names the canonical verification command', () => {
    const text = body();
    expect(text).toMatch(/gh issue view.*--json comments/);
    expect(text).toMatch(/author\.login/);
  });

  it('treats the check as mandatory, not optional', () => {
    const text = body();
    expect(text).toMatch(/mandatory tail|not.*optional|treat this as (mandatory|required)/i);
  });
});

describe('coordination.md — auto-opened issue handling (#164)', () => {
  it('differentiates bot-reporter from peer-reporter rules', () => {
    const text = body();
    expect(text).toMatch(/auto-opened|github-actions\[bot\]|non-human.*bot/i);
  });

  it('forbids Closes keyword on bot-filed issues', () => {
    const text = body();
    expect(text).toMatch(/Refs.*not.*Closes|don't use.*auto-close|not `Closes/i);
  });

  it('routes reviews to reviewer, not echoes back to the bot-reporter', () => {
    const text = body();
    expect(text).toMatch(/don't echo.*@mention|not by echoing|route.*to.*@macf-science-agent/i);
  });

  it('waits for next-run verification before closing', () => {
    const text = body();
    expect(text).toMatch(/next.*auto-run|post-merge.*confirm|next.*run.*green|wait for the next auto-run/i);
  });
});
