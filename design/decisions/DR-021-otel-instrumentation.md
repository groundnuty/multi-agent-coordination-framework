# DR-021: OpenTelemetry instrumentation for the MACF channel server

**Status:** Accepted
**Date:** 2026-04-22

## Context

Observability for multi-agent coordination needs trace-tree data, not
just JSONL logs:

- **Latency per hop**: routing Action → mTLS /notify → MCP push → tmux
  wake → Claude Code turn → GitHub reply. One unified trace per
  coordination round-trip answers "where did the 8 seconds go?"
- **Correlation across repos**: the routing Action in
  `groundnuty/macf-actions` already emits to Langfuse if
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set (Claude Code auto-emits token
  counts + tool-call spans). The channel server is the missing hop:
  today its coordination events are JSONL-only and can't join that
  trace tree.
- **Paper-grade metrics**: p50/p95/p99 latency per hop; tokens per
  round-trip correlatable to the specific routing event; cross-
  validation against `tools/trace-round-trip.py` stdlib
  reconstruction.

Science-agent is standing up a 3-tier observability stack at
`groundnuty/macf-science-agent/ops/observability/`:

- Tier 1 — stdlib trace reconstruction (done)
- Tier 2 — Langfuse + OTEL collector (compose + makefile landed,
  waiting on code-side emission)
- Tier 3 — SigNoz (Apache 2.0) for infra metrics (skeleton)

This DR + PR closes the macf-side emission gap for Tier 2.

## Decision

Ship OTEL instrumentation for `src/server.ts` + `src/https.ts` +
`src/tmux-wake.ts` + `src/mcp.ts`. Manual spans only (no auto-
instrumentations). W3C traceparent extract/inject from routing
Action's HTTP request header.

### Span hierarchy

```
macf.server.notify_received (SERVER, parent from traceparent or new)
├── macf.mcp.push (INTERNAL)
└── macf.tmux_wake.deliver (INTERNAL) — attr macf.tmux.target

macf.server.sign_csr (SERVER)
├── macf.certs.verify_challenge (INTERNAL) — planned
└── macf.certs.sign (INTERNAL) — planned
```

(Startup + health spans deferred to keep PR 1 focused; see below.)

### Attribute conventions

Per-span attribute keys centralized in `src/tracing.ts`:

- `gen_ai.*` — experimental v1.36+ semconv; emit but expect rename.
- `macf.*` — MACF-specific, no semconv collision risk.
- `service.name = "macf"` (resource attribute); operators can
  override via `OTEL_SERVICE_NAME` for per-agent grouping in Langfuse.

Specific keys:

| Key | Source | Notes |
|---|---|---|
| `gen_ai.system` | literal `"macf"` | Queryable filter in Langfuse |
| `gen_ai.agent.name` | `config.agentName` | e.g. `cv-architect` |
| `gen_ai.agent.id` | `APP_ID` env | App installation ID |
| `gen_ai.operation.name` | mapped from NotifyPayload.type | `invoke_agent` / `handoff` / `notify` |
| `macf.notify.type` | `payload.type` literal | `mention` / `issue_routed` / etc. |
| `macf.issue.number` | `payload.issue_number` | GitHub issue ref |
| `macf.agent.role` | `config.agentRole` | e.g. `code` / `science` |
| `macf.remote_cn` | peer cert CN | Who called us; audit-trail value |
| `macf.tmux.target` | resolved tmux target | Pane ID or session:window |
| `macf.wake.outcome` | `delivered` / `helper_missing` / `no_target` / `spawn_error` / `nonzero_exit` | Wake-path classification |

### Version pinning (exact, not caret)

- `@opentelemetry/api@1.9.1` (stable)
- `@opentelemetry/sdk-trace-node@2.7.0` (stable)
- `@opentelemetry/sdk-trace-base@2.7.0` (stable)
- `@opentelemetry/exporter-trace-otlp-proto@0.215.0` (pre-1.0)
- `@opentelemetry/resources@2.7.0` (stable)
- `@opentelemetry/semantic-conventions@1.40.0` (stable)

SDK-node packages are still 0.x — breaking changes land in minor
releases. Exact pins prevent `npm update` from silently breaking the
instrumentation.

### Bootstrap pattern

`src/otel.ts` is a side-effecting module:

