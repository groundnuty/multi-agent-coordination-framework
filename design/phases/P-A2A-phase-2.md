# Phase: A2A v1.0 Inbound Message Exchange (Phase 2)

**Issue:** [groundnuty/macf#390](https://github.com/groundnuty/macf/issues/390)
**Status:** Phase 2a in flight (skeleton + happy path); Phase 2b filed separately
**Date:** 2026-05-19
**Authored by:** code-agent; design-reviewed by science-agent on issue thread

## Overview

Phase 2 implements MACF's first substantive A2A protocol surface: inbound
JSON-RPC `message/send` on `macf-channel-server` with the canonical
A2A v1.0 task lifecycle state machine. Backwards-compatible with the existing
`/notify` (MACF envelope) endpoint — A2A is purely additive.

Phase 2a (this doc + PR) ships the skeleton + happy path. Phase 2b
(separate sub-issue) ships INPUT_REQUIRED / AUTH_REQUIRED edge cases +
Python-SDK integration test + traceparent E2E smoke.

## Spec verification (research-first)

Verified against A2A v1.0 spec on a2a-protocol.org **2026-05-19**:

- **Method**: `"message/send"` (slash-namespaced; spec § 9 examples)
- **TaskState enum (§ 4.1.3)**: SCREAMING_SNAKE_CASE; 8 values: `TASK_STATE_SUBMITTED`,
  `TASK_STATE_WORKING`, `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`,
  `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, `TASK_STATE_CANCELED`,
  `TASK_STATE_REJECTED`
- **Role enum (§ 4.1.4)**: `ROLE_USER`, `ROLE_AGENT`
- **Part shape (§ 4.1.5)**: OneOf semantics — `text` / `file` / `data`
  variants; v1.0 removed the `kind` discriminator per Appendix A.2.1
- **Message.taskId**: canonical resume reference for INPUT_REQUIRED /
  AUTH_REQUIRED — set on the follow-up message to point at the existing task
- **Error shape**: `google.rpc.Status` with `ErrorInfo.reason` in
  UPPER_SNAKE_CASE + domain `"a2a-protocol.org"`
- **`@a2a-js/sdk`**: still at v0.3.13 (A2A v0.3 target); v1.0 not released.
  Hand-rolled Zod (per Phase 1) remains the right call. Re-evaluate at
  Phase 3 (outbound).
- **`@a2a-py-sdk`**: v1.0.3 (v1.0-compatible); used in Phase 1's
  `groundnuty/macf#385` integration test; Phase 2b will pin the same
  version when extending the harness to test `message/send`.

## Design decisions

Five questions surfaced in the issue body; all resolved on the design-proposal
comment (science-agent design-reviewed 2026-05-19, two corrections incorporated):

| # | Decision | Justification |
|---|---|---|
| 1 | **Endpoint path**: `/a2a/v1` | Versioned namespace; future-proof for spec iterations. AgentCard.url advertises `<host>:<port>/a2a/v1`. |
| 2 | **Persistence**: in-memory `Map<taskId, Task>` indexed by UUIDv4 | Bounded scope; sweep on process exit; no on-disk state. Phase 2.5 may revisit if longer-lived persistence becomes a need. |
| 3 | **Resume semantics**: `Message.taskId` (canonical) | Per A2A v1.0 § 4.4.x; standard A2A clients parse against this field. MACF-specific `metadata.macf.resume` was the original proposal — corrected to use the canonical field (science-agent flag 1). |
| 4 | **Traceparent**: header-only (W3C tracecontext via HTTP) | Current mTLS topology doesn't header-rewrite (per [#368](https://github.com/groundnuty/macf/issues/368) finding). Defense-in-depth metadata-stuffing reserved for Phase 4 (external gateway scenarios). |
| 5 | **AgentCard.skills**: MACF domain capabilities | Per A2A v1.0 § 4.4.5 — skills describe WHAT the agent does, not WHICH JSON-RPC methods it serves. Initial mapping: `macf.notify_peer`, `macf.checkpoint_to_memory`. (Original proposal of one-skill-per-method was corrected per science-agent flag 2.) |

## State machine

```
                      ┌─────────────┐
                      │  SUBMITTED  │  initial state on /a2a/v1 receipt
                      └──────┬──────┘
                             │
              ┌──────────────┼──────────────┬──────────────┐
              ▼              ▼              ▼              ▼
       ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
       │  WORKING │   │ REJECTED │   │ CANCELED │   │  FAILED  │
       └────┬─────┘   └──────────┘   └──────────┘   └──────────┘
            │           (terminal)    (terminal)    (terminal)
   ┌────────┼────────┬────────┬───────────┐
   ▼        ▼        ▼        ▼           ▼
COMPLETED FAILED CANCELED INPUT_REQ   AUTH_REQ
(terminal)             (interrupted) (interrupted)
                            │              │
                            └──────┬───────┘
                                   │
                                   ▼
                          (resume via Message.taskId
                           → back to WORKING; Phase 2b)
```

**Phase 2a exercises**: SUBMITTED → WORKING → COMPLETED (happy path).
All other transitions declared in `a2a-task.ts`'s `ALLOWED_TRANSITIONS`
table but not exercised in the happy-path code path. Phase 2b will
wire the intermediate states via skill-name → MCP-tool dispatch.

**Terminal states** (4): `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`.
`REJECTED` is v1.0-only (not in v0.3); distinct from `FAILED` —
agent declined to process vs. agent tried and errored.

## Phase 2a (skeleton + happy path) — this PR

**Files added:**

- `packages/macf-channel-server/src/a2a-types.ts` — Zod schemas for the
  v1.0 wire shapes (Message, Part, Task, TaskStatus, TaskState,
  JSON-RPC envelopes); spec section refs in JSDoc; constants for error
  codes + method strings + endpoint path
- `packages/macf-channel-server/src/a2a-task.ts` — `TaskStore`
  (in-memory `Map<taskId, Task>`) + `transition()` validation against
  the full v1.0 transition table + `completeHappyPath()` helper that
  drives SUBMITTED → WORKING → COMPLETED in one call

**Files modified:**

- `packages/macf-channel-server/src/https.ts` — new POST `/a2a/v1`
  route handling JSON-RPC `message/send`; validates envelope + Message
  shape; SERVER-kind OTel span (analog to existing `/notify` handler);
  W3C tracecontext extracted from headers; happy-path Task returned
  in JSON-RPC `result` field
- `packages/macf-channel-server/src/agent-card.ts` — `agent.url` points
  to `/a2a/v1`; `skills[]` populated with MACF capabilities
  (`macf.notify_peer`, `macf.checkpoint_to_memory`)
- `packages/macf-channel-server/src/server.ts` — wires `TaskStore` into
  `createHttpsServer` config

**Tests added:**

- `test/a2a-types.test.ts` — Zod schema round-trip + enum coverage +
  constants pin
- `test/a2a-task.test.ts` — state machine transition validity (legal +
  illegal moves across all 8 states) + TaskStore CRUD + happy-path drive

**Tests updated:**

- `test/agent-card.test.ts` — skills + capabilities + url assertions
  reflect Phase 2a values

## Phase 2b (deferred sub-issue, file after 2a merges)

Out of Phase 2a scope; will be filed as a follow-up issue:

- **INPUT_REQUIRED / AUTH_REQUIRED transitions** — happy-path tasks
  go straight to COMPLETED; Phase 2b adds intermediate-state surface
  + the resume dispatch on `Message.taskId` match
- **Python `a2a-sdk` v1.0.3 integration test** — extends
  [#385](https://github.com/groundnuty/macf/pull/385)'s harness with
  a `message/send` round-trip through the official SDK client; validates
  cross-implementation interop against the reference v1.0 parser
- **Traceparent end-to-end E2E smoke** — empirical confirmation of
  the static-review finding from
  [#368](https://github.com/groundnuty/macf/issues/368)
  (current mTLS topology preserves W3C tracecontext through the
  terminator); a live trace lands in Tempo with parent-child
  correlation between client CLIENT span and server SERVER span
- **Skill → MCP-tool dispatch** — Phase 2a synthesizes a response
  message; Phase 2b wires the JSON-RPC `message/send` request body's
  intent (parsed from `Message.parts`) to the appropriate MACF MCP
  tool (`notify_peer` / `checkpoint_to_memory`) so the response
  reflects actual tool output

## Backwards compatibility

Phase 2a is **purely additive**. Existing endpoints unchanged:

- `POST /notify` — MACF custom envelope (legacy + current); 49+ E2E
  tests continue passing
- `POST /macf/sign` — DR-010 cert signing; intentionally NOT
  advertised in AgentCard.skills per Path 2 ([#371](https://github.com/groundnuty/macf/issues/371))
- `GET /health` — liveness probe
- `GET /.well-known/agent-card.json` — A2A discovery (Phase 1)

The new `/a2a/v1` POST route is gated by mTLS + clientAuth EKU like
all other endpoints (uniform threat model; per-project CA). A2A clients
that aren't in MACF's PKI can't reach the endpoint today; widening to
public access is a Phase 4 consideration (external publication to
Bedrock AgentCore / Azure AI Foundry).

## Cross-references

- A2A v1.0 spec: [a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/)
- A2A v1.0 changes: [a2a-protocol.org/latest/whats-new-v1/](https://a2a-protocol.org/latest/whats-new-v1/)
- Phase 0: [#369](https://github.com/groundnuty/macf/issues/369) (OTel `invoke_agent` span rename)
- Phase 1: [#370](https://github.com/groundnuty/macf/issues/370) (AgentCard discovery), [#385](https://github.com/groundnuty/macf/pull/385) (Python SDK integration test)
- Master tracking: [#368](https://github.com/groundnuty/macf/issues/368)
- DR-010: `/sign` → `/macf/sign` (live attestation stays MACF-only)
- DR-022: channel-server-npm-npx distribution
- DR-023: Stage 3 mcp_tool hook architecture
