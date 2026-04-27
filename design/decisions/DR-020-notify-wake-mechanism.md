# DR-020: On-notify wake mechanism for running agents

**Status:** Accepted
**Date:** 2026-04-21

## Context

After Phase 7 rolled out mTLS `/notify` delivery, routing Action end-to-end
POSTs cleanly reached agents' channel servers (HTTP 200, MCP push succeeds).
But a surprising UX gap emerged during the first multi-agent coordination
smoke (CV Phase 6, academic-resume#2): **the running Claude Code TUI
never saw the notification as a new prompt**. The MCP push deposited data
into the channel-server-observable state, but didn't interrupt the running
session with a fresh turn. Agents processed new work only when their session
was restarted (SessionStart auto-pickup hook) or the operator manually
pushed a wake prompt via `tmux-send-to-claude.sh`.

Filed as macf#185 during the CV rollout. Phase 7's user-facing promise
("agents wake on /notify") was unmet in the running-session case. The
whole point of moving from SSH+tmux v1 to mTLS v3 was to supersede that
ceiling — without fixing this, the ceiling stays.

## Options considered

### A. MCP polling tool

Plugin's MCP server exposes a `checkPendingWork` tool; something (session
hook or Claude-side behavior) polls it every N seconds. Claude checks the
tool, sees new notifications, processes them.

**Why not:** polling frequency vs. token cost tradeoff. Frequent polls
burn tokens on a fast-growing agent fleet; infrequent polls add latency
to the loop. No observable-from-outside signal that a wake happened —
hard to debug when it doesn't fire.

### B. Sidecar wake via `tmux-send-to-claude.sh`

On `/notify` delivery, channel server shells out to the canonical helper
with the agent's tmux session:window target + a human-readable prompt.
The helper writes the prompt into the tmux pane's input buffer exactly
as a human typing would. Claude processes it as the next input turn.

**Why it fits:**

