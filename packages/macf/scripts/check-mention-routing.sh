#!/usr/bin/env bash
#
# check-mention-routing.sh — Claude Code PreToolUse hook that blocks
# `gh issue comment` / `gh pr comment` / `gh issue close --comment` /
# `gh pr close --comment` invocations when the `--body` content contains
# raw `@macf-<role>-agent[bot]` mentions in describing contexts (mid-line,
# not backticked). Implements `mention-routing-hygiene.md` §5 structurally.
#
# Hook contract: JSON on stdin, exit 0 = allow, exit 2 = block (stderr
# is fed back to Claude as the error). Mirrors the shape of #140's
# check-gh-token.sh per groundnuty/macf#272 design alignment.
#
# Override: MACF_SKIP_MENTION_CHECK=1 bypasses (for legitimate raw-mention
# cases the heuristic catches; rare per the canonical rule's structure
# but mirrors check-gh-token.sh's escape hatch).
#
# Refs: groundnuty/macf#244 (must-have-mention class — orthogonal, deferred),
#       groundnuty/macf#272 (must-not-leak — what this script enforces),
#       DR-023 UC-4 (bash-form per substrate-compat — mcp_tool variant
#       won't fire on substrate workspaces where the macf-agent MCP server
#       isn't loaded, but the breach pattern is concentrated on substrate).
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_MENTION_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Read PreToolUse payload. Fall through to allow on parse error — a
# broken hook must not brick the harness. Same defense-in-depth as
# check-gh-token.sh.
INPUT_JSON="$(cat)"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

# Wrapper-aware match for the comment-posting subcommands. Mirrors
# check-gh-token.sh's pattern shape — covers sudo, env VAR=, watch,
# ionice, setsid, nice, time prefix wrappers + chained-form leadins
# `;` `|` `&`. The subcommands we care about are exactly those that
# accept --body and post text content visible to other agents:
#   gh issue comment    gh pr comment
#   gh issue close      gh pr close      (only when --comment is present;
#                                          plain close has no body)
GH_COMMENT_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+(issue|pr)[[:space:]]+(comment|close)([[:space:]]|$)'

# Shell-wrapper bypass: catches `bash -c "gh issue comment ..."` and
# variants. Same flag-handling logic as check-gh-token.sh.
SHELL_C_GH_COMMENT_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]+(issue|pr)[[:space:]]+(comment|close)([[:space:]]|$)'

if [[ ! "$COMMAND" =~ $GH_COMMENT_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_GH_COMMENT_PATTERN ]]; then
  # Not a comment-posting command — allow.
  exit 0
fi

# `gh issue close` / `gh pr close` without --comment doesn't post text.
# Skip — nothing to check.
if [[ "$COMMAND" =~ gh[[:space:]]+(issue|pr)[[:space:]]+close ]] && [[ ! "$COMMAND" =~ --comment ]]; then
  exit 0
fi

