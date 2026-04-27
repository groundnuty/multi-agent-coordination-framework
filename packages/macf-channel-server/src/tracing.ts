/**
 * Shared tracer + attribute conventions for MACF instrumentation.
 *
 * Single source of truth for span names + attribute keys so the
 * emission layer (server.ts, tmux-wake.ts, mcp.ts) stays decoupled
 * from the SDK import sprawl. Also the only place that knows which
 * `gen_ai.operation.name` value maps to which NotifyPayload type.
 *
 * See DR-021 + macf#194 for the full convention. TL;DR:
 *
 *   - `gen_ai.*` attributes follow the experimental v1.36+ OTEL
 *     GenAI agent-spans semconv. Subject to rename when semconv
 *     stabilizes; keep in one place so the mass-rename is cheap.
 *   - `macf.*` attributes are MACF-specific and not covered by any
 *     semconv. Prefixed to avoid future collisions.
 *   - Span kinds: SERVER for HTTP-handler spans, INTERNAL for
 *     in-process operations (MCP push, tmux wake), CLIENT for
 *     outgoing HTTPS calls (none today — channel server is a sink).
 */
import { trace } from '@opentelemetry/api';
import type { Tracer } from '@opentelemetry/api';
import type { NotifyPayload } from '@groundnuty/macf-core';

/** The single tracer instance used across the MACF codebase. */
export function getTracer(): Tracer {
  return trace.getTracer('macf');
}

/** Span names — centralized for easy rename + grep. */
export const SpanNames = {
  NotifyReceived: 'macf.server.notify_received',
  SignCsr: 'macf.server.sign_csr',
  StartupRegister: 'macf.server.register',
  StartupCollisionCheck: 'macf.server.collision_check',
  McpPush: 'macf.mcp.push',
  TmuxWakeDeliver: 'macf.tmux_wake.deliver',
  CertsVerifyChallenge: 'macf.certs.verify_challenge',
  CertsSign: 'macf.certs.sign',
  // macf#267: outbound notify_peer span. CLIENT-kind (sender side).
  // Wraps the httpsRequest call in notify-peer.ts; per-call OTel
  // visibility for Phase D / Claim 1b cell-effect measurement +
  // parent-child relationship to receiver's NotifyReceived span via
  // W3C traceparent propagation.
  ToolNotifyPeer: 'macf.tool.notify_peer',
} as const;

/** MACF-specific attribute keys (not covered by OTEL semconv). */
export const Attr = {
  NotifyType: 'macf.notify.type',
  IssueNumber: 'macf.issue.number',
  AgentRole: 'macf.agent.role',
  RemoteCn: 'macf.remote_cn',
  TmuxTarget: 'macf.tmux.target',
  WakeOutcome: 'macf.wake.outcome',
  // macf#267: notify_peer span attributes. Surface measurable Phase D /
  // Claim 1b cell-effect dimensions (peers_attempted vs peers_delivered),
  // identify the broadcast-vs-single-peer mode, and the triggering hook
  // event for downstream slicing.
  NotifyTarget: 'macf.notify.target',
  NotifyEvent: 'macf.notify.event',
  PeersAttempted: 'macf.notify.peers_attempted',
  PeersDelivered: 'macf.notify.peers_delivered',
} as const;

/** GenAI semconv keys (experimental in v1.36+). */
export const GenAiAttr = {
  AgentName: 'gen_ai.agent.name',
  AgentId: 'gen_ai.agent.id',
  OperationName: 'gen_ai.operation.name',
  System: 'gen_ai.system',
} as const;

/**
 * Map NotifyPayload.type to the experimental GenAI `operation.name`
 * vocabulary. If the type isn't one we've classified, returns
 * `'notify'` as a catch-all so the span still has a reasonable value.
 */
export function operationNameForNotifyType(type: NotifyPayload['type']): string {
  switch (type) {
    case 'mention':
      return 'invoke_agent';
    case 'issue_routed':
      return 'handoff';
    case 'startup_check':
    case 'ci_completion':
      return 'notify';
    // macf#256 / DR-023 UC-1: dedicated GenAI op-name for hook-driven
    // peer notifications (notify_peer MCP tool). Distinct from `notify`
    // (status-update class) and `invoke_agent` (mention class) so Phase
    // D / Claim 1b cell-effect measurements can isolate framework-induced
    // peer-traffic from GitHub-driven routing without conflation.
    case 'peer_notification':
      return 'peer_notify';
  }
}
