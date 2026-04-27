import type { NotifyPayload } from '@groundnuty/macf-core';

/**
 * Render a NotifyPayload to the operator-facing content string that
 * gets pushed through MCP. Pure function — extracted from `onNotify`
 * in `server.ts` per ultrareview finding A6. Previously the renderer
 * lived inside a 58-line closure that also did logging, health-state
 * mutation, and MCP push; adding a new `NotifyPayload` variant meant
 * editing that closure. Extracting makes variant dispatch testable
 * in isolation.
 *
 * Returns the rendered content and the issue number the payload is
 * associated with (for health-state updates at the call site).
 */
export interface FormattedNotify {
  readonly content: string;
  readonly issueNumber?: number;
}

export function formatNotifyContent(payload: NotifyPayload): FormattedNotify {
  if (payload.type === 'issue_routed') {
    if (payload.issue_number !== undefined) {
      const suffix = payload.title ? `: ${payload.title}` : '';
      // Include `--repo <repo>` instruction when the producer
      // supplied origin-repo (macf-actions v3.2.0+, #30). Multi-homed
      // receivers otherwise fall back to cwd-repo on bare `gh issue
      // view N`, which is rarely the routing source. The hint mirrors
      // the route-by-mention path's MESSAGE template. When repo is
      // absent (older producer), the trailing-period + Run-hint are
      // omitted to keep the legacy single-sentence shape unchanged.
      const repoSuffix = payload.repo
        ? `. Run: gh issue view ${payload.issue_number} --repo ${payload.repo} --json title,body,labels,comments`
        : '';
      return {
        content: `Issue #${payload.issue_number} was routed to you${suffix}${repoSuffix}`,
        issueNumber: payload.issue_number,
      };
    }
    return {
      content: payload.title
        ? `An issue was routed to you: ${payload.title}`
        : 'An issue was routed to you',
    };
  }

  if (payload.type === 'mention') {
    return { content: payload.message ?? 'You were mentioned' };
  }

  if (payload.type === 'ci_completion') {
    // Prefer the prebuilt `message` (producer has all context) but
    // fall back to a shape-derived rendering if absent. Producers
    // that use CiCompletionPayloadSchema always provide `message`.
    if (payload.message) {
      return { content: payload.message };
    }
    if (payload.pr_number !== undefined && payload.conclusion !== undefined) {
      const prRef = `PR #${payload.pr_number}`;
      if (payload.conclusion === 'success') {
        return { content: `${prRef}: CI SUCCESS` };
      }
      const failing = payload.failing_check_name
        ? ` (first failing check: '${payload.failing_check_name}')`
        : '';
      return {
        content: `${prRef}: CI ${payload.conclusion.toUpperCase()}${failing}`,
      };
    }
    return { content: 'CI completed' };
  }

  if (payload.type === 'peer_notification') {
    // macf#256 / DR-023 UC-1: rendered when the channel-server's
    // notify_peer MCP tool POSTs to a peer's /notify. Source is the
    // sending peer's agent name; event is the hook context that
    // triggered the notification (session-end / turn-complete /
    // error / custom). Prefer producer's `message` if present;
    // otherwise synthesize a minimal "Peer X reports event Y" line.
    if (payload.message) {
      const prefix = payload.source ? `Peer ${payload.source}: ` : 'Peer notification: ';
      return { content: `${prefix}${payload.message}` };
    }
    const sourcePart = payload.source ? `Peer ${payload.source}` : 'A peer';
    const eventPart = payload.event ? ` reports event: ${payload.event}` : ' sent a notification';
    return { content: `${sourcePart}${eventPart}` };
  }

  // startup_check or any future variant falls through here
  return { content: payload.message ?? 'Pending issues found at startup' };
}
