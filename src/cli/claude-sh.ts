/**
 * Generate and write the per-workspace `claude.sh` launcher. Extracted
 * from `init.ts` so `macf update` can regenerate it when the template
 * changes (see #63 — workspaces init'd on older CLI versions end up
 * with stale launchers and no way to refresh short of re-running init).
 *
 * The launcher carries a "managed file" header telling users not to
 * edit it — same pattern as the rules distribution (#54). `macf update`
 * overwrites unconditionally; user customizations are expected to live
 * elsewhere (e.g., `.claude/settings.local.json` for env tweaks).
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MacfAgentConfig } from './config.js';

/**
 * Emit shell `export MACF_REGISTRY_*` lines matching the registry
 * scope in `cfg`. The plugin's `src/config.ts` reads these three env
 * vars (MACF_REGISTRY_TYPE + per-type ORG / USER / REPO) on startup;
 * without them the plugin falls back to a hardcoded default repo and
 * 403s every registry op on consumers in other scopes. See macf#178.
 *
 * Exhaustive switch on the discriminated union — if a new RegistryConfig
 * variant is ever added, TypeScript fails the build here, forcing a
 * paired env-line update.
 */
function registryEnvLines(cfg: MacfAgentConfig): string[] {
  switch (cfg.registry.type) {
    case 'repo':
      return [
        `export MACF_REGISTRY_TYPE="repo"`,
        `export MACF_REGISTRY_REPO="${cfg.registry.owner}/${cfg.registry.repo}"`,
      ];
    case 'org':
      return [
        `export MACF_REGISTRY_TYPE="org"`,
        `export MACF_REGISTRY_ORG="${cfg.registry.org}"`,
      ];
    case 'profile':
      return [
        `export MACF_REGISTRY_TYPE="profile"`,
        `export MACF_REGISTRY_USER="${cfg.registry.user}"`,
      ];
  }
}

/**
 * Claude Code session-resume flags for the final `exec claude ...`.
 * Permanent agents reattach to the prior session so context persists
 * across relaunches (same ergonomics as macf-science-agent /
 * macf-code-agent's existing tmux wrappers). Worker agents skip `-c`
 * because every invocation is fresh by design. See macf#178 Gap 5.
 *
 * Exhaustive switch on `agent_type` so adding a new type is a compile
 * error that forces a paired flag policy decision.
 */
function resumeFlags(cfg: MacfAgentConfig): string[] {
  switch (cfg.agent_type) {
    case 'permanent':
      return ['-c'];
    case 'worker':
      return [];
  }
}

const MANAGED_HEADER_LINES = [
  '# This file is managed by `macf`. Do not edit directly — edits are',
  '# overwritten on the next `macf update`. The template lives at',
  '# groundnuty/macf:src/cli/claude-sh.ts. To change the launcher, file',
  '# an issue or PR against that file, then run `macf update` here.',
];

/**
 * Build the full `claude.sh` content for a given agent config. Pure
 * function — no I/O. Used by both `macf init` (first write) and
 * `macf update` (refresh).
 */
