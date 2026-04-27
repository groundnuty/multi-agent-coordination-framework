# DR-023: Stage-3 hook → MCP-tool architecture

**Status:** Accepted
**Date:** 2026-04-26
**Trigger:** [macf#241](https://github.com/groundnuty/macf/issues/241) (architectural primitive design); [macf#255](https://github.com/groundnuty/macf/issues/255) (Stage-3 design sub-issue under master [#254](https://github.com/groundnuty/macf/issues/254))

## Context

Claude Code 2.1.118 added a new hook type — `type: "mcp_tool"` — that lets a hook directly invoke a tool on a connected MCP server, instead of shelling out to a separate process. The tool runs inside Claude Code's existing MCP-client context, gets typed parameters, and returns a structured response.

This is an architectural primitive that becomes load-bearing once MACF's Stage-3 channel server (already shipped per DR-022 + DR-020 + 9 prior DRs) is paired with hook-driven workflows: cross-agent session-end notification, programmatic LGTM enforcement, auto-checkpoint, routing-leak detection.

Forward-looking design lived in `groundnuty/macf-science-agent:research/2026-04-25-stage3-hook-mcp-tool-architecture.md` since 2026-04-25. Per macf#255 Sub 1's research-first AC, the schema was re-verified against canonical docs on 2026-04-26 before this DR landed; **5 corrections** to the original research doc are folded into this DR (see §"Schema corrections from re-verification").

## Decision

Adopt the `type: "mcp_tool"` hook surface as the canonical primitive for hook-driven channel-server tool invocation in MACF Stage 3.

Implementation expands the existing `@groundnuty/macf-channel-server` package with MCP tools for hook invocation (separate surface from the HTTP `/notify` / `/health` / `/sign` endpoints — see DR-015 amendment). Plugin manifest (`packages/macf/plugin/hooks/hooks.json`) gains `type: "mcp_tool"` hook entries that invoke these tools.

## Schema (verified 2026-04-26 against [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks))

```json
{
  "type": "mcp_tool",
  "server": "<configured-mcp-server-name>",
  "tool": "<tool-name-on-that-server>",
  "input": { "field": "literal", "path_field": "${tool_input.file_path}" },
  "timeout": 60,
  "statusMessage": "...",
  "if": "Bash(git push *)"
}
```

Field shape:

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"mcp_tool"` | yes | Hook type discriminator |
| `server` | string | yes | Configured MCP server name; must already be connected (no OAuth/connection-flow trigger) |
| `tool` | string | yes | Tool name on that server |
| `input` | object | no | Arguments. String values support `${path}` substitution from hook's JSON input via dot notation (e.g., `${tool_input.file_path}`) |
| `timeout` | number | no | Seconds; default 60 |
| `statusMessage` | string | no | Spinner text |
| `if` | string | no | Permission rule syntax filter (tool events only) |

## Failure-mode contract — non-blocking by default

**Critical correction from the prior research doc:** all errors are **non-blocking** unless the tool successfully returns an explicit JSON decision. Specifically:

- Server not connected → non-blocking error; execution continues
- Tool does not exist on server → non-blocking error; execution continues
- Tool returns `isError: true` → non-blocking error; execution continues
- Tool times out → non-blocking error; execution continues

To **block** an event, the tool must:
1. Successfully execute (no error path)
2. Return JSON content matching the event-specific decision shape

This invalidates the original research doc's framing of UC-2 (LGTM gate) as "fail-safe = block on tool failure." The hook layer is structurally observational; fail-safe-block semantics must live on a different layer (e.g., routing-Action-side Pattern A invariant assertion — see DR-005 amendment).

## Decision shape per event

Tool's JSON output is parsed against event-specific schemas:

| Event | Decision JSON | Effect |
|---|---|---|
| `PreToolUse` | `{hookSpecificOutput: {hookEventName, permissionDecision: "deny", permissionDecisionReason}}` | Blocks tool call |
| `PostToolUse` | `{decision: "block", reason}` | Feedback to Claude (tool already ran) |
| `PermissionRequest` | `{decision: {behavior: "allow"|"deny"}}` | Permission decision |
| `UserPromptSubmit` | `{decision: "block", reason}` | Rejects prompt |
| `Stop` and most other events | JSON honored if returned; non-blocking-error path always-continues | Mostly observational |

Reference example (PreToolUse deny):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Merge blocked: no LGTM on PR per pr-discipline.md"
  }
}
```

## Use cases

Four use cases. UC-1 ships first (lowest blast-radius, demonstrates the wire-level pattern); others follow as design + operational evidence accumulates.

### UC-1: Cross-agent session-end notification (`Stop` → `notify_peer`)

**Hook event:** `Stop` (session end via `/exit`, Ctrl-C, or process signal).

**MCP tool:** `macf-channel:notify_peer` (new — exposed on `@groundnuty/macf-channel-server`).

**Tool surface (MCP SDK shape, Zod-validated per `/modelcontextprotocol/typescript-sdk` v1.x):**

```typescript
server.registerTool(
  'notify_peer',
  {
    description: 'Notify a peer agent of an event via the channel-server network',
    inputSchema: z.object({
      to: z.string().optional(),       // optional per macf#256 Option A
      event: z.enum(['session-end', 'turn-complete', 'error', 'custom']),
      message: z.string().optional(),
      context: z.record(z.unknown()).optional(),
    }),
    outputSchema: z.object({
      delivered: z.boolean(),
      channel_state: z.enum(['online', 'offline']),
      peers_attempted: z.number().int().nonnegative(),
      peers_delivered: z.number().int().nonnegative(),
    }),
  },
  async ({ to, event, message, context }) => {
    // If `to` is provided, POSTs to that single peer's /notify (1:1).
    // If absent, looks up all peers via Registry.list(), excludes self
    // (cycle-prevention per §"Cycle prevention" tuple-dedup), POSTs in
    // parallel to each (1:N broadcast). Returns content + structuredContent
    // with per-peer aggregate counts.
  }
);
```

**`to` field semantic — refined post-design via macf#256 Option A (impl-time):**

- `to` is OPTIONAL. The plugin-shipped Stop hook entry in
  `packages/macf/plugin/hooks/hooks.json` ships universally to all
  consumer workspaces; per-agent `to: "<peer>"` customization is not
  feasible because hook-input substitution (`${path}`) only resolves
  from the hook's JSON input + `${cwd}` — no env-var path. So the
  default Stop hook fires `notify_peer` without `to`, broadcasting
  to all registered peers. Single-peer mode is available for any
  caller (other hook entries, MCP-tool-using agent code, ad-hoc
  invocation) that needs explicit targeting.
- Self-exclusion: when broadcasting, the tool excludes the calling
  agent's own registration to prevent the (server, tool, input)
  deduplication cycle warned about in §"Cycle prevention".

**Failure profile:** observational — `Stop` events ignore non-blocking errors by design. If channel-server unreachable or peer offline, notification is missed but session-end proceeds normally. Polling-fallback (existing pattern) catches missed notifications on next session-start.

**`isError` semantic** (paper-trail observability for the LLM):

- Single-peer mode (`to` provided): `isError: true` if the named peer didn't deliver (transport error, peer-rejected, peer-not-registered)
- Broadcast mode (`to` absent): `isError: true` if `peers_attempted > 0 && peers_delivered === 0` (tried but all failed). `isError: false` if `peers_attempted === 0` (no peers registered — not a failure, just empty state) or if at least one peer delivered (partial success counts as overall success)

The `Stop` event itself is non-blocking regardless of `isError` — `isError` only signals to the LLM for self-correction in the next turn (e.g., "all peers offline; falling back to GitHub-issue-mediated notification").

**Latency budget:** <500ms typical (well within `Stop` event's tolerance for non-interactive shutdown).

**Why first:** lowest blast-radius. Failure mode is "peer doesn't get heads-up" — recoverable via polling. Validates the wire-level pattern with minimal risk surface.

### UC-2: Pre-merge LGTM gate (`PreToolUse` → `check_lgtm`)

**Hook event:** `PreToolUse` with `if: "Bash(gh pr merge*)"` filter.

**MCP tool:** `macf-channel:check_lgtm`.

**Tool surface:**

```typescript
server.registerTool(
  'check_lgtm',
  {
    description: 'Check whether a PR has reviewer LGTM before allowing merge',
    inputSchema: z.object({
      pr_url: z.string().url(),
      required_reviewers: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      has_lgtm: z.boolean(),
      reviewers: z.array(z.string()),
      required_count: z.number(),
      reason: z.string().optional(),
    }),
  },
  async ({ pr_url, required_reviewers }) => {
    // Calls gh API to read PR review state
    // Returns content + structuredContent + (if no LGTM)
    //   { hookSpecificOutput: { hookEventName: 'PreToolUse',
    //     permissionDecision: 'deny',
    //     permissionDecisionReason: '...' } }
  }
);
```

**Failure profile:** **observational with deny-on-success.** If channel-server unreachable, hook fails non-blocking → merge proceeds without gate. To enforce fail-safe-block semantics, pair with Pattern A defense at routing-Action layer (see DR-005 amendment) — the routing-Action's pre-merge invariant check is the structural fail-safe; the hook is the in-process speed-up that catches violations before the merge command actually fires.

**Latency budget:** <200ms (single `gh api` call).

**Risk surface:** auto-merge bots (Renovate-style) trigger this; bypass via `MACF_SKIP_LGTM=1` env var or scope the `if` filter to agent-initiated merges only.

### UC-3: Auto-checkpoint to memory (`Stop` → `checkpoint`)

**Hook event:** `Stop`.

**MCP tool:** `macf-memory:checkpoint` (hypothetical — requires a separate memory MCP server; deferred).

**Status:** **deferred.** Requires architecture decision on memory-MCP-server existence (does the channel-server expose memory tools, or does memory get its own MCP server?). Defer to a follow-up DR when the codification-gap pattern motivates building the memory tool.

### UC-4: Routing-leak detector (`PreToolUse` → `check_routing_hygiene`)

**Hook event:** `PreToolUse` with `if: "Bash(gh issue comment *)"` and `if: "Bash(gh pr comment *)"`.

**MCP tool:** `macf-lint:check_routing_hygiene` (hypothetical — would live in a separate `macf-lint` MCP server).

**Status:** **deferred.** The matcher-side fix in `groundnuty/macf-actions#33` is the structural solution for routing-leak prevention; the hook-side check is fallback enforcement. Defer until matcher-side defense gaps surface.

## Architectural constraints (from re-verification)

### Hook deduplication by `(server, tool, input)` tuple

Identical hook invocations are deduplicated by the platform. Two events triggering the same `(server, tool, input)` tuple → second invocation suppressed. Use distinct `input` objects (e.g., include `${tool_input.command}` substitution) or separate tools if repeated calls are needed.

Affects MACF design: notify_peer should include event-distinguishing params in `input` (e.g., the `event` field), so repeated `Stop` notifications across sessions don't collapse.

### No guaranteed parallel-hook execution order

> "All matching hooks run in parallel, and identical handlers are deduplicated automatically."

Cannot rely on UC-1 firing before UC-2 even when both match the same event. Build idempotency into peer-notification handlers + don't depend on hook-ordering for correctness.

### `SessionStart` + `Setup` events fire BEFORE MCP servers connect

UCs that hook these events get `"not connected"` errors on first run. UC-1 hooks `Stop` (post-connect) so this doesn't bite; UC adoption on `SessionStart` for things like checkpoint-on-startup would need a different mechanism (e.g., delayed retry inside the tool itself).

### Substitution syntax: `${path}` from hook's JSON input

Path uses dot notation into the hook's JSON input. Example: `${tool_input.file_path}`, `${cwd}`. Substitution failure (path doesn't exist) is silent; treat as empty/null at tool boundary + handle in input validation.

## Cycle prevention

A hook calling an MCP tool that triggers another hook risks infinite loop. Mechanisms:

1. **Platform deduplication by tuple** — identical `(server, tool, input)` is automatically suppressed; catches the simplest 1-step cycles structurally
2. **Per-hook depth cap** — track session-counter of hook invocations from a given matcher; cap at e.g. 10
3. **Recursion detection via call stack** — track `(event, matcher, tool)` tuples in current invocation; abort if same tuple appears twice
4. **Tool-side reentrancy guard** — MCP tool maintains in-process flag, refuses re-entry

Decision: rely on platform deduplication (1) as the primary defense; recommend tool-side reentrancy guards (4) as a per-tool implementation pattern in the design freeze. Depth cap (2) + recursion detection (3) deferred until empirical cycle observed.

## Latency budgets

| Event | Cap | Rationale |
|---|---|---|
| `Stop` | <500ms | Non-interactive shutdown |
| `PreToolUse` non-merge | <100ms | Fires every Bash; latency compounds |
| `PreToolUse` merge gate | <200ms | One-shot; interactive but not high-frequency |
| `PostToolUse` | <100ms | Same compounding concern as PreToolUse |

The `type: "mcp_tool"` path's structural advantage (~50ms typical vs ~200-500ms shell-script cold-start) makes the <100ms cap feasible for high-frequency hooks.

Implementation MUST emit OTel histogram metrics under `macf.hook.latency_ms` per `packages/macf/plugin/rules/observability-wiring.md`.

## Test harness shape

Hook → MCP-tool path is unit-testable without spinning up real channel server or MCP infrastructure:

- **Mock MCP client**: `MockMcpClient` captures tool calls, returns canned responses; injectable via `new HookDispatcher({ client: mockClient })`
- **Hook-event simulation**: `simulateHookEvent({ event: 'Stop', matcher: '*' })` drives dispatcher with synthetic events
- **Assertion library**: convenience matchers — `did hook X fire?`, `with what params?`, `in what order?`

Test categories:

1. **Wire-level**: hook fires → mock client receives expected call → dispatcher returns expected action
2. **Failure-mode**: mock client raises (timeout, transport error) → dispatcher applies non-blocking-error semantics
3. **Cycle-detection**: tuple deduplication + (if implemented) depth cap triggers
4. **Concurrency**: parallel hooks on same client don't cross-contaminate state

Lives under `packages/macf-channel-server/test/hook-dispatcher/`. Implementation belongs to code-agent per macf#256.

## Schema corrections from re-verification

Five corrections to the prior research doc (`research/2026-04-25-stage3-hook-mcp-tool-architecture.md` in `groundnuty/macf-science-agent`):

1. **All errors always non-blocking** — research doc framed UC-2 as "fail-safe = block on tool failure"; that's structurally impossible at hook layer. Corrected: hook is observational; fail-safe-block must live elsewhere.
2. **Decision shape is event-specific** — research doc proposed generic `{action, message, override_env}`; actual shape is per-event JSON (PreToolUse vs PostToolUse vs PermissionRequest vs UserPromptSubmit).
3. **Hook deduplication by tuple** — research doc didn't anticipate platform-level dedup; informs cycle-prevention design (D-3).
4. **No guaranteed parallel-hook order** — research doc implicitly assumed sequential; corrected.
5. **`SessionStart` + `Setup` fire before MCP connect** — research doc's smoke-test path uses `Stop` so this doesn't bite; documented for any future SessionStart-event UC.

The research doc itself stays in place as the design rationale + use-case-tradeoff record. This DR supersedes its concrete schema + failure-mode claims.

## Smoke-test status

Smoke-test hook deployed `2026-04-26` in `groundnuty/macf-science-agent:.claude/settings.json` (commit `f642746`) — `Stop` event invoking `chrome-devtools.list_pages` (idempotent, read-only). Pending fire on next session-end. Verifies wire-level mechanism using existing MCP server before any MACF-specific tools exist.

Result will document as Appendix A in `research/2026-04-25-stage3-hook-mcp-tool-architecture.md`.

## Implementation scope (macf#256 Sub 2)

Per the master tracker reframe ([macf#254](https://github.com/groundnuty/macf/issues/254)):

1. **Channel-server tool surface:** add `notify_peer` tool to `@groundnuty/macf-channel-server` (Zod-validated per MCP SDK v1.x; `server.registerTool` API)
2. **Plugin hook config:** add `type: "mcp_tool"` Stop hook entry in `packages/macf/plugin/hooks/hooks.json` invoking `notify_peer`
3. **Tests:** unit (notify_peer tool) + integration (hook → tool → channel-server → peer round-trip) + e2e
4. **OTel:** `macf.hook.latency_ms` histogram + traces
5. **Documentation:** `@groundnuty/macf-channel-server` README + plugin docs

UC-2 (LGTM gate), UC-3 (checkpoint), UC-4 (routing-hygiene) ship in follow-up DR/issue cycles as their respective design questions resolve.

## Migration scope (macf#257 Sub 3)

Substrate workspaces (science / code / devops) currently lack channel servers (still on Stage 2 SSH+tmux routing — exposed to RC IPC silent-fallback Instance 3 per `silent-fallback-hazards.md`). Sub 3 covers:

- Bootstrap channel servers on each substrate workspace via existing `macf init` (channel-server already on npm v0.2.0 per DR-022; no code changes needed)
- Once channel servers operational, the new mcp_tool hook config (from Sub 2) propagates via `macf update`
- Retire SSH+tmux routing path post-cutover

## Sources consulted (research-first AC)

Per macf#255 Sub 1's research-first AC + standing directive (memory `feedback_design_features_with_research_first.md`):

- **[code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)** (WebFetch 2026-04-26) — canonical hook schema, failure semantics, decision shape
- **`/modelcontextprotocol/typescript-sdk` v1.x** (Context7 query 2026-04-26) — `server.registerTool` API, Zod input/output schemas, response shape (`content`, `structuredContent`, `isError`), `McpServer` class metadata
- **`silent-fallback-hazards.md` Instance 3** — operational evidence motivating UC-2 fail-safe-block-must-live-elsewhere
- **`research/2026-04-26-stage3-dr-audit.md`** (`groundnuty/macf-science-agent`) — audit driving the 5 amendments alongside this new DR
- **`research/2026-04-25-stage3-hook-mcp-tool-architecture.md`** (`groundnuty/macf-science-agent`) — design doc + 4 use-case tradeoff record (corrected per §"Schema corrections")
- **macf#241** — backlog tracker; this DR closes the architectural-primitive design surface

## Cross-references

- **DR-015 (HTTP endpoints)** — amended to add §"Two surface types: HTTP endpoints + MCP tools" cross-referencing this DR
- **DR-022 (channel-server-npm-npx)** — amended with cross-ref to this DR's tool surface
- **DR-020 (notify-wake)** — amended to document RC IPC silent-fallback as known failure mode
- **DR-005 (agent-registration)** — amended to note hidden online-but-routing-bypassed state + Pattern A fail-safe-block defense
- **DR-003 (communication-planes)** — amended to document Stage 2/3 structural asymmetry
