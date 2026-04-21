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