# `--body-file` reads content from a file path; we don't lint file
# contents (the file may not exist at hook-fire time, or may be
# regenerated). Accept the trade-off and allow. The canonical rule
# still applies; operator discipline catches it without the hook.
if [[ "$COMMAND" =~ --body-file([[:space:]]|=) ]] && [[ ! "$COMMAND" =~ --body([[:space:]]|=)[[:space:]]*[\"\']*[@] ]]; then
  exit 0
fi

# Per-occurrence scan for raw @macf-<role>-agent[bot] patterns in the
# command string. Heuristic per groundnuty/macf#272 design synthesis:
#   - Already wrapped in backticks (`@bot[bot]`) → allowed (describing form §5)
#   - At line start (only whitespace, blockquote `>`, or list markers
#     `* ` `- ` `1. ` before it on the same line) → allowed (addressing
#     form §3 — typical PR-closing-line / handoff / escalation shape)
#   - Otherwise → BLOCK as describing-context leak
#
# False-positive trade-off: single-line bodies with the addressing form
# right after `--body "` (no preceding newline) are flagged. The canonical
# rule's examples (§3) all show addressing on its own line, so this
# matches the expected idiom. Override available for rare exceptions.
#
# False-negative trade-off: line-start mentions that are actually
# describing-with-bot-as-subject ("@bot's response was clean" — line
# starts with the handle but the sentence is descriptive) pass through.
# This is rare in practice; canonical idiom puts describing references
# inside prose, not at line-start. Operator discipline catches the residual.
# awk regex: `[[]` and `[]]` express literal `[` and `]` in a char class
# context (awk's `\[` escape would either warn-and-strip or be ambiguous
# across awk variants).
#
# Pattern scope (broadened per macf#276): matches ANY `@<handle>[bot]`
# rather than only `@macf-*-agent[bot]`. First char must be a letter
# (excludes leading digit/underscore/hyphen forms which aren't valid
# GitHub handles anyway); body accepts alphanumeric / underscore /
# hyphen so digit-suffixed and multi-segment handles match.
#
# Covers: macf-* fleet (`macf-code-agent`, `macf-science-agent`,
# `macf-tester-N-agent`, `macf-devops-agent`); future CV fleet
# (`cv-architect`, `academic-resume-author`, similar shapes); future
# MACF-consumer fleets that may not follow the `macf-*-agent` naming
# convention; AND third-party bots (`dependabot`, `github-actions`).
# Third-party bots don't fire MACF routing (not in agent registry),
# but blocking their describing-context use is consistent style — and
# operators can use `MACF_SKIP_MENTION_CHECK=1` for the rare legitimate
# describing reference. The cost of generalization is small; the
# benefit (fleet-agnostic protection) is durable.
HANDLE_PATTERN='@[a-zA-Z][a-zA-Z0-9_-]*[[]bot[]]'

OFFENDING="$(awk -v pat="$HANDLE_PATTERN" '
  {
    # Process every match on this line. After each match, advance the
    # search-substring past it (RSTART+RLENGTH from the original line $0
    # tracked via abs_offset).
    abs_offset = 0
    line = $0
    while ( match(line, pat) ) {
      abs_start = abs_offset + RSTART
      abs_end = abs_start + RLENGTH

      # Surrounding chars from the ORIGINAL line $0
      char_before = (abs_start - 1 >= 1) ? substr($0, abs_start - 1, 1) : ""
      char_after = substr($0, abs_end, 1)

      # Already-backticked? Allowed describing form (§5).
      if (char_before == "`" && char_after == "`") {
        line = substr(line, RSTART + RLENGTH)
        abs_offset = abs_start + RLENGTH - 1
        continue
      }

      # Line-start (after optional whitespace, blockquote, or list-item
      # markers)? Allowed addressing form (§3).
      prefix = substr($0, 1, abs_start - 1)
      if (prefix ~ /^[[:space:]>]*([0-9]+\.[[:space:]]+|[-*][[:space:]]+)?$/) {
        line = substr(line, RSTART + RLENGTH)
        abs_offset = abs_start + RLENGTH - 1
        continue
      }

      # Mid-line raw mention — describing-context leak.
      print NR ": " $0
      next  # skip remaining matches on this line; one report per line
    }
  }
' <<<"$COMMAND")"

if [[ -n "$OFFENDING" ]]; then
  cat >&2 <<ERR
BLOCKED by MACF mention-routing-hygiene hook: this comment contains raw
@<bot>[bot] mention(s) in describing-context (mid-line, not backticked) which
would fire false-positive routing per mention-routing-hygiene.md §5.

Offending line(s) within the command:
$OFFENDING

Fix per the canonical rule — wrap describing-context mentions in backticks:
  Wrong:  @macf-tester-2-agent[bot] response quoted coordination.md ...
  Right:  \`@macf-tester-2-agent[bot]\` response quoted coordination.md ...

Or use one of the equivalent suppression forms (§5):
  - Backticks:  \`@macf-tester-2-agent[bot]\`   (preferred — semantic markup)
  - Escapes:    \\@macf-tester-2-agent\\[bot\\]
  - Label form: "tester-2" or "the tester-2 agent"

Addressing form (line-start, expected to fire routing) is allowed:
  @macf-science-agent[bot] PR ready for review.

Override (ONLY for legitimate raw-mention cases the heuristic catches):
  export MACF_SKIP_MENTION_CHECK=1

Refs: groundnuty/macf#244, #272 (this hook); mention-routing-hygiene.md
(canonical rule, distributed via \`macf rules refresh\`).
ERR
  exit 2
fi

exit 0
