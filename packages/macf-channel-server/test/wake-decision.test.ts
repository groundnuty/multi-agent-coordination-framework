/**
 * Tests for `decideWake` (macf#351) — pure-function discriminator that
 * tells the receiver-side `/notify` handler whether to call wakeViaTmux.
 *
 * The two security-load-bearing properties under test:
 *
 *   1. **Pattern E preservation.** Stop-hook autonomous flows post a
 *      peer_notification WITHOUT `wake` (or with `wake: false`). The
 *      decision MUST be `skip` so receivers don't fire a fresh turn,
 *      which would re-trigger their own Stop hooks → cross-agent loop
 *      (macf#267 Option d).
 *
 *   2. **Wake opt-in for operator-driven flows (macf#351).** When a
 *      peer_notification arrives with `wake: true`, the decision MUST
 *      be `wake`. Operator-driven invocations (slash-command in
 *      macf#350) need the receiver TUI to show the notification
 *      visibly without a context switch.
 *
 * A regression test pins the no-`wake`-field case (the on-the-wire
 * form Stop-hook hooks produce — `wake` field omitted entirely from
 * the POST body) so any future refactor that conflates "field absent"
 * with "field=true" trips this test.
 */
import { describe, it, expect } from 'vitest';
import { decideWake } from '../src/wake-decision.js';

describe('decideWake (macf#351)', () => {
  describe('peer_notification — Pattern E (default skip)', () => {
    it('skips wake when wake field is absent (Stop-hook autonomous flow)', () => {
      // Regression test: hooks.json `Stop` entry never sets `wake` —
      // this is the on-the-wire form for the autonomous flow. MUST be
      // `skip` to keep cross-agent Stop-hook loop prevention intact.
      const decision = decideWake({
        type: 'peer_notification',
        source: 'tester-1',
        event: 'session-end',
      });
      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('peer_notification_observational');
    });

    it('skips wake when wake is explicitly false', () => {
      const decision = decideWake({
        type: 'peer_notification',
        source: 'tester-1',
        event: 'session-end',
        wake: false,
      });
      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('peer_notification_observational');
    });
  });

  describe('peer_notification — wake opt-in (macf#351)', () => {
    it('wakes when wake is explicitly true', () => {
      const decision = decideWake({
        type: 'peer_notification',
        source: 'operator',
        event: 'custom',
        message: 'operator typed: notify code-agent that ...',
        wake: true,
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('peer_notification_wake_opt_in');
    });
  });

  describe('non-peer notify types — wake by default', () => {
    it('wakes for issue_routed', () => {
      const decision = decideWake({
        type: 'issue_routed',
        issue_number: 42,
        title: 'fix the thing',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });

    it('wakes for mention', () => {
      const decision = decideWake({
        type: 'mention',
        message: 'You were mentioned in #99',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });

    it('wakes for ci_completion', () => {
      const decision = decideWake({
        type: 'ci_completion',
        pr_number: 100,
        conclusion: 'success',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });

    it('wakes for pr_review_state', () => {
      const decision = decideWake({
        type: 'pr_review_state',
        review_state: 'approved',
        reviewer_login: 'reviewer[bot]',
        pr_number: 200,
        pr_url: 'https://github.com/x/y/pull/200',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });

    it('wakes for startup_check', () => {
      const decision = decideWake({
        type: 'startup_check',
        message: 'pending issues found',
      });
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });

    it('ignores wake field on non-peer types (no spillover)', () => {
      // Pin: `wake` is peer_notification-only. If a non-peer payload
      // happens to carry wake=false, it MUST still wake (the field is
      // not part of those variants' contract). This guards against a
      // future refactor that treats wake==false as a global skip.
      const decision = decideWake({
        type: 'issue_routed',
        issue_number: 42,
        wake: false,
      } as never);
      expect(decision.action).toBe('wake');
      expect(decision.reason).toBe('standard_notify_type');
    });
  });
});
