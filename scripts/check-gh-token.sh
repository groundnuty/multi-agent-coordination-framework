#!/usr/bin/env bash
#
# check-gh-token.sh — Claude Code PreToolUse hook that blocks `gh` and
# `git push` invocations when GH_TOKEN isn't a bot installation token
# (ghs_ prefix). Prevents the attribution trap documented in
# plugin/rules/coordination.md (Token & Git Hygiene) and #140.
#
# Hook contract: JSON on stdin, exit 0 = allow, exit 2 = block (stderr
# is fed back to Claude as the error). See groundnuty/macf#140 for
# design rationale; 5 recurrences in a single day drove the move from
# behavioral to structural enforcement.
#
# Override: MACF_SKIP_TOKEN_CHECK=1 bypasses (for intentional
# user-attributed ops, e.g. `gh auth login` during onboarding).
set -euo pipefail

# Operator override first — cheapest exit. No stdin read needed.
if [[ "${MACF_SKIP_TOKEN_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Read and parse the PreToolUse JSON payload. Fall through to allow on
# parse error — a broken hook must not brick the harness. Claude Code
# emits a well-formed payload in practice; this is defense-in-depth.
INPUT_JSON="$(cat)"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

# Wrapper-aware regex: match `gh ` or `git push ` as the effective
# command, allowing for zero or more of: sudo, env VAR=VAL..., watch,
# ionice, setsid, nice, time. Also triggers when preceded by `;`, `&&`,
# `||`, `|` so chained forms like `make && sudo gh ...` still match.
# Designed per science-agent's #140 review — the naïve anchored regex
# was trivially bypassable by wrappers.
GH_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(gh[[:space:]]|git[[:space:]]+push([[:space:]]|$))'

# Shell-wrapper bypass regex: catches `bash -c "gh ..."`, `sh -c '...'`,
# and `zsh -c` / `-lc` variants. The shell's -c flag executes the
# quoted string AS A COMMAND, so `gh` inside it IS a real invocation —
# unlike `echo "gh is cool"` where the same text is just literal data.
# Without this branch, `bash -c "gh issue close"` was a trivial bypass:
# `bash` isn't in the wrapper allowlist, and `gh` inside the quotes
# isn't preceded by one of the allowed delimiters `[[:space:];|&]`.
# Caught in the post-#140 audit pass, 2026-04-20.
SHELL_C_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+-l?c[[:space:]]+[^[:space:]].*(gh[[:space:]]|git[[:space:]]+push([[:space:]]|$))'

if [[ ! "$COMMAND" =~ $GH_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_PATTERN ]]; then
  # Not a gh/git-push command — allow without checking token.
  exit 0
fi

# `gh auth *` is identity-management (login, logout, status, token,
# refresh, setup-git) — user-attribution is correct by design here.
# Blanket-blocking this subcommand would put the hook directly in the
# onboarding path (fresh workspace → first `gh auth login` → wall of
# error text), which is exactly the wrong user experience. Carve it
# out. Wrapper forms (`sudo gh auth ...`) also match because the regex
# allows arbitrary wrapper prefix before `gh`.
if [[ "$COMMAND" =~ (^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+auth([[:space:]]|$) ]]; then
  exit 0
fi

# Check GH_TOKEN: must be present AND start with ghs_ (bot token).
# ghp_/gho_/ghu_ are user tokens; empty falls through to stored
# `gh auth login` (user). Either case fires the trap.
# Note: `${GH_TOKEN:-}` expansion is mandatory under `set -u`; a bare
# `${GH_TOKEN:0:4}` errors with "unbound variable" when the env var
# is unset, which is exactly the case we need to handle.
GH_TOKEN_VALUE="${GH_TOKEN:-}"
TOKEN_PREFIX="${GH_TOKEN_VALUE:0:4}"
if [[ -z "$GH_TOKEN_VALUE" ]] || [[ "$TOKEN_PREFIX" != "ghs_" ]]; then
  cat >&2 <<ERR
BLOCKED by MACF attribution-trap hook: this command would post as the USER, not the BOT.

Command: ${COMMAND}
GH_TOKEN prefix: ${TOKEN_PREFIX:-(empty)}

This hook exists because behavioral controls for the GH_TOKEN attribution
trap recurred 5 times in a single day. See groundnuty/macf#140 and
.claude/rules/coordination.md (Token & Git Hygiene).

Fix — refresh the bot token via the fail-loud helper:

  GH_TOKEN=\$(./.claude/scripts/macf-gh-token.sh \\
    --app-id "\$APP_ID" --install-id "\$INSTALL_ID" --key "\$KEY_PATH") || exit 1
  export GH_TOKEN

If the helper is missing, restore it:
  macf rules refresh --dir .

Override (ONLY for intentional user-attributed ops like onboarding):
  export MACF_SKIP_TOKEN_CHECK=1
ERR
  exit 2
fi

exit 0
