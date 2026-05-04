/**
 * Pure-function wake-decision for the `/notify` receiver-side handler.
 *
 * Extracted from `server.ts` `onNotify` (macf#351) so the discriminator
 * is unit-testable without spinning up the HTTPS server. The receiver's
 * decision tree is small but security-load-bearing — Pattern E
 * (macf#267 Option d) prevents the cross-agent Stop-hook ping-pong loop,
 * and the wake-opt-in path (macf#351) is the operator-driven escape
 * hatch.
 *
 * Decision rule (in order):
 *
 *   1. `peer_notification` with `wake !== true` → SKIP tmux wake
 *      (Pattern E; observational-only delivery).
 *   2. `peer_notification` with `wake === true` → WAKE via tmux
 *      (operator opted in; loop hazard does not apply when trigger is
 *      a human, not a Stop hook).
 *   3. Any other NotifyType (issue_routed, mention, ci_completion,
 *      pr_review_state, startup_check) → WAKE via tmux (existing
 *      behavior — these variants always wake the receiver).
 *
 * Returns the action + a structured reason for log/observability.
 */
import type { NotifyPayload } from '@groundnuty/macf-core';

export type WakeAction = 'wake' | 'skip';

export interface WakeDecision {
  readonly action: WakeAction;
  /** Stable string for log-event `reason` field; one per branch. */
  readonly reason:
    | 'peer_notification_observational'
    | 'peer_notification_wake_opt_in'
    | 'standard_notify_type';
}

export function decideWake(payload: NotifyPayload): WakeDecision {
  if (payload.type === 'peer_notification') {
    if (payload.wake === true) {
      return { action: 'wake', reason: 'peer_notification_wake_opt_in' };
    }
    return { action: 'skip', reason: 'peer_notification_observational' };
  }
  return { action: 'wake', reason: 'standard_notify_type' };
}
