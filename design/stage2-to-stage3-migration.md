# Stage 2 → Stage 3 migration runbook

**Date:** 2026-04-27
**Status:** Per-agent self-migration (path 2 per `macf#257` Phase B coordination model)
**Driver:** `macf#257` — substrate workspaces transition from SSH+tmux routing to mTLS HTTP-POST against per-agent channel servers

This document is what each substrate-agent operator (or the agent itself, picking up the directive) reads to migrate a workspace from Stage 2 to Stage 3 routing. Phase A deliverable per `macf#257`.

## What changes

| Layer | Stage 2 | Stage 3 |
|---|---|---|
| **Routing transport** | `ssh user@host tmux send-keys '<prompt>' Enter` | `curl -X POST https://host:port/notify` (mTLS) |
| **Address resolution** | Hardcoded `host`/`port`/`tmux_session` in caller's `agent-config.json` | `MACF_<PROJECT>_AGENT_<NAME>` registry variable populated by channel server on launch |
| **Failure mode** | Routing-Action exits 0 even when `tmux send-keys` succeeds but recipient TUI is in Remote Control mode (silent-fallback Instance 3 — 2× empirical firings 2026-04-26) | Pattern A result-invariant assertion: HTTP 200 from channel server confirms recipient acknowledged the byte sequence |
| **Per-agent runtime** | Custom `claude.sh` wrapper invokes `claude` directly | `claude.sh` from `macf init` invokes `claude --plugin-dir .macf/plugin`; plugin's `mcpServers.macf-agent` spawns the channel server as MCP stdio child |

## Pre-conditions

Operator must verify before any agent begins migration:

- [ ] **`groundnuty/macf-actions` workflow is on v3.x** (already shipped — agent-router.yml v3 is "registry-driven mTLS transport"; SSH+tmux paths gone from active code per macf#257 P6 finding)
- [ ] **`@groundnuty/macf` CLI ≥ v0.2.1** is installable globally (already published on npm — `npm install -g @groundnuty/macf` resolves to current v0.2.1+)
- [ ] **Per-project CA exists** at `~/.macf/certs/<project>/{ca-cert.pem,ca-key.pem}` (create one-time via `macf certs init` from any workspace in the project, with passphrase prompt; uploads CA cert to project's GitHub Variables for routing-Action to trust)
- [ ] **Each agent's GitHub App has `actions_variables: write`** on the project's registry repo/org (per DR-019); without it the channel server can't self-register and routing-Action can't resolve the agent's address

## Per-agent migration steps

For each substrate workspace (e.g., `groundnuty/macf-science-agent`, `groundnuty/macf` — code-agent, `groundnuty/macf-devops-toolkit` — devops-agent), the operator (or the agent itself, picking up via routing) executes:

### 1. Verify pre-conditions

```bash
# Pre-condition: macf CLI installed
command -v macf || npm install -g @groundnuty/macf

# Pre-condition: project CA exists (create if not — interactive passphrase)
ls ~/.macf/certs/<project>/{ca-cert.pem,ca-key.pem} 2>/dev/null \
  || (cd <existing-workspace> && macf certs init)
```

### 2. Save existing claude.sh customizations

`macf init` overwrites `claude.sh` with the canonical launcher. If your existing `claude.sh` carries substrate-specific OTel resource attrs, custom env exports, or a tmux-wrapper pattern not in the canonical template, save them first:

```bash
cp claude.sh claude.sh.pre-stage3.bak
# Inspect for: OTEL_RESOURCE_ATTRIBUTES with custom values; OTEL_LOG_* flags;
# tmux/sg-docker wrappers; non-standard claude flags
```

The canonical claude.sh from `macf init` exports the MACF_* envs the channel server needs (`MACF_AGENT_NAME`, `MACF_CA_CERT`, `MACF_AGENT_CERT`, `MACF_AGENT_KEY`, `MACF_PROJECT`, `MACF_REGISTRY_TYPE/REPO`, etc.) and invokes `claude --plugin-dir .macf/plugin` so the plugin loads + spawns the channel server on session start.

### 3. Run `macf init`

```bash
macf init \
  --project <project-name> \
  --role <code-agent|science-agent|devops-agent> \
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

Effects:

- Creates `.macf/{certs,logs,plugin}/`
- Generates agent cert (signed by project CA from step 1)
- Writes `.macf/macf-agent.json` (single source of truth for agent identity + registry pointer)
- Fetches `groundnuty/macf-marketplace@v<plugin-version>` plugin to `.macf/plugin/`
- Writes canonical `claude.sh` with MACF_* env exports
- Merges the gh-token PreToolUse hook into `.claude/settings.json` (per `macf#140`)
- Pre-approves the 4 macf-agent plugin skills

Post-init, hand-merge any saved customizations from step 2 into the new `claude.sh` (typically: extra OTel attrs, content-emission flags). Avoid removing any of the canonical MACF_* exports — the channel server's `loadConfig` requires them.

### 4. Restart the agent's session via the new `claude.sh`

Stop any prior `claude` process for this agent. Launch fresh:

```bash
./claude.sh
```

The plugin loads; `mcpServers.macf-agent` spawns the channel server as an MCP stdio child; channel server bootstraps OTel (if `OTEL_EXPORTER_OTLP_ENDPOINT` is set), starts HTTPS server on a free port, and self-registers in the project's GitHub Variables.

### 5. Verify channel server is operationally registered

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

### 6. Verify routing reaches the agent end-to-end

From a peer agent's workspace (or from any tester), file an issue tagged for this agent (label = agent's app name without `[bot]` suffix, e.g., `science-agent`). The routing-Action workflow on the project's repo fires `curl -X POST https://<this-agent-host>:<this-agent-port>/notify` and the prompt arrives in the agent's TUI.

If the routing succeeds (HTTP 200) but the prompt doesn't arrive, that's the silent-fallback Instance 3 class — file an issue on `groundnuty/macf-science-agent` to update the hazards catalog.

## Verification gate

Migration considered complete for an agent when:

- [ ] `MACF_<PROJECT>_AGENT_<NAME>` registry variable updated within last session-start window
- [ ] `.macf/logs/channel.log` shows `server_started` event for current session
- [ ] One end-to-end routing test from a peer agent confirmed (issue → routing-Action HTTP-POST → channel server `/notify` → recipient TUI)
- [ ] Pre-existing in-flight issues for this agent re-routed cleanly (no `agent-offline` label spurious-applied during transition)

## Rollback (if migration fails)

```bash
# Restore pre-Stage-3 claude.sh
cp claude.sh.pre-stage3.bak claude.sh

# Optionally remove .macf/ to clean up
rm -rf .macf/
```

The `agent-router.yml` v3 workflow gracefully degrades — if a channel server is unreachable, it adds the `agent-offline` label (per `macf#140` defensive routing). So a failed Stage 3 agent is recoverable: revert claude.sh, restart the session in pre-Stage-3 mode, the routing-Action will mark it offline, and the operator can re-attempt migration once the failure root cause is diagnosed.

Note: the v3 routing-Action does NOT fall back to SSH+tmux on channel-server failure — there's no Stage 2 path. So an agent with a broken channel server is effectively offline for routing until the channel server is fixed. This is by design (Stage 2's silent-fallback Instance 3 hazard is exactly what Stage 3 cuts out).

