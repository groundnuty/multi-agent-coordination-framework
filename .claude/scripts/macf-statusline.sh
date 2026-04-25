#!/usr/bin/env bash
# .claude/scripts/macf-statusline.sh — display agent settings + cwd
set -euo pipefail
INPUT=$(cat)

EFFORT=$(echo "$INPUT" | jq -r '.effort.level // "default"')
THINKING=$(echo "$INPUT" | jq -r '.thinking.enabled // false')
MODEL=$(echo "$INPUT" | jq -r '.model.id // "?"')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' | sed "s|$HOME|~|")

THINK_MARK=""; [[ "$THINKING" == "true" ]] && THINK_MARK="◆"
echo "[${MODEL}/${EFFORT}${THINK_MARK}] ${CWD}"
