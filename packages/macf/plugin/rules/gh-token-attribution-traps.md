# gh-token attribution-trap failure modes

**Six ways `gh` operations silently mis-attribute to the user account instead of the bot, and the patterns that prevent them.**

When a bot agent runs `gh` commands, multiple silent failure modes cause ops to attribute to the user account instead of the bot. Because the content the agent posts is what it intended, mis-attribution is **invisible unless explicitly checked.** Past incidents:

- Code-agent's merge-handoff comments posted under operator's account for an entire session — discovered only when cross-agent routing started failing
- PR #16/#17 author mis-attribution surfaced during routine review (not by attribution itself)
- 5+ recurring instances logged across science-agent + code-agent memory before this rule was canonicalized

This is a **silent-fallback hazard class**: tool operations succeed at the API boundary, semantic-level failure (wrong identity / wrong scope / wrong target) is invisible until something downstream breaks. Defenses must guard at the *result-invariant* level, not the *exit-code* level.

---

## The six failure modes

### 1. Wrong private key file

GitHub rotated the App's private key (or the operator put the wrong .pem in the workspace). Local `.github-app-key.pem` doesn't match what GitHub has registered. Every JWT fails with `"A JSON web token could not be decoded"`. `gh token generate` exits non-zero, `GH_TOKEN=$(...)` captures empty, `gh` silently falls through to stored `gh auth login` as the user.

**Detect:**
```bash
# Compare local fingerprint with GitHub's (visible on the App settings page)
openssl rsa -in <key.pem> -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -binary | base64
```
Should match the "SHA256:..." shown on `github.com/settings/apps/<app>`.

### 2. Clock drift between VM and GitHub

If `iat` in the JWT is ahead of GitHub's clock (VM runs fast, or even a few seconds skew), GitHub rejects the JWT as "from the future" — same `"JSON web token could not be decoded"` error. Intermittent: sometimes valid, sometimes not, depending on the moment.

**Fix:** use a 180-second back-window on `iat` (not the 60s default):
```bash
iat=$((now - 180))    # 3 minutes in the past — tolerates up to 3 min of clock skew
exp=$((now + 420))    # still 10 min total lifetime (180 past + 420 future)
```

### 3. `gh` silent fallback to stored user auth

When `GH_TOKEN` is empty or invalid, `gh` falls through to `~/.config/gh/hosts.yml` if present. Ops succeed, content is correct, but `author` on the created resource is the user account.

**Fix:** fail loud. Never use `export GH_TOKEN=$(gh token generate ... | jq)` as a one-liner; it swallows errors. Pattern:
```bash
# Assert token was generated AND has the bot prefix
TOKEN=$(.claude/scripts/macf-gh-token.sh --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || {
  echo "FATAL: token-gen failed" >&2; exit 1
}
[ -n "$TOKEN" ] || { echo "FATAL: empty token" >&2; exit 1; }
case "$TOKEN" in ghs_*) ;; *) echo "FATAL: bad token prefix" >&2; exit 1 ;; esac
export GH_TOKEN="$TOKEN"
```

### 4. Wrong `gh auth` on the VM providing fallback

Having `gh auth login` configured as a user account creates the fallback surface in #3. Even a "good" setup where the script is correct can hide a broken bot token because `gh` quietly uses the user auth.

**Best hardening:** remove stored `gh auth login` on agent VMs entirely — then broken bot tokens fail loudly with "no auth," not silently as the user.

**Tradeoff:** interactive `gh` inspection by a human on the VM also requires a token. Usually acceptable for dedicated agent VMs.

### 5. Helper script missing from workspace (path 127, silent empty capture)

Non-init'd workspace had never received `.claude/scripts/macf-gh-token.sh` because the operator forgot to run `macf rules refresh` after the helper was introduced. Calling `./.claude/scripts/macf-gh-token.sh ...` returned exit 127 ("no such file") — but with `export GH_TOKEN=$(helper 2>/dev/null)` the 127 is silently discarded, stdout is empty, `GH_TOKEN=""`, `gh` falls through to stored user auth.

Compounds modes #3 + #4: all the bot ops look normal but post as the user. Only noticed when a human checked a comment URL.

**Fix:** use `macf rules refresh --dir <workspace>` to install canonical `macf-gh-token.sh` + `macf-whoami.sh` + `tmux-send-to-claude.sh`. Workbench-only workspaces (substrate agents) still need this — the helpers are distributed via a separate mechanism from full `macf init`.

Also: **always validate token prefix in the chain, not just in the helper.** Even a correctly-installed helper can fail (rotated key, clock drift) and return empty. Chain guard:

