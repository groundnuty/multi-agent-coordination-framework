# Phase: A2A v1.0 Phase 4 — External Publication + Legacy notify_peer Sunset

**Issue:** [groundnuty/macf#405](https://github.com/groundnuty/macf/issues/405)
**Status:** in-progress (this PR ships the implementation)
**Date:** 2026-05-20
**Authored by:** code-agent; design considerations cross-referenced from `groundnuty/macf-science-agent#24` (pending merge at impl-start)

## Overview

Phase 4 closes the A2A v1.0 integration arc on the **external surface** —
demonstrating that A2A-compliant clients running OUTSIDE MACF's mTLS
perimeter can discover + invoke MACF agents through industry-standard
registration platforms, and establishing the criterion for sunsetting
the legacy `notify_peer` envelope path.

Phase 2 (#391/#395/#397/#402, v0.2.32) established inbound A2A; Phase 3
(#407, v0.2.32) established outbound A2A; this phase establishes
**external A2A** — publishing MACF agents to A2A-aware orchestration
platforms (AWS Bedrock Agent Registry; Microsoft Foundry Control Plane)
and surfacing them to non-MACF clients.

## Research-first SOTA verification (2026-05-20 impl-start)

Per `feedback_design_features_with_research_first.md`, the landscape has
shifted significantly since the #405 filing date (2026-05-19):

| Surface | State at filing (2026-05-19) | State at impl (2026-05-20) | Implication |
|---|---|---|---|
| **Microsoft Foundry Control Plane** | Preview | **GA** | Step 3 priority elevates from optional → mandatory per #405 "Foundry-preview risk" clause |
| **AWS Bedrock Agent Registry** | Transparent-proxy only (no external registry) | **Preview** — Agent Registry launched April 2026 with A2A endpoint discovery | NEW Step 3.5 surface; was out of scope at filing |
| **A2A Discussion #741** | Open — registry standardization unresolved | **Still open** — two divergent paths (Catalog Federation vs Peer Federation); production implementations exist (OpenAgora, Agentry) but no unified standard | Cannot block on; Phase 4.5 trigger if it resolves |

Both Foundry + Bedrock register external A2A agents via the canonical
`/.well-known/agent-card.json` discovery endpoint that MACF already
exposes (Phase 1 #370, proto-aligned Phase 2c #395). The pivot point
moved from "demonstrate AgentCard discovery works" to "demonstrate
external-platform registration works through the AgentCard."

## Acceptance criteria

### Step 1 — AgentCard public-reachability + topology requirements documented

**Status**: documented (this section)

MACF's `/.well-known/agent-card.json` endpoint is protected by **mTLS +
clientAuth EKU** by design (per DR-004 v2 + DR-010). External A2A clients
running OUTSIDE the MACF PKI cannot reach the endpoint directly. Three
topology patterns enable external publication while preserving the
internal security model:

**Pattern α — AI Gateway proxy (Foundry's model)**

```
External A2A Client
        ↓ (public HTTPS, OAuth2 or API key)
    AI Gateway (e.g., Azure API Management)
        ↓ (mTLS into MACF perimeter via gateway-issued cert)
    MACF Channel-Server /.well-known/agent-card.json + /a2a/v1
```

The gateway terminates the external auth + presents an mTLS-valid client
cert to MACF. Foundry Control Plane's documented A2A registration path
generates a proxy URL via Azure API Management; MACF appears as an
internal endpoint to Foundry consumers. Suits multi-tenant SaaS
publication.

**Pattern β — Public mTLS endpoint with broader CA**

Operator extends MACF's CA to include a broader trust root (or moves
to a public CA like Let's Encrypt for the SERVER side while keeping
client mTLS for authentication). External clients with mTLS-capable
SDKs (Python `a2a-sdk`, Bedrock Agent Registry's auto-pull mechanism)
can register directly. Higher operator burden; fewer moving parts.

**Pattern γ — Public unauthenticated AgentCard with private /a2a/v1**

Operator splits the surface: `/.well-known/agent-card.json` served
publicly (no mTLS) for discovery; `/a2a/v1` retains mTLS for actual
message exchange. AgentCard advertises both interfaces; clients use
the AgentCard to bootstrap auth (e.g., OAuth2 device flow via a
`securitySchemes.oauth2` advertisement). Closest to A2A v1.0 spec
§ 4.5 multi-scheme support; requires Phase 2c-style AgentCard extension
work that's currently out of scope.

**Recommendation**: Pattern α for the canonical Foundry integration
(Step 3 below); Pattern β for direct Bedrock Agent Registry
registration if simpler; Pattern γ documented for future Phase 4.5+
if a public-discovery use case surfaces.

### Step 2 — External A2A client end-to-end smoke (MANDATORY)

**Status**: ✓ done (substantively delivered by Phase 2d)

Phase 2d shipped `packages/macf-channel-server/test/integration/a2a-message-send-python-sdk.test.ts`
(PR #402) — Python `a2a-sdk` v1.0.3 reference client successfully:

1. Discovers MACF's AgentCard via `/.well-known/agent-card.json`
2. Invokes `message/send` JSON-RPC at `/a2a/v1`
3. Receives a valid `Task` response with state `TASK_STATE_COMPLETED`
4. Calls `tasks/get` + `tasks/cancel` lifecycle methods
5. Validates the Task wire body through the SDK's protobuf model
   (`a2a.types.a2a_pb2.Task`)

The cross-implementation triangulation is paper-grade evidence for
Step 2 of this AC. Phase 2c's AgentCard schema realignment (#395) +
Phase 2d's `MessageToDict` round-trip validation prove MACF emits
**spec-compliant** A2A v1.0 wire bodies that the canonical reference
SDK parses without modification.

**Caveat — wire-form divergence (cross-ref Phase 3 design doc §)**:
the Python SDK CLIENT path emits the spec-text form (slash-namespaced
methods + SCREAMING_SNAKE_CASE roles + direct `result: Task`); MACF
accepts that. The SDK SERVER path natively uses PascalCase methods +
proto-wrapped responses; that mismatch only bites OUTBOUND from MACF
to a Python SDK server (deferred to Phase 3.6). Inbound from external
A2A clients to MACF works on the spec-text form.

### Step 3 — Microsoft Foundry Control Plane registration (MANDATORY per state shift)

**Status**: operator-driven; documentation below

Foundry Control Plane went GA between #405 filing (2026-05-19) and
impl-start (2026-05-20). Per the #405 "Foundry-preview risk" clause,
Step 3 priority elevates from optional → mandatory. Registration
procedure (operator action; documented for codification, not executed
in this PR since requires Azure tenant + production deployment):

1. Provision an Azure tenant + Foundry Control Plane workspace
2. AI Gateway (Azure API Management) provisioned per Pattern α
3. Foundry portal → Custom Agents → Register agent
4. Protocol: **A2A** (vs LangGraph / HTTP fallback)
5. Foundry auto-discovers `/.well-known/agent-card.json` via the
   gateway-issued proxy URL
6. Foundry generates a public proxy URL; external clients use it for
   `message/send` exchanges
7. Configure OTel instrumentation for observability (MACF channel-server
   already emits the canonical `invoke_agent {target}` GenAI semconv
   spans; Foundry's monitoring stack consumes them)

**Out of scope for this PR**: actual Foundry registration (requires
operator infrastructure). The doc captures the procedure so future
operator-driven registration can follow it; success is verifiable via
Foundry's "Test Connection" UI + Tempo trace correlation
(MACF channel-server `invoke_agent` spans should link to Foundry's
SERVER spans via traceparent propagation).

### Step 3.5 — AWS Bedrock Agent Registry (NEW, NOT in original AC)

**Status**: documented; operator-driven for future test deployment

AWS Bedrock Agent Registry launched preview April 2026 (out of scope at
filing). Registration procedure:

1. AWS account + Bedrock AgentCore enabled
2. AgentCore Console → Agent Registry → Register agent
3. Two registration paths supported:
   - **Manual metadata** entry (org/owner/capability/compliance fields)
   - **Endpoint auto-discovery**: provide A2A endpoint URL; Registry
     pulls metadata from `/.well-known/agent-card.json`
4. For MACF: requires Pattern α (gateway) or Pattern β (public mTLS)
   topology since Bedrock crawls the AgentCard endpoint
5. Registry serves as canonical catalog; downstream Bedrock-resident
   agents discover MACF via AgentCore SDK or MCP server

**Distinct from Foundry**: AWS Bedrock Agent Registry is **catalog-only**
(Path A in A2A Discussion #741 terminology); Foundry is **AI Gateway
proxy + catalog** (Path A + traffic-mediation). Both are operator
choices depending on Azure-vs-AWS deployment context.

**Recommendation**: Bedrock registration as optional paper-trail-grade
demonstration if/when an AWS-resident deployment exists; not blocking
Phase 4 closure.

### Step 4 — Legacy `notify_peer` envelope sunset criterion (operator decision)

**Status**: criterion options documented; operator chooses

The legacy `POST /notify` envelope (per DR-023 UC-1) was the inter-agent
notification surface pre-A2A. Phase 3 (#407, v0.2.32) added
protocol-selection in `notify_peer.ts` — `notify_peer` now dispatches
via A2A when target peer publishes AgentCard with JSONRPC binding;
falls back to legacy `/notify` when no AgentCard or when
`event === 'custom'` (preserves wake-on-receipt) or when
`MACF_OUTBOUND_LEGACY=1` env flag set.

The legacy `/notify` path is **dead code candidate** once all consumers
flip to A2A. Sunset criterion options:

**Option A — Counter-based threshold** (recommended):

> Sunset when **no `notify_peer` legacy-path invocations observed for
> 60 consecutive days** across all known MACF deployments. Observation
> via the `macf.outbound.protocol: 'legacy'` span attribute count in
> Tempo (groundnuty/macf-devops-toolkit observability stack).

Rationale: usage-driven; avoids premature removal while ANY consumer
still uses the path. Sister-shape to feature-flag-removal discipline
(`feature.is_used()` returning false for N days → safe to remove).

**Option B — Calendar-based** (alternative):

> Sunset on **2026-09-30** (Q3 2026 close), regardless of usage
> observations.

Rationale: forcing-function discipline; gives consumers a hard deadline.
Risk: still-active legacy callers break on removal.

**Option C — Phase-completion-based** (composite):

> Sunset when **Phase 5 (#406) CV consumer-fleet migration completes
> + 30 days post-completion with zero legacy invocations**.

Rationale: ties sunset to the natural migration completion; minimum
30-day observation window post-migration to catch edge-case callers.

**Recommendation**: Operator picks A or C. Option B (calendar-only) is
the riskiest given an unknown consumer fleet. Capturing the decision in
DR-022 (new Amendment O when picked) finalizes the sunset criterion.

### AgentCardSignature deferral decision

**Status**: deferred (recorded)

A2A v1.0 supports an optional `signatures` field on AgentCard (JWS
format per RFC 7515) for cryptographic verification of card authenticity.
Per A2A v1.0 § 4.4.3 — optional per proto.

Neither Foundry Control Plane (per April 2026 GA docs) nor AWS Bedrock
Agent Registry (per April 2026 preview docs) require
AgentCardSignature for registration. Both validate via endpoint
reachability + AgentCard schema validation; signature is supplemental.

**Decision**: defer AgentCardSignature implementation until external
registry / orchestration platform requires it. If Foundry Control Plane
or Bedrock Agent Registry adds a signature-required mode in a future
update, file Phase 4.5 sub-issue to implement. The JWS pattern is
well-understood (we already do mTLS cert signing in DR-010); the impl
delta is small when triggered.

### Phase 4 design doc location

**Status**: this file (`design/phases/P-A2A-phase-4.md`)

The original AC item "move design doc from `research/` to `design/phases/`
per code-research separation discipline" partially deferred — the
research doc lives in `groundnuty/macf-science-agent#24` (PR pending
merge at impl-start). This impl-side design doc is **complementary** to
the research doc:

- **Research doc** (science-agent#24): design considerations, landscape
  analysis, decision-options exploration
- **Impl doc** (this file): what shipped, why, how to operate it, where
  to find the code

Once science-agent#24 merges, cross-link bidirectionally. Code-research
separation per `feedback_code_research_separation.md` is preserved.

## Implementation summary

| Surface | File | Changes |
|---|---|---|
| Design doc | `design/phases/P-A2A-phase-4.md` | NEW (this file) — topology patterns + Step 2 evidence + Step 3/3.5 registration procedures + Step 4 sunset options + AgentCardSignature deferral |
| Source code | (none) | Phase 4 is doc-only — no code shipped this phase; the external-publication primitives all exist post-Phase-2c (AgentCard) + Phase-3 (outbound) |
| Tests | (none new) | Step 2 evidence already covered by Phase 2d's `a2a-message-send-python-sdk.test.ts` (#402); no additional test surface required |

## Out of scope (deferred phases)

- **Phase 4.5**: AgentCardSignature implementation if Foundry/Bedrock
  add a signature-required mode (reactive-deferral)
- **Phase 4.6**: Pattern γ (public AgentCard, private /a2a/v1) — if a
  public-discovery use case surfaces requiring split-endpoint topology
- **A2A Discussion #741 alignment**: file followup when the
  registry-standardization debate resolves with a canonical pattern
- **Actual Foundry / Bedrock registration**: requires operator
  Azure/AWS tenant; documented for future operator action
- **Phase 5** (#406): CV consumer-fleet migration to A2A path (already
  filed; Phase 4 doesn't block Phase 5 start)
- **DR-022 Amendment O** (new): codify the selected notify_peer sunset
  criterion when operator picks (Option A/B/C above)

## Backwards compatibility

Phase 4 is **doc-only**; no code changes; no breaking changes to any
surface. AgentCard endpoint behavior unchanged from Phase 2c. `/a2a/v1`
endpoint behavior unchanged from Phase 2d. `notify_peer` protocol
selection unchanged from Phase 3.

The Step 4 sunset (when operator selects + a future PR implements) WILL
break legacy `notify_peer` callers; that's by design — operators
configure `MACF_OUTBOUND_LEGACY=1` to opt-in to legacy through the
deprecation window, and the sunset criterion's observation period
catches any straggling consumers before removal.

## Cross-references

- A2A v1.0 spec: [a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/)
- A2A Discussion #741 (canonical registry standardization, still open
  as of 2026-05-20): [github.com/a2aproject/A2A/discussions/741](https://github.com/a2aproject/A2A/discussions/741)
- Foundry Control Plane A2A registration: [learn.microsoft.com/en-us/azure/foundry/control-plane/register-custom-agent](https://learn.microsoft.com/en-us/azure/foundry/control-plane/register-custom-agent)
- AWS Bedrock Agent Registry (preview, April 2026): [aws.amazon.com/blogs/machine-learning/the-future-of-managing-agents-at-scale-aws-agent-registry-now-in-preview/](https://aws.amazon.com/blogs/machine-learning/the-future-of-managing-agents-at-scale-aws-agent-registry-now-in-preview/)
- AWS Bedrock AgentCore A2A protocol contract: [docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a-protocol-contract.html](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a-protocol-contract.html)
- Phase 1: [#370](https://github.com/groundnuty/macf/issues/370) (AgentCard discovery endpoint)
- Phase 2a: [#391](https://github.com/groundnuty/macf/pull/391) (inbound message/send)
- Phase 2b: [#397](https://github.com/groundnuty/macf/pull/397) (resume + intermediate states)
- Phase 2c: [#395](https://github.com/groundnuty/macf/pull/395) (AgentCard proto-alignment)
- Phase 2d: [#402](https://github.com/groundnuty/macf/pull/402) (tasks/get + tasks/cancel + Python SDK round-trip)
- Phase 3: [#407](https://github.com/groundnuty/macf/pull/407) (outbound A2A + protocol selection)
- Phase 5: [#406](https://github.com/groundnuty/macf/issues/406) (CV consumer-fleet migration; sister-coordination)
- Master tracking: [#368](https://github.com/groundnuty/macf/issues/368)
- DR-010 (mTLS per-project CA) — Pattern α/β/γ topology constraints
- DR-022 + Amendment N (OIDC Trusted Publishers as canonical CI auth; future Amendment O codifies sunset criterion)
- DR-023 (mcp_tool hook; UC-1 notify_peer envelope shape that this phase sunsets)
- `feedback_design_features_with_research_first.md` — applied at impl-start (SOTA verification surfaced Foundry GA + Bedrock Registry shifts)
- Science-agent design considerations doc: `groundnuty/macf-science-agent#24` (pending merge at impl-start; this doc complements it)
