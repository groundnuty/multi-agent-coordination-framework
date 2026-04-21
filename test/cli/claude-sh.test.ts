/**
 * Tests for the extracted claude.sh generator. Used by both `macf init`
 * (first write) and `macf update` (refresh after a template change).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateClaudeSh, writeClaudeSh } from '../../src/cli/claude-sh.js';
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
  it('includes the --plugin-dir flag + -c for permanent agents', () => {
    const output = generateClaudeSh(sampleConfig);
    // Permanent agent → `-c` reattaches to prior session (macf#178 Gap 5).
    expect(output).toContain('exec claude -c --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"');
  });

  it('omits -c for worker agents (each invocation is fresh by design)', () => {
    const workerConfig: MacfAgentConfig = { ...sampleConfig, agent_type: 'worker' };
    const output = generateClaudeSh(workerConfig);
    expect(output).toContain('exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"');
    expect(output).not.toContain('exec claude -c');
  });

  it('exports the expected environment variables from config', () => {
    const output = generateClaudeSh(sampleConfig);
    expect(output).toContain('export MACF_AGENT_NAME="code-agent"');
    expect(output).toContain('export MACF_PROJECT="TEST"');
    expect(output).toContain('export MACF_AGENT_TYPE="permanent"');
    expect(output).toContain('export MACF_AGENT_ROLE="code-agent"');
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
