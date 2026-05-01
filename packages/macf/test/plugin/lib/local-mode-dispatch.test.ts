/**
 * Integration test for #332 — exercises the full local-mode dispatch path
 * that the `macf-plugin-cli` binary's status/peers/ping cases use, without
 * spawning a subprocess.
 *
 * Path covered: env vars → getRegistryConfig → createRegistryFromConfig
 * (factory dispatch on `local` variant) → LocalRegistryClient (real file
 * I/O against tmp registry) → list/get → formatPeerTable rendering.
 *
 * Pre-#332 fix, this path was broken at step 1 — getRegistryConfig
 * ignored MACF_REGISTRY_TYPE=local entirely. Step 2 onward was already
 * correct (PR #324 LocalRegistryClient + PR #329 channel-server local
 * dispatch). The fix wires the bin to honor the env var the launcher
 * exports.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRegistryConfig } from '../../../src/plugin/lib/registry-config.js';
import { listPeers } from '../../../src/plugin/lib/registry.js';
import { formatPeerTable } from '../../../src/plugin/lib/format.js';
import { createRegistryFromConfig } from '@groundnuty/macf-core';

let workDir: string;
let registryPath: string;

const samplePeerJson = {
  schema_version: 1,
  project: 'PPAM_2026',
  agents: {
    PAPER_AGENT: {
      host: '127.0.0.1',
      port: 9001,
      type: 'permanent',
      instance_id: 'a1b2c3',
      started: '2026-05-01T17:30:00Z',
    },
    CODE_AGENT: {
      host: '127.0.0.1',
      port: 9002,
      type: 'permanent',
      instance_id: 'd4e5f6',
      started: '2026-05-01T17:30:30Z',
    },
  },
};

beforeEach(() => {
  workDir = join(tmpdir(), `macf-local-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  chmodSync(workDir, 0o700);
  registryPath = join(workDir, 'PPAM_2026.json');
  writeFileSync(registryPath, JSON.stringify(samplePeerJson, null, 2), { mode: 0o600 });
  chmodSync(registryPath, 0o600);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('local-mode dispatch end-to-end (#332 regression)', () => {
  it('full path: env → getRegistryConfig → factory → LocalRegistryClient → list → formatPeerTable', async () => {
    // Step 1: Env exactly as claude.sh exports in local mode (no APP_ID/INSTALL_ID/KEY_PATH).
    const env = {
      MACF_REGISTRY_TYPE: 'local',
      MACF_REGISTRY_PATH: registryPath,
      MACF_PROJECT: 'PPAM_2026',
    };

    // Step 2: Bin's getRegistryConfig translates env → RegistryConfig.
    const config = getRegistryConfig(env);
    expect(config).toEqual({ type: 'local', path: registryPath });

    // Step 3: Factory dispatches on `local` variant. Token is empty string
    // per the macf#332 fix in the bin's peers/status/ping cases (no
    // generateToken() call in local mode; LocalRegistryClient ignores token).
    const registry = createRegistryFromConfig(config, 'PPAM_2026', '');

    // Step 4: LocalRegistryClient reads the tmp registry file.
    const peers = await listPeers(registry);
    expect(peers).toHaveLength(2);
    const names = peers.map(p => p.name).sort();
    expect(names).toEqual(['CODE_AGENT', 'PAPER_AGENT']);

    // Step 5: formatPeerTable renders without crashing on the real peer data.
    const peersWithHealth = peers.map(p => ({ ...p, health: null }));
    const output = formatPeerTable(peersWithHealth);
    expect(output).toContain('PAPER_AGENT');
    expect(output).toContain('CODE_AGENT');
    expect(output).toContain('127.0.0.1:9001');
    expect(output).toContain('127.0.0.1:9002');
    // Without a real channel-server probe the health is null → "offline" rendering;
    // that's expected here. The point of this test is dispatch correctness, not health.
    expect(output).toContain('offline');
  });

  it('pre-fix would have failed at step 2: env-without-MACF_REGISTRY_TYPE-handling falls through to default', () => {
    // Simulate the pre-#332 getRegistryConfig behaviour: ignore MACF_REGISTRY_TYPE.
    // The default fallback path is still exercised when only the local-mode env vars are set.
    const env = {
      MACF_REGISTRY_PATH: registryPath,
      // MACF_REGISTRY_TYPE intentionally omitted to simulate the pre-fix code path
    };
    const config = getRegistryConfig(env);
    // Without the type marker, falls through to default repo (groundnuty/macf) —
    // which is exactly the bug: dispatch hits GitHub registry path requiring App env vars.
    expect(config).toEqual({ type: 'repo', owner: 'groundnuty', repo: 'macf' });
    // This path then reaches `await generateToken()` in the bin (in repo mode),
    // which throws if APP_ID/INSTALL_ID/KEY_PATH are missing — the operator-witnessed
    // error from macf#332. The fix gates that call on registry.type === 'local'
    // AND adds the local handling above so the env actually dispatches correctly.
  });

  it('local-mode env with multiple peers renders consistent table output', async () => {
    const config = getRegistryConfig({
      MACF_REGISTRY_TYPE: 'local',
      MACF_REGISTRY_PATH: registryPath,
    });
    const registry = createRegistryFromConfig(config, 'PPAM_2026', '');
    const peers = await listPeers(registry);
    const peersWithHealth = peers.map(p => ({ ...p, health: null }));
    const lines = formatPeerTable(peersWithHealth).split('\n');
    // Header + separator + 2 peers
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[0]).toMatch(/NAME.*HOST:PORT.*STATUS/);
  });
});