```bash
GH_TOKEN=$(./.claude/scripts/macf-gh-token.sh ...) \
  && [[ "$GH_TOKEN" == ghs_* ]] \
  || { echo "FATAL: bad token"; exit 1; }
export GH_TOKEN
```

The `[[ ... == ghs_* ]]` check catches both empty and junk-output cases (e.g., the "(eval):1: no such file" leak when stderr was merged into stdout).

### 6. Relative path to helper (or key) breaks on cross-repo `cd`

When an agent `cd`'s to another repo for cross-repo work (e.g., code-agent editing `macf-actions` from its `macf` workspace), `./.claude/scripts/...` doesn't resolve from the new cwd, and relative `$KEY_PATH` can't be read either.

`$(...)` command substitution swallows the helper's exit 127 silently, returns empty string. `export GH_TOKEN=""` succeeds with no error. Next `gh` call falls through to stored user auth. Mode-3 silent fallback, triggered by path breakage.

**Fix (canonical, post macf#161):**

- `claude.sh` exports `MACF_WORKSPACE_DIR="$SCRIPT_DIR"` — the workspace absolute path, available in all agent env regardless of cwd.
- `claude.sh` absolutizes `KEY_PATH` via `case` on leading slash (preserves operator-absolute paths like `/etc/macf/keys/...`, rewrites relative default to `$SCRIPT_DIR/$KEY_PATH`).
- All canonical agent templates use `$MACF_WORKSPACE_DIR/.claude/scripts/...` (NOT relative `./...`).

**Why mode 6 is distinct from mode 5:** mode 5 is "helper script file missing from workspace entirely." Mode 6 is "helper present in workspace, but reachable only via a path that breaks on cross-repo cwd." Mode 5's fix is installing the helper (`macf rules refresh`); mode 6's fix is using an absolute path to it (`$MACF_WORKSPACE_DIR/...`).

---

## Verifying identity after ops

Don't trust; verify. A token that "looks right" can still be misattributed due to a subtle env issue. Spot-check at session start:

```bash
# After posting any comment in a session, sanity-check ONE post:
GH_TOKEN=$T gh api "/repos/$REPO/issues/comments/$ID" --jq '.user.login'
# Expect: <bot-name>[bot]; FAIL if it shows the operator's user account
```

Do this once at session start (cheap), then trust. Mid-session re-checks not needed unless something suspicious happens.

The `macf-whoami.sh` helper canonicalizes this check:

```bash
.claude/scripts/macf-whoami.sh
# Prints the actor identity associated with current $GH_TOKEN
```

---

## Canonical pattern (distilled)

```bash
# Token acquisition — fails loud, token-prefix validated
TOKEN=$(.claude/scripts/macf-gh-token.sh --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") \
  || { echo "FATAL: token gen failed" >&2; exit 1; }

# Chain the op immediately so token doesn't linger in env
GH_TOKEN=$TOKEN gh issue comment <N> --repo <owner>/<repo> --body "..."
```

The helper script `macf-gh-token.sh` must:
1. Use `set -euo pipefail`
2. Use 180s `iat` back-window for clock drift tolerance
3. Validate token prefix is `ghs_` (installation token); refuse to print user PATs (`ghp_*`, `gho_*`)
4. Print nothing to stdout on failure (only stderr)

---

## Structural backstop: PreToolUse hook (macf#140)

Workspaces include a `PreToolUse` hook that intercepts `gh` and `git push` invocations and blocks with `exit 2` if `GH_TOKEN` is missing or doesn't have the `ghs_` prefix. This catches mode 3, 5, and 6 at the call site rather than after the fact.

Distribution: `macf init` / `macf update` / `macf rules refresh` install the hook + the helper scripts together.

When intentionally bypassing the hook for a knowingly user-attributed op (e.g., `gh auth login` during onboarding), set `MACF_SKIP_TOKEN_CHECK=1` for that one call.

---

## How this relates to other canonical rules

- `coordination.md` § "Token & Git Hygiene" documents the canonical helper invocation; this rule provides the failure-mode catalog the helper is designed to defend against.
- `pr-discipline.md` documents auto-close-keyword hazards in PR bodies; same shape (silent-fallback hazard at the API boundary) but different surface.

---

## Why this rule exists

Silent mis-attribution is a coordination failure mode that breaks routing workflows (workflow @-mention iteration sees user identity on bot-emitted posts; routing doesn't fire) and audit trails (paper-trail evidence shows wrong actors). The trap is mature — recurred 5+ instances across two substrate agents before this rule canonicalized — and prevention is straightforward once the failure modes are catalogued.

Pattern: defenses target *result-invariants* (token has `ghs_` prefix; spot-check actor on a known post), not *exit-code-success* (which silent fallbacks satisfy). This generalizes beyond gh-tokens to other tool/API surfaces with silent-fallback hazards.
