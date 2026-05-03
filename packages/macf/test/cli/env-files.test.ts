/**
 * Tests for the per-concern env-file generators (groundnuty/macf#342, PR-A).
 *
 * Each generator is a pure function from `MacfAgentConfig` to file content.
 * No file I/O is exercised here — disk writes land in PR-B's
 * `writeEnvFiles()` helper.
 *
 * Test style mirrors `claude-sh.test.ts`: describe-block per generator,
 * with sample-config matrix for the cross-concern invariants near the end.
 */
import { describe, it, expect } from 'vitest';
import {
  generateEnvIdentity,
  generateEnvGitHub,
  generateEnvCerts,
  generateEnvRegistry,
  generateEnvTelemetry,
  generateEnvTmux,
} from '../../src/cli/env-files.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

const baseConfig: MacfAgentConfig = {
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

const localConfig: MacfAgentConfig = {
  project: 'TEST',
  agent_name: 'cv-architect',
  agent_role: 'cv-architect',
  agent_type: 'permanent',
  registry: { type: 'local', path: '/home/u/.macf/registry/TEST.json' },
  versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
};

const orgConfig: MacfAgentConfig = {
  ...baseConfig,
  registry: { type: 'org', org: 'papers-org' },
};

const profileConfig: MacfAgentConfig = {
  ...baseConfig,
  registry: { type: 'profile', user: 'groundnuty' },
};

const workerConfig: MacfAgentConfig = {
  ...baseConfig,
  agent_type: 'worker',
};

const tmuxFullConfig: MacfAgentConfig = {
  ...baseConfig,
  tmux_session: 'cv-project',
  tmux_window: 'cv-architect',
};

const tmuxSessionOnlyConfig: MacfAgentConfig = {
  ...baseConfig,
  tmux_session: 'macf-code',
};

const advertiseHostConfig: MacfAgentConfig = {
  ...baseConfig,
  advertise_host: '100.124.163.105',
};

// ---------------------------------------------------------------------------
// generateEnvIdentity
// ---------------------------------------------------------------------------

describe('generateEnvIdentity', () => {
  it('emits managed-file header (macf-managed)', () => {
    const out = generateEnvIdentity(baseConfig);
    expect(out).toContain('managed by `macf`');
    expect(out).toContain('overwritten on the next `macf update`');
  });

  it('emits the schema_version comment', () => {
    expect(generateEnvIdentity(baseConfig)).toContain('# schema_version: 1');
  });

  it('exports MACF_PROJECT + MACF_AGENT_TYPE as direct values', () => {
    const out = generateEnvIdentity(baseConfig);
    expect(out).toContain('export MACF_PROJECT="TEST"');
    expect(out).toContain('export MACF_AGENT_TYPE="permanent"');
  });

  it('exports MACF_WORKSPACE_DIR=$SCRIPT_DIR for cross-repo path safety', () => {
    expect(generateEnvIdentity(baseConfig)).toContain(
      'export MACF_WORKSPACE_DIR="$SCRIPT_DIR"',
    );
  });

  it('emits the 3-layer settings-driven priority for MACF_AGENT_NAME', () => {
    const out = generateEnvIdentity(baseConfig);
    expect(out).toContain(
      'MACF_AGENT_NAME="${MACF_AGENT_NAME:-$(macf_settings_get MACF_AGENT_NAME)}"',
    );
    expect(out).toContain('MACF_AGENT_NAME="${MACF_AGENT_NAME:-code-agent}"');
    expect(out).toContain('export MACF_AGENT_NAME');
  });

  it('emits the 3-layer settings-driven priority for MACF_AGENT_ROLE', () => {
    const out = generateEnvIdentity(baseConfig);
    expect(out).toContain(
      'MACF_AGENT_ROLE="${MACF_AGENT_ROLE:-$(macf_settings_get MACF_AGENT_ROLE)}"',
    );
    expect(out).toContain('MACF_AGENT_ROLE="${MACF_AGENT_ROLE:-code-agent}"');
    expect(out).toContain('export MACF_AGENT_ROLE');
  });

  it('defines macf_settings_get helper (env.identity self-contained)', () => {
    const out = generateEnvIdentity(baseConfig);
    expect(out).toContain('macf_settings_get() {');
    expect(out).toContain('settings.local.json');
  });

  it('worker agent_type flows through', () => {
    expect(generateEnvIdentity(workerConfig)).toContain(
      'export MACF_AGENT_TYPE="worker"',
    );
  });

  it('local-mode config still emits identity (identity is mode-agnostic)', () => {
    const out = generateEnvIdentity(localConfig);
    expect(out).toContain('export MACF_PROJECT="TEST"');
    expect(out).toContain('MACF_AGENT_NAME="${MACF_AGENT_NAME:-cv-architect}"');
  });
});

// ---------------------------------------------------------------------------
// generateEnvGitHub
// ---------------------------------------------------------------------------

describe('generateEnvGitHub', () => {
  it('emits APP_ID / INSTALL_ID / KEY_PATH from config', () => {
    const out = generateEnvGitHub(baseConfig);
    expect(out).toContain('export APP_ID="12345"');
    expect(out).toContain('export INSTALL_ID="67890"');
    expect(out).toContain('export KEY_PATH=".github-app-key.pem"');
  });

  it('resolves KEY_PATH against $SCRIPT_DIR when relative (cross-repo cwd trap)', () => {
    expect(generateEnvGitHub(baseConfig)).toMatch(
      /case "\$KEY_PATH" in[\s\S]*?\/\*\) ;;[\s\S]*?\*\) KEY_PATH="\$SCRIPT_DIR\/\$KEY_PATH"/,
    );
  });

  it('uses the fail-loud token helper (no naive gh token generate | jq)', () => {
    const out = generateEnvGitHub(baseConfig);
    expect(out).toContain('macf-gh-token.sh');
    expect(out).toContain('$SCRIPT_DIR/.claude/scripts/macf-gh-token.sh');
    expect(out).toMatch(/macf-gh-token\.sh[\s\S]*?exit 1/);
    expect(out).not.toMatch(/gh token generate[^\n]*\|\s*jq/);
  });

  it('exports GH_TOKEN after the helper invocation', () => {
    expect(generateEnvGitHub(baseConfig)).toContain('export GH_TOKEN');
  });

  it('exports GIT_AUTHOR_NAME + GIT_COMMITTER_NAME with [bot] suffix', () => {
    const out = generateEnvGitHub(baseConfig);
    expect(out).toContain('export GIT_AUTHOR_NAME="code-agent[bot]"');
    expect(out).toContain('export GIT_COMMITTER_NAME="code-agent[bot]"');
  });

  it('echoes the agent identity startup banner', () => {
    expect(generateEnvGitHub(baseConfig)).toContain(
      'echo "Starting code-agent (code-agent)..."',
    );
  });

  it('emits managed-file header (macf-managed)', () => {
    expect(generateEnvGitHub(baseConfig)).toContain('managed by `macf`');
  });

  it('emits schema_version comment', () => {
    expect(generateEnvGitHub(baseConfig)).toContain('# schema_version: 1');
  });

  describe('local-mode placeholder (DR-024)', () => {
    it('returns minimal placeholder content — no APP_ID / GH_TOKEN exports', () => {
      // Substring assertions on var names would false-positive on the
      // explanatory comment text ("No APP_ID, INSTALL_ID, KEY_PATH..."),
      // so check for the actual `export VAR=` form + tool invocation.
      const out = generateEnvGitHub(localConfig);
      expect(out).not.toContain('export APP_ID');
      expect(out).not.toContain('export INSTALL_ID');
      expect(out).not.toContain('export KEY_PATH');
      expect(out).not.toContain('export GH_TOKEN');
      expect(out).not.toContain('export GIT_AUTHOR_NAME');
      expect(out).not.toContain('export GIT_COMMITTER_NAME');
      expect(out).not.toContain('macf-gh-token.sh');
    });

    it('includes a comment explaining the local-mode short-circuit + DR-024 ref', () => {
      const out = generateEnvGitHub(localConfig);
      expect(out).toContain('local-mode');
      expect(out).toContain('DR-024');
    });

    it('still emits managed-file header + schema_version', () => {
      const out = generateEnvGitHub(localConfig);
      expect(out).toContain('managed by `macf`');
      expect(out).toContain('# schema_version: 1');
    });

    it('emits the local-mode startup banner', () => {
      expect(generateEnvGitHub(localConfig)).toContain(
        'echo "Starting cv-architect (cv-architect) [local-registry mode]..."',
      );
    });
  });

  it('emits a defensive warning when non-local mode lacks github_app block', () => {
    // Schema permits github_app: undefined regardless of registry type, so
    // a malformed config (non-local but no github_app) is reachable in
    // theory. Surface visibly rather than silently emitting empty exports.
    const broken: MacfAgentConfig = { ...baseConfig, github_app: undefined };
    const out = generateEnvGitHub(broken);
    expect(out).toContain('WARNING');
    expect(out).toContain('macf init --force');
    expect(out).not.toContain('export APP_ID');
  });
});

