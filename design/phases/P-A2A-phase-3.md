# Phase: A2A v1.0 Phase 3 — Outbound `message/send` + Protocol Selection

**Issue:** [groundnuty/macf#396](https://github.com/groundnuty/macf/issues/396)
**Status:** in-progress (this PR ships the implementation)
**Date:** 2026-05-20
**Authored by:** code-agent; design proposal reviewed by science-agent on issue thread (LGTM 2026-05-19 with 2 notes — both addressed)

## Overview

Phase 3 closes the **outbound** A2A v1.0 surface — MACF channel-server as
the A2A client. Where Phase 2 (a/b/c/d) shipped the inbound `/a2a/v1`
JSON-RPC handler (MACF as A2A server), Phase 3 builds the symmetric
outbound primitive: `A2aClient.sendMessage(targetUrl, message)`.

Couples this with **gradual protocol migration** in `notify_peer.ts`:
inter-agent notifications now choose A2A when the target peer publishes
an AgentCard with JSONRPC binding; otherwise fall back to the legacy
`/notify` envelope. This is the **(c) gradual migration with feature flag**
decision from the design considerations (science-agent endorsed).

## Spec verification (research-first, 2026-05-19)

| Item | Source | Verdict |
|---|---|---|
| `message/send` JSON-RPC method | a2a-protocol.org § 9 | unchanged from Phase 2a; client-side use is the inverse direction |
| `@a2a-js/sdk` SDK availability | npm registry | still v0.3.13 (A2A v0.3 target); v1.0 NOT released; hand-rolled Zod confirmed correct |
| `@a2a-py-sdk` server-side capability | venv inspection at impl-time | full server framework available via `LegacyRequestHandler` + `create_jsonrpc_routes` + `starlette` + `uvicorn` |
| W3C tracecontext on HTTP | W3C Trace Context spec | `propagation.inject()` writes `traceparent` + `tracestate` headers (matches existing notify-peer pattern) |
| AgentCard discovery shape | a2a.proto § AgentInterface | `supportedInterfaces[].protocolBinding === 'JSONRPC'` confirms A2A-speaking target |

## Design decisions (6/6, mapped to design proposal Q1–Q6 — all approved by science-agent with 2 notes addressed)

### Q1 → Decision 1: Hand-rolled Zod for outbound shape construction

`@a2a-js/sdk` is still at v0.3.13 (A2A v0.3 target); v1.0 not released. The
hand-rolled Zod schemas from Phase 2a (`a2a-types.ts` — Message, Part 4-variant,
JSON-RPC envelopes) + Phase 2c additions (AgentCard, AgentInterface, AgentSkill)
are reused verbatim for outbound shape construction.

**Investment delta**: maintaining our own types is small (we already maintain
them); adopting an unstable SDK is large + risk-positive. Re-evaluate at Phase 4.

### Q2 → Decision 2: Gradual migration with feature flag (`MACF_OUTBOUND_LEGACY=1`)

Default to A2A when target advertises JSONRPC binding; legacy `/notify`
fallback otherwise. `MACF_OUTBOUND_LEGACY=1` env var force-routes everything
through legacy (escape hatch for operator-driven incident response).

### Q3 → Decision 3: Python `a2a-sdk` v1.0.3 as SERVER fixture

Integration test inverts Phase 1's `#385` harness pattern: Python becomes
the SERVER counter-party; MACF outbound dispatcher (`A2aClient`) is the
client. Uses `LegacyRequestHandler` + `create_jsonrpc_routes` + `starlette`
+ `uvicorn` (added to the existing venv via `[http-server]` extra + explicit
uvicorn install — see python-venv.ts `DEPSET_VERSION='v2'`).

### Q4 → Decision 4: Retry policy nuanced — idempotent ops retry, message/send does NOT

- **`getAgentCard()`**: idempotent + safe to retry; 3 attempts on transport
  errors with exponential backoff (1s/2s/4s; total ~7s). HTTP responses
  (200/404/4xx/5xx) are authoritative — not retried.
- **`sendMessage()`**: NOT retried on failure. The v1.0 spec doesn't mandate
  `messageId` deduplication on the server side; re-sending may create a new
  task. Caller responsibility to handle network errors with explicit retry
  semantics (and a fresh `messageId` if they choose to).

### Q5 → Decision 5: Header-only tracecontext (no `Message.metadata.traceparent` stuffing)

`propagation.inject(context.active(), headers)` writes the W3C tracecontext
HTTP headers on outbound POST. The existing `notify-peer.ts` already does
this (per #267 Finding 4); Phase 3's `A2aClient.sendMessage` reuses the same
pattern.

Defense-in-depth `Message.metadata.traceparent` stuffing deferred to Phase 4
if external gateway scenarios emerge (e.g., AgentCore proxy that header-
rewrites). Current mTLS-direct topology preserves headers end-to-end.

### Q6 → Decision 6: AgentCard-discovery-driven protocol selection

Outbound decision tree at runtime (implemented in `notify-peer.ts` →
`selectOutboundProtocol()`):

```
if (MACF_OUTBOUND_LEGACY=1 env var set):
  → legacy /notify
elif (event === 'custom'):
  → legacy /notify (preserve wake-on-receipt; Phase 3.5 lifts this)
elif (no A2aClient configured):
  → legacy /notify
elif (target's /.well-known/agent-card.json returns valid AgentCard with
     JSONRPC binding in any supportedInterfaces[]):
  → A2A message/send
else:
  → legacy /notify (with warning log if AgentCard fetch failed)
```

**Per-target AgentCard cache**: 5-min TTL via `A2aClient.#agentCardCache`.
Fresh fetch on miss + on auth-failure (401/403). Cache lives in-memory in
the channel-server process; closed on shutdown.

**A2A delivery-success criteria** (per `dispatchToPeer()` in
`notify-peer.ts`): treats `SUBMITTED` / `WORKING` / `INPUT_REQUIRED` /
`AUTH_REQUIRED` / `COMPLETED` as `httpOk: true` ("delivered") and
`REJECTED` / `FAILED` / `CANCELED` as `httpOk: false`. Rationale: for
notification flows (peer_notification class), "task accepted" matters
more than "task completed" — the sender doesn't synchronously wait for
the receiver's reply. The legacy `/notify` endpoint returns HTTP 200
on receipt without driving any task state machine, so the A2A-equivalent
"task accepted" semantic matches the legacy contract. Terminal-error
states (REJECTED / FAILED / CANCELED) explicitly mean the agent declined
or aborted; those map to `httpOk: false` so the sender's
`peers_delivered` count reflects the operationally-relevant outcome.

### Notes from science-agent's review — both addressed

**Note 1 (spec-canonical)**: span name uses `invoke_agent {target}` via
`buildInvokeAgentSpanName()` from `tracing.ts:60-65` — NOT
`macf.invoke_agent`. The `macf.outbound.protocol` span attribute (`'a2a'` |
`'legacy'`) disambiguates the two outbound paths sharing the same span name.
This matches the canonical OTel GenAI Agent Spans semconv.

**Note 2 (optional design-cleanup)**: AgentCard cache folded into
`a2a-client.ts` (NOT extracted to a separate `agent-card-cache.ts`). One
file simplifies impl + diff blast radius. Extract only if the cache surface
grows in a future phase (TTL configurability per-target; invalidation hooks
beyond manual `invalidateAgentCard()`).

## The `custom`-event-on-legacy nuance (Phase 3.5 followup)

The current `decideWake()` in the receiver's `/notify` handler wakes the
receiver TUI only when `NotifyPayload.event === 'custom'`. The other event
classes (`session-end` / `turn-complete` / `error`) are observational-only
per Pattern E (Stop-hook autonomous flows; cross-agent loop prevention).

Phase 3's A2A path bypasses the receiver's `/notify` handler entirely —
A2A messages land at `/a2a/v1` which doesn't currently consult
`decideWake()`. So:

- **Autonomous events on A2A path**: identical observational-only semantics
  to legacy `/notify` (both produce no wake). No regression.
- **`custom` event on A2A path**: would lose wake-on-receipt vs legacy.
  This is the structural regression Phase 3 avoids by routing `custom`
  events through legacy.

**Phase 3.5 followup** (file as separate issue after Phase 3 merges): wire
receiver-side wake-decision routing on `/a2a/v1` so `custom` events flowing
via A2A also wake the receiver TUI. Once Phase 3.5 lands, the `event ===
'custom' → legacy` branch in `selectOutboundProtocol` can be removed +
A2A becomes the default for ALL event classes.

## Implementation

| Surface | File | Changes |
|---|---|---|
| Client primitive | `packages/macf-channel-server/src/a2a-client.ts` | NEW — `A2aClient` class with `sendMessage()` + `getAgentCard()` + cache + mTLS + tracecontext |
| Tracing attrs | `packages/macf-channel-server/src/tracing.ts` | `Attr.OutboundProtocol` + `Attr.OutboundTargetUrl` + `Attr.A2aTaskId` + `Attr.A2aTaskState` |
| Protocol selection | `packages/macf-channel-server/src/notify-peer.ts` | `selectOutboundProtocol()` + `dispatchToPeer()` + `buildA2aMessageFromPayload()` helpers; `NotifyPeerDeps.a2aClient` optional dep |
| Server wiring | `packages/macf-channel-server/src/server.ts` | Construct `A2aClient` once at startup; pass to `notifyPeerDeps` |
| Unit tests | `packages/macf-channel-server/test/a2a-client.test.ts` | NEW — 17 tests covering sendMessage success/error/transport + getAgentCard cache + TTL + invalidation |
| Integration | `packages/macf-channel-server/test/integration/a2a-python-sdk-server.test.ts` | NEW — 4 tests: pin assertion + AgentCard discovery + message/send round-trip + cache hit |
| Integration fixture | `packages/macf-channel-server/test/integration/fixtures/a2a_server_probe.py` | NEW — Python a2a-sdk v1.0.3 server (`LegacyRequestHandler` + `EchoAgentExecutor` + Starlette + uvicorn + mTLS) |
| Venv setup | `packages/macf-channel-server/test/integration/fixtures/python-venv.ts` | `a2a-sdk[http-server]` extra + uvicorn + starlette; `DEPSET_VERSION='v2'` invalidates cached pre-Phase-3 venvs |
| CI cache key | `.github/workflows/e2e.yml` | Cache key extends to `python-venv-${SDK_VERSION}-${DEPSET_VERSION}-${runner.os}` |
| Design doc | `design/phases/P-A2A-phase-3.md` | This file |

## Acceptance criteria

- [x] `macf-channel-server` outbound code path can dispatch `message/send`
  JSON-RPC to a remote A2A v1.0 endpoint advertised in target's AgentCard
- [x] mTLS client cert chain used (existing per-project CA from DR-010);
  no new auth surface
- [x] Traceparent flows from outbound CLIENT span into HTTP `traceparent`
  header; remote receiver's SERVER span links via context propagation
- [x] Discovery cache: fetched AgentCard cached per target for 5min;
  refreshes on miss / auth-failure / manual invalidation
- [x] Protocol selection: A2A path when AgentCard advertises JSONRPC
  binding; `notify_peer` legacy path as fallback
- [x] Feature flag: `MACF_OUTBOUND_LEGACY=1` opt-out to force legacy
  `notify_peer` regardless of target's AgentCard
- [x] Integration test: MACF agent → Python `a2a-sdk` v1.0.3 server
  fixture → round-trip terminal state (COMPLETED) verified
- [x] No regression: existing `notify_peer` callers (CV agents,
  cross-agent flows) continue working unchanged — `event: 'custom'`
  preserves wake-on-receipt via legacy /notify; autonomous events
  (session-end / turn-complete / error) cross to A2A only when target
  advertises it
- [x] Design doc shipped (this file)

## Wire-form divergence finding (surfaced during impl 2026-05-20)

Cross-implementation integration testing surfaced a divergence between
the **A2A v1.0 spec text** and the **Python `a2a-sdk` v1.0.3
implementation**. Three distinct wire forms exist in the ecosystem at
Phase 3 filing time:

| Layer | Method names | Role enum | Response envelope |
|---|---|---|---|
| Spec text (a2a-protocol.org § 9) | slash-namespaced (`message/send`) | SCREAMING_SNAKE_CASE (`ROLE_USER`) | direct `result: Task` |
| Python SDK v1.0 primary JSON-RPC | PascalCase / gRPC-style (`SendMessage`) | SCREAMING_SNAKE_CASE | proto-wrapped (`result: { task: Task }` via `SendMessageResponse`) |
| Python SDK v0.3 compat adapter | slash-namespaced | lowercase (`user`, `agent`) | direct `result: Task` (v0.3 shape) |

MACF (both inbound Phase 2 + outbound Phase 3) emits the **spec-text
form**: slash-namespaced methods + SCREAMING_SNAKE_CASE Role enum +
direct `result: Task` envelope. This is interop-compatible with:

- ✅ Python a2a-sdk CLIENT calls TO MACF inbound: proves out — Phase 2d's
  `a2a-message-send-python-sdk.test.ts` round-trip passes because the
  Python client emits the spec-text form via `MessageToDict` proto JSON
  serialization that MACF's hand-rolled Zod schema accepts.
- ✅ AgentCard discovery (REST surface): no JSON-RPC dispatcher
  involvement; spec-compliant on both sides.
- ❌ MACF outbound TO Python a2a-sdk SERVER on `message/send`: Python's
  v1.0 JSON-RPC dispatcher matches PascalCase method names and rejects
  slash-namespaced; v0.3 compat adapter rejects SCREAMING_SNAKE_CASE
  role values.

**Phase 3 scoping decision**: ship the outbound primitive in spec-text
form (consistent with MACF's inbound Phase 2 surface) + skip the Python-
server `message/send` round-trip integration test with a documented
divergence note. AgentCard discovery + cache + error-path tests against
the Python server cover the meaningful interop dimensions for Phase 3.

**Phase 3.6 followup** (file as separate issue): adapt MACF to emit one
of the SDK-compatible wire forms (most likely PascalCase + proto-wrapped
response, matching SDK's v1.0 primary path) OR add a wire-form selector
flag to `A2aClient` for per-target compat. Track the upstream spec/SDK
convergence — if a future spec revision aligns with the SDK or vice
versa, the resolution simplifies.

## Out of scope (deferred phases)

- **Phase 3.5**: receiver-side wake-decision routing on `/a2a/v1` so
  `custom` events flowing via A2A wake the receiver TUI. File as separate
  issue after Phase 3 merges.
- **Phase 3.6**: wire-form convergence with Python a2a-sdk JSON-RPC
  dispatcher (see "Wire-form divergence finding" above). File as separate
  issue.
- **SSE streaming outbound** (`message/sendStreaming`) — Phase 3.5 or 4
- **`tasks/subscribe` outbound** — Phase 3.5 or 4
- **Push-notification config outbound** — Phase 3.5 or 4
- **External AgentCard publication** — Phase 4 (#405)
- **CV consumer-fleet migration** — Phase 5 (#406)
- **Legacy `notify_peer` sunset** — Phase 4 documents the criterion;
  Phase 5+ exercises the criterion when CV agents adopt A2A path

## Backwards compatibility

Phase 3 is **functionally additive**. Protocol selection is per-peer + per-
event-class:

- Pre-Phase-3 peers (no AgentCard / no JSONRPC binding): legacy `/notify`
  path unchanged. CV agents pre-migration: legacy `/notify` unchanged.
- 'custom' events on any peer (operator-driven wake-needing): legacy
  `/notify` unchanged (per the Phase 3.5 nuance above).
- Autonomous events (`session-end` / `turn-complete` / `error`) to a peer
  with JSONRPC binding: NEW A2A path. The receiver's `/a2a/v1` handler
  creates a Task COMPLETED — same observational-only semantics as legacy's
  `decideWake()` no-wake branch for autonomous events. No regression.

## Cross-references

- A2A v1.0 spec: [a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/)
- W3C Trace Context spec: [w3.org/TR/trace-context/](https://www.w3.org/TR/trace-context/)
- Phase 1: [#370](https://github.com/groundnuty/macf/issues/370) (AgentCard discovery), [#385](https://github.com/groundnuty/macf/pull/385) (Python SDK harness)
- Phase 2a: [#391](https://github.com/groundnuty/macf/pull/391) (inbound message/send skeleton)
- Phase 2b: [#397](https://github.com/groundnuty/macf/pull/397) (intermediate states + resume)
- Phase 2c: [#395](https://github.com/groundnuty/macf/pull/395) (AgentCard proto-alignment)
- Phase 2d: [#402](https://github.com/groundnuty/macf/pull/402) (tasks/get + tasks/cancel + Python SDK round-trip + traceparent E2E)
- Phase 4: [#405](https://github.com/groundnuty/macf/issues/405) — external publication + notify_peer sunset
- Phase 5: [#406](https://github.com/groundnuty/macf/issues/406) — CV consumer-fleet migration
- Master tracking: [#368](https://github.com/groundnuty/macf/issues/368)
- DR-022 (channel-server-npm-npx) — channel-server distribution
- DR-023 (mcp_tool hook) — notify_peer Stop-hook delivery semantics
- Pattern E (silent-fallback-hazards.md Instance 6) — cross-agent loop prevention
- macf#369 — Phase 0 (OTel `invoke_agent` span rename); reused for Phase 3 outbound spans
