---
name: macf-notify-peer
description: Send a peer notification to a specific MACF agent. Operator-driven cross-agent messaging — drops a message in the receiver's MCP push queue and (by default) wakes their tmux TUI on receipt.
argument-hint: <peer> "<message>" [--event=custom|session-end|turn-complete|error] [--no-wake] [--verbose]
allowed-tools: mcp__plugin_macf-agent_macf-agent__notify_peer
---

Parse the args after `/macf-agent:notify-peer`:

- **First positional arg** = peer name (e.g. `code-agent`)
- **Second positional arg** = message text (quoted; joined verbatim if multi-token)
- Optional flags (any order, anywhere in the args):
  - `--event=<type>` where `<type>` ∈ `custom` | `session-end` | `turn-complete` | `error` (default: `custom`)
  - `--no-wake` (default: wake the receiver — this is operator-driven so the receiver TUI should visibly wake; flip to false only when the operator explicitly does not want a wake)
  - `--verbose` (default: minimal one-line response — see below; flip to full output for debugging)

Invoke `notify_peer` with:
- `to`: parsed peer name
- `event`: parsed event type (default `custom`)
- `message`: parsed message text
- `wake`: `true` UNLESS `--no-wake` was passed

**Respond with EXACTLY ONE LINE** (default; minimizes context-token consumption per macf#350):

- Success → `→ <peer> [<event>] delivered=<bool>`
- Failure → `→ <peer> failed: <reason>`

Do NOT restate the JSON result, the tool's input schema, or describe what the operation did. The operator already knows what they invoked — they invoked the slash-command.

If `--verbose` was passed, also print the full `notify_peer` result JSON after the one-line confirmation.
