/**
 * Tests for src/tracing.ts — the shared MACF tracing conventions
 * module. Covers the pure-function pieces (attribute-key mapping) +
 * tracer-acquisition smoke check.
 *
 * Integration-level tests (full span tree assertion with an
 * InMemorySpanExporter + live HTTPS server) live under test/e2e/
 * as a follow-up; this file stays unit-scoped.
 */
import { describe, it, expect } from 'vitest';
import {
  getTracer,
  SpanNames,
  Attr,
  GenAiAttr,
  operationNameForNotifyType,
  buildInvokeAgentSpanName,
} from '../src/tracing.js';
import type { NotifyPayload } from '@groundnuty/macf-core';

describe('operationNameForNotifyType', () => {
  it('maps mention → invoke_agent (GenAI semconv vocabulary)', () => {
    expect(operationNameForNotifyType('mention')).toBe('invoke_agent');
  });

  it('maps issue_routed → handoff', () => {
    expect(operationNameForNotifyType('issue_routed')).toBe('handoff');
  });

  it('maps startup_check + ci_completion → notify (generic)', () => {
    expect(operationNameForNotifyType('startup_check')).toBe('notify');
    expect(operationNameForNotifyType('ci_completion')).toBe('notify');
  });

  it('maps peer_notification → peer_notify (macf#256)', () => {
    expect(operationNameForNotifyType('peer_notification')).toBe('peer_notify');
  });

  it('maps pr_review_state → handoff (macf-actions#39)', () => {
    // PR review-state-driven routing is structural state-change
    // routing of a work unit (sister to issue_routed). Distinct from
    // `invoke_agent` (reserved for addressed @mentions) and
    // `peer_notify` (framework-induced peer traffic).
    expect(operationNameForNotifyType('pr_review_state')).toBe('handoff');
  });

  it('is exhaustive over NotifyPayload.type', () => {
    // Type-level check: operationNameForNotifyType should accept
    // every variant of NotifyPayload['type']. If a new variant is
    // added to types.ts without a corresponding case in the switch,
    // the TypeScript exhaustiveness check fails the build — this
    // test is a runtime smoke anchor for that invariant.
    const types: NotifyPayload['type'][] = [
      'mention',
      'issue_routed',
      'startup_check',
      'ci_completion',
      'peer_notification',
      'pr_review_state',
    ];
    for (const t of types) {
      const op = operationNameForNotifyType(t);
      expect(typeof op).toBe('string');
      expect(op.length).toBeGreaterThan(0);
    }
  });
});

describe('span name + attribute constants', () => {
  it('exports stable span names under macf.* prefix', () => {
    expect(SpanNames.NotifyReceived).toBe('macf.server.notify_received');
    expect(SpanNames.SignCsr).toBe('macf.server.sign_csr');
    expect(SpanNames.McpPush).toBe('macf.mcp.push');
    expect(SpanNames.TmuxWakeDeliver).toBe('macf.tmux_wake.deliver');
  });

  it('exports macf-specific attribute keys under macf.* prefix', () => {
    // Prefix collision-guard: if a future OTEL semconv standardizes a
    // `macf.*` key we'd refactor, but today they're all ours.
    for (const [, key] of Object.entries(Attr)) {
      expect(key).toMatch(/^macf\./);
    }
  });

  it('exports GenAI semconv keys under gen_ai.* prefix', () => {
    for (const [, key] of Object.entries(GenAiAttr)) {
      expect(key).toMatch(/^gen_ai\./);
    }
  });
});

describe('buildInvokeAgentSpanName (macf#369 — A2A Phase 0)', () => {
  // Per OTel GenAI Agent Spans semconv:
  // "Span name SHOULD be `invoke_agent {gen_ai.agent.name}` if
  // available, else `invoke_agent`."
  // Source: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/

  it('returns "invoke_agent <target>" when target is non-empty', () => {
    expect(buildInvokeAgentSpanName('code-agent')).toBe('invoke_agent code-agent');
    expect(buildInvokeAgentSpanName('science-agent')).toBe('invoke_agent science-agent');
  });

  it('returns bare "invoke_agent" when target is undefined (broadcast fallback)', () => {
    expect(buildInvokeAgentSpanName(undefined)).toBe('invoke_agent');
  });

  it('returns bare "invoke_agent" when target is empty string', () => {
    // Defensive: empty-string target shouldn't yield "invoke_agent "
    // (trailing space). Spec's "if available" clause covers this.
    expect(buildInvokeAgentSpanName('')).toBe('invoke_agent');
  });

  it('starts with "invoke_agent" prefix (regression — Tempo TraceQL prefix match)', () => {
    // TraceQL `{ name =~ "^invoke_agent" }` is the canonical
    // cross-target query for all invoke_agent spans. The prefix MUST
    // stay literal; breaking this regresses devops-agent's snapshot
    // queries.
    for (const target of ['code-agent', 'science-agent', undefined, '']) {
      expect(buildInvokeAgentSpanName(target)).toMatch(/^invoke_agent/);
    }
  });
});

describe('getTracer', () => {
  it('returns a Tracer with the "macf" instrumentation scope', () => {
    // When no provider is registered (test env default), the global
    // ProxyTracerProvider returns a NonRecordingTracer. Behavior
    // contract: .startActiveSpan(...) exists and runs the callback.
    const tracer = getTracer();
    expect(tracer).toBeDefined();
    expect(typeof tracer.startActiveSpan).toBe('function');
  });

  it('no-op tracer runs callback + returns its value', () => {
    const tracer = getTracer();
    const result = tracer.startActiveSpan('test.span', (span) => {
      expect(span).toBeDefined();
      span.end();
      return 42;
    });
    expect(result).toBe(42);
  });
});
