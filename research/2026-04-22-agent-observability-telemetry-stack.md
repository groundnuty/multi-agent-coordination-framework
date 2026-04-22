# Agent Observability & Telemetry Stack for MACF

**Date:** 2026-04-22
**Status:** Research complete, decision pending. To revisit after first CV production runs + first paper-data collection pass.
**Context:** Surfaced during the bilateral autonomous e2e demo on 2026-04-22 (academic-resume#6, 2m20s round-trip). We need observability both for (a) debugging multi-agent coordination issues — today's demo exposed 5+ bugs across 2 hours — and (b) gathering quantitative data for the paper (latency distributions, token overhead, failure taxonomy, MACF-vs-CPC comparison).

## Why this matters

Today's debugging relied on:
1. `tail -f` of JSONL channel logs at `<workspace>/.macf/logs/channel.log`
2. `gh run list --workflow "Agent Router"` for routing workflow timings
3. `gh issue view --json comments,closedAt` for coordination-event timestamps
4. Ad-hoc `ps aux | grep server.js` + `ss -ltnp` for process/listen state
5. `tmux capture-pane` snapshots for TUI observation

This works for single-issue post-mortem but doesn't scale to:
- **N-many samples for the paper** (need latency distributions across 20+ round-trips, not hand-composed per-issue timelines)
- **Multi-agent concurrent runs** (need cross-agent view, not per-file tails)
- **Token accounting** (we have transcripts but no aggregator)
- **Trace propagation** (routing → mTLS /notify → channel server → tmux-wake → agent response — no unified trace ID across these hops)

---

## Landscape — what changed in the last ~60 days (2026-02 to 2026-04)

The AI-agent observability space is evolving fast; recommendations from even 6 months ago are stale. Key shifts:

### OpenTelemetry GenAI semantic conventions maturing
- [OTEL semconv for GenAI agent spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/) now defines standardized attributes for `gen_ai.agent.name`, `gen_ai.agent.role`, `gen_ai.task.*`, `gen_ai.action.*`, `gen_ai.team.*`, artifacts, memory.
- Current experimental version v1.36.0+; stability transition plan published.
- Frameworks being co-standardized: OpenAI Agents SDK, Claude Agent SDK, LangGraph, CrewAI, AutoGen, IBM Bee Stack, IBM wxFlow, Mastra.
- **Implication for MACF:** our `agent`, `project`, `issue` model maps naturally onto these semantic attributes. Early adoption means our traces stay queryable alongside any other OTEL-instrumented agent stack — no custom schema to maintain.

### Commercial-vs-OSS consolidation events
- **ServiceNow acquired Traceloop on 2026-03-02** (~$60-80M). **OpenLLMetry — Traceloop's OSS instrumentation library — remains Apache 2.0 and independent.** So the pure-OSS path is unaffected; if anything, the library has enterprise backing now.
- Multiple SaaS observability vendors (Honeycomb, Datadog) launched MCP integrations. Not relevant for our OSS-only path.

### Claude Code's native OTEL
- Per [Claude Code Monitoring docs](https://code.claude.com/docs/en/monitoring-usage): Claude Code emits OTLP metrics/logs/traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Captures token usage, API cost, tool execution events, context-window utilization, session duration per session.
- `OTEL_LOG_TOOL_DETAILS=1` adds Bash commands, MCP server+tool names, skill names, file paths as event attributes.
- **No code change on our side needed — just env var activation.** Confirmed today that `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` is already present in CV workspaces' env, indicating the wiring is live.

---

## Tool comparison

### Licensing first (since OSS preference is strict)

| Tool | License | OSI-approved OSS? | Notes |
|---|---|---|---|
| **Langfuse** | **MIT** | ✅ | Strictly OSS; self-hostable via Docker Compose |
| **OpenLLMetry** | **Apache 2.0** | ✅ | Pure instrumentation library; ships data elsewhere |
| **SigNoz (core)** | **Apache 2.0** | ✅ | Full-stack OSS (logs/metrics/traces + LLM) |
| **TruLens** | **Apache 2.0** | ✅ | Evaluation-first, strong for post-hoc LLM quality |
| **Grafana LGTM** (Loki/Grafana/Tempo/Mimir) | **Apache 2.0** | ✅ | Modular OSS; more ops to run |
| **Arize Phoenix** | **Elastic License 2.0** | ⚠️ source-available, NOT OSI-OSS | Free to self-host; restricts commercial redistribution |
| **Honeycomb / Datadog / LangSmith** | Proprietary | ❌ | SaaS with free tiers but not source-available |

### Feature comparison (open-source tools only)

| Tool | Role | Agent-tracing UX | Backend-agnostic | Self-host deployment |
|---|---|---|---|---|
| **Langfuse** | Storage + UI + prompt management | Strong; LLM-first views, agent traces, sessions, evaluations | No — it's the backend | Docker Compose + Postgres |
| **OpenLLMetry** | Instrumentation library only | N/A (ships to backend) | **Yes** — exports OTLP to Langfuse, Jaeger, Tempo, any OTEL backend | pip / npm install, single-line init |
| **SigNoz** | Unified O11y platform (infra + LLM) | Moderate; built on top of general tracing | No — it's the backend | Docker / Kubernetes, ClickHouse |
| **TruLens** | Evaluation + feedback functions | Evaluation-first, not real-time tracing | Mixed | pip, runs locally |
| **Grafana LGTM** | Vendor-neutral general o11y | Depends on dashboards built | No — it's the backend | Docker Compose (or K8s for scale) |

### Recommendation within the OSI-OSS cohort

**For MACF's stage + paper-writing goals: OpenLLMetry (instrumentation) + Langfuse (storage/UI).**

Why:
- **Langfuse is purpose-built for LLM observability** with strong agent-trace views, session timelines, prompt management, datasets, and evaluations out of the box. It's what the LLM-ops community is settling on as the MIT-licensed default.
- **OpenLLMetry provides vendor-neutral instrumentation.** If we ever want to move from Langfuse to SigNoz, or dual-export to both, it's a Collector config change — no re-instrumentation of our code.
- Combined stack is **one `docker-compose up` for Langfuse** + one env var activation on each agent. Low friction, high return.

**Reserve SigNoz / Grafana LGTM** for later if we need infrastructure observability (channel server CPU/memory, agent-pane health, routing workflow queue depth) on top of LLM observability. Today we don't.

**Phoenix is tempting** (Claude Agent SDK support out of box, agent-specific trace views), but Elastic License 2.0 isn't OSI-OSS and restricts commercial redistribution. If strict-OSS is a hard constraint for paper methodology or future use, avoid.

---

## Tiered adoption plan for MACF

### Tier 1 — zero-install, stdlib-only (available today)
- Channel JSONL logs at `<workspace>/.macf/logs/channel.log`
- `gh` CLI for GitHub Actions runs + issue timestamps
- Claude Code session transcripts at `~/.claude/projects/<hash>/<session-id>.jsonl`
- **Built**: `tools/trace-round-trip.py` in `groundnuty/macf-science-agent` — aggregates all four sources per-issue into a single JSON timeline. Fail-soft, stdlib-only.

**Purpose:** enough for debugging + first paper samples (n=5-10). No new deps. Already in place.

### Tier 2 — proper OTEL + Langfuse (recommended once paper-grade data matters)

**Instrumentation** (what emits telemetry):
- **Claude Code**: already OTEL-native. Set `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_LOG_TOOL_DETAILS=1` in `claude.sh` template. Captures tokens, tool calls, session events per agent.
- **MACF channel server**: add `@opentelemetry/sdk-node` + `@opentelemetry/api` in `src/server.ts`. Wrap `onNotify` in a span with **GenAI agent semconv attributes** (`gen_ai.agent.name`, `gen_ai.task.type`, `gen_ai.action.*`). Propagate trace context from routing Action via HTTP headers on mTLS /notify — gives us cross-hop trace IDs.
- **Optional**: `@traceloop/node-server-sdk` (OpenLLMetry) for auto-instrumentation if channel server ever calls LLM APIs itself (currently not).

**Storage + UI**:
- **Langfuse** self-hosted via Docker Compose, Postgres backend.
- Single OTEL Collector in front of Langfuse for fan-out + transformation.

**One-file deployment sketch** (`docker-compose.observability.yml`):
```yaml
services:
  langfuse:
    image: langfuse/langfuse:latest
    ports: ["3000:3000"]
    depends_on: [postgres]
    environment:
      - DATABASE_URL=postgresql://langfuse:langfuse@postgres:5432/langfuse
      - NEXTAUTH_SECRET=<random-32-byte>
      - SALT=<random-32-byte>
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: langfuse
      POSTGRES_PASSWORD: langfuse
      POSTGRES_DB: langfuse
    volumes: [langfuse-db:/var/lib/postgresql/data]
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    ports: ["4317:4317", "4318:4318"]
    volumes: [./otel-config.yaml:/etc/otelcol/config.yaml]
volumes:
  langfuse-db:
```

Then in each agent's `claude.sh` (or a sibling sourced file):
```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://<observability-host>:4318
export OTEL_LOG_TOOL_DETAILS=1
export OTEL_SERVICE_NAME=macf-agent-${MACF_AGENT_NAME}
export OTEL_RESOURCE_ATTRIBUTES=gen_ai.agent.name=${MACF_AGENT_NAME},gen_ai.agent.role=${MACF_AGENT_ROLE}
```

**Purpose:** paper-grade data collection; multi-agent concurrent view; trace-level debugging; token accounting per coordination turn.

**Estimated effort:** few days. One macf issue for channel-server instrumentation; one operator-side setup doc.

### Tier 3 — full-stack (only if scale demands)

If CV deployment grows beyond ~5 agents, or if paper reviewers ask for infrastructure metrics:
- Add **SigNoz** or keep Langfuse + add **Grafana LGTM** alongside for infra metrics.
- Infrastructure side: channel server CPU/memory, routing workflow queue depth, mTLS handshake latency distributions, fleet health.

Not needed today; mentioned for completeness.

---

## What to measure for the paper

MACF vs CPC vs direct-tmux-baseline comparison table. Empirical metrics:

| Metric | Tier-1 source | Tier-2 source (better) |
|---|---|---|
| Round-trip latency (issue filed → both sides reply → closed) | channel log + `gh` | Langfuse session timeline |
| Per-hop latency (routing / /notify / wake / agent-think / reply-post) | channel log + gh run timing | OTEL span tree with parent-child hop relationships |
| Tokens per coordination turn | session transcripts | Claude Code OTEL metrics per session |
| Token ratio (coordination overhead / task tokens) | manual classify + aggregate | Langfuse tags + queries |
| Failure mode taxonomy | channel log + manual annotation | structured exception/status attributes |
| Operator interventions per task | manual log | span events tagged `operator.intervention=true` |
| Success rate (attempts → completed round-trips) | GitHub issue state transitions | same, cross-queried in Langfuse |

Tier-2 upgrade makes the paper section on "quantitative performance" much more defensible: n=many samples, distributions instead of single-run snapshots, comparable to other OTEL-instrumented agent stacks.

---

## Decisions to revisit

**Pending:**
1. **Adopt OTEL GenAI agent span semconv** — once the spec hits v1.x stable (currently experimental v1.36+), lock in the attribute schema. Low-risk adoption before stable if we need data sooner; schema stability means retroactive backfill is cheap.
2. **Dual-export vs single-backend** — start with Langfuse only; add a second exporter (e.g., to Tempo for raw trace storage) if paper reviewers want independent verification.
3. **macf#? for channel-server OTEL instrumentation** — file when we're ready to move to Tier 2. Single focused PR on `src/server.ts` + `src/tmux-wake.ts` wrapping existing events as spans with GenAI semconv attributes.

**NOT-pending (decided):**
- Pure OSS path: **Langfuse (MIT) + OpenLLMetry (Apache 2.0)** as the instrumentation + UI baseline.
- Avoid **Phoenix** for the strict-OSS path (Elastic License 2.0 is source-available, not OSI-OSS).
- Avoid **Honeycomb / Datadog / LangSmith** (proprietary SaaS).

---

## Key references

- [OpenTelemetry blog — AI Agent Observability: Evolving Standards (2025)](https://opentelemetry.io/blog/2025/ai-agent-observability/)
- [OTEL Semantic Conventions for GenAI agent spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)
- [OTEL Semantic Conventions for GenAI events](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/)
- [OTEL Semantic Conventions for GenAI metrics](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/)
- [Semantic Conventions for Generative AI Agentic Systems — GitHub issue #2664](https://github.com/open-telemetry/semantic-conventions/issues/2664)
- [Claude Code Monitoring documentation](https://code.claude.com/docs/en/monitoring-usage)
- [Langfuse (MIT) — GitHub](https://github.com/langfuse/langfuse)
- [Langfuse OTEL integration docs](https://langfuse.com/integrations/native/opentelemetry)
- [OpenLLMetry (Apache 2.0) — Morph overview](https://www.morphllm.com/openllmetry)
- [Arize Phoenix (Elastic License 2.0)](https://github.com/Arize-ai/phoenix)
- [SigNoz LLM Observability docs](https://signoz.io/docs/llm-observability/)
- [Langfuse vs Phoenix — ZenML comparison](https://www.zenml.io/blog/langfuse-vs-phoenix)
- [Top OSS LLM Observability Tools 2026 — OpenObserve](https://openobserve.ai/blog/llm-observability-tools/)
- [MCP Debugging docs — modelcontextprotocol.io](https://modelcontextprotocol.io/docs/tools/debugging)

## Related internal docs

- `tools/trace-round-trip.py` in `groundnuty/macf-science-agent` — Tier 1 building block, already written
- `design/phases/P7-*.md` — Phase 7 delivery covers routing + wake; observability is cross-cutting, not a phase
- `design/decisions/DR-020-notify-wake-mechanism.md` — the tmux-wake sidecar design that benefits most from trace instrumentation (parent-child span across routing → /notify → wake)

Session that surfaced this research: `~/repos/groundnuty/academic-resume/issues/6` (2026-04-22 bilateral coordination demo).
