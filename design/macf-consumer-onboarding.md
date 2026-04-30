# MACF consumer onboarding

**Status:** Active runbook for new MACF-consumer projects
**Audience:** Operators bootstrapping a NEW MACF-consumer project (CV agents, future macf-init'd workspaces). **Substrate workspaces (`groundnuty/macf-science-agent`, `groundnuty/macf` — code-agent, `groundnuty/macf-devops-toolkit` — devops-agent) are out of scope per operator directive 2026-04-27 — substrate never runs `macf init`.**
**History:** Originally drafted as `stage2-to-stage3-migration.md` (PR #264, `macf#257` Phase A) for substrate migration. Reshaped per `macf#273` after the substrate-permanent-Stage-2 directive made the migration framing obsolete; consumer onboarding is the actual reusable surface.

This document is what an operator (or the consumer agent itself, picking up the directive) reads to bootstrap a new MACF-consumer project against Stage 3 routing infrastructure (mTLS HTTP-POST `/notify` against per-agent channel servers).

For a hands-on tutorial walking through the bootstrap path step-by-step (with concrete time budgets per step), see [`docs/quickstart.md`](../docs/quickstart.md). This document is the **reference runbook** (more detail per step + decommission + rollback paths); `quickstart.md` is the **tutorial** (linear, ~30 min, designed for first-time bootstrap).

## What you get

After bootstrap, a consumer agent participates in MACF coordination via:

| Layer | Mechanism |
|---|---|
| **Routing transport** | `curl -X POST https://<host>:<port>/notify` (mTLS) — sender's `agent-router.yml` workflow → receiver's channel-server `/notify` endpoint → recipient TUI wake |
| **Address resolution** | `MACF_<PROJECT>_AGENT_<NAME>` GitHub Variables registry entry, populated by the channel server on session start |
| **Failure detection** | Pattern A result-invariant assertion: HTTP 200 from channel server confirms recipient acknowledged the byte sequence (no silent-fallback Instance 3 class) |
| **Per-agent runtime** | Canonical `claude.sh` (from `macf init`) invokes `claude --plugin-dir .macf/plugin`; plugin's `mcpServers.macf-agent` spawns the channel server as MCP stdio child |
| **Coordination rules + scripts** | `.claude/rules/coordination.md`, `.claude/scripts/macf-gh-token.sh`, attribution-trap PreToolUse hook, mention-routing-hygiene PreToolUse hook — all distributed by `macf init` and refreshed by `macf update` |

## Requirements

Operator must verify before any consumer agent begins bootstrap:

- [ ] **`groundnuty/macf-actions` workflow is on v3.x** (already shipped — `agent-router.yml` v3 is "registry-driven mTLS transport"; SSH+tmux paths gone from active code per `macf#257` P6 finding). The consumer's project repo must reference it from `.github/workflows/agent-router.yml` via `uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3` (or pinned tag).
- [ ] **`@groundnuty/macf` CLI** is installable globally — `npm install -g @groundnuty/macf` resolves to current published version. Latest published version reachable via `npm view @groundnuty/macf version`. v0.2.9 ships the doctor + Path-2 hooks set; later versions inherit.
- [ ] **Per-project CA exists** at `~/.macf/certs/<project>/{ca-cert.pem,ca-key.pem}` (create one-time via `macf certs init` from any workspace in the project, with passphrase prompt; uploads CA cert to the project's GitHub Variables for the routing-Action to trust).
- [ ] **Each agent's GitHub App has `actions_variables: write`** on the project's registry repo/org/profile (per DR-019); without it the channel server can't self-register and the routing-Action can't resolve the agent's address. Verify via `macf doctor` post-bootstrap (it surfaces all DR-019 permission gaps + a few hardening checks for `permissions.allow` and `sandbox.filesystem.allowRead`).

## Bootstrap steps

For each new consumer agent (e.g., `cv-architect` on `groundnuty/academic-resume`, `cv-project-archaeologist` on its own repo, future MACF-consumer projects), the operator (or the agent itself, picking up via routing) executes:

### 1. Verify pre-conditions

```bash
# Pre-condition: macf CLI installed
command -v macf || npm install -g @groundnuty/macf

# Pre-condition: project CA exists (create if not — interactive passphrase)
ls ~/.macf/certs/<project>/{ca-cert.pem,ca-key.pem} 2>/dev/null \
  || (cd <existing-workspace> && macf certs init)
```

### 2. Run `macf init`

```bash
macf init \
  --project <project-name> \
  --role <agent-role> \
  --name <agent-app-name> \
  --type permanent \
  --app-id $APP_ID \
  --install-id $INSTALL_ID \
  --key-path .github-app-key.pem \
  --registry-type <repo|org|profile> \
  --registry-repo <owner>/<repo>     # if --registry-type repo
  --advertise-host <127.0.0.1|<tailscale-ip>>  # 127.0.0.1 if all agents on same VM
  --tmux-session <session-name>      # for on-notify wake (DR-020)
  --dir .
```

Required flags (per `packages/macf/src/cli/index.ts`): `--project`, `--role`, `--app-id`, `--install-id`, `--key-path`. Optional flags supply defaults; `--registry-type` defaults to `repo`, `--type` defaults to `permanent`. Cross-reference the live `--help` output for the canonical flag set when the CLI is updated.

Effects of `macf init`:

- Creates `.macf/{certs,logs,plugin}/`
- Generates the agent cert (signed by the project CA from step 1)
- Writes `.macf/macf-agent.json` (single source of truth for agent identity + registry pointer)
- Fetches `groundnuty/macf-marketplace@v<plugin-version>` plugin to `.macf/plugin/`
- Writes canonical `claude.sh` with MACF_* env exports
- Merges the gh-token + mention-routing PreToolUse hooks into `.claude/settings.json` (per `macf#140`, `macf#272`, `macf#244`)
- Pre-approves the 4 macf-agent plugin skills
- Distributes canonical rules to `.claude/rules/`: `coordination.md`, `pr-discipline.md`, `mention-routing-hygiene.md`, `silent-fallback-hazards.md`, `delegation-template.md`, `agent-identity.md`

### 3. Launch the agent's session via `claude.sh`

```bash
./claude.sh
```

The plugin loads; `mcpServers.macf-agent` spawns the channel server as an MCP stdio child; channel server bootstraps OTel (if `OTEL_EXPORTER_OTLP_ENDPOINT` is set), starts HTTPS server on a free port, and self-registers in the project's GitHub Variables.

### 4. Verify channel server is operationally registered

```bash
# Check the registry variable
gh api repos/<owner>/<registry-repo>/actions/variables/MACF_<PROJECT_UPPER>_AGENT_<NAME_UPPER> --jq '{name, value, updated_at}'
```

Expected: `value` is JSON with `host`, `port`, `type: "permanent"`, `instance_id`, `started` timestamp matching this session's start.

```bash
# Check the channel server log
cat .macf/logs/channel.log
```

Expected: `collision_check`, `registered`, `server_started` events at session-start timestamp.

### 5. Verify routing reaches the agent end-to-end

From a peer agent's workspace (or from any tester / coordinator), file an issue tagged for this agent (label = agent's app name without `[bot]` suffix, e.g., `cv-architect`). The routing-Action workflow on the project's repo fires `curl -X POST https://<this-agent-host>:<this-agent-port>/notify` and the prompt arrives in the agent's TUI.

If the routing succeeds (HTTP 200) but the prompt doesn't arrive in the recipient TUI, that's the silent-fallback Instance 3 class — file an issue on `groundnuty/macf-science-agent` to update the hazards catalog.

### 6. Run `macf doctor` (recommended)

```bash
macf doctor
```

Surfaces:
- DR-019 permission gaps on the GitHub App
- Sandbox `/proc/self/fd` allowRead pattern (fixes Bash tool failures per `macf#200`)
- Workspace permissions: `permissions.allow` Write/Edit presence (per `macf#296` / `#305`) — autonomous coordination prerequisite. Reads merged view of `.claude/settings.json` + `.claude/settings.local.json` per Claude Code's canonical merge semantics.

The doctor is warn-only on `permissions.allow` gaps (operator may have deliberate restrictions) but errors on missing DR-019 perms or absent sandbox FD pattern.

## Verification gate

Bootstrap considered complete for a consumer when:

- [ ] `MACF_<PROJECT>_AGENT_<NAME>` registry variable updated within last session-start window
- [ ] `.macf/logs/channel.log` shows `server_started` event for current session
- [ ] One end-to-end routing test from a peer agent confirmed (issue → routing-Action HTTP-POST → channel server `/notify` → recipient TUI wake)
- [ ] `macf doctor` returns exit 0 (no missing DR-019 perms; sandbox FD allowRead present; workspace `permissions.allow` either grants Write/Edit or has explicit operator deny rules)

## Rollback (if bootstrap fails partway)

If `macf init` aborts mid-flow, the channel server fails to register, or the routing test fails:

```bash
# Optionally remove .macf/ to clean up partial state
rm -rf .macf/

# Remove the canonical claude.sh (operator will re-run macf init)
rm claude.sh

# If certs were registered to the registry but the workspace is broken,
# remove the registry variable so a peer doesn't see a stale entry:
gh variable delete MACF_<PROJECT_UPPER>_AGENT_<NAME_UPPER> --repo <owner>/<registry-repo>
```

The `agent-router.yml` v3 workflow gracefully degrades — if a channel server is unreachable, it adds the `agent-offline` label (per `macf#140` defensive routing). So a workspace mid-bootstrap-failure looks "offline" to peers; once the operator diagnoses the failure (typically a missing GitHub App permission, expired install token, or wrong `--advertise-host`), re-running `macf init --dir .` is safe (idempotent — overwrites `claude.sh`, refreshes `.claude/`).

## Decommission (winding down a healthy consumer)

When a consumer project is winding down or a specific agent is being retired:

```bash
# 1. Stop the agent session (so the channel server flushes pending state)
#    Then: stop the claude process for this agent

# 2. Remove the registry variable so peers don't route to a dead address
gh variable delete MACF_<PROJECT_UPPER>_AGENT_<NAME_UPPER> --repo <owner>/<registry-repo>

# 3. (Optional) Revoke the agent's cert from the project CA
#    No central revocation list — re-issuance via macf certs is the canonical path; deletion is local

# 4. Remove the workspace MACF state
rm -rf .macf/ claude.sh

# 5. Remove the routing-action workflow if this is the project's last consumer
rm .github/workflows/agent-router.yml
```

The decommission is reversible — re-running `macf init` per the bootstrap section restores the agent. CV consumer workspaces have done this multiple times during cv-e2e-test rehearsal cycles without operator intervention beyond the standard bootstrap.

## Non-MACF rollback (consumer reverts to a different coordination substrate)

If a project decides to abandon MACF entirely (e.g., switch to a different multi-agent framework or revert to single-agent operation):

1. Decommission each consumer per the section above (stop sessions, remove registry vars, delete `.macf/` + `claude.sh`)
2. Remove `.github/workflows/agent-router.yml` from the project repo
3. Uninstall the GitHub Apps and remove the project CA from `~/.macf/certs/<project>/`
4. Remove the project's `.claude/rules/`, `.claude/scripts/`, and `.claude/settings.json` MACF entries (operator-edit; nothing in MACF mandates the operator removes their own settings, but coordination.md + helper scripts remain dormant otherwise)

There is no automated tooling for switching frameworks — MACF doesn't track consumers' history beyond what's in the workspace. The reverse path is operator-driven.

## Operator role

For each consumer project bootstrap, the operator's role is:

1. **One-time per project**: create the project CA, install the routing-action workflow, ensure the GitHub App's permissions are configured (per DR-019)
2. **Per-consumer**: provide `--app-id`, `--install-id`, `--key-path` to the consumer agent (or the bootstrap script invokes `macf init` directly with these resolved)
3. **Cross-consumer verification**: once two or more consumers are operational, verify cross-agent routing works (file an issue from agent A tagged for agent B; confirm B receives it)

The operator does NOT post-bootstrap-edit the workspace state by default. The agent owns its own runtime; operator owns the project-wide pre-conditions and the verification telemetry.

## Worked example — CV-fleet onboarding (2026-04 timeline)

Empirical reference for the bootstrap path:

1. **`groundnuty/academic-resume`** (`cv-architect` agent) — bootstrap via `macf init`. Channel server registered; cross-routing tested via cv-e2e-test rehearsals #11b, #12b, #13b (10/11 PASS empirically validating route-by-pr-review-state per macf-actions#39). Notable workspace customization: operator-authored `Write` + `Edit` in `.claude/settings.local.json` (per `macf#305` merge-view fix in `macf doctor`).
2. **`groundnuty/cv-project-archaeologist`** — same bootstrap path; sister consumer; cross-routing exercised in research-handoff PR cycles.
3. **Future CV-fleet additions** — same path; differential is project-name + agent-role at `macf init` time.

Reference test bootstrap shape: `groundnuty/macf-testbed:scripts/bootstrap-tester.sh` shows the canonical save/restore-claude.sh pattern for workspaces with custom launchers (testbed agents have a custom `claude.sh` with extra OTel attrs + tmux/sg-docker wrappers; `bootstrap-tester.sh` saves it before `macf init` and re-merges after). Most consumer projects don't need this customization — the canonical `claude.sh` is sufficient.

## Cross-references

- `macf#254` + `#257` — Stage 3 master tracker + Phase A (this doc's original draft)
- `macf#273` — this doc's reshape from substrate-migration framing to consumer-onboarding framing
- `macf#260` — `FALLBACK_VERSIONS.plugin` bump that made `macf init` bootstrap actually work end-to-end
- `macf-testbed#229` — first end-to-end Phase B+C verification of the bootstrap path (testers; same mechanism)
- `macf-testbed:scripts/bootstrap-tester.sh` — reference implementation showing the save/restore-claude.sh pattern
- `groundnuty/macf-actions` v3.x — current routing-Action implementation (Stage 3; consumers reference it via `uses:`)
- `silent-fallback-hazards.md` Instance 3 (in `groundnuty/macf-science-agent`) — the hazard class Stage 3 structurally retires
- `design/decisions/DR-002` (channel-per-agent), `DR-003` (communication-planes), `DR-005` (agent-registration), `DR-007` (port-assignment), `DR-015` (http-endpoints), `DR-019` (App permissions), `DR-020` (notify-wake), `DR-022` (channel-server-npm-npx) — design decisions Stage 3 implements
