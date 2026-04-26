# Stage 3 design freeze — Sub 2 implementer's first read

**Date:** 2026-04-26
**Status:** Design freeze for macf#256 (Stage 3 Sub 2 implementation)
**Driver:** macf#255 Sub 1 design close

This document is what the Sub 2 implementer (`code-agent` per macf#256) reads first. It synthesizes the design freeze for the mcp_tool hook surface implementation. Detail lives in the cited DRs + research docs.

## What's already shipped (no work needed)

- **`@groundnuty/macf-channel-server`** on npm at v0.2.0 with provenance — MCP server bridging HTTPS endpoints into Claude Code (per DR-022)
- **`@groundnuty/macf-core`** + **`@groundnuty/macf`** on npm at v0.2.0 — registry / certs / CLI / plugin templates
- **CV consumer workspaces** (academic-resume, cv-project-archaeologist) on Stage 3 routing per DR-020 evidence trail
- **HTTP endpoints** `/notify`, `/health`, `/sign` per DR-015
- **mTLS authentication** with EKU + principal types per DR-004 v2 (2026-04-17)
- **Tmux-wake on /notify** per DR-020
- **Smoke-test hook** for `type: "mcp_tool"` wire-level validation deployed `groundnuty/macf-science-agent:.claude/settings.json` commit `f642746` (pending fire on next session-end)

## What Sub 2 implements

### Scope: mcp_tool hook surface for UC-1 (`notify_peer` Stop hook)

**Three concrete artifacts:**

1. **`notify_peer` MCP tool** in `@groundnuty/macf-channel-server`
   - Use `server.registerTool` per MCP SDK v1.x (`/modelcontextprotocol/typescript-sdk`)
   - Zod-validated input + output schemas per DR-023 §"UC-1"
   - Implementation resolves peer's channel-server URL from registry, POSTs to peer's `/notify` HTTP endpoint
   - Returns `content` array + `structuredContent` matching outputSchema; `isError: true` on failure (LLM can self-correct)

2. **`type: "mcp_tool"` Stop hook entry** in `packages/macf/plugin/hooks/hooks.json`
   - Schema verified against [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) 2026-04-26
   - Per DR-023 §"Schema": 7 fields (`type`, `server`, `tool`, `input`, `timeout`, `statusMessage`, `if`)
   - For UC-1: `server: "macf-agent"`, `tool: "notify_peer"`, input includes `event: "session-end"` + `to: "<peer>"` + `message: "..."`
   - Timeout default 60s acceptable for UC-1; can override via `timeout: 30` for tighter budget
   - **Important:** the hook surface is observational + non-blocking by default. Plan accordingly (per DR-023 §"Failure-mode contract").

3. **Tests** under `packages/macf-channel-server/test/hook-dispatcher/`
   - Unit: `notify_peer` tool behavior (mock channel-server URL resolution, mock HTTP POST)
   - Integration: hook → tool → channel-server → peer round-trip with mock MCP client
   - E2E: one full cross-agent notification with two real channel-server instances

### Latency budget

- `Stop` event hook: <500ms typical (per DR-023 §"Latency budgets")
- Emit OTel histogram metrics under `macf.hook.latency_ms` per `packages/macf/plugin/rules/observability-wiring.md`

### What's explicitly out of scope for Sub 2

- UC-2 (LGTM gate), UC-3 (checkpoint), UC-4 (routing-leak detector) — ship in follow-up DR/issue cycles per DR-023
- Substrate workspace migration (Sub 3 / macf#257) — code-agent picks up after Sub 2 closes
- DR amendments — already merged via this Sub 1 PR

## Critical correction from prior research doc

**The hook layer is observational + non-blocking by default.** All errors (server not connected, tool missing, tool error response, timeout) are **non-blocking** — execution continues regardless. To **block** an event, the tool must successfully execute AND return an explicit JSON decision.

**Implication for UC-2 fail-safe-block:** the prior research doc framed UC-2 LGTM gate as "fail-safe = block on tool failure" — this is structurally impossible at the hook layer. To enforce fail-safe-block semantics for merge gating, pair the hook with a complementary defense at the routing-Action layer (Pattern A invariant assertion per DR-005 amendment + `silent-fallback-hazards.md` Pattern A). Hook is the in-process speed-up; routing-Action invariant is the structural fail-safe.

This isn't UC-2's problem (Sub 2 ships UC-1 only); it's documented here so the implementer doesn't carry a wrong mental model into UC-2 follow-up work.

## Architectural constraints (from re-verification)

| Constraint | Implication for implementation |
|---|---|
| All errors non-blocking | Don't expect hook failures to block merges/sessions; design accordingly |
| Hook deduplication by `(server, tool, input)` tuple | Use distinct `input` per fire-context to avoid platform-level dedup (e.g., include `event` field) |
| No guaranteed parallel-hook order | Build idempotency into peer-notification handlers; don't assume UC-1 fires before UC-2 |
| `SessionStart` + `Setup` fire BEFORE MCP connect | UC-1 hooks `Stop` (post-connect); not affected. Don't hook `SessionStart` for UCs that need MCP. |
| Substitution `${path}` from hook's JSON input | Use dot notation (`${tool_input.command}`); silent failure if path missing |

## Cross-references (read these in order)

1. **DR-023** (new, this PR) — formal architectural decision for mcp_tool hook surface
2. **DR-015 amendment** (this PR) — two surface types: HTTP endpoints + MCP tools
3. **DR-022 Amendment K** (this PR) — channel-server's tool surface for hook invocation
4. **DR-003 amendment** (this PR) — Stage 2 vs Stage 3 structural asymmetry (motivates Sub 3 migration)
5. **DR-005 amendment** (this PR) — hidden online-but-routing-bypassed state + Pattern A defense
6. **DR-020 amendment** (this PR) — RC IPC silent-fallback failure mode + Pattern C heartbeat detector
7. **`research/2026-04-26-stage3-dr-audit.md`** in `groundnuty/macf-science-agent` — full audit narrative
8. **`research/2026-04-25-stage3-hook-mcp-tool-architecture.md`** in `groundnuty/macf-science-agent` — design rationale + use case tradeoff record (corrected per DR-023)
9. **macf#241** — backlog tracker for the architectural primitive (closes when DR-023 + Sub 2 land)

## When you can pick up Sub 2 (macf#256)

After this PR merges:

1. The `backlog` label drops on macf#256
2. You're @mentioned with handoff state
3. Read this doc + DR-023 first (in that order)
4. Pre-read the existing channel-server code in `packages/macf-channel-server/src/` (no new files; just adding `notify_peer` tool registration in `mcp.ts` or equivalent)
5. Pre-read `packages/macf/plugin/hooks/hooks.json` for the existing hook structure (you're adding a `Stop` event entry)
6. Per the standing research-first directive: re-verify SDK current state at impl time (Context7 + WebFetch) — this freeze captures 2026-04-26 state, may have moved by impl time