export function generateClaudeSh(config: MacfAgentConfig): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `# MACF Agent Launcher: ${config.agent_name}`,
    ...MANAGED_HEADER_LINES,
    '',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$SCRIPT_DIR"',
    '',
    // Export MACF_WORKSPACE_DIR so runtime agent templates
    // (.claude/rules/agent-identity.md + plugin/agents/*.md) can
    // reference the workspace root as an absolute path. Relative
    // paths break the moment the agent cd's to another repo for
    // cross-repo work — attribution trap fires. See #140 + the
    // cross-repo cwd trap note in coordination.md Token & Git Hygiene.
    'export MACF_WORKSPACE_DIR="$SCRIPT_DIR"',
    `export MACF_AGENT_NAME="${config.agent_name}"`,
    `export MACF_PROJECT="${config.project}"`,
    `export MACF_AGENT_TYPE="${config.agent_type}"`,
    `export MACF_AGENT_ROLE="${config.agent_role}"`,
    `export APP_ID="${config.github_app.app_id}"`,
    `export INSTALL_ID="${config.github_app.install_id}"`,
    `export KEY_PATH="${config.github_app.key_path}"`,
    // Resolve KEY_PATH against $SCRIPT_DIR if it's relative. Absolute
    // paths (e.g., operators who stored the key under /etc or /opt)
    // pass through unchanged. Previously KEY_PATH stayed relative and
    // broke the moment the agent cd'd to another repo — attribution
    // trap fires on the next `gh` call. See #140 + coordination.md
    // Token & Git Hygiene (cross-repo cwd trap note).
    'case "$KEY_PATH" in',
    '  /*) ;;  # already absolute',
    '  *) KEY_PATH="$SCRIPT_DIR/$KEY_PATH" ;;',
    'esac',
    'export KEY_PATH',
    `export MACF_CA_CERT="$HOME/.macf/certs/${config.project}/ca-cert.pem"`,
    `export MACF_CA_KEY="$HOME/.macf/certs/${config.project}/ca-key.pem"`,
    'export MACF_AGENT_CERT="$SCRIPT_DIR/.macf/certs/agent-cert.pem"',
    'export MACF_AGENT_KEY="$SCRIPT_DIR/.macf/certs/agent-key.pem"',
    'export MACF_LOG_PATH="$SCRIPT_DIR/.macf/logs/channel.log"',
    'export MACF_DEBUG="${MACF_DEBUG:-false}"',
    // Listen on all interfaces; advertise the routable host below. When
    // advertise_host is unset in macf-agent.json, fall back to 127.0.0.1
    // (the plugin's existing default — keeps backward compat for
    // workspaces that haven't set the field yet). See macf#178.
    'export MACF_HOST="0.0.0.0"',
    `export MACF_ADVERTISE_HOST="${config.advertise_host ?? '127.0.0.1'}"`,
    ...registryEnvLines(config),
    '',
    '# Bot token generation — fail loud. The helper validates the ghs_ prefix',
    '# and surfaces diagnostics (clock drift, bad key, wrong App/install ID).',
    '# Do NOT inline the bare CLI here — without pipefail, a failed fetch piped',
    '# through jq would succeed, GH_TOKEN would become "null", and Claude Code',
    '# would silently fall back to stored `gh auth login` as the user. See the',
    '# attribution-trap section of coordination.md Token & Git Hygiene.',
    'GH_TOKEN=$("$SCRIPT_DIR/.claude/scripts/macf-gh-token.sh" \\',
    '    --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || {',
    '  echo "FATAL: bot token generation failed — see stderr above." >&2',
    '  exit 1',
    '}',
    'export GH_TOKEN',
    '',
    `export GIT_AUTHOR_NAME="${config.agent_name}[bot]"`,
    `export GIT_COMMITTER_NAME="${config.agent_name}[bot]"`,
    '',
    `echo "Starting ${config.agent_name} (${config.agent_role})..."`,
    // --plugin-dir loads the pinned macf-agent plugin from this workspace
    // (per DR-013). Additive — user-scope plugins still load alongside.
    // `-c` (for permanent agents) reattaches to the prior Claude Code
    // session so context persists across relaunches; worker agents skip
    // it so every invocation is fresh. See macf#178 Gap 5.
    `exec claude ${[...resumeFlags(config), '--plugin-dir', '"$SCRIPT_DIR/.macf/plugin"'].join(' ')} "$@"`,
    '',
  ].join('\n');
}

/**
 * Write `claude.sh` into the workspace at 0755. Overwrites any existing
 * content — the managed-file header warns users against hand-editing.
 */
export function writeClaudeSh(workspaceDir: string, config: MacfAgentConfig): string {
  const absDir = resolve(workspaceDir);
  const path = join(absDir, 'claude.sh');
  writeFileSync(path, generateClaudeSh(config), { mode: 0o755 });
  // writeFileSync's `mode` option only applies when creating a new file.
  // On overwrite, the existing mode (often 0o644 from a user's editor)
  // is kept — so we must explicitly chmod to make sure the launcher
  // stays executable after `macf update` rewrites it.
  chmodSync(path, 0o755);
  return path;
}
