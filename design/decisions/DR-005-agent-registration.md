# DR-005: Agent Registration via Per-Agent Variables

**Status:** Accepted
**Date:** 2026-03-28

## Context

Agents need to register their host:port so the GitHub Action and other agents can find them. This must work across VMs, handle concurrent startups, and support ephemeral workers.

## Decision

Each agent writes its own GitHub variable: `{PROJECT}_AGENT_{name}`. No shared state, no orchestrator.

## Options Considered (7 designs evaluated)

| # | Design | Race-free | Cross-VM | Ephemeral workers | Verdict |
|---|---|---|---|---|---|
| 1 | Static agent-config.json in repo | N/A | Yes | No | Can't handle workers |
| 2 | Dedicated orchestrator process | Yes | Yes | Yes | Single point of failure, overengineered |
| 3 | Leader election (etcd/bully) | Yes | Yes | Yes | Distributed consensus for port assignment is absurd |
| 4 | File-based registry (/tmp/) | Lock needed | **No** | Yes | Breaks cross-VM |
| 5 | GitHub Contents API with SHA CAS | Yes | Yes | Yes | Commits for ephemeral state |
| 6 | Single org variable (one JSON) | **No** | Yes | Yes | Race condition, no CAS |
| **7** | **Per-agent variables** | **Yes** | **Yes** | **Yes** | **Chosen** |

## Rationale

Per-agent variables are race-free by construction — each agent writes ONLY its own variable. No shared state means no concurrent write conflicts.

### Variable format

```
{PROJECT}_AGENT_{agent_name} = {
  "host": "100.86.5.117",
  "port": 8847,
  "type": "permanent",
  "started": "2026-03-28T18:00:00Z"
}
```

### No heartbeats

Liveness is checked at routing time: Action POSTs to the agent, if POST fails → agent is offline → add `agent-offline` label. No periodic API calls, no rate limit concerns.

### Cleanup

- Permanent agents: variable stays, agent overwrites on restart (self-healing)
- Workers: spawner deletes the variable after worker exits
- `/macf-status` flags stale entries

### Limits

1000 variables per org. With project prefix, that's 1000 agents per project — sufficient.

## Liveness states beyond online/offline (added 2026-04-26)

The original framing (2026-03-28) treated agent liveness as binary: HTTP-200 → online; failed POST → offline → add `agent-offline` label. Operational evidence (2026-04-26) surfaces a hidden third state.

### The hidden state: agent-online-but-routing-bypassed

POST succeeds (HTTP 200) but the recipient never sees the message. Failure mode is structural, not transient — the routing-target receives the bytes, but the bytes don't reach Claude Code's input handler.

Concrete instance: Remote Control IPC silent-fallback (`silent-fallback-hazards.md` Instance 3) — Claude Code TUI in RC mode binds input handler to SDK socket, not tmux pane stdin; tmux send-keys exits 0; keystrokes silently bypassed. 2× empirical firings on real routes 2026-04-26 — same shape, hours apart, cross-agent triangulated.

The current `agent-offline` label semantics treat HTTP-200 as proof of receipt. They don't.

### Pattern A defense: result-invariant assertion

The structural defense is to assert an invariant on the **result**, not just the exit code:

- **For HTTP-mediated routing (Stage 3 channel-server)**: confirm recipient acknowledged via channel-server tool's `structuredContent` response (`{delivered: true, channel_state: 'online'}`); MCP push acknowledgment is observable in-process
- **For tmux-mediated routing (Stage 2 SSH+tmux)**: sample `session_activity` timestamp pre/post send-keys, assert it advanced within ~2s — this is the same Pattern C heartbeat detector documented in the DR-020 amendment §"Pattern C heartbeat detector"; log `tmux_wake_unconfirmed` warning if not
- **For routing-Action's pre-merge LGTM gate** (per DR-023 UC-2): the hook layer is observational + non-blocking; fail-safe-block must live at the routing-Action's pre-merge invariant check, NOT in the hook itself

This defense is **complementary** to the binary online/offline state the registry maintains — it catches the hidden state by asserting on receipt-invariant rather than POST-success.

Cross-ref:

- DR-003 amendment (Stage 2 vs Stage 3 structural asymmetry)
- DR-020 amendment (failure mode catalog addition for RC IPC silent-fallback)
- DR-023 (mcp_tool hook architecture; UC-2 fail-safe-block lives outside the hook)
- `silent-fallback-hazards.md` Instance 3 + Patterns A, C
