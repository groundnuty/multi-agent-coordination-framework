#!/bin/bash
# Launcher for macf-code-agent
# Generates a GitHub App token, starts tmux session, boots Claude Code.
#
# Requires:
#   - .claude/settings.local.json with env.APP_ID, env.INSTALL_ID, env.KEY_PATH
#   - .github-app-key.pem (or whatever KEY_PATH points to)
#   - gh CLI with personal login (for token generation)
#   - jq, tmux, claude

set -euo pipefail

if [ -d /home/linuxbrew/.linuxbrew ]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS="$DIR/.claude/settings.local.json"

if [ ! -f "$SETTINGS" ]; then
  echo "error: $SETTINGS not found" >&2
  echo "copy .claude/settings.local.json.example and fill in APP_ID / INSTALL_ID" >&2
  exit 1
fi

APP_ID=$(jq -r '.env.APP_ID' "$SETTINGS")
INSTALL_ID=$(jq -r '.env.INSTALL_ID' "$SETTINGS")
KEY_PATH=$(jq -r '.env.KEY_PATH' "$SETTINGS")

if [ "$APP_ID" = "null" ] || [ "$INSTALL_ID" = "null" ] || [ "$KEY_PATH" = "null" ]; then
  echo "error: APP_ID / INSTALL_ID / KEY_PATH missing in $SETTINGS" >&2
  exit 1
fi

ABS_KEY="$DIR/$KEY_PATH"
if [ ! -f "$ABS_KEY" ]; then
  echo "error: private key not found at $ABS_KEY" >&2
  exit 1
fi

GH_TOKEN=$(gh token generate --app-id "$APP_ID" --installation-id "$INSTALL_ID" --key "$ABS_KEY" | jq -r '.token')

SESSION="code-agent"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "session '$SESSION' already exists. attach with: tmux attach -t $SESSION" >&2
  exit 0
fi

tmux new-session -s "$SESSION" -c "$DIR" \
  "GH_TOKEN=$GH_TOKEN claude --permission-mode acceptEdits -c || GH_TOKEN=$GH_TOKEN claude --permission-mode acceptEdits"
