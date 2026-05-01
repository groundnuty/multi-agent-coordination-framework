/**
 * Tests for the extracted claude.sh generator. Used by both `macf init`
 * (first write) and `macf update` (refresh after a template change).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateClaudeSh, writeClaudeSh, otelTelemetryLines } from '../../src/cli/claude-sh.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

const sampleConfig: MacfAgentConfig = {
  project: 'TEST',
  agent_name: 'code-agent',
  agent_role: 'code-agent',
  agent_type: 'permanent',
  registry: { type: 'repo', owner: 'o', repo: 'r' },
  github_app: {
    app_id: '12345',
    install_id: '67890',
    key_path: '.github-app-key.pem',
  },
  versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
};

describe('generateClaudeSh', () => {
  it('includes the --plugin-dir flag + -c for permanent agents (default branch)', () => {
    const output = generateClaudeSh(sampleConfig);
    // Permanent agent → `-c` reattaches to prior session (macf#178 Gap 5).
    // The -c path lives inside the `else` branch; MACF_TEST-unset takes it.
    expect(output).toContain('exec claude -c --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"');
  });

  it('omits -c for worker agents (each invocation is fresh by design)', () => {
    const workerConfig: MacfAgentConfig = { ...sampleConfig, agent_type: 'worker' };
    const output = generateClaudeSh(workerConfig);
    // Worker has no -c in either MACF_TEST branch, so both lines look the same.
    expect(output).toContain('exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"');
    expect(output).not.toContain('exec claude -c');
  });

  describe('MACF_TEST escape hatch (macf#189 sub-item 4)', () => {
    it('generates a conditional exec: MACF_TEST set → no -c, else → -c (permanent)', () => {
      const output = generateClaudeSh(sampleConfig);
      // The template emits an if/else in the shell; both execs appear
      // in source, guarded at RUNTIME by the env check. Just assert
      // the conditional is there + both branches produce the expected
      // exec line.
      expect(output).toContain('if [ -n "${MACF_TEST:-}" ]; then');
      expect(output).toContain('exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"');
      expect(output).toContain('exec claude -c --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"');
      // Closing fi present.
      expect(output).toMatch(/fi[\s\n]*$/);
    });

    it('worker agents get the same conditional shape (both branches have no -c)', () => {
      // MACF_TEST doesn't change behavior for workers (already no -c),
      // but the if/else still gets emitted — the template is uniform.
      const workerConfig: MacfAgentConfig = { ...sampleConfig, agent_type: 'worker' };
      const output = generateClaudeSh(workerConfig);
      expect(output).toContain('if [ -n "${MACF_TEST:-}" ]; then');
    });
  });

  it('exports the expected environment variables from config', () => {
    const output = generateClaudeSh(sampleConfig);
    // MACF_AGENT_NAME + MACF_AGENT_ROLE use settings-driven 3-layer
    // priority post-#313 (env > settings.local.json > baked default).
    // Assert on each layer + final export rather than the direct-export
    // form that pre-#313 used.
    expect(output).toContain('MACF_AGENT_NAME="${MACF_AGENT_NAME:-$(macf_settings_get MACF_AGENT_NAME)}"');
    expect(output).toContain('MACF_AGENT_NAME="${MACF_AGENT_NAME:-code-agent}"');
    expect(output).toContain('export MACF_AGENT_NAME');
    expect(output).toContain('MACF_AGENT_ROLE="${MACF_AGENT_ROLE:-$(macf_settings_get MACF_AGENT_ROLE)}"');
    expect(output).toContain('MACF_AGENT_ROLE="${MACF_AGENT_ROLE:-code-agent}"');
    expect(output).toContain('export MACF_AGENT_ROLE');
    // MACF_PROJECT + MACF_AGENT_TYPE stay as direct exports (no
    // settings-driven priority — they're identity-internal, not
    // operator-tweakable per agent run).
    expect(output).toContain('export MACF_PROJECT="TEST"');
    expect(output).toContain('export MACF_AGENT_TYPE="permanent"');
    expect(output).toContain('export APP_ID="12345"');
    expect(output).toContain('export INSTALL_ID="67890"');
    expect(output).toContain('export KEY_PATH=".github-app-key.pem"');
  });

  it('exports MACF_WORKSPACE_DIR for cross-repo path resolution', () => {
    // Runtime agent templates (.claude/rules/agent-identity.md +
    // plugin/agents/*.md) reference $MACF_WORKSPACE_DIR so cd'ing to
    // another repo doesn't break the token helper path.
    // Observed failure mode: 2026-04-21 PR #16 attribution misfire.
    const output = generateClaudeSh(sampleConfig);
    expect(output).toContain('export MACF_WORKSPACE_DIR="$SCRIPT_DIR"');
  });

  it('resolves KEY_PATH against $SCRIPT_DIR when relative (cross-repo cwd trap)', () => {
    // Previously KEY_PATH stayed at the bare config value. If
    // `.github-app-key.pem` (relative), cd-ing to another repo made
    // the helper unable to find the key → silent empty GH_TOKEN →
    // attribution trap. Now claude.sh rewrites relative paths to
    // absolute at launch.
    const output = generateClaudeSh(sampleConfig);
    expect(output).toMatch(/case "\$KEY_PATH" in[\s\S]*?\/\*\) ;;[\s\S]*?\*\) KEY_PATH="\$SCRIPT_DIR\/\$KEY_PATH"/);
  });

  it('starts with a bash shebang and set -euo pipefail', () => {
    const output = generateClaudeSh(sampleConfig);
    const lines = output.split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env bash');
    expect(lines[1]).toBe('set -euo pipefail');
  });

  it('includes the managed-file header warning users not to edit', () => {
    const output = generateClaudeSh(sampleConfig);
    expect(output).toContain('managed by `macf`');
    expect(output).toContain('overwritten on the next `macf update`');
  });

  it('namespaces MACF_CA_CERT to the project', () => {
    const output = generateClaudeSh(sampleConfig);
    expect(output).toContain('export MACF_CA_CERT="$HOME/.macf/certs/TEST/ca-cert.pem"');
  });

  it('exports MACF_CA_KEY alongside MACF_CA_CERT (#103 R3)', () => {
    // Pre-#103 only MACF_CA_CERT was exported; server.ts derived the
    // key path via string-replace. Now the launcher emits both so
    // server config can consume the explicit field.
    const output = generateClaudeSh(sampleConfig);
    expect(output).toContain('export MACF_CA_KEY="$HOME/.macf/certs/TEST/ca-key.pem"');
  });

  describe('registry env exports (macf#178 Gap 1)', () => {
    it('emits MACF_REGISTRY_TYPE + MACF_REGISTRY_REPO for repo-scoped registry', () => {
      const cfg: MacfAgentConfig = {
        ...sampleConfig,
        registry: { type: 'repo', owner: 'groundnuty', repo: 'macf' },
      };
      const output = generateClaudeSh(cfg);
      expect(output).toContain('export MACF_REGISTRY_TYPE="repo"');
      expect(output).toContain('export MACF_REGISTRY_REPO="groundnuty/macf"');
      expect(output).not.toContain('MACF_REGISTRY_ORG');
      expect(output).not.toContain('MACF_REGISTRY_USER');
    });

    it('emits MACF_REGISTRY_TYPE + MACF_REGISTRY_ORG for org-scoped registry', () => {
      const cfg: MacfAgentConfig = {
        ...sampleConfig,
        registry: { type: 'org', org: 'papers-org' },
      };
      const output = generateClaudeSh(cfg);
      expect(output).toContain('export MACF_REGISTRY_TYPE="org"');
      expect(output).toContain('export MACF_REGISTRY_ORG="papers-org"');
      expect(output).not.toContain('MACF_REGISTRY_REPO');
      expect(output).not.toContain('MACF_REGISTRY_USER');
    });

    it('emits MACF_REGISTRY_TYPE + MACF_REGISTRY_USER for profile-scoped registry', () => {
      const cfg: MacfAgentConfig = {
        ...sampleConfig,
        registry: { type: 'profile', user: 'groundnuty' },
      };
      const output = generateClaudeSh(cfg);
      expect(output).toContain('export MACF_REGISTRY_TYPE="profile"');
      expect(output).toContain('export MACF_REGISTRY_USER="groundnuty"');
      expect(output).not.toContain('MACF_REGISTRY_REPO');
      expect(output).not.toContain('MACF_REGISTRY_ORG');
    });
  });

  describe('tmux-wake env exports (macf#185)', () => {
    it('emits MACF_TMUX_SESSION when tmux_session set in config', () => {
      const cfg: MacfAgentConfig = { ...sampleConfig, tmux_session: 'cv-project' };
      const output = generateClaudeSh(cfg);
      expect(output).toContain('export MACF_TMUX_SESSION="cv-project"');
    });

    it('emits MACF_TMUX_WINDOW when tmux_window set', () => {
      const cfg: MacfAgentConfig = {
        ...sampleConfig,
        tmux_session: 'cv-project',
        tmux_window: 'cv-architect',
      };
      const output = generateClaudeSh(cfg);
      expect(output).toContain('export MACF_TMUX_WINDOW="cv-architect"');
    });

    it('omits both exports when neither field set (auto-detect path)', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).not.toContain('MACF_TMUX_SESSION');
      expect(output).not.toContain('MACF_TMUX_WINDOW');
    });

    it('emits session alone when window not set', () => {
      const cfg: MacfAgentConfig = { ...sampleConfig, tmux_session: 'macf-code' };
      const output = generateClaudeSh(cfg);
      expect(output).toContain('export MACF_TMUX_SESSION="macf-code"');
      expect(output).not.toContain('MACF_TMUX_WINDOW');
    });
  });

  describe('advertise-host env export (macf#178 Gap 2)', () => {
    it('emits MACF_HOST=0.0.0.0 + MACF_ADVERTISE_HOST from config when set', () => {
      const cfg: MacfAgentConfig = { ...sampleConfig, advertise_host: '100.124.163.105' };
      const output = generateClaudeSh(cfg);
      expect(output).toContain('export MACF_HOST="0.0.0.0"');
      expect(output).toContain('export MACF_ADVERTISE_HOST="100.124.163.105"');
    });

    it('falls back to MACF_ADVERTISE_HOST=127.0.0.1 when config.advertise_host is unset', () => {
      // Matches plugin's internal default in src/config.ts — keeps
      // backward-compat for workspaces that haven't opted into off-box
      // routing. The env is always emitted so `echo $MACF_ADVERTISE_HOST`
      // shows the active value regardless.
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('export MACF_ADVERTISE_HOST="127.0.0.1"');
    });

    it('accepts a DNS name as advertise-host', () => {
      const cfg: MacfAgentConfig = { ...sampleConfig, advertise_host: 'agent.tailnet.ts.net' };
      const output = generateClaudeSh(cfg);
      expect(output).toContain('export MACF_ADVERTISE_HOST="agent.tailnet.ts.net"');
    });
  });

  it('uses the fail-loud token helper (no naive gh token generate | jq)', () => {
    // #67: the launcher must not embed the silent-fallback anti-pattern.
    const output = generateClaudeSh(sampleConfig);

    // Invokes the helper, not the bare CLI.
    expect(output).toContain('macf-gh-token.sh');
    expect(output).toContain('$SCRIPT_DIR/.claude/scripts/macf-gh-token.sh');

    // Fails loud — explicit `exit 1` on helper failure.
    expect(output).toMatch(/macf-gh-token\.sh[\s\S]*?exit 1/);

    // And specifically does NOT reinstate the naive pattern.
    expect(output).not.toMatch(/gh token generate[^\n]*\|\s*jq/);
  });
});

describe('writeClaudeSh', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-claude-sh-test-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes claude.sh to <workspace>/claude.sh with mode 0755', () => {
    const path = writeClaudeSh(tmpRoot, sampleConfig);
    expect(path).toBe(join(tmpRoot, 'claude.sh'));
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('overwrites existing claude.sh (managed-file semantics)', () => {
    const path = join(tmpRoot, 'claude.sh');
    const { writeFileSync } = require('node:fs');
    writeFileSync(path, '# stale user edits\n', { mode: 0o644 });

    writeClaudeSh(tmpRoot, sampleConfig);

    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('stale user edits');
    expect(after).toContain('exec claude -c --plugin-dir');
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it('returns the absolute path to the written file', () => {
    const path = writeClaudeSh(tmpRoot, sampleConfig);
    expect(path.startsWith('/')).toBe(true);
    expect(path.endsWith('/claude.sh')).toBe(true);
  });
});

describe('otelTelemetryLines (macf#197 + macf#245)', () => {
  it('emits all telemetry gates + per-signal exporters + OTLP endpoint env by default', () => {
    const lines = otelTelemetryLines(sampleConfig, {});
    const joined = lines.join('\n');
    // Master gate + traces-beta gate.
    expect(joined).toContain('export CLAUDE_CODE_ENABLE_TELEMETRY=1');
    expect(joined).toContain('export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1');
    // Per-signal exporters — each missing → that signal silently emits
    // nothing per Claude Code docs. macf#245 surfaced the metrics+logs
    // gap (only traces was wired pre-#245, so devops's stack saw zero
    // metrics + logs from any agent despite the master gate being on).
    expect(joined).toContain('export OTEL_TRACES_EXPORTER=otlp');
    expect(joined).toContain('export OTEL_METRICS_EXPORTER=otlp');
    expect(joined).toContain('export OTEL_LOGS_EXPORTER=otlp');
    // Default endpoint — 4-layer chain (macf#313):
    //   1. OTEL_EXPORTER_OTLP_ENDPOINT (runtime env, canonical OTel name)
    //   2. MACF_OTEL_ENDPOINT (runtime env)
    //   3. settings.local.json `.env.MACF_OTEL_ENDPOINT`
    //   4. Baked default (template-time MACF_OTEL_ENDPOINT or hardcoded fallback)
    // Default `:14318` per current k3d cluster topology (macf#282;
    // pre-2026-04-25 default `:4318` was the retired compose-stack port).
    expect(joined).toContain('MACF_OTEL_ENDPOINT="${MACF_OTEL_ENDPOINT:-$(macf_settings_get MACF_OTEL_ENDPOINT)}"');
    expect(joined).toContain('MACF_OTEL_ENDPOINT="${MACF_OTEL_ENDPOINT:-http://localhost:14318}"');
    expect(joined).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-$MACF_OTEL_ENDPOINT}"');
    // Protocol.
    expect(joined).toContain('export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf');
    // Per-agent service name + resource attrs (semconv-compliant
    // gen_ai.agent.* namespace per macf#245 alignment with devops).
    expect(joined).toContain('export OTEL_SERVICE_NAME="macf-agent-code-agent"');
    expect(joined).toContain(
      'export OTEL_RESOURCE_ATTRIBUTES="gen_ai.agent.name=code-agent,gen_ai.agent.role=code-agent,service.namespace=macf"',
    );
  });

  it('honors MACF_OTEL_ENDPOINT template-time override (bakes custom default)', () => {
    const lines = otelTelemetryLines(sampleConfig, {
      MACF_OTEL_ENDPOINT: 'http://obs.tailnet.ts.net:14318',
    });
    const joined = lines.join('\n');
    // Template-time override bakes the custom URL into the 4th layer
    // of the chain (template-time MACF_OTEL_ENDPOINT default).
    expect(joined).toContain('MACF_OTEL_ENDPOINT="${MACF_OTEL_ENDPOINT:-http://obs.tailnet.ts.net:14318}"');
    expect(joined).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-$MACF_OTEL_ENDPOINT}"');
    // No mention of the canonical default since we overrode it.
    expect(joined).not.toContain('localhost:14318');
    // No mention of the retired :4318 either (regression guard for macf#282).
    expect(joined).not.toContain(':4318');
  });

  it('default endpoint is :14318 (current cluster), NOT :4318 (retired)', () => {
    // macf#282 regression guard: the canonical claude-sh template
    // hardcoded `:4318` (retired compose-stack port). CV agents had
    // 34min of zero telemetry because of this. The fix moved the
    // default to `:14318` (k3d serverlb host-port mapping per
    // macf-devops-toolkit:CLAUDE.md).
    const lines = otelTelemetryLines(sampleConfig, {});
    const joined = lines.join('\n');
    expect(joined).toContain('localhost:14318');
    expect(joined).not.toContain('localhost:4318');
  });

  it('emits env-overridable form for run-time OTEL_EXPORTER_OTLP_ENDPOINT override', () => {
    // The bash `${OTEL_EXPORTER_OTLP_ENDPOINT:-<default>}` substitution
    // means setting `OTEL_EXPORTER_OTLP_ENDPOINT=<url>` in the operator's
    // shell BEFORE invoking ./claude.sh wins over the baked default.
    // macf#282 fix: pre-2026-04-25 the export was unconditional
    // (hardcoded value won regardless of operator env), which is what
    // bit CV-agents.
    const lines = otelTelemetryLines(sampleConfig, {});
    const joined = lines.join('\n');
    // Must contain the bash default-substitution syntax — not bare
    // hardcoded value. Post-#313 the default-side is `$MACF_OTEL_ENDPOINT`
    // (which itself resolves through the 4-layer chain).
    expect(joined).toMatch(/export OTEL_EXPORTER_OTLP_ENDPOINT="\$\{OTEL_EXPORTER_OTLP_ENDPOINT:-\$MACF_OTEL_ENDPOINT\}"/);
  });

  it('omits the block entirely when MACF_OTEL_DISABLED=1', () => {
    const lines = otelTelemetryLines(sampleConfig, { MACF_OTEL_DISABLED: '1' });
    expect(lines).toEqual([]);
  });

  it('omits the block when MACF_OTEL_DISABLED=true', () => {
    const lines = otelTelemetryLines(sampleConfig, { MACF_OTEL_DISABLED: 'true' });
    expect(lines).toEqual([]);
  });

  it('rejects shell-unsafe characters in MACF_OTEL_ENDPOINT', () => {
    // Double-quoted shell context. A literal `"`, `$`, backtick,
    // backslash, or newline in the URL would break the export line
    // or trigger substitution. Same allowlist as validateInitOpts
    // on keyPath.
    const unsafe = [
      'http://host"; rm -rf /;"',
      'http://host:$(whoami)',
      'http://host:`whoami`',
      'http://host:\\n',
      'http://host\nexport MALICIOUS=1',
    ];
    for (const val of unsafe) {
      expect(() => otelTelemetryLines(sampleConfig, { MACF_OTEL_ENDPOINT: val }))
        .toThrow(/shell-unsafe/);
    }
  });
});

describe('generateClaudeSh integration with OTEL block (macf#197)', () => {
  it('embeds the OTEL block in the full launcher output by default', () => {
    // generateClaudeSh reads from process.env, not an injected env.
    // Save + clear MACF_OTEL_* so the default-path test is
    // deterministic on runners that happened to set them.
    const backupDisabled = process.env['MACF_OTEL_DISABLED'];
    const backupEndpoint = process.env['MACF_OTEL_ENDPOINT'];
    delete process.env['MACF_OTEL_DISABLED'];
    delete process.env['MACF_OTEL_ENDPOINT'];
    try {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('export CLAUDE_CODE_ENABLE_TELEMETRY=1');
      expect(output).toContain('export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1');
      expect(output).toContain('export OTEL_TRACES_EXPORTER=otlp');
      // Post-#313: 4-layer chain — env > settings.local.json > MACF_OTEL_ENDPOINT > baked default
      expect(output).toContain('MACF_OTEL_ENDPOINT="${MACF_OTEL_ENDPOINT:-http://localhost:14318}"');
      expect(output).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-$MACF_OTEL_ENDPOINT}"');
    } finally {
      if (backupDisabled !== undefined) process.env['MACF_OTEL_DISABLED'] = backupDisabled;
      if (backupEndpoint !== undefined) process.env['MACF_OTEL_ENDPOINT'] = backupEndpoint;
    }
  });

  it('omits the OTEL block when MACF_OTEL_DISABLED=1 at generate time', () => {
    const backupDisabled = process.env['MACF_OTEL_DISABLED'];
    process.env['MACF_OTEL_DISABLED'] = '1';
    try {
      const output = generateClaudeSh(sampleConfig);
      expect(output).not.toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
      expect(output).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    } finally {
      if (backupDisabled === undefined) delete process.env['MACF_OTEL_DISABLED'];
      else process.env['MACF_OTEL_DISABLED'] = backupDisabled;
    }
  });
});

describe('claude-sh.ts tmux self-wrap + settings-driven identity (macf#313)', () => {
  describe('settings-driven identity', () => {
    it('emits macf_settings_get bash helper', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('macf_settings_get() {');
      expect(output).toContain('local var_name="$1"');
      // Reads from .claude/settings.local.json relative to $SCRIPT_DIR
      expect(output).toContain('"$SCRIPT_DIR/.claude/settings.local.json"');
      // Uses jq with env-key path + // empty fallback
      expect(output).toContain('jq -r ".env.${var_name} // empty"');
      // Stderr suppressed for missing-jq / malformed-json cases
      expect(output).toContain('2>/dev/null');
    });

    it('emits MACF_AGENT_NAME with three-layer priority', () => {
      const output = generateClaudeSh(sampleConfig);
      // Layer 1: env var wins (no rewrite when already set)
      // Layer 2: settings.local.json `.env.MACF_AGENT_NAME`
      expect(output).toContain('MACF_AGENT_NAME="${MACF_AGENT_NAME:-$(macf_settings_get MACF_AGENT_NAME)}"');
      // Layer 3: baked default from config
      expect(output).toContain('MACF_AGENT_NAME="${MACF_AGENT_NAME:-code-agent}"');
      expect(output).toContain('export MACF_AGENT_NAME');
    });

    it('emits MACF_AGENT_ROLE with three-layer priority', () => {
      const roleConfig: MacfAgentConfig = { ...sampleConfig, agent_role: 'science-agent' };
      const output = generateClaudeSh(roleConfig);
      expect(output).toContain('MACF_AGENT_ROLE="${MACF_AGENT_ROLE:-$(macf_settings_get MACF_AGENT_ROLE)}"');
      expect(output).toContain('MACF_AGENT_ROLE="${MACF_AGENT_ROLE:-science-agent}"');
      expect(output).toContain('export MACF_AGENT_ROLE');
    });

    it('emits MACF_OTEL_ENDPOINT four-layer chain (env > settings > template > hardcoded)', () => {
      const output = generateClaudeSh(sampleConfig);
      // Settings layer
      expect(output).toContain('MACF_OTEL_ENDPOINT="${MACF_OTEL_ENDPOINT:-$(macf_settings_get MACF_OTEL_ENDPOINT)}"');
      // Baked default layer
      expect(output).toContain('MACF_OTEL_ENDPOINT="${MACF_OTEL_ENDPOINT:-http://localhost:14318}"');
      // OTel canonical override pointing at MACF_OTEL_ENDPOINT (not direct hardcoded value)
      expect(output).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-$MACF_OTEL_ENDPOINT}"');
    });

    it('macf_settings_get is defined before any caller (function-not-defined hazard guard)', () => {
      const output = generateClaudeSh(sampleConfig);
      const helperPos = output.indexOf('macf_settings_get() {');
      const firstCallerPos = output.indexOf('$(macf_settings_get');
      expect(helperPos).toBeGreaterThan(0);
      expect(firstCallerPos).toBeGreaterThan(helperPos);
    });
  });

  describe('tmux self-wrap', () => {
    it('emits tmux self-wrap block with $TMUX guard + MACF_NO_TMUX_WRAP opt-out', () => {
      const output = generateClaudeSh(sampleConfig);
      // Guard: bypass if already in tmux ($TMUX set) OR opt-out flag set
      expect(output).toContain('if [ -z "${TMUX:-}" ] && [ "${MACF_NO_TMUX_WRAP:-}" != "1" ]; then');
    });

    it('emits canonical session name from MACF_PROJECT@MACF_AGENT_NAME', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('SESSION_NAME="${MACF_PROJECT}@${MACF_AGENT_NAME}"');
    });

    it('emits has-session re-attach path with stderr suppressed', () => {
      const output = generateClaudeSh(sampleConfig);
      // Stderr suppressed handles stale-server-socket case (per
      // science-agent's edge-case note)
      expect(output).toContain('if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then');
      expect(output).toContain('exec tmux attach -t "$SESSION_NAME"');
    });

    it('emits tmux new-session create path with -c $SCRIPT_DIR + script re-exec', () => {
      const output = generateClaudeSh(sampleConfig);
      // -c sets the new session's start directory
      // "$0" "$@" re-execs the script inside the new session
      expect(output).toContain('exec tmux new-session -s "$SESSION_NAME" -c "$SCRIPT_DIR" "$0" "$@"');
    });

    it('tmux wrap block comes AFTER MACF_PROJECT + MACF_AGENT_NAME exports (variable-resolution order)', () => {
      const output = generateClaudeSh(sampleConfig);
      const projectExportPos = output.indexOf('export MACF_PROJECT="TEST"');
      const agentNamePos = output.indexOf('export MACF_AGENT_NAME');
      const tmuxWrapPos = output.indexOf('if [ -z "${TMUX:-}" ]');
      expect(projectExportPos).toBeGreaterThan(0);
      expect(agentNamePos).toBeGreaterThan(0);
      expect(tmuxWrapPos).toBeGreaterThan(0);
      // Wrap MUST come after both — SESSION_NAME interpolates them
      expect(tmuxWrapPos).toBeGreaterThan(projectExportPos);
      expect(tmuxWrapPos).toBeGreaterThan(agentNamePos);
    });

    it('tmux wrap block comes BEFORE the final claude exec (re-exec hazard guard)', () => {
      const output = generateClaudeSh(sampleConfig);
      // The wrap re-execs the script inside tmux. The final claude exec
      // must be reachable on the second invocation (when $TMUX is set).
      // If the wrap comes AFTER claude, the script never reaches it on
      // first invocation and can't deliver agent identity to claude.
      const tmuxWrapPos = output.indexOf('if [ -z "${TMUX:-}" ]');
      const claudeExecPos = output.indexOf('exec claude');
      expect(tmuxWrapPos).toBeGreaterThan(0);
      expect(claudeExecPos).toBeGreaterThan(0);
      expect(tmuxWrapPos).toBeLessThan(claudeExecPos);
    });

    it('tmux wrap block does NOT bypass token generation or claude exec', () => {
      // Regression guard: the tmux block uses `exec tmux` which replaces
      // the process. The script after the wrap (token gen + claude exec)
      // runs on the SECOND invocation (inside tmux, $TMUX set). The
      // script doesn't have any `exit` statements that would skip later
      // sections — only the conditional `exec` inside the if-block.
      const output = generateClaudeSh(sampleConfig);
      // Token gen + claude exec still present in the generated script
      expect(output).toContain('GH_TOKEN=$("$SCRIPT_DIR/.claude/scripts/macf-gh-token.sh"');
      expect(output).toContain('exec claude');
    });
  });

  describe('substrate compat (regression guards)', () => {
    it('does not break existing MACF_TEST escape hatch', () => {
      const output = generateClaudeSh(sampleConfig);
      // MACF_TEST=1 still bypasses -c (per macf#189 sub-item 4)
      expect(output).toContain('if [ -n "${MACF_TEST:-}" ]; then');
    });

    it('does not break existing MACF_OTEL_DISABLED opt-out', () => {
      const backupDisabled = process.env['MACF_OTEL_DISABLED'];
      process.env['MACF_OTEL_DISABLED'] = '1';
      try {
        const output = generateClaudeSh(sampleConfig);
        // No OTEL block + no MACF_OTEL_ENDPOINT line either
        expect(output).not.toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
        expect(output).not.toContain('MACF_OTEL_ENDPOINT');
      } finally {
        if (backupDisabled === undefined) delete process.env['MACF_OTEL_DISABLED'];
        else process.env['MACF_OTEL_DISABLED'] = backupDisabled;
      }
    });

    it('preserves managed-file header (operators see "do not edit directly")', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('# This file is managed by `macf`. Do not edit directly');
    });
  });
});