- Reuses `tmux-send-to-claude.sh` (already canonical per
  `plugin/rules/coordination.md` "Submitting a Prompt to a Claude Code
  TUI" — handles the multi-line-submit quirk).
- Tmux session:window is already an operator-configurable concept
  (v1.x `agent-config.json` carried it for SSH+tmux routing).
- Observable: operator inspects the tmux pane's input buffer to verify
  delivery; the helper's invocation is debuggable via `ps` / audit
  logging.
- Zero-cost wake signal: no polling, no keepalive, just an event-driven
  poke on notification arrival.

### C. Long-poll MCP tool

MCP server exposes a long-poll endpoint; Claude's tool-call blocks waiting
for the next notification.

**Why not:** novel + clean BUT depends on Claude Code's MCP runtime
honoring long-polls. Untested territory; tightly coupled to a specific
Claude runtime contract we don't control.

### D. Filesystem/FIFO watchdog

Channel server writes to a FIFO; a watchdog on the Claude side fires a
hook when the FIFO has new data.

**Why not:** fragile, watchdog-dependent, adds moving parts (watchdog
process per agent). Failure modes (watchdog dies silently) leave the
agent stuck.

## Decision

**Option B — sidecar wake via `tmux-send-to-claude.sh`.**

- Matches existing MACF tmux conventions (v1 SSH+tmux lineage, canonical
  helper already shipped with workspaces).
- Observable + debuggable via standard tmux inspection.
- No new polling / token-burn surface.
- Composable: the MCP push still happens (preserving any consumer of
  the MCP channel state); the tmux wake is additive.

## Implementation

### `src/tmux-wake.ts`

Exports `wakeViaTmux(prompt, opts)` returning `boolean`. Opts carry
`workspaceDir`, optional `session`/`window`, and a `Logger`. Flow:

1. Check helper script exists at `${workspaceDir}/.claude/scripts/tmux-send-to-claude.sh`. Missing → return false, log skip.
2. Resolve target via `resolveTmuxTarget()`:
   - Explicit session + window → `"session:window"`
   - Explicit session only → `"session"`
   - Neither, but `$TMUX` set → auto-detect via `tmux display-message -p '#{session_name}:#{window_index}'`
   - Neither + no `$TMUX` → null → return false, log skip
3. `spawnSync(scriptPath, [target, prompt], { timeout: 10_000 })`. argv-level invocation — prompt is opaque to the shell, no injection surface.
4. Non-zero exit → return false, log warn with stderr snippet.
5. Success → return true, log info with target + prompt length.

### Integration in `src/server.ts` onNotify

After `mcp.pushNotification(content, meta)` + `health.recordNotification()`,
call `wakeViaTmux(content, { workspaceDir, session, window, logger })` when
`workspaceDir` is set. The formatted `content` from `formatNotifyContent`
becomes both the MCP payload AND the tmux-injected prompt — single
source-of-truth for what the agent sees, different transport.

### Config plumbing

- **Plugin runtime** (`src/config.ts`): read `MACF_WORKSPACE_DIR`, `MACF_TMUX_SESSION`, `MACF_TMUX_WINDOW` from env.
- **CLI schema** (`src/cli/config.ts` `MacfAgentConfigSchema`): optional `tmux_session` + `tmux_window` string fields.
- **`macf init`**: `--tmux-session <name>` + `--tmux-window <idx-or-name>` flags (both optional).
- **`claude.sh`**: emits `MACF_TMUX_SESSION` / `MACF_TMUX_WINDOW` only when set in config; the runtime auto-detect path handles the zero-config case.

## Fail-silent policy

Every non-happy path (missing helper, missing target, tmux not installed,
session died, helper nonzero exit) **logs at info/warn + returns false
without throwing**. `/notify`'s HTTP 200 response remains unaffected —
we're saying "accepted into MCP", not "delivered to live TUI". Running
agent being temporarily unreachable is a separate queue-clear concern
(agent picks up on next SessionStart auto-pickup run + the registry is
the source of truth for outstanding work).

## Failure modes catalog

| Condition | Behavior | Log event |
|---|---|---|
| `MACF_WORKSPACE_DIR` unset | No-op, /notify still 200s | `tmux_wake_skipped reason=no_workspace_dir` |
| helper script missing | No-op | `tmux_wake_skipped reason=helper_missing` |
| No session + no `$TMUX` | No-op | `tmux_wake_skipped reason=no_target` |
| Helper exits non-zero (session gone) | No-op | `tmux_wake_failed reason=nonzero_exit status=N stderr=...` |
| Helper times out (>10s) | Returns false | `tmux_wake_failed reason=spawn_error error=...` |
| Success | Delivered | `tmux_wake_delivered target=... prompt_length=...` |

## Known failure mode: RC IPC silent-fallback (added 2026-04-26)

**Empirical evidence:** 2× firings on real routes 2026-04-26 (`groundnuty/macf-actions#34` ~09:00Z + `groundnuty/macf-devops-toolkit#59` ~17:21Z). Cross-agent triangulated; both routes succeeded HTTP-200 at routing-Action; both `tmux_wake_delivered` log events fired (false-positive); recipient never received the prompt.

### The hidden failure

| Condition | Behavior | Log event | True outcome |
|---|---|---|---|
| Recipient TUI in Remote Control mode | Helper exits 0; `tmux send-keys` syscall succeeds | `tmux_wake_delivered` (**false-positive**) | Keystrokes silently bypassed; bound to RC SDK socket, not pane stdin |

Helper-exit-0 is an insufficient invariant when the recipient's input handler is bound to a different IPC channel. This is `silent-fallback-hazards.md` Instance 3 — a class of hazards where API-boundary success doesn't guarantee semantic success.

### Pattern C heartbeat detector (optional addition)

Cheap fragility detector: sample `session_activity` timestamp pre/post `tmux send-keys`; if timestamp didn't advance within ~2s, log `tmux_wake_unconfirmed` warning. Implementation invokes tmux via the existing safe-spawn helpers (`execFileNoThrow` or equivalent); the conceptual flow:

```
PRE  ← spawnSync('tmux', ['display', '-p', '-t', target, '#{session_activity}'])
spawnSync(scriptPath, [target, prompt], { timeout: 10_000 })
sleep(2s)
POST ← spawnSync('tmux', ['display', '-p', '-t', target, '#{session_activity}'])
if POST <= PRE: logger.warn('tmux_wake_unconfirmed', { target, reason: 'session_activity_did_not_advance' })
```

The target argument is operator-trusted (config-derived per existing `resolveTmuxTarget()` flow); pass through `execFile`-style argv (no shell interpretation) per existing security stance in §Security below.

This is a heuristic — `session_activity` advances on any pane I/O, including unrelated background output. False-positives possible (heartbeat looked like wake-success when something else also fired); false-negatives unlikely. Adding it improves observability without changing fail-silent policy.

### Structural fix forward-pointer

Stage 3 channel-server's MCP push (direct stdio between channel-server process + Claude Code process, per DR-002) bypasses the tmux layer entirely → not subject to this hazard. Substrate workspaces' migration to Stage 3 (macf#257 Sub 3) is the structural defense; tmux-wake stays as the consumer-side path until then.

For UCs in DR-023 that depend on hook-fire reaching Claude Code reliably, this matters: hooks fire in-process inside the running session, NOT via tmux send-keys; the hook surface itself is RC-IPC-immune.

Cross-ref:

- `silent-fallback-hazards.md` Instance 3 (canonical-pending in substrate)
- `insights/2026-04-26-remote-control-ipc-blocks-tmux-send-keys-routing.md` (in `groundnuty/macf-science-agent`)
- DR-003 amendment (Stage 2 vs Stage 3 structural asymmetry)
- DR-005 amendment (hidden online-but-routing-bypassed state)
- DR-023 (mcp_tool hook surface; in-process; tmux-immune)

## Security

**Shell injection surface:** zero. The prompt is passed as a discrete
argv element to `spawnSync`, not concatenated into a `sh -c "..."`. No
shell interprets the prompt; metacharacters (`$(...)`, backticks, `;`,
`&&`, etc.) are literal characters in the eventual `tmux send-keys`
argv. Verified by `test/tmux-wake.test.ts` "passes prompts with
shell-metacharacters safely" case.

**Tmux target spoofing:** the session:window target comes from
operator-declared config (`macf-agent.json`) or `$TMUX` auto-detect.
Both are operator-trusted. An adversary with write access to the config
or env could redirect notifications, but they already have
workspace-filesystem access at that point.

## Rollout

1. Land the implementation (this DR + code).
2. Operators bump workspace via `macf update`, which regenerates
   `claude.sh` — new `MACF_*` exports appear automatically for configs
   without `tmux_session` (they'd auto-detect from `$TMUX`).
3. For explicit multi-window setups (e.g., `cv-project:cv-architect`
   vs. `cv-project:cv-project-archaeologist`), operators re-run
   `macf init --force --tmux-session cv-project --tmux-window <name>`
   on each workspace.
4. Live test: operator fires a /notify (via routing Action or manual
   curl); running agent's TUI shows the prompt in its input buffer +
   processes it on the next turn.

## Related

- Phase 7 delivery infra (mTLS /notify from routing Action) — this DR
  closes the running-session UX gap on top of that.
- coordination.md "Submitting a Prompt to a Claude Code TUI" — the
  canonical path reused here.
- `src/notify-formatter.ts` — produces the prompt text used by both
  MCP push AND tmux wake.
- macf-marketplace#13 (v0.1.7 smart SessionStart auto-pickup) —
  complementary piece for the fresh-launch-wake case. Both paths
  together give full multi-agent coordination UX.