```ts
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const provider = new NodeTracerProvider({ resource, spanProcessors: [...] });
  provider.register();
  process.once('SIGTERM', () => provider.shutdown());
}
```

Imported as the FIRST statement in `src/server.ts` — must run before
any other module calls `trace.getTracer()` at eval time or the global
no-op tracer gets returned and every subsequent span is dropped.

## Options considered

### A. Manual spans via `@opentelemetry/api` only (chosen)

Explicit `startActiveSpan` calls in the handlers that matter.
Predictable instrumentation surface. No monkey-patching.

### B. `NodeSDK` + `auto-instrumentations-node`

Automatic instrumentation of Node core modules (http, https, fs,
etc.) + a manifest-style init.

**Rejected** because `auto-instrumentations-node` monkey-patches the
HTTPS module. MACF's `src/https.ts` relies on exact mTLS client-cert
validation semantics + the EKU-extension check in #121. Any patching
layer between us and Node's TLS code is a correctness risk we don't
need. The spans we care about (coordination-semantic, not plumbing)
are the ones we write explicitly anyway.

### C. OTLP gRPC exporter

Higher throughput for massive span volume.

**Rejected** — MACF's emission rate is event-driven (1-10 spans per
coordination event), nowhere near gRPC's throughput regime. HTTP-
proto exporter is simpler to deploy (no gRPC toolchain on the
operator side), same payload format, fewer moving parts.

### D. JSON-over-HTTP exporter (`-http`) vs protobuf-over-HTTP (`-proto`)

`-proto` wins on payload size + slightly better CPU. Both accepted
by Langfuse + SigNoz. `-proto` is idiomatic for production OTEL
emission.

## Zero-cost default

If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, `src/otel.ts` skips
provider registration entirely. `trace.getTracer()` returns the
global no-op tracer; `startActiveSpan` allocates only the closure +
runs the callback with a `NonRecordingSpan`. No background work, no
exporter queue, no memory pressure. Safe default for operators who
don't run the observability stack.

## Rollout

1. **Land this PR** — dependency pins + `src/otel.ts` + `src/tracing.ts`
   + span wraps in server/https/tmux-wake. No behavior change with
   `OTEL_EXPORTER_OTLP_ENDPOINT` unset.
2. **Single-agent smoke**: operator sets
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in one CV
   agent's `claude.sh`, restarts, fires a /notify. Expect
   `macf.server.notify_received` span + its 2 children to appear in
   Langfuse with correct parent-child + attributes.
3. **Fleet adoption**: if smoke passes, operators add the env to all
   agents' claude.sh (either hand-edit or `macf init --force` with
   a new `--otel-endpoint` flag — deferred to follow-up).
4. **Follow-up PRs**: startup spans, health-check spans (with head
   sampling), CLIENT spans on any future outgoing HTTPS (none today).

## Non-goals / follow-ups

- **Startup spans** (`macf.server.startup`, `macf.server.register`,
  `macf.server.collision_check`) — deferred to follow-up after
  the /notify path proves out.
- **Health-check spans** — low-value, noisy. Deferred pending head
  sampling config.
- **Metrics** (counters, histograms via OTEL metrics SDK) — traces
  first; metrics are a separate PR if science-agent wants
  per-event-type rates.
- **Init flag on `macf init`** (`--otel-endpoint`) — operator
  currently hand-edits claude.sh or sets env externally; CLI flag
  is a convenience add-on.

## Security considerations

- **No-op-by-default** means a workspace that ships claude.sh without
  the endpoint env does NOT emit any spans, even at debug levels.
  Zero information leakage to unauthorized collectors.
- **Payloads** on span attributes: we do NOT include issue body,
  prompt text, or token content in attributes. Only metadata (type,
  number, agent name). Keeps the trace stream free of potentially
  sensitive content.
- **Cert CN in `macf.remote_cn`**: peer CN is public info (printed
  in logs on every TLS handshake). No sensitivity escalation.

## References

- [OTEL GenAI agent-spans semconv v1.36+](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)
- [OTEL Node SDK docs](https://opentelemetry.io/docs/languages/js/)
- Science-agent's [observability research doc](https://github.com/groundnuty/macf-science-agent/blob/main/research/2026-04-22-agent-observability-telemetry-stack.md)
- macf#185 (tmux-wake sidecar) — the hop that most benefits from parent-child tracing
- macf#194 (this issue) — PR implementing this DR
