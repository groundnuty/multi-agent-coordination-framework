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
 * Emit the Claude Code native OTEL telemetry env block into the
 * generated `claude.sh`. Three mandatory gates per Claude Code docs
 * — missing any one of them → zero traces emit:
 *
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1       master gate
 *   CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1  additional gate (traces are beta)
 *   OTEL_TRACES_EXPORTER=otlp            choose exporter (default is none)
 *
 * See code.claude.com/docs/en/monitoring-usage § Traces (beta).
 *
 * Knobs at `macf init` / `macf update` time (read from calling shell
 * env, NOT persisted to macf-agent.json — observability is a
 * deployment-topology concern, not a per-agent-identity setting):
 *
 *   MACF_OTEL_DISABLED=1       → omit the block entirely. For
 *                                deployments without an observability
 *                                stack; avoids retry-spam to a
 *                                non-existent collector. See macf#197.
 *   MACF_OTEL_ENDPOINT=<url>   → bake a custom default into the
 *                                generated `claude.sh` (template-time
 *                                override). For central obs hosts
 *                                reachable over Tailscale / other
 *                                network paths.
 *
 * Default endpoint is `http://localhost:14318` per the canonical k3d
 * cluster topology (`groundnuty/macf-devops-toolkit:CLAUDE.md` —
 * `:14318` is the host-port-mapped serverlb endpoint; the
 * pre-2026-04-25 compose-stack `:4318` is retired). Surfaced in
 * groundnuty/macf#282 — CV-agents had zero telemetry for 34min because
 * the previous default landed on the retired port.
 *
 * Run-time override: the GENERATED claude.sh emits
 * `${OTEL_EXPORTER_OTLP_ENDPOINT:-<default>}` so a per-launch
 * `OTEL_EXPORTER_OTLP_ENDPOINT=<url>` in the operator's shell wins
 * over the baked default. Two-layer override pattern:
 *   - Template-time (`MACF_OTEL_ENDPOINT` at `macf init` / `macf update`):
 *     bakes a different default into claude.sh
 *   - Run-time (`OTEL_EXPORTER_OTLP_ENDPOINT` before `./claude.sh`):
 *     overrides the baked default for that launch
 *
 * Exported for unit tests.
 *
 * @param env — defaults to `process.env`; tests inject a fake.
 */
export function otelTelemetryLines(
  config: MacfAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env['MACF_OTEL_DISABLED'] === '1' || env['MACF_OTEL_DISABLED'] === 'true') {
    return [];
  }

  const endpoint = env['MACF_OTEL_ENDPOINT'] ?? 'http://localhost:14318';

  // The endpoint value gets embedded verbatim in a shell double-
  // quoted export. Reject chars that would break quoting or trigger
  // substitution: `"`, `$`, backtick, backslash, newline. Same
  // allowlist pattern as validateInitOpts on keyPath.
  if (/["$`\\\n\r]/.test(endpoint)) {
    throw new Error(
      `MACF_OTEL_ENDPOINT contains a shell-unsafe character. ` +
        `Got: ${JSON.stringify(endpoint)}. ` +
        `Expected a plain URL like http://host:port.`,
    );
  }

  return [
    '',
    '# macf#197 + macf#245: Claude Code native OTEL telemetry → observability stack.',
    '# Three telemetry signal gates — each independent, ALL required for the',
    '# corresponding signal to emit (per code.claude.com/docs/en/monitoring-usage):',
    '#   CLAUDE_CODE_ENABLE_TELEMETRY        — master telemetry gate (all signals)',
    '#   CLAUDE_CODE_ENHANCED_TELEMETRY_BETA — additional gate for traces (still beta)',
    '#   OTEL_TRACES_EXPORTER=otlp           — emit traces (default: none)',
    '#   OTEL_METRICS_EXPORTER=otlp          — emit metrics (default: none)',
    '#   OTEL_LOGS_EXPORTER=otlp             — emit logs (default: none)',
    '# Without the per-signal exporter env vars, that signal silently emits',
    '# nothing even if the master gate is on (#245 surfaced the metrics+logs',
    '# gap — only traces had the exporter set; metrics + logs were dark).',
    '# Omit the whole block by setting MACF_OTEL_DISABLED=1 at `macf update`',
    '# time — e.g. deployments without the obs stack running locally.',
    '# Endpoint override has two layers (groundnuty/macf#282):',
    '#   - Template-time: MACF_OTEL_ENDPOINT=<url> at `macf init` /',
    '#     `macf update` bakes a different default into this script',
    '#   - Run-time: OTEL_EXPORTER_OTLP_ENDPOINT=<url> in the shell',
    '#     BEFORE invoking ./claude.sh overrides the baked default',
    '#     (per-launch knob; matches OTel canonical env var name)',
    'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
    'export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1',
    'export OTEL_TRACES_EXPORTER=otlp',
    'export OTEL_METRICS_EXPORTER=otlp',
    'export OTEL_LOGS_EXPORTER=otlp',
    `export OTEL_EXPORTER_OTLP_ENDPOINT="\${OTEL_EXPORTER_OTLP_ENDPOINT:-${endpoint}}"`,
    'export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    `export OTEL_SERVICE_NAME="macf-agent-${config.agent_name}"`,
    `export OTEL_RESOURCE_ATTRIBUTES="gen_ai.agent.name=${config.agent_name},gen_ai.agent.role=${config.agent_role},service.namespace=macf"`,
  ];
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
    // macf#185: tmux session:window for on-notify wake via
    // tmux-send-to-claude.sh. If unset, the server auto-detects
    // from $TMUX when launched inside a tmux pane. Explicit-env
    // takes priority — handy when the agent is launched outside
    // tmux by a supervisor and still wants to target a named pane.
    ...(config.tmux_session !== undefined
      ? [`export MACF_TMUX_SESSION="${config.tmux_session}"`]
      : []),
    ...(config.tmux_window !== undefined
      ? [`export MACF_TMUX_WINDOW="${config.tmux_window}"`]
      : []),
    ...registryEnvLines(config),
    ...otelTelemetryLines(config),
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
    //
    // MACF_TEST=1 bypasses the `-c` auto-resume for clean-state smoke
    // tests — `-c` errors with "No deferred tool marker found" when the
    // prior session state is missing/partial. Normal production runs
    // (MACF_TEST unset) get the resume-by-default behavior. See
    // macf#189 sub-item 4.
    'if [ -n "${MACF_TEST:-}" ]; then',
    `  exec claude ${['--plugin-dir', '"$SCRIPT_DIR/.macf/plugin"'].join(' ')} "$@"`,
    'else',
    `  exec claude ${[...resumeFlags(config), '--plugin-dir', '"$SCRIPT_DIR/.macf/plugin"'].join(' ')} "$@"`,
    'fi',
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