## Operator role

Under path 2 (each agent migrates itself), the operator's role is:

1. **Pre-condition setup** (one-time per project): create the project CA, ensure the routing-action's GitHub App secrets are configured (per DR-022 + macf-actions v3 caller requirements)
2. **Surface the migration directive** to each substrate agent (file an issue tagged for the agent referencing this runbook + Phase B of `macf#257`)
3. **Monitor for breakage** during the migration window — watch for spurious `agent-offline` labels, missing `MACF_*_AGENT_*` registry variables, or routing-Action workflow failures
4. **Coordinate cross-substrate verification** — once two or more substrates have migrated, verify cross-agent routing actually works (file an issue from agent A tagged for agent B; confirm B receives it)

The operator does NOT unilaterally bootstrap each substrate workspace. Each agent owns its own migration; the operator owns the project-wide pre-conditions and the verification telemetry.

## Cross-references

- `macf#257` — substrate migration master tracker
- `macf#260` — `FALLBACK_VERSIONS.plugin` bump that made `macf init` bootstrap actually work end-to-end (without it, channel server didn't spawn via `--plugin-dir`)
- `macf-testbed#229` — first end-to-end Phase B+C verification of the bootstrap path (testers, not substrate; same mechanism)
- `macf-testbed#230` — `bootstrap-tester.sh` reference implementation showing the save/restore-claude.sh pattern for workspaces with custom launchers
- `groundnuty/macf-actions` v3.x — current routing-Action implementation (already on Stage 3; no migration needed at the Action layer)
- `silent-fallback-hazards.md` Instance 3 (in `groundnuty/macf-science-agent`) — the hazard class Stage 3 structurally retires
- DR-002 (channel-per-agent), DR-003 (communication-planes), DR-005 (agent-registration), DR-007 (port-assignment), DR-015 (http-endpoints), DR-020 (notify-wake), DR-022 (channel-server-npm-npx) — design decisions Stage 3 implements
