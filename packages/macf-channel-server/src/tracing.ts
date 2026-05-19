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
  // macf#271: PreCompact-driven checkpoint_to_memory span. INTERNAL-kind
  // (purely local filesystem write). Attributes: trigger (manual|auto),
  // written (bool), deduplicated (bool). DR-023 §UC-3 telemetry pattern.
  ToolCheckpointToMemory: 'macf.tool.checkpoint_to_memory',
} as const;

/**
 * Build the span name for an outbound `invoke_agent` operation per OTel
 * GenAI Agent Spans semconv (CLIENT-kind variant).
 *
 * Spec: "Span name SHOULD be `invoke_agent {gen_ai.agent.name}` if
 * available, else `invoke_agent`."
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)
 *
 * The `{gen_ai.agent.name}` placeholder is the TARGET agent (the one
 * being invoked) — not the emitting agent. For MACF's `notify_peer`,
 * single-peer mode passes `input.to`; broadcast mode (no target peer)
 * falls back to the bare `invoke_agent` form.
 *
 * macf#369 — A2A Phase 0 (OTel GenAI semconv alignment).
 */
export function buildInvokeAgentSpanName(target?: string): string {
  if (target !== undefined && target.length > 0) {
    return `invoke_agent ${target}`;
  }
  return 'invoke_agent';
}

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
  // macf#271: checkpoint_to_memory span attributes. Surface PreCompact
  // trigger source (manual / auto) + outcome (written, deduplicated)
  // for DR-023 UC-3 telemetry.
  CheckpointTrigger: 'macf.checkpoint.trigger',
  CheckpointWritten: 'macf.checkpoint.written',
  CheckpointDeduplicated: 'macf.checkpoint.deduplicated',
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
 *
 * **Scope (post-macf#369)**: this mapping is for the RECEIVER-side
 * incoming-span operation only (SERVER-kind `NotifyReceived` span in
 * https.ts onNotify). The SENDER-side outbound `invoke_agent` span
 * (CLIENT-kind, notify-peer.ts) hard-codes `operation.name='invoke_agent'`
 * per OTel GenAI Agent Spans semconv — sender and receiver carry
 * different GenAI operation semantics, and that's correct under the
 * spec (the CLIENT span IS the invoke; the SERVER span is the
 * receive-and-process).
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
    // macf-actions#39 (v3.3.0): PR review-state-change routes via the
    // route-by-pr-review-state job to the PR author's channel-server.
    // Mapped to `handoff` (work-unit state advancement) per the GenAI
    // semconv distinction: `invoke_agent` is reserved for addressed
    // mentions; `handoff` is structural state-change-driven routing of
    // a work unit (PR) to the agent who owns the next step. Sister to
    // `issue_routed` which also maps to `handoff`.
    case 'pr_review_state':
      return 'handoff';
  }
}
