# DR-003: Two Communication Planes

**Status:** Accepted
**Date:** 2026-03-28

## Context

How do agents communicate? Through GitHub? Through direct channels? Both?

## Decision

Two separate communication planes:

1. **GitHub** (work artifacts): Issues, PRs, reviews, comments. Persistent, auditable, board-visible.
2. **Channels** (operational signals): Routing notifications, P2P health pings. Ephemeral, infrastructure.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| GitHub only (current CPC) | Simple, auditable | Can't health-ping, no direct agent-to-agent |
| Channels only | Fast, direct | No audit trail, no board visibility |
| **Both, separated by purpose** | **Audit trail for work, speed for operations** | **Two systems to maintain** |

## Rationale

These planes serve different purposes and don't compete:

- **GitHub** answers: "What work was done? Who decided what? What's the status?" (content)
- **Channels** answer: "Is the agent alive? Where is it? Route this issue to it." (plumbing)

Like HTTP serves content but TCP keepalives check the connection. Different layers, different concerns.

The GitHub Action stays — it handles label routing, @mention routing, board sync, offline detection. Channels replace only the message delivery mechanism (HTTP POST instead of SSH+tmux).

## Stage 2 vs Stage 3 routing structural asymmetry (added 2026-04-26)

The original framing (2026-03-28) treated Stage 2 (SSH+tmux send-keys routing) and Stage 3 (HTTP POST to channel server) as equivalent in delivery semantics, differing only in performance + security shape. **Operational evidence over 2026-04 contradicts this**: Stage 2 carries a structural fragility class that Stage 3 bypasses.

### The fragility: Remote Control IPC silent-fallback (`silent-fallback-hazards.md` Instance 3)

Claude Code TUIs running in Remote Control (RC) mode bind their input handler to the RC SDK socket, **not** the tmux pane stdin. tmux send-keys exits 0; keystrokes silently bypass Claude's input handler.

Operational evidence (2026-04-26):

- `groundnuty/macf-actions#34` (~09:00Z) — routing-Action send-keys to science-agent's tmux exited 0; recipient never saw the prompt
- `groundnuty/macf-devops-toolkit#59` (~17:21Z) — devops-agent's @mention to science-agent routed via inline (workflow log: "Routed mention to science-agent via inline (target=science-agent)"); SSH+tmux send-keys exit-0 succeeded; science-agent's RC-bound TUI didn't receive the prompt; operator-replay was the actual delivery path

Cross-agent triangulated; both routes succeeded HTTP-200 at the routing-Action layer; recipient never received the prompt. Cheap fragility detector: `tmux display -p '#{session_activity}'` doesn't advance under RC-bound input.

### Why Stage 3 bypasses this hazard

Stage 3's channel server uses MCP stdio between channel-server process and Claude Code process — **direct IPC, not tmux-mediated**. The notify-wake mechanism (DR-020) does fall back to tmux send-keys for the running-session UX gap, but that's a complementary delivery path; the MCP push itself bypasses tmux entirely.

For substrate workspaces (science / code / devops) still on Stage 2: each is exposed to this hazard until the cutover (Sub 3 in macf#257 backlog). For consumer workspaces (CV agents, future macf-init'd): already on Stage 3 per DR-020 evidence trail.

### Migration imperative

Substrate workspace migration to Stage 3 is the structural defense for this hazard class — not optional discipline. Cross-ref:

- DR-020 amendment (failure mode catalog addition for RC IPC silent-fallback)
- DR-005 amendment (hidden online-but-routing-bypassed state)
- DR-023 (Stage-3 hook → MCP-tool architecture; new mcp_tool hook surface depends on channel-server existing)
- `silent-fallback-hazards.md` Instance 3
- `insights/2026-04-26-remote-control-ipc-blocks-tmux-send-keys-routing.md` (in `groundnuty/macf-science-agent`)