// ---------------------------------------------------------------------------
// generateEnvCerts
// ---------------------------------------------------------------------------

describe('generateEnvCerts', () => {
  it('namespaces MACF_CA_CERT to the project under $HOME/.macf/certs/', () => {
    expect(generateEnvCerts(baseConfig)).toContain(
      'export MACF_CA_CERT="$HOME/.macf/certs/TEST/ca-cert.pem"',
    );
  });

  it('exports MACF_CA_KEY alongside MACF_CA_CERT (#103 R3)', () => {
    expect(generateEnvCerts(baseConfig)).toContain(
      'export MACF_CA_KEY="$HOME/.macf/certs/TEST/ca-key.pem"',
    );
  });

  it('exports MACF_AGENT_CERT + MACF_AGENT_KEY under $SCRIPT_DIR/.macf/certs', () => {
    const out = generateEnvCerts(baseConfig);
    expect(out).toContain(
      'export MACF_AGENT_CERT="$SCRIPT_DIR/.macf/certs/agent-cert.pem"',
    );
    expect(out).toContain(
      'export MACF_AGENT_KEY="$SCRIPT_DIR/.macf/certs/agent-key.pem"',
    );
  });

  it('exports MACF_LOG_PATH', () => {
    expect(generateEnvCerts(baseConfig)).toContain(
      'export MACF_LOG_PATH="$SCRIPT_DIR/.macf/logs/channel.log"',
    );
  });

  it('emits schema_version + managed-file header', () => {
    const out = generateEnvCerts(baseConfig);
    expect(out).toContain('# schema_version: 1');
    expect(out).toContain('managed by `macf`');
  });

  describe('local-mode CA paths (DR-024)', () => {
    it('points MACF_CA_CERT at <registry-dir>/<project>.ca.crt', () => {
      // registry path /home/u/.macf/registry/TEST.json → dir /home/u/.macf/registry
      expect(generateEnvCerts(localConfig)).toContain(
        'export MACF_CA_CERT="/home/u/.macf/registry/TEST.ca.crt"',
      );
    });

    it('points MACF_CA_KEY at <registry-dir>/<project>.ca.key', () => {
      expect(generateEnvCerts(localConfig)).toContain(
        'export MACF_CA_KEY="/home/u/.macf/registry/TEST.ca.key"',
      );
    });

    it('still exports MACF_AGENT_CERT under $SCRIPT_DIR (workspace-local)', () => {
      expect(generateEnvCerts(localConfig)).toContain(
        'export MACF_AGENT_CERT="$SCRIPT_DIR/.macf/certs/agent-cert.pem"',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// generateEnvRegistry
// ---------------------------------------------------------------------------

describe('generateEnvRegistry', () => {
  it('emits MACF_REGISTRY_TYPE + MACF_REGISTRY_REPO for repo-scoped registry', () => {
    const out = generateEnvRegistry(baseConfig);
    expect(out).toContain('export MACF_REGISTRY_TYPE="repo"');
    expect(out).toContain('export MACF_REGISTRY_REPO="o/r"');
    expect(out).not.toContain('MACF_REGISTRY_ORG');
    expect(out).not.toContain('MACF_REGISTRY_USER');
    expect(out).not.toContain('MACF_REGISTRY_PATH');
  });

  it('emits MACF_REGISTRY_TYPE + MACF_REGISTRY_ORG for org-scoped registry', () => {
    const out = generateEnvRegistry(orgConfig);
    expect(out).toContain('export MACF_REGISTRY_TYPE="org"');
    expect(out).toContain('export MACF_REGISTRY_ORG="papers-org"');
    expect(out).not.toContain('MACF_REGISTRY_REPO');
  });

  it('emits MACF_REGISTRY_TYPE + MACF_REGISTRY_USER for profile-scoped registry', () => {
    const out = generateEnvRegistry(profileConfig);
    expect(out).toContain('export MACF_REGISTRY_TYPE="profile"');
    expect(out).toContain('export MACF_REGISTRY_USER="groundnuty"');
  });

  it('emits MACF_REGISTRY_TYPE + MACF_REGISTRY_PATH for local-scoped registry', () => {
    const out = generateEnvRegistry(localConfig);
    expect(out).toContain('export MACF_REGISTRY_TYPE="local"');
    expect(out).toContain(
      'export MACF_REGISTRY_PATH="/home/u/.macf/registry/TEST.json"',
    );
  });

  it('emits managed-file header + schema_version', () => {
    const out = generateEnvRegistry(baseConfig);
    expect(out).toContain('managed by `macf`');
    expect(out).toContain('# schema_version: 1');
  });
});

// ---------------------------------------------------------------------------
// generateEnvTelemetry
// ---------------------------------------------------------------------------

describe('generateEnvTelemetry', () => {
  // No envvar to disable + no MACF_OTEL_ENDPOINT set → default endpoint emits.
  const cleanEnv: NodeJS.ProcessEnv = {};

  it('exports the 3 mandatory Claude Code OTel gates', () => {
    const out = generateEnvTelemetry(baseConfig, cleanEnv);
    expect(out).toContain('export CLAUDE_CODE_ENABLE_TELEMETRY=1');
    expect(out).toContain('export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1');
    expect(out).toContain('export OTEL_TRACES_EXPORTER=otlp');
  });

  it('exports per-signal exporters for metrics + logs (#245 gap fix)', () => {
    const out = generateEnvTelemetry(baseConfig, cleanEnv);
    expect(out).toContain('export OTEL_METRICS_EXPORTER=otlp');
    expect(out).toContain('export OTEL_LOGS_EXPORTER=otlp');
  });

  it('bakes the canonical k3d default endpoint when MACF_OTEL_ENDPOINT unset', () => {
    expect(generateEnvTelemetry(baseConfig, cleanEnv)).toContain(
      'http://localhost:14318',
    );
  });

  it('honors MACF_OTEL_ENDPOINT template-time override', () => {
    const out = generateEnvTelemetry(baseConfig, {
      MACF_OTEL_ENDPOINT: 'http://obs.tailnet.ts.net:4318',
    });
    expect(out).toContain('http://obs.tailnet.ts.net:4318');
  });

  it('emits 4-layer endpoint resolution chain (env > settings > baked)', () => {
    const out = generateEnvTelemetry(baseConfig, cleanEnv);
    expect(out).toContain(
      'MACF_OTEL_ENDPOINT="${MACF_OTEL_ENDPOINT:-$(macf_settings_get MACF_OTEL_ENDPOINT)}"',
    );
    expect(out).toContain(
      'export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-$MACF_OTEL_ENDPOINT}"',
    );
  });

  it('exports OTEL_SERVICE_NAME = macf-agent-<agent_name>', () => {
    expect(generateEnvTelemetry(baseConfig, cleanEnv)).toContain(
      'export OTEL_SERVICE_NAME="macf-agent-code-agent"',
    );
  });

  it('exports OTEL_RESOURCE_ATTRIBUTES with gen_ai.agent.name + role + namespace', () => {
    expect(generateEnvTelemetry(baseConfig, cleanEnv)).toContain(
      'export OTEL_RESOURCE_ATTRIBUTES="gen_ai.agent.name=code-agent,gen_ai.agent.role=code-agent,service.namespace=macf"',
    );
  });

  it('rejects shell-unsafe characters in MACF_OTEL_ENDPOINT', () => {
    expect(() =>
      generateEnvTelemetry(baseConfig, {
        MACF_OTEL_ENDPOINT: 'http://obs"injection',
      }),
    ).toThrow(/shell-unsafe/);
  });

  it('returns minimal placeholder when MACF_OTEL_DISABLED=1', () => {
    const out = generateEnvTelemetry(baseConfig, { MACF_OTEL_DISABLED: '1' });
    expect(out).not.toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
    expect(out).not.toContain('OTEL_TRACES_EXPORTER');
    expect(out).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    // But still has the schema header so the file is well-formed.
    expect(out).toContain('# schema_version: 1');
    expect(out).toContain('Telemetry intentionally disabled');
  });

  it('also accepts MACF_OTEL_DISABLED=true (matches claude-sh.ts)', () => {
    const out = generateEnvTelemetry(baseConfig, {
      MACF_OTEL_DISABLED: 'true',
    });
    expect(out).not.toContain('OTEL_TRACES_EXPORTER');
  });

  it('emits operator-managed header (softer wording than macf-managed)', () => {
    const out = generateEnvTelemetry(baseConfig, cleanEnv);
    expect(out).toContain('operator-editable');
    expect(out).not.toContain('managed by `macf`');
  });
});

// ---------------------------------------------------------------------------
// generateEnvTmux
// ---------------------------------------------------------------------------

describe('generateEnvTmux', () => {
  it('emits both MACF_TMUX_SESSION + MACF_TMUX_WINDOW when both set', () => {
    const out = generateEnvTmux(tmuxFullConfig);
    expect(out).toContain('export MACF_TMUX_SESSION="cv-project"');
    expect(out).toContain('export MACF_TMUX_WINDOW="cv-architect"');
  });

  it('emits session alone when window not set', () => {
    const out = generateEnvTmux(tmuxSessionOnlyConfig);
    expect(out).toContain('export MACF_TMUX_SESSION="macf-code"');
    expect(out).not.toContain('MACF_TMUX_WINDOW');
  });

  it('returns minimal placeholder when neither field is set', () => {
    const out = generateEnvTmux(baseConfig);
    expect(out).not.toContain('export MACF_TMUX_SESSION');
    expect(out).not.toContain('export MACF_TMUX_WINDOW');
    // Still has the schema header so the file is well-formed.
    expect(out).toContain('# schema_version: 1');
    expect(out).toContain('auto-detect');
  });

  it('emits operator-managed header', () => {
    const out = generateEnvTmux(tmuxFullConfig);
    expect(out).toContain('operator-editable');
    expect(out).not.toContain('managed by `macf`');
  });
});

// ---------------------------------------------------------------------------
// Cross-concern invariants
// ---------------------------------------------------------------------------

describe('cross-concern invariants', () => {
  /**
   * Sample matrix: every {registry, agent_type, tmux} combination that
   * upstream init.ts can produce. Each generator must be a TOTAL function
   * across this matrix — no thrown exceptions for any valid config.
   */
  const matrix: ReadonlyArray<{ name: string; cfg: MacfAgentConfig }> = [
    { name: 'repo + permanent + bare', cfg: baseConfig },
    { name: 'org + permanent', cfg: orgConfig },
    { name: 'profile + permanent', cfg: profileConfig },
    { name: 'local + permanent', cfg: localConfig },
    { name: 'repo + worker', cfg: workerConfig },
    { name: 'repo + tmux full', cfg: tmuxFullConfig },
    { name: 'repo + tmux session-only', cfg: tmuxSessionOnlyConfig },
    { name: 'repo + advertise_host', cfg: advertiseHostConfig },
  ];

  for (const { name, cfg } of matrix) {
    describe(`config: ${name}`, () => {
      it('all 6 generators run without throwing', () => {
        // generateEnvTelemetry takes an env arg; pass clean env so the
        // shell-unsafe-char check + MACF_OTEL_DISABLED branch don't fire.
        expect(() => generateEnvIdentity(cfg)).not.toThrow();
        expect(() => generateEnvGitHub(cfg)).not.toThrow();
        expect(() => generateEnvCerts(cfg)).not.toThrow();
        expect(() => generateEnvRegistry(cfg)).not.toThrow();
        expect(() => generateEnvTelemetry(cfg, {})).not.toThrow();
        expect(() => generateEnvTmux(cfg)).not.toThrow();
      });

      it('every generator output ends with a trailing newline', () => {
        expect(generateEnvIdentity(cfg).endsWith('\n')).toBe(true);
        expect(generateEnvGitHub(cfg).endsWith('\n')).toBe(true);
        expect(generateEnvCerts(cfg).endsWith('\n')).toBe(true);
        expect(generateEnvRegistry(cfg).endsWith('\n')).toBe(true);
        expect(generateEnvTelemetry(cfg, {}).endsWith('\n')).toBe(true);
        expect(generateEnvTmux(cfg).endsWith('\n')).toBe(true);
      });

      it('every generator output carries the schema_version line', () => {
        expect(generateEnvIdentity(cfg)).toContain('# schema_version: 1');
        expect(generateEnvGitHub(cfg)).toContain('# schema_version: 1');
        expect(generateEnvCerts(cfg)).toContain('# schema_version: 1');
        expect(generateEnvRegistry(cfg)).toContain('# schema_version: 1');
        expect(generateEnvTelemetry(cfg, {})).toContain('# schema_version: 1');
        expect(generateEnvTmux(cfg)).toContain('# schema_version: 1');
      });
    });
  }

  it('determinism — same config + same env produce the exact same string', () => {
    expect(generateEnvIdentity(baseConfig)).toBe(generateEnvIdentity(baseConfig));
    expect(generateEnvGitHub(baseConfig)).toBe(generateEnvGitHub(baseConfig));
    expect(generateEnvCerts(baseConfig)).toBe(generateEnvCerts(baseConfig));
    expect(generateEnvRegistry(baseConfig)).toBe(generateEnvRegistry(baseConfig));
    expect(generateEnvTelemetry(baseConfig, {})).toBe(
      generateEnvTelemetry(baseConfig, {}),
    );
    expect(generateEnvTmux(baseConfig)).toBe(generateEnvTmux(baseConfig));
  });

  it('non-overlap: env.identity vars do not appear in env.github', () => {
    // env.identity owns MACF_PROJECT, MACF_AGENT_TYPE, MACF_AGENT_NAME
    // (the bare-export form), MACF_AGENT_ROLE, MACF_WORKSPACE_DIR. None
    // should leak into env.github (non-local mode).
    const github = generateEnvGitHub(baseConfig);
    expect(github).not.toContain('export MACF_PROJECT');
    expect(github).not.toContain('export MACF_AGENT_TYPE');
    expect(github).not.toContain('export MACF_AGENT_NAME');
    expect(github).not.toContain('export MACF_AGENT_ROLE');
    expect(github).not.toContain('export MACF_WORKSPACE_DIR');
  });

  it('non-overlap: env.identity vars do not appear in env.certs', () => {
    const certs = generateEnvCerts(baseConfig);
    expect(certs).not.toContain('export MACF_PROJECT');
    expect(certs).not.toContain('export MACF_AGENT_NAME');
    expect(certs).not.toContain('export MACF_AGENT_ROLE');
  });

  it('non-overlap: env.registry only emits MACF_REGISTRY_* vars', () => {
    const registry = generateEnvRegistry(baseConfig);
    // Strip comments + blank lines + shebang-style lines, then check
    // every non-comment `export` line targets MACF_REGISTRY_*.
    const exportLines = registry
      .split('\n')
      .filter(l => l.startsWith('export '));
    for (const line of exportLines) {
      expect(line).toMatch(/export MACF_REGISTRY_/);
    }
  });

  it('non-overlap: env.telemetry only emits OTEL_* / CLAUDE_CODE_* / MACF_OTEL_*', () => {
    const telemetry = generateEnvTelemetry(baseConfig, {});
    const exportLines = telemetry
      .split('\n')
      .filter(l => l.startsWith('export '));
    for (const line of exportLines) {
      expect(line).toMatch(
        /export (OTEL_|CLAUDE_CODE_|MACF_OTEL_)/,
      );
    }
  });

  it('non-overlap: env.tmux only emits MACF_TMUX_* vars', () => {
    const tmux = generateEnvTmux(tmuxFullConfig);
    const exportLines = tmux.split('\n').filter(l => l.startsWith('export '));
    for (const line of exportLines) {
      expect(line).toMatch(/export MACF_TMUX_/);
    }
  });
});
