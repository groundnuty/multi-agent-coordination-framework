# Phase: A2A v1.0 Phase 2d — Python SDK round-trip + traceparent E2E + tasks/get + tasks/cancel

**Issue:** [groundnuty/macf#398](https://github.com/groundnuty/macf/issues/398)
**Status:** in-progress (this PR ships the implementation)
**Date:** 2026-05-19
**Authored by:** code-agent; sub-issue filed by science-agent post-Phase-2b merge

## Overview

Phase 2d closes the three deferred items from Phase 2b that were
scope-disciplined out of `#392` so that PR stayed focused on the
intermediate-state edges + resume dispatch:

1. **Python `a2a-sdk` v1.0.3 `message/send` round-trip** — extends
   [#385](https://github.com/groundnuty/macf/pull/385)'s harness with
   inbound message-send + tasks/get scenarios
2. **Traceparent E2E smoke** — empirical confirmation that W3C
   tracecontext propagates from inbound `traceparent` header → MACF's
   SERVER span on `/a2a/v1`, per Phase 2b design decision 4
   (header-only propagation through mTLS)
3. **`tasks/get` + `tasks/cancel` JSON-RPC methods** — Phase 2a's
   route handler returned `-32601 Method not found` for these; Phase 2d
   dispatches them through the existing `TaskStore` with structured
   error mapping for unknown / terminal tasks

Phase 2d is **purely additive** to Phase 2a/2b. No existing endpoints
change semantics; no breaking schema changes; baseline 1438 tests
become 1438 + new tests with zero existing regressions.

## Spec verification (research-first, 2026-05-19)

| Item | Source | Verdict |
|---|---|---|
| `tasks/get` JSON-RPC method | a2a-protocol.org § 9 + proto `GetTaskRequest` | confirmed slash-namespaced; params accept `{ id }` OR proto-canonical `{ name: "tasks/<id>" }` |
| `tasks/cancel` JSON-RPC method | a2a-protocol.org § 9 + proto `CancelTaskRequest` | confirmed slash-namespaced; same param shapes |
| Cancellable from-states | spec § 4.1.3 transition table | SUBMITTED / WORKING / INPUT_REQUIRED / AUTH_REQUIRED → CANCELED legal; terminal states reject |
| Error envelope on terminal-cancel | spec § 9.5 google.rpc.Status | `reason: TASK_TERMINAL_STATE` (Phase 2b constant; reused) |
| W3C traceparent format | W3C Trace Context spec | `<version>-<32-hex trace-id>-<16-hex span-id>-<flags>` |
| OTel JS propagation API | `@opentelemetry/api` propagator interface | `propagation.extract(ctx, headers)` reads `traceparent` via W3CTraceContextPropagator |

## Design decisions

### Decision 1: `TaskIdParams` accepts both `{ id }` and proto-canonical `{ name: "tasks/<id>" }`

Two clients on the wire emit different shapes:

- The Python `a2a-sdk` v1.0.3 client surface emits `params: { id }` for
  tasks/get (verified via SDK source inspection)
- The protobuf-canonical wire form via `MessageToDict(GetTaskRequest)`
  emits `params: { name: "tasks/<id>" }` (per `string name = 1` field)

Rejecting either would break a real client. The Zod schema accepts both
via `.refine()`; `resolveTaskId()` strips the `tasks/` prefix from
`name` to yield the bare id for `TaskStore` lookup. `id` takes
precedence when both are present.

**Pattern A consideration (both-present payloads with mismatched values).**
A payload with both `{ id: "abc", name: "tasks/xyz" }` where `abc != xyz`
passes the refine ("at least one is present") + `resolveTaskId()`
silently prefers `id`. The semantic outcome could surprise a client
that assumed `name`-precedence. We accept this because: (a) surveyed
SDKs emit ONE of the two fields (Python emits `id`, protobuf-canonical
emits `name`); we haven't seen a real client emit both; (b) tighter
refine ("if both present, they must dereference to the same task id")
adds complexity for a hypothetical mis-construction. If a real client
surfaces emitting both-mismatched, revisit with the tighter refine.
The precedence rule is documented in `resolveTaskId()` JSDoc + tested
in `a2a-types.test.ts > id takes precedence when both are present`.

### Decision 2: `tasks/cancel` on terminal task → `TASK_TERMINAL_STATE` error

Spec § 4.1.3 declares COMPLETED / FAILED / CANCELED / REJECTED as
terminal — no transitions allowed out. `tasks/cancel` against a
terminal task could be:

- (a) **Reject with error** — our choice; matches the transition-table
  invariant + the Phase 2b error-mapping pattern for resume-on-terminal
- (b) Silent no-op (idempotent semantics) — would surprise clients that
  expect to observe a state change

(a) preserves the explicit-error principle from `silent-fallback-hazards.md`
Pattern A — make failure loud at the boundary. Sister-shape to the
Phase 2b TaskNotResumableError on terminal: same reason code
(`TASK_TERMINAL_STATE`) so clients can write a single handler for the
class.

### Decision 3: `tasks/cancel` on already-CANCELED task → same error class

Could be idempotent ("you're trying to cancel; the task IS canceled;
no-op success") OR an error ("you can't cancel an already-canceled
task; that's a terminal state"). We pick the error path because:

- CANCELED is terminal per the spec table; consistency with the
  general terminal-rejection rule
- Idempotent-cancel would create a 2-state inference problem: client
  can't tell from response whether the cancel ACHIEVED state or merely
  OBSERVED it

If client genuinely wants idempotent cancel-or-confirm semantics, they
can `tasks/get` first + cancel only if non-terminal.

### Decision 4: Traceparent capture via `InMemorySpanExporter`, not mock OTLP HTTP listener

The acceptance criterion suggested a mock OTLP HTTP listener. We use
OTel's canonical `InMemorySpanExporter` testing primitive instead:

- **InMemorySpanExporter exports spans at the SDK layer** — before any
  OTLP wire-serialization
- **Decouples the assertion (tracecontext propagation) from OTLP
  protocol-decoding noise** — the wire-encoding is a separate concern
  covered by `otel.test.ts` + the live observability stack in
  `groundnuty/macf-devops-toolkit`
- **Standard OTel JS testing pattern** — sister-shape to
  `BatchSpanProcessor` testing in upstream OTel JS

The propagation assertion ("client's traceparent → SERVER span's
parent context") is the same regardless of capture mechanism. Using
the canonical primitive avoids reinventing wheel-mocks.

### Decision 5: Round-trip Python probe hand-builds the JSON-RPC envelope

The `a2a-sdk` v1.0.3 SDK exposes `Client.send_message()` but it
requires AgentCard discovery + an HTTP transport setup that doesn't
match our test's direct-POST pattern. The probe hand-builds the
JSON-RPC envelope and **validates the Task response through the SDK's
protobuf model** (`a2a_pb2.Task` via `json_format.ParseDict`). This
preserves the cross-implementation triangulation property:

- Our wire body parses cleanly through the canonical proto model ✓
- The SDK round-trips it back to a dict with required fields preserved ✓
- We don't depend on the SDK's higher-level discovery + dispatch (which
  is independently exercised by Phase 1's `a2a_client_probe.py`)

## Implementation

| Surface | File | Changes |
|---|---|---|
| Schemas | `packages/macf-channel-server/src/a2a-types.ts` | `TaskIdParamsSchema` + `resolveTaskId()` helper; `A2A_METHOD_TASKS_GET` + `A2A_METHOD_TASKS_CANCEL` constants |
| State machine | `packages/macf-channel-server/src/a2a-task.ts` | `TaskStore.cancel(taskId)` method; `TaskNotCancelableError` class |
| Route dispatch | `packages/macf-channel-server/src/https.ts` | switch dispatch in `/a2a/v1` block; `tasks/get` + `tasks/cancel` branches |
| Unit tests | `packages/macf-channel-server/test/a2a-task.test.ts` | 10 new tests for cancel + error mapping |
| Unit tests | `packages/macf-channel-server/test/a2a-types.test.ts` | 10 new tests for TaskIdParams + resolveTaskId |
| E2E tests | `packages/macf-channel-server/test/e2e/a2a-message-send.test.ts` | NEW — 12 tests covering message/send + tasks/get + tasks/cancel + dispatch errors |
| E2E tests | `packages/macf-channel-server/test/e2e/a2a-traceparent-e2e.test.ts` | NEW — 3 tests covering W3C tracecontext propagation + fresh trace ID + GenAI attrs |
| Integration | `packages/macf-channel-server/test/integration/a2a-message-send-python-sdk.test.ts` | NEW — 4 tests covering Python SDK round-trip across the 3 methods + terminal-cancel error |
| Integration | `packages/macf-channel-server/test/integration/fixtures/a2a_message_send_probe.py` | NEW — Python probe with `--mode {message_send,tasks_get,tasks_cancel}` |

## Acceptance criteria

- [x] `tasks/get` JSON-RPC method dispatched in `/a2a/v1` route; returns Task or TASK_NOT_FOUND error
- [x] `tasks/cancel` JSON-RPC method dispatched; transitions non-terminal tasks to TASK_STATE_CANCELED; returns error for terminal or unknown tasks
- [x] Python SDK integration test scenarios:
  - [x] happy-path `message/send` round-trip (COMPLETED state)
  - [x] tasks/get Python client → MACF server
  - [x] tasks/cancel Python client → MACF server (+ TASK_TERMINAL_STATE error path)
- [ ] INPUT_REQUIRED resume via `Message.taskId` (Python harness) — **deferred to Phase 3+**: requires synthetic trigger in MACF to drive a task INTO INPUT_REQUIRED, which depends on the Phase 3 skill→MCP-tool dispatcher to land. The Phase 2b unit + E2E tests already cover the resume code path; the missing piece is a way to PUT the task into INPUT_REQUIRED from the Python client side, which isn't exercisable until tool dispatch lands.
- [x] Traceparent E2E smoke via mock OTLP collector → **substituted with InMemorySpanExporter** (canonical OTel JS testing primitive; rationale in Decision 4)
- [x] No regression in `make -f dev.mk check` (baseline 1438; new test count: 1438 + new unit + new E2E + new integration)
- [x] No regression in existing E2E suite (mTLS, notify, sign, AgentCard discovery)

The deferred INPUT_REQUIRED-resume-via-Python-client item is captured
in Phase 3 (`#396`) as out-of-scope-for-2d. The state-machine code path
is already tested via the Phase 2b TS-side E2E tests; the deferred item
is purely the cross-implementation triangulation.

## Out of scope (deferred phases)

- **`message/stream` + SSE** — Phase 3.5 or 4
- **`tasks/subscribe`** — Phase 3.5 or 4
- **`tasks/pushNotificationConfig.set` + `.get`** — Phase 4 (external
  publication territory)
- **Outbound A2A `message/send`** — Phase 3 (`#396`; design approved)
- **Real OTLP Tempo verification** — operator-local k3d-only per
  deployment-topology footnote in DR-019 Amendment A

## Backwards compatibility

Phase 2d is purely additive:

- `POST /notify` — unchanged
- `POST /macf/sign` — unchanged
- `GET /health` — unchanged
- `GET /.well-known/agent-card.json` — unchanged
- `POST /a2a/v1` — same endpoint, expanded method set (was just
  `message/send`; now also `tasks/get` + `tasks/cancel`)

Existing METHOD_NOT_SUPPORTED clients that polled `tasks/get` or
`tasks/cancel` before Phase 2d will now succeed instead of erroring;
this is a strict improvement (no breaking change).

## Cross-references

- A2A v1.0 spec: [a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/)
- W3C Trace Context spec: [w3.org/TR/trace-context/](https://www.w3.org/TR/trace-context/)
- Phase 2a: [#391](https://github.com/groundnuty/macf/pull/391) (`#390`)
- Phase 2b: [#397](https://github.com/groundnuty/macf/pull/397) (`#392`)
- Phase 2c: [#395](https://github.com/groundnuty/macf/pull/395) (`#393`)
- Phase 3: [#396](https://github.com/groundnuty/macf/issues/396) (design approved; outbound A2A)
- Master tracking: [#368](https://github.com/groundnuty/macf/issues/368)
- DR-022 Amendment M (Phase 2c AgentCard proto-alignment)
